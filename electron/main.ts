import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
  type IpcMainInvokeEvent,
} from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadFfmpegManifestJson,
  loadAsrManifestJson,
  loadQwenAsrManifestJson,
  resolveAsrRoots,
  resolveAppDataDirs,
  resolveFfmpegRoots,
  resolvePreloadPath,
  resolveRendererEntry,
} from "./paths";
import { isTrustedRendererNavigation } from "./navigation";
import { createTaskSupervisorClient } from "./task-supervisor-client";
import { createTaskEventPublisher } from "./task-event-publisher";
import { decideExitBehavior, resolveAutomatedExitResponse } from "./exit-policy";
import {
  handleMediaProtocolRequest,
  isMediaGrantAuthorized,
  issueMediaGrant,
  mediaProtocolPrivilegedScheme,
  revokeMediaGrantsForWebContents,
} from "./media-protocol";
import { DEFAULT_ASR_VAD_SETTINGS } from "../shared/asr-vad-config.mjs";
// @ts-expect-error Backend services are runtime-checked JavaScript modules.
import { transferModelStorage } from "../backend/settings/model-storage-transfer.mjs";
import { TRANSLATION_PROVIDER_CATALOG } from "../shared/provider-registry.mjs";
import {
  DESKTOP_API_CHANNEL,
  DESKTOP_BEFORE_CLOSE_CHANNEL,
  DESKTOP_EVENT_CHANNEL,
  DESKTOP_MODEL_STORAGE_TRANSFER_CHANNEL,
  type AppStoragePathKey,
  type AsrInfoOpenRequest,
  type AsrModelId,
} from "../src/contracts/desktop-api";

protocol.registerSchemesAsPrivileged([mediaProtocolPrivilegedScheme()]);

const moduleDir = dirname(fileURLToPath(import.meta.url));

type IpcAdapter = {
  handle: (event: IpcMainInvokeEvent, envelope: unknown) => Promise<unknown>;
  reconcileProjectIndex: () => { rebuilt: number; diagnostics: string[] };
  hasActiveTasks: () => boolean;
  stopActiveTasks: () => Promise<void>;
  close: () => void;
};

let mainWindow: BrowserWindow | null = null;
let ipcAdapter: IpcAdapter | null = null;
let taskSupervisorClient: ReturnType<typeof createTaskSupervisorClient> | null = null;
let taskCoordinator: any = null;
let tray: Tray | null = null;
const taskEventPublisher = createTaskEventPublisher({
  send: (event) => {
    const current = mainWindow;
    if (current && !current.isDestroyed()) current.webContents.send(DESKTOP_EVENT_CHANNEL, event);
  },
});
let closingAfterFlush = false;
let appShutdownInProgress = false;
let appShutdownComplete = false;

function showMainWindow() {
  const current = mainWindow;
  if (!current || current.isDestroyed()) return;
  current.show();
  current.focus();
}

function createTrayImage() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const offset = (y * size + x) * 4;
      const gold = x === y || x + y === size - 1 || x === 2 || y === 2;
      pixels[offset] = gold ? 69 : 48;
      pixels[offset + 1] = gold ? 130 : 56;
      pixels[offset + 2] = gold ? 185 : 79;
      pixels[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBuffer(pixels, { width: size, height: size });
}

function ensureTray() {
  if (tray) return tray;
  tray = new Tray(createTrayImage());
  tray.setToolTip("AI Translator Desktop — tasks running in background");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: showMainWindow },
    { type: "separator" },
    { label: "停止任务并退出", click: () => app.quit() },
  ]));
  tray.on("click", showMainWindow);
  return tray;
}

async function requestCloseAfterFlush() {
  const current = mainWindow;
  if (!current || current.isDestroyed()) return;
  const behavior = await decideExitBehavior({
    hasActiveTasks: Boolean(ipcAdapter?.hasActiveTasks()),
    prompt: async () => {
      const automated = resolveAutomatedExitResponse({
        fakeProvider: process.env.TRANSLATION_FAKE_PROVIDER === "1",
        choice: process.env.PHASE8_E2E_EXIT_CHOICE,
      });
      if (automated !== null) return automated;
      return (await dialog.showMessageBox(current, {
        type: "question",
        title: "任务仍在运行",
        message: "关闭窗口后如何处理正在运行的任务？",
        detail: "后台继续会保留任务与托盘；停止并退出会先取消任务并清理子进程。",
        buttons: ["后台继续", "停止并退出", "取消退出"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })).response;
    },
  });
  if (behavior === "cancel") return;
  if (behavior === "background") {
    ensureTray();
    current.hide();
    return;
  }
  if (behavior === "stop") await ipcAdapter?.stopActiveTasks();
  closingAfterFlush = true;
  current.destroy();
  closingAfterFlush = false;
  app.quit();
}

async function loadIpcAdapterModule() {
  const candidates = [
    join(moduleDir, "ipc/adapter.mjs"),
    join(moduleDir, "../electron/ipc/adapter.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) {
    throw new Error("ipc adapter module was not found");
  }
  const mod = await import(pathToFileURL(matched).href);
  return mod.createIpcAdapter as (options: Record<string, unknown>) => IpcAdapter;
}

async function loadPersistencePortFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/persistence/desktop-persistence-port.mjs"),
    join(moduleDir, "../backend/persistence/desktop-persistence-port.mjs"),
    join(moduleDir, "../../backend/persistence/desktop-persistence-port.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) {
    throw new Error("desktop-persistence-port.mjs was not found");
  }
  const mod = await import(pathToFileURL(matched).href);
  return mod.openDesktopPersistencePort as (options: Record<string, string>) => unknown;
}

async function loadCredentialStoreFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/credentials/credential-store.mjs"),
    join(moduleDir, "../backend/credentials/credential-store.mjs"),
    join(moduleDir, "../../backend/credentials/credential-store.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) {
    throw new Error("credential-store.mjs was not found");
  }
  const mod = await import(pathToFileURL(matched).href);
  return mod.openCredentialStore as (options: Record<string, unknown>) => unknown;
}

async function loadProjectRepositoryFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/persistence/project-repository.mjs"),
    join(moduleDir, "../backend/persistence/project-repository.mjs"),
    join(moduleDir, "../../backend/persistence/project-repository.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) {
    throw new Error("project-repository.mjs was not found");
  }
  const mod = await import(pathToFileURL(matched).href);
  return mod.openProjectRepository as (containerDir: string, options?: Record<string, unknown>) => unknown;
}

async function loadTaskCoordinatorFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/tasks/task-coordinator.mjs"),
    join(moduleDir, "../backend/tasks/task-coordinator.mjs"),
    join(moduleDir, "../../backend/tasks/task-coordinator.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) {
    throw new Error("task-coordinator.mjs was not found");
  }
  const mod = await import(pathToFileURL(matched).href);
  return mod.createTaskCoordinator as (options: Record<string, unknown>) => any;
}

async function loadTranslationPortFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/translation/desktop-translation-port.mjs"),
    join(moduleDir, "../backend/translation/desktop-translation-port.mjs"),
    join(moduleDir, "../../backend/translation/desktop-translation-port.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) {
    throw new Error("desktop-translation-port.mjs was not found");
  }
  const mod = await import(pathToFileURL(matched).href);
  return mod.createDesktopTranslationPort as (options: Record<string, unknown>) => unknown;
}

function resolveWorkerEntry(fileName: string) {
  const candidates = [
    join(app.getAppPath(), "backend/worker", fileName),
    join(moduleDir, "../backend/worker", fileName),
    join(moduleDir, "../../backend/worker", fileName),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error(`${fileName} was not found`);
  return matched;
}

function workerEnvironment() {
  return Object.fromEntries(
    ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key] as string]] : [],
    ),
  );
}

function createMainWindow() {
  const preload = resolvePreloadPath();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    frame: false,
    title: "AI Translator Desktop",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  const entry = resolveRendererEntry(process.env.VITE_DEV_SERVER_URL);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererNavigation(url, entry)) {
      return;
    }
    event.preventDefault();
  });

  mainWindow.on("close", (event) => {
    if (closingAfterFlush || !mainWindow) {
      return;
    }
    event.preventDefault();
    mainWindow.webContents.send(DESKTOP_BEFORE_CLOSE_CHANNEL);
  });

  mainWindow.on("closed", () => {
    if (mainWindow) {
      try {
        revokeMediaGrantsForWebContents(mainWindow.webContents.id);
      } catch {
        /* ignore */
      }
    }
    mainWindow = null;
  });

  if (entry.type === "url") {
    void mainWindow.loadURL(entry.value);
  } else {
    void mainWindow.loadFile(entry.value);
  }
}

function registerSessionGuards() {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["app-media://*/*"] },
    (details, callback) => callback({ cancel: !isMediaGrantAuthorized(details.url, details.webContentsId) }),
  );
}

async function loadMediaServiceFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/media/media-service.mjs"),
    join(moduleDir, "../backend/media/media-service.mjs"),
    join(moduleDir, "../../backend/media/media-service.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("media-service.mjs was not found");
  const mod = await import(pathToFileURL(matched).href);
  return mod.createMediaService as (options: Record<string, unknown>) => any;
}

async function loadVideoExportServiceFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/export/video-export-service.mjs"),
    join(moduleDir, "../backend/export/video-export-service.mjs"),
    join(moduleDir, "../../backend/export/video-export-service.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("video-export-service.mjs was not found");
  const mod = await import(pathToFileURL(matched).href);
  return mod.createVideoExportService as (options: Record<string, unknown>) => any;
}

async function loadAudioSeparationServiceFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/audio/separation-service.mjs"),
    join(moduleDir, "../backend/audio/separation-service.mjs"),
    join(moduleDir, "../../backend/audio/separation-service.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("separation-service.mjs was not found");
  const mod = await import(pathToFileURL(matched).href);
  return mod.createAudioSeparationService as (options: Record<string, unknown>) => any;
}

async function loadArtifactResolver() {
  const candidates = [
    join(app.getAppPath(), "backend/media/ffmpeg-artifact-manifest.mjs"),
    join(moduleDir, "../backend/media/ffmpeg-artifact-manifest.mjs"),
    join(moduleDir, "../../backend/media/ffmpeg-artifact-manifest.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("ffmpeg-artifact-manifest.mjs was not found");
  const mod = await import(pathToFileURL(matched).href);
  return mod.resolveVerifiedArtifactPaths as (manifest: unknown, options: Record<string, unknown>) => any;
}

async function loadProcessTreeKiller() {
  const candidates = [
    join(app.getAppPath(), "backend/media/process-runner.mjs"),
    join(moduleDir, "../backend/media/process-runner.mjs"),
    join(moduleDir, "../../backend/media/process-runner.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("process-runner.mjs was not found");
  const mod = await import(pathToFileURL(matched).href);
  return mod.killProcessTree as (pid: number) => void;
}

async function loadAsrRuntimePortFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/asr/runtime-registry.mjs"),
    join(moduleDir, "../backend/asr/runtime-registry.mjs"),
    join(moduleDir, "../../backend/asr/runtime-registry.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("runtime-registry.mjs was not found");
  const mod = await import(pathToFileURL(matched).href);
  return mod.createAsrRuntimePort as (options: Record<string, unknown>) => any;
}

async function loadAsrModelInstallerFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/asr/model-installer.mjs"),
    join(moduleDir, "../backend/asr/model-installer.mjs"),
    join(moduleDir, "../../backend/asr/model-installer.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("model-installer.mjs was not found");
  const mod = await import(pathToFileURL(matched).href);
  return mod.createModelInstaller as (options: Record<string, unknown>) => any;
}

async function loadVocalSeparationProcessFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/audio/vocal-separation-process.mjs"),
    join(moduleDir, "../backend/audio/vocal-separation-process.mjs"),
    join(moduleDir, "../../backend/audio/vocal-separation-process.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("vocal-separation-process.mjs was not found");
  return import(pathToFileURL(matched).href) as Promise<Record<string, any>>;
}

async function loadSongClassifierFactories() {
  async function load(fileName: string) {
    const candidates = [
      join(app.getAppPath(), "backend/audio", fileName),
      join(moduleDir, "../backend/audio", fileName),
      join(moduleDir, "../../backend/audio", fileName),
    ];
    const matched = candidates.find((candidate) => existsSync(candidate));
    if (!matched) throw new Error(`${fileName} was not found`);
    return import(pathToFileURL(matched).href);
  }
  const [processModule, installerModule] = await Promise.all([
    load("song-classifier-process.mjs"),
    load("song-classifier-installer.mjs"),
  ]);
  return {
    createSongClassifierProcess: processModule.createSongClassifierProcess,
    createSongClassifierInstaller: installerModule.createSongClassifierInstaller,
  } as Record<string, (options: Record<string, unknown>) => any>;
}

async function loadQwenAsrFactories() {
  async function load(fileName: string) {
    const candidates = [
      join(app.getAppPath(), "backend/asr", fileName),
      join(moduleDir, "../backend/asr", fileName),
      join(moduleDir, "../../backend/asr", fileName),
    ];
    const matched = candidates.find((candidate) => existsSync(candidate));
    if (!matched) throw new Error(`${fileName} was not found`);
    return import(pathToFileURL(matched).href);
  }
  const [port, installer] = await Promise.all([
    load("qwen3-asr-port.mjs"), load("qwen3-asr-installer.mjs"),
  ]);
  return {
    createQwenRuntimePort: port.createQwenRuntimePort,
    createUnifiedAsrRuntimePort: port.createUnifiedAsrRuntimePort,
    createQwenInstaller: installer.createQwenInstaller,
    createUnifiedAsrInstaller: installer.createUnifiedAsrInstaller,
  } as Record<string, (options: Record<string, unknown>) => any>;
}

async function loadAsrDeviceSelectorFactory() {
  const candidates = [
    join(app.getAppPath(), "backend/asr/device-selector.mjs"),
    join(moduleDir, "../backend/asr/device-selector.mjs"),
    join(moduleDir, "../../backend/asr/device-selector.mjs"),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) throw new Error("device-selector.mjs was not found");
  const mod = await import(pathToFileURL(matched).href);
  return mod.createAsrDeviceSelector as (options: Record<string, unknown>) => any;
}

async function loadAsrProjectFactories() {
  async function load(fileName: string) {
    const candidates = [
      join(app.getAppPath(), "backend/asr", fileName),
      join(moduleDir, "../backend/asr", fileName),
      join(moduleDir, "../../backend/asr", fileName),
    ];
    const matched = candidates.find((candidate) => existsSync(candidate));
    if (!matched) throw new Error(`${fileName} was not found`);
    return import(pathToFileURL(matched).href);
  }
  const [asr, candidate, language, detector, project] = await Promise.all([
    load("asr-service.mjs"),
    load("asr-candidate-service.mjs"),
    load("asr-language-service.mjs"),
    load("asr-language-region-detector.mjs"),
    load("asr-project-service.mjs"),
  ]);
  return {
    createAsrService: asr.createAsrService,
    createAsrCandidateService: candidate.createAsrCandidateService,
    createAsrLanguageService: language.createAsrLanguageService,
    createAsrLanguageRegionDetector: detector.createAsrLanguageRegionDetector,
    createAsrProjectService: project.createAsrProjectService,
  } as Record<string, (options: Record<string, unknown>) => any>;
}

async function loadPhase12Factories() {
  async function load(relativePath: string) {
    const candidates = [
      join(app.getAppPath(), "backend", relativePath),
      join(moduleDir, "../backend", relativePath),
      join(moduleDir, "../../backend", relativePath),
    ];
    const matched = candidates.find((candidate) => existsSync(candidate));
    if (!matched) throw new Error(`${relativePath} was not found`);
    return import(pathToFileURL(matched).href);
  }
  const [settings, capabilities, backup, diagnostics] = await Promise.all([
    load("settings/app-settings.mjs"),
    load("capabilities/capability-service.mjs"),
    load("backup/backup-service.mjs"),
    load("support/diagnostics.mjs"),
  ]);
  return {
    createAppSettingsService: settings.createAppSettingsService,
    createCapabilityService: capabilities.createCapabilityService,
    createBackupService: backup.createBackupService,
    createDiagnosticsService: diagnostics.createDiagnosticsService,
    createStructuredLogger: diagnostics.createStructuredLogger,
  } as Record<string, (options: Record<string, unknown>) => any>;
}

async function bootstrap() {
  const openDesktopPersistencePort = await loadPersistencePortFactory();
  const openCredentialStore = await loadCredentialStoreFactory();
  const openProjectRepository = await loadProjectRepositoryFactory();
  const createTaskCoordinator = await loadTaskCoordinatorFactory();
  const createDesktopTranslationPort = await loadTranslationPortFactory();
  const createMediaService = await loadMediaServiceFactory();
  const createVideoExportService = await loadVideoExportServiceFactory();
  const createAudioSeparationService = await loadAudioSeparationServiceFactory();
  const {
    createVocalSeparationProcess,
    VOCAL_SEPARATION_IDENTITY,
  } = await loadVocalSeparationProcessFactory();
  const { createSongClassifierProcess, createSongClassifierInstaller } = await loadSongClassifierFactories();
  const resolveVerifiedArtifactPaths = await loadArtifactResolver();
  const killAsrProcessTree = await loadProcessTreeKiller();
  const createAsrRuntimePort = await loadAsrRuntimePortFactory();
  const createModelInstaller = await loadAsrModelInstallerFactory();
  const { createQwenRuntimePort, createUnifiedAsrRuntimePort, createQwenInstaller, createUnifiedAsrInstaller } = await loadQwenAsrFactories();
  const createAsrDeviceSelector = await loadAsrDeviceSelectorFactory();
  const {
    createAsrService,
    createAsrCandidateService,
    createAsrLanguageService,
    createAsrLanguageRegionDetector,
    createAsrProjectService,
  } = await loadAsrProjectFactories();
  const {
    createAppSettingsService,
    createCapabilityService,
    createBackupService,
    createDiagnosticsService,
    createStructuredLogger,
  } = await loadPhase12Factories();
  const createIpcAdapter = await loadIpcAdapterModule();
  const dirs = resolveAppDataDirs();
  [dirs.cacheDir, dirs.modelDir, dirs.backupDir, dirs.logsDir].forEach((path) => mkdirSync(path, { recursive: true }));
  const persistencePort = openDesktopPersistencePort(dirs) as any;
  const asrManifest = loadAsrManifestJson();
  const qwenAsrManifest = loadQwenAsrManifestJson();
  const appSettingsDefaults = {
    schemaVersion: 1,
    startupPage: "resume",
    translationProvider: null,
    translationModel: null,
    asrDefaultModelId: "small",
    asrVad: DEFAULT_ASR_VAD_SETTINGS,
    asrVocalSeparation: "off",
    asrSongHandling: "preserve",
    cachePath: dirs.cacheDir,
    modelPath: dirs.modelDir,
    backupPath: dirs.backupDir,
    downloadSource: "official",
    customDownloadUrl: "",
    notifications: { taskDone: true, error: true, release: true, system: true },
  };
  const appSettingsService = createAppSettingsService({ repository: persistencePort, defaults: appSettingsDefaults, protectedRoots: [dirs.projectsDir] });
  let effectiveAppSettings = appSettingsService.get();
  try {
    effectiveAppSettings = await appSettingsService.validate(effectiveAppSettings);
  } catch {
    effectiveAppSettings = appSettingsDefaults;
  }
  const structuredLogger = createStructuredLogger({ logsDir: dirs.logsDir });
  const asrRoots = resolveAsrRoots(effectiveAppSettings.modelPath);
  const openDownload = async ({ url, headers, signal }: { url: string; headers: Record<string, string>; signal: AbortSignal }) => {
    const response = await net.fetch(url, { method: "GET", headers, signal, redirect: "follow" });
    return { status: response.status, headers: response.headers, body: response.body };
  };
  let asrProjectService: any = null;
  const whisperRuntimePort = createAsrRuntimePort({
    manifest: asrManifest,
    appOwnedRoot: asrRoots.appOwnedRoot,
    bundledRuntimeRoot: asrRoots.bundledRuntimeRoot,
    platform: process.platform,
    arch: process.arch,
  });
  const qwenRuntimePort = createQwenRuntimePort({
    manifest: qwenAsrManifest,
    appOwnedRoot: asrRoots.appOwnedRoot,
    resourceRoot: asrRoots.qwenResourceRoot,
    platform: process.platform,
    arch: process.arch,
  });
  const asrRuntimePort = createUnifiedAsrRuntimePort({ whisper: whisperRuntimePort, qwen: qwenRuntimePort });
  const whisperModelInstaller = createModelInstaller({
    manifest: asrManifest,
    appOwnedRoot: asrRoots.appOwnedRoot,
    trustedNoticeRoot: asrRoots.trustedNoticeRoot,
    bundledVadRoot: asrRoots.bundledVadRoot,
    openDownload,
    getDownloadSettings: () => appSettingsService.get(),
    isAssetInUse: () => Boolean(asrProjectService?.isBusy()) || Boolean(taskSupervisorClient?.isAsrBusy()),
    selectImportFile: async ({ assetId, extensions }: { assetId: string; extensions: string[] }) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const isRuntime = assetId === "whisper-cpp-cuda-12.4-x64" && extensions.length === 1 && extensions[0] === "zip";
      const result = await dialog.showOpenDialog(win, {
        title: isRuntime ? "导入 Whisper CUDA 运行时" : `导入 Whisper ${assetId} 模型`,
        properties: ["openFile"],
        filters: [{ name: isRuntime ? "Whisper CUDA runtime" : "Whisper model", extensions: isRuntime ? ["zip"] : ["bin"] }],
      });
      return result.canceled || !result.filePaths[0]
        ? { canceled: true }
        : { canceled: false, filePath: result.filePaths[0] };
    },
  });
  await whisperModelInstaller.reconcile();
  const workerEntry = resolveWorkerEntry("task-supervisor-entry.mjs");
  taskSupervisorClient = createTaskSupervisorClient({
    entryPath: workerEntry,
    useFakeProvider: process.env.TRANSLATION_FAKE_PROVIDER === "1",
    fakeFailureLanguage: process.env.TRANSLATION_FAKE_FAIL_LANGUAGE,
    fakeDelayMs: Number(process.env.TRANSLATION_FAKE_DELAY_MS ?? 0),
    killProcessTree: killAsrProcessTree,
    onCrash: () => {
      for (const task of taskCoordinator?.reconcileInterrupted() ?? []) {
        taskEventPublisher.publish({
          type: "status",
          taskId: task.id,
          projectId: task.projectId,
          stage: task.stage,
          sequence: task.sequence,
          timestamp: task.updatedAt,
          status: task.status,
          progress: task.progress,
          checkpointStage: task.checkpointStage ?? undefined,
          errorCode: task.lastErrorCode ?? undefined,
        });
      }
    },
    onEvent: (event) => {
      const accepted = taskCoordinator?.acceptEvent(event);
      if (accepted?.accepted) taskEventPublisher.publish(event as any);
    },
    forkWorker: () =>
      utilityProcess.fork(workerEntry, [], {
        serviceName: "Task Supervisor",
        stdio: "ignore",
        env: workerEnvironment(),
      }),
  });

  const qwenModelInstaller = createQwenInstaller({
    manifest: qwenAsrManifest,
    appOwnedRoot: asrRoots.appOwnedRoot,
    trustedNoticeRoot: asrRoots.trustedNoticeRoot,
    resourceRoot: asrRoots.qwenResourceRoot,
    openDownload,
    isAssetInUse: () => Boolean(asrProjectService?.isBusy()) || Boolean(taskSupervisorClient?.isAsrBusy()),
    runProcess: (payload: Record<string, unknown>) => taskSupervisorClient!.runMediaProcess(payload),
    cancelProcess: ({ operationId }: { operationId: string }) => taskSupervisorClient!.cancelMedia({ operationId }),
  });
  const asrModelInstaller = createUnifiedAsrInstaller({ whisper: whisperModelInstaller, qwen: qwenModelInstaller });
  await qwenModelInstaller.reconcile();

  const asrDeviceSelector = createAsrDeviceSelector({
    getCapabilityStatus: () => asrRuntimePort.getCapabilityStatus(),
    resolveRuntime: (device: "cpu" | "cuda", modelId: AsrModelId) => asrRuntimePort.resolveReadyRuntime(device, modelId),
    resolveProbeRuntime: (device: "cpu" | "cuda", modelId: AsrModelId) => asrRuntimePort.resolveReadyRuntimeForProbe(device, modelId),
    probeRuntime: ({ operationId, runtime }: { operationId: string; runtime: Record<string, unknown> }) =>
      taskSupervisorClient!.probeAsrRuntime({ operationId, runtime }),
    cancelProbe: ({ operationId }: { operationId: string }) => taskSupervisorClient!.cancelAsr({ operationId }),
    getDefaultModelId: () => appSettingsService.get().asrDefaultModelId,
    loadState: () => persistencePort.loadAsrDeviceState(),
    saveState: (state: Record<string, unknown>) => persistencePort.saveAsrDeviceState(state),
  });
  const openRepos = new Map<string, any>();
  const getProjectRepository = (projectId: string, options: { create?: boolean } = {}) => {
    if (openRepos.has(projectId)) return openRepos.get(projectId);
    const containerDir = join(dirs.projectsDir, projectId);
    if (!options.create && !existsSync(join(containerDir, "project.sqlite"))) {
      const error = new Error("Project not found");
      // @ts-expect-error code
      error.code = "NOT_FOUND";
      throw error;
    }
    const repo = openProjectRepository(containerDir, {
      migrationsDir: dirs.projectMigrationsDir,
    }) as any;
    openRepos.set(projectId, repo);
    return repo;
  };
  taskCoordinator = createTaskCoordinator({
    queueRepository: persistencePort,
    appendHistory: (task: any) => {
      try {
        getProjectRepository(task.projectId).appendTaskHistory({
          ...task,
          id: `${task.id}:${task.sequence}`,
          queueTaskId: task.id,
          recordedAt: task.updatedAt,
        });
      } catch {
        // The app queue remains authoritative if a project was removed externally.
      }
    },
  });
  taskCoordinator.reconcileInterrupted();

  const mediaService = createMediaService({
    resolveArtifacts: () => {
      const roots = resolveFfmpegRoots();
      const manifest = loadFfmpegManifestJson();
      return resolveVerifiedArtifactPaths(manifest, { artifactRootDir: roots.artifactRootDir });
    },
    getProjectRepository,
    runProcess: (payload: Record<string, unknown>) =>
      taskSupervisorClient!.runMediaProcess(payload).then((result) => ({
        ...result,
        stdout: Buffer.from(result.stdoutBase64, "base64"),
      })),
    cancelProcess: (operationId: string) => taskSupervisorClient!.cancelMedia({ operationId }),
    persistProject: (project: any) => {
      persistencePort.saveProject(project);
      persistencePort.captureInitialProjectResources(project.id, project.config);
    },
    persistBatchProjects: (entries: Array<Record<string, unknown>>) =>
      persistencePort.createProjects(entries),
    openFileDialog: async ({ title, filters }: { title: string; filters: any[] }) => {
      const e2eFixture = process.env.MEDIA_E2E_FIXTURE_PATH;
      if (e2eFixture && existsSync(e2eFixture)) {
        return { canceled: false, filePath: e2eFixture };
      }
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const result = await dialog.showOpenDialog(win, {
        title,
        properties: ["openFile"],
        filters,
      });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      return { canceled: false, filePath: result.filePaths[0] };
    },
  });

  const runMediaProcess = (payload: Record<string, unknown>) =>
    taskSupervisorClient!.runMediaProcess(payload).then((result) => ({
      ...result,
      stdout: Buffer.from(result.stdoutBase64, "base64"),
    }));
  const resolveFfmpegArtifacts = () => {
    const roots = resolveFfmpegRoots();
    return resolveVerifiedArtifactPaths(loadFfmpegManifestJson(), { artifactRootDir: roots.artifactRootDir });
  };
  const songClassifierSidecarPath = join(asrRoots.qwenResourceRoot, "backend", "audio", "song-classifier-sidecar.py");
  const songClassifierInstaller = createSongClassifierInstaller({
    appOwnedRoot: asrRoots.appOwnedRoot,
    qwenRuntimeId: qwenAsrManifest.runtime.id,
    sidecarPath: songClassifierSidecarPath,
    openDownload,
    runProcess: runMediaProcess,
    cancelProcess: ({ operationId }: { operationId: string }) => taskSupervisorClient!.cancelMedia({ operationId }),
    isInUse: () => Boolean(asrProjectService?.isBusy()),
  });
  const songClassifierProcess = createSongClassifierProcess({
    runProcess: runMediaProcess,
    cancelProcess: ({ operationId }: { operationId: string }) => taskSupervisorClient!.cancelMedia({ operationId }),
  });
  const getAsrCapabilityStatus = async () => ({
    ...await asrRuntimePort.getCapabilityStatus(),
    songClassifier: await songClassifierInstaller.getStatus(),
  });
  const vocalSeparationProcess = createVocalSeparationProcess({
    runProcess: runMediaProcess,
    cancelProcess: ({ operationId }: { operationId: string }) => taskSupervisorClient!.cancelMedia({ operationId }),
  });
  const resolveVocalSeparationRuntime = ({
    ffmpegPath,
    device,
  }: { ffmpegPath: string; device: "cpu" | "cuda" }) => {
    if (device !== "cpu" && device !== "cuda") throw new Error("Invalid vocal separation device");
    const scriptsDir = join(
      asrRoots.appOwnedRoot,
      "runtimes",
      qwenAsrManifest.runtime.id,
      "venv",
      "Scripts",
    );
    const modelDir = join(asrRoots.appOwnedRoot, "auxiliary", VOCAL_SEPARATION_IDENTITY.modelId);
    return {
      engineId: VOCAL_SEPARATION_IDENTITY.engineId,
      engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
      executablePath: join(scriptsDir, "audio-separator.exe"),
      cwd: scriptsDir,
      ffmpegPath,
      modelId: VOCAL_SEPARATION_IDENTITY.modelId,
      modelRevision: VOCAL_SEPARATION_IDENTITY.modelRevision,
      modelHash: VOCAL_SEPARATION_IDENTITY.modelSha256,
      modelSizeBytes: VOCAL_SEPARATION_IDENTITY.modelSizeBytes,
      modelDir,
      modelPath: join(modelDir, VOCAL_SEPARATION_IDENTITY.modelFileName),
      configHash: VOCAL_SEPARATION_IDENTITY.configSha256,
      configSizeBytes: VOCAL_SEPARATION_IDENTITY.configSizeBytes,
      configPath: join(modelDir, VOCAL_SEPARATION_IDENTITY.configFileName),
      device,
    };
  };
  const videoExportService = createVideoExportService({
    getProjectRepository,
    resolveMediaPath: (projectId: string) => mediaService.resolveMediaAbsolutePath(projectId),
    resolveFfmpegArtifacts,
    runProcess: runMediaProcess,
    cancelProcess: (operationId: string) => taskSupervisorClient!.cancelMedia({ operationId }),
    selectOutputFile: async ({ suggestedName }: { suggestedName: string }) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const result = await dialog.showSaveDialog(win, {
        title: "选择翻译视频保存位置",
        defaultPath: join(app.getPath("documents"), suggestedName),
        filters: [{ name: "Matroska 视频", extensions: ["mkv"] }],
      });
      return result.canceled || !result.filePath
        ? { canceled: true }
        : { canceled: false, filePath: result.filePath };
    },
    revealOutputFile: (path: string) => shell.showItemInFolder(path),
  });
  const audioSeparationService = createAudioSeparationService({
    getProjectRepository,
    resolveMediaPath: (projectId: string) => mediaService.resolveMediaAbsolutePath(projectId),
    capabilityProvider: () => ({
      available: false,
      workerId: null,
      modelVersion: null,
      reason: "worker_not_installed",
    }),
    runWorker: async () => {
      const error = new Error("Audio separation worker is not installed");
      // @ts-expect-error code
      error.code = "NOT_AVAILABLE";
      throw error;
    },
  });
  const asrService = createAsrService({
    getProjectRepository,
    resolveMediaPath: (projectId: string) => mediaService.resolveMediaAbsolutePath(projectId),
    resolveFfmpegArtifacts,
    getAsrCapabilityStatus,
    getDefaultModelId: () => appSettingsService.get().asrDefaultModelId,
    getVadSettings: () => appSettingsService.get().asrVad,
    getVocalSeparationSettings: () => appSettingsService.get().asrVocalSeparation,
    getSongHandlingSettings: () => appSettingsService.get().asrSongHandling,
    vocalSeparation: {
      resolveRuntime: resolveVocalSeparationRuntime,
      probe: (payload: Record<string, unknown>) => vocalSeparationProcess.probe(payload),
      separate: (payload: Record<string, unknown>) => vocalSeparationProcess.separate(payload),
      cancel: (operationId: string) => vocalSeparationProcess.cancel(operationId),
    },
    songClassifier: {
      resolveRuntime: ({ device }: { device: "cpu" | "cuda" }) => songClassifierInstaller.resolveRuntime({ device }),
      probe: (payload: Record<string, unknown>) => songClassifierProcess.probe(payload),
      classify: (payload: Record<string, unknown>) => songClassifierProcess.classify(payload),
      cancel: (operationId: string) => songClassifierProcess.cancel(operationId),
    },
    runMediaProcess,
    cancelMediaProcess: (operationId: string) => taskSupervisorClient!.cancelMedia({ operationId }),
    deviceSelector: asrDeviceSelector,
    transcribe: (payload: Record<string, unknown>) => taskSupervisorClient!.transcribeAsr(payload as any),
    cancelTranscription: (operationId: string) => taskSupervisorClient!.cancelAsr({ operationId }),
  });
  const asrCandidateService = createAsrCandidateService({ getProjectRepository });
  const asrLanguageRegionDetector = createAsrLanguageRegionDetector({
    getProjectRepository,
    resolveMediaPath: (projectId: string) => mediaService.resolveMediaAbsolutePath(projectId),
    resolveFfmpegArtifacts,
    runMediaProcess,
    cancelMediaProcess: (operationId: string) => taskSupervisorClient!.cancelMedia({ operationId }),
    deviceSelector: asrDeviceSelector,
    detectLanguageRegion: (payload: Record<string, unknown>) => taskSupervisorClient!.detectAsrLanguageRegion(payload as any),
    cancelDetection: (operationId: string) => taskSupervisorClient!.cancelAsr({ operationId }),
  });
  const asrLanguageService = createAsrLanguageService({
    getProjectRepository,
    detectRegion: (payload: Record<string, unknown>) => asrLanguageRegionDetector.detectRegion(payload),
  });
  asrProjectService = createAsrProjectService({
    getProjectRepository,
    getCapabilityStatus: getAsrCapabilityStatus,
    getDeviceStatus: () => asrDeviceSelector.getStatus(),
    asrService,
    candidateService: asrCandidateService,
    languageService: asrLanguageService,
    languageRegionDetector: asrLanguageRegionDetector,
    persistProject: (project: any) => persistencePort.refreshProjectIndex(project),
  });

  const asrInfoUrls = Object.freeze({
    "engine-source": "https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1",
    "engine-license": "https://github.com/ggml-org/whisper.cpp/blob/f049fff95a089aa9969deb009cdd4892b3e74916/LICENSE",
    "model-license": "https://github.com/openai/whisper/blob/main/LICENSE",
    "vad-source": asrManifest.vadModel?.sourceUrl.replace("/resolve/", "/blob/"),
    "vad-license": asrManifest.vadModel?.licenseUrl,
  });
  const openAsrInfo = async ({ target, modelId = "small" }: AsrInfoOpenRequest) => {
    const qwen = modelId.startsWith("qwen3-asr-");
    const selectedModel = (qwen ? qwenAsrManifest : asrManifest).models.find((model: { id: string }) => model.id === modelId);
    const href = target === "model-source"
      ? qwen ? selectedModel?.sourceBaseUrl.replace("/resolve/", "/tree/") : selectedModel?.sourceUrl.replace("/resolve/", "/blob/")
      : target === "model-license" && qwen ? qwenAsrManifest.engine.licenseUrl
      : target === "engine-source" && qwen ? qwenAsrManifest.engine.sourceUrl
      : target === "engine-license" && qwen ? qwenAsrManifest.engine.licenseUrl
      : asrInfoUrls[target];
    if (!href) throw new Error("ASR information target is not trusted");
    const url = new URL(href);
    if (url.protocol !== "https:" || !["github.com", "huggingface.co"].includes(url.hostname)) {
      throw new Error("ASR information target is not trusted");
    }
    await shell.openExternal(url.href);
    return { opened: true };
  };

  const capabilityService = createCapabilityService({
    getAsrCapability: getAsrCapabilityStatus,
    getProviderReadinesses: () => (
      TRANSLATION_PROVIDER_CATALOG
        .filter((provider) => provider.v1TranslationEnabled)
        .map((provider) => persistencePort.loadProviderReadiness(provider.id))
        .filter(Boolean)
    ),
    getAudioSeparationCapability: () => audioSeparationService.getCapability(),
    getVideoCapability: () => {
      try {
        resolveFfmpegArtifacts();
        return { available: true };
      } catch {
        return { available: false, reason: "FFmpeg 运行时校验失败" };
      }
    },
    getProject: (projectId: string) => persistencePort.openProject(projectId),
  });
  const backupService = createBackupService({
    backupPath: () => appSettingsService.get().backupPath,
    projectsDir: dirs.projectsDir,
    getAppState: () => ({ settings: appSettingsService.get(), resources: persistencePort.listResources() }),
    restoreAppState: async (state: any) => {
      const settings = await appSettingsService.validate(state.settings);
      return persistencePort.restoreAppState({ ...state, settings });
    },
    selectBackupFile: async ({ kind }: { kind: "app" | "project" }) => {
      const e2eBackupPath = process.env.PHASE14_E2E_BACKUP_RESTORE_PATH;
      if (kind === "app" && process.env.TRANSLATION_FAKE_PROVIDER === "1" && e2eBackupPath && existsSync(e2eBackupPath)) {
        return { canceled: false, filePath: e2eBackupPath };
      }
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const result = await dialog.showOpenDialog(win, {
        title: kind === "app" ? "选择应用备份" : "选择项目备份",
        defaultPath: appSettingsService.get().backupPath,
        properties: ["openFile"],
        filters: kind === "app"
          ? [{ name: "AI Translator app backup", extensions: ["json"] }]
          : [{ name: "AI Translator project backup", extensions: ["zip"] }],
      });
      return result.canceled || !result.filePaths[0] ? { canceled: true } : { canceled: false, filePath: result.filePaths[0] };
    },
    beforeProjectRestore: (projectId: string) => {
      openRepos.get(projectId)?.close?.();
      openRepos.delete(projectId);
    },
    onProjectRestored: (projectId: string) => {
      persistencePort.openProjectFromContainer(projectId);
      persistencePort.rebuildProjectIndex();
    },
  });
  const diagnosticsService = createDiagnosticsService({
    logsDir: dirs.logsDir,
    getCapabilities: () => capabilityService.getStatus(),
    getSettingsSummary: () => {
      const settings = appSettingsService.get();
      return {
        schemaVersion: settings.schemaVersion,
        startupPage: settings.startupPage,
        downloadSource: settings.downloadSource,
        notifications: settings.notifications,
      };
    },
    runtimeInfo: { platform: process.platform, arch: process.arch, version: app.getVersion() },
    selectOutputFile: async ({ suggestedName }: { suggestedName: string }) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const result = await dialog.showSaveDialog(win, {
        title: "导出脱敏诊断包",
        defaultPath: join(appSettingsService.get().backupPath, suggestedName),
        filters: [{ name: "AI Translator diagnostics", extensions: ["json"] }],
      });
      return result.canceled || !result.filePath ? { canceled: true } : { canceled: false, filePath: result.filePath };
    },
  });

  const issueMediaPreviewUrl = ({
    projectId,
    assetId,
    webContentsId,
  }: {
    projectId: string;
    assetId: string;
    webContentsId: number;
  }) => {
    const absolutePath = mediaService.resolveMediaAbsolutePath(projectId);
    if (!absolutePath) {
      const error = new Error("Media source is missing");
      // @ts-expect-error code
      error.code = "NOT_FOUND";
      throw error;
    }
    const project = getProjectRepository(projectId).loadProject();
    const issued = issueMediaGrant({
      projectId,
      assetId,
      absolutePath,
      webContentsId,
      mimeType: undefined,
    });
    return {
      ...issued,
      mediaKind: project?.mediaKind || "unknown",
    };
  };

  protocol.handle("app-media", (request) => handleMediaProtocolRequest(request));

  let modelTransferActive = false;
  let modelTransferSelection: { token: string; path: string } | null = null;
  let latestModelTransferProgress: Record<string, unknown> | null = null;
  ipcAdapter = createIpcAdapter({
    openDesktopPersistencePort,
    openCredentialStore,
    openProjectRepository,
    createDesktopTranslationPort,
    translationWorkerClient: taskSupervisorClient,
    mediaService,
    videoExportService,
    audioSeparationService,
    asrRuntimePort,
    getAsrCapabilityStatus,
    asrModelInstaller,
    songClassifierInstaller,
    asrDeviceSelector,
    asrProjectService,
    taskCoordinator,
    publishWorkerEvent: (event: any) => taskEventPublisher.publish(event),
    openAsrInfo,
    issueMediaPreviewUrl,
    onBeforePermanentProjectDelete: (projectId: string) => {
      openRepos.get(projectId)?.close?.();
      openRepos.delete(projectId);
    },
    persistencePort,
    safeStorage,
    allowLoopbackHttp:
      Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.TRANSLATION_FAKE_PROVIDER === "1",
    ...dirs,
    getMainWindow: () => mainWindow,
    requestCloseAfterFlush,
    appSettingsService,
    capabilityService,
    backupService,
    diagnosticsService,
    structuredLogger,
    showItemInFolder: (path: string) => shell.showItemInFolder(path),
    selectSettingsDirectory: async (pathKey: AppStoragePathKey) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const titles: Record<AppStoragePathKey, string> = {
        cachePath: "选择缓存目录",
        backupPath: "选择备份目录",
      };
      const result = await dialog.showOpenDialog(win, {
        title: titles[pathKey],
        defaultPath: appSettingsService.get()[pathKey],
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled || !result.filePaths[0]
        ? { canceled: true }
        : { canceled: false, directoryPath: result.filePaths[0] };
    },
    selectModelStorageDestination: async () => {
      if (modelTransferActive) throw Object.assign(new Error("模型转移期间不能更换目标目录"), { code: "CONFLICT" });
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const result = await dialog.showOpenDialog(win, {
        title: "选择模型转移目录（必须为空）",
        defaultPath: dirname(appSettingsService.get().modelPath),
        properties: ["openDirectory", "createDirectory"],
      });
      const directoryPath = result.filePaths[0];
      if (result.canceled || !directoryPath) return { canceled: true };
      modelTransferSelection = { token: randomUUID(), path: directoryPath };
      return { canceled: false, directoryPath, selectionToken: modelTransferSelection.token };
    },
    transferModelStorage: async (selectionToken: string) => {
      if (modelTransferActive) throw Object.assign(new Error("已有模型转移正在进行"), { code: "CONFLICT" });
      const selected = modelTransferSelection;
      if (!selected || selected.token !== selectionToken) {
        throw Object.assign(new Error("模型转移目录选择已失效，请重新选择"), { code: "NOT_FOUND" });
      }
      if (
        ipcAdapter?.hasActiveTasks()
        || asrProjectService?.isBusy()
        || taskSupervisorClient?.isAsrBusy()
        || asrModelInstaller.getDownloadStatus?.().some((item: any) => item.status === "active")
        || songClassifierInstaller.getDownloadStatus?.().some((item: any) => item.status === "active")
      ) {
        throw Object.assign(new Error("请先停止正在运行的任务和模型下载，再转移模型"), { code: "CONFLICT" });
      }
      const current = appSettingsService.get();
      const win = mainWindow;
      if (!win || win.isDestroyed()) throw Object.assign(new Error("设置窗口不可用"), { code: "NOT_AVAILABLE" });
      const destinationPath = selected.path;
      modelTransferActive = true;
      latestModelTransferProgress = null;
      try {
        const result = await transferModelStorage({
          sourceRoot: current.modelPath,
          destinationRoot: destinationPath,
          commit: async () => {
            const latest = appSettingsService.get();
            if (latest.modelPath !== current.modelPath) {
              throw Object.assign(new Error("模型目录在转移过程中被其他设置修改"), { code: "CONFLICT" });
            }
            await appSettingsService.relocateModelPath(destinationPath);
          },
          onProgress: (progress: Record<string, unknown>) => {
            latestModelTransferProgress = progress;
            if (!win.isDestroyed()) win.webContents.send(DESKTOP_MODEL_STORAGE_TRANSFER_CHANNEL, progress);
          },
        });
        modelTransferSelection = null;
        setTimeout(() => {
          app.relaunch();
          void requestCloseAfterFlush();
        }, 2_500);
        return { destinationPath, ...result };
      } catch (error) {
        const previous = latestModelTransferProgress as any;
        if (!win.isDestroyed()) win.webContents.send(DESKTOP_MODEL_STORAGE_TRANSFER_CHANNEL, {
          stage: "failed",
          progress: previous?.progress ?? 0,
          message: "转移失败，旧模型目录未被改动。",
          processedBytes: previous?.processedBytes ?? 0,
          totalBytes: previous?.totalBytes ?? 0,
        });
        throw error;
      } finally {
        modelTransferActive = false;
      }
    },
    selectSubtitleExportDirectory: async () => {
      const e2eExportDir = process.env.SUBTITLE_E2E_EXPORT_DIR;
      if (e2eExportDir) return { canceled: false, directoryPath: e2eExportDir };
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const result = await dialog.showOpenDialog(win, {
        title: "选择字幕保存文件夹",
        defaultPath: app.getPath("documents"),
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled || !result.filePaths[0]
        ? { canceled: true }
        : { canceled: false, directoryPath: result.filePaths[0] };
    },
    selectSourceSubtitleFile: async ({ projectId, mode, format }: { projectId: string; mode: "raw" | "normalized"; format?: string }) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const project = persistencePort.openProject(projectId);
      const sourceName = project?.sourceFileName || "source.srt";
      const suggestedName = mode === "raw"
        ? sourceName
        : `${sourceName.replace(/\.[^.]+$/, "")}.${format || "srt"}`;
      const e2eExportDir = process.env.SUBTITLE_E2E_EXPORT_DIR;
      if (e2eExportDir) return { canceled: false, filePath: join(e2eExportDir, suggestedName) };
      const result = await dialog.showSaveDialog(win, {
        title: "选择源字幕保存位置",
        defaultPath: join(app.getPath("documents"), suggestedName),
        ...(mode === "normalized" && format
          ? { filters: [{ name: "字幕文件", extensions: [format] }] }
          : {}),
      });
      return result.canceled || !result.filePath
        ? { canceled: true }
        : { canceled: false, filePath: result.filePath };
    },
    selectAudioExportFile: async ({ projectId }: { projectId: string }) => {
      const project = persistencePort.openProject(projectId);
      const sourceName = project?.sourceFileName || "source";
      const suggestedName = `${sourceName.replace(/\.[^.]+$/, "")}-audio.wav`;
      const e2eExportPath = process.env.MEDIA_AUDIO_E2E_EXPORT_PATH;
      if (e2eExportPath) return { canceled: false, filePath: e2eExportPath };
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { canceled: true };
      const result = await dialog.showSaveDialog(win, {
        title: "选择音频保存位置",
        defaultPath: join(app.getPath("documents"), suggestedName),
        filters: [{ name: "WAV 音频", extensions: ["wav"] }],
      });
      return result.canceled || !result.filePath
        ? { canceled: true }
        : { canceled: false, filePath: result.filePath };
    },
  });

  try {
    ipcAdapter.reconcileProjectIndex();
  } catch {
    // Diagnostics only; startup continues with empty/partial index.
  }

  ipcMain.handle(DESKTOP_API_CHANNEL, async (event: IpcMainInvokeEvent, envelope: unknown) => {
    return ipcAdapter!.handle(event, envelope);
  });

  registerSessionGuards();
  createMainWindow();
}

app.whenReady().then(() => {
  void bootstrap();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function closeSynchronousMainServices() {
  ipcAdapter?.close();
  ipcAdapter = null;
  taskCoordinator = null;
  taskEventPublisher.close();
  tray?.destroy();
  tray = null;
}

app.on("before-quit", (event) => {
  if (appShutdownComplete) {
    closeSynchronousMainServices();
    return;
  }
  event.preventDefault();
  if (appShutdownInProgress) return;
  appShutdownInProgress = true;
  const supervisor = taskSupervisorClient;
  taskSupervisorClient = null;
  const adapter = ipcAdapter;
  void (async () => {
    await adapter?.stopActiveTasks();
    closeSynchronousMainServices();
    if (supervisor) await supervisor.close();
    appShutdownComplete = true;
    app.quit();
  })();
});
