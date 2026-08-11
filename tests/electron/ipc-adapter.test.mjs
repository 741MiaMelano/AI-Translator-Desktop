import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createIpcAdapter, translationTaskError } from "../../electron/ipc/adapter.mjs";
import { createBackupService } from "../../backend/backup/backup-service.mjs";
import { openDesktopPersistencePort } from "../../backend/persistence/desktop-persistence-port.mjs";
import { openAppRepository } from "../../backend/persistence/app-repository.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import { createTaskCoordinator } from "../../backend/tasks/task-coordinator.mjs";
import {
  createMemorySafeStorage,
  createUnavailableSafeStorage,
  openCredentialStore,
} from "../../backend/credentials/credential-store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const appMigrationsDir = join(root, "migrations", "app");
const projectMigrationsDir = join(root, "migrations", "project");

test("partial translation outcomes fail the durable root task without automatic retry", () => {
  assert.equal(translationTaskError([{ status: "completed" }]), null);

  const providerFailure = translationTaskError([
    { status: "completed", targetLanguage: "zh-CN" },
    { status: "failed", targetLanguage: "ja-JP", errorClass: "server" },
  ]);
  assert.equal(providerFailure.code, "PROVIDER_SERVER");
  assert.equal(providerFailure.retryable, true);

  const authFailure = translationTaskError([
    { status: "failed", targetLanguage: "zh-CN", errorClass: "auth" },
  ]);
  assert.equal(authFailure.retryable, false);

  const schemaFailure = translationTaskError([
    { status: "failed", targetLanguage: "zh-CN", errorClass: "schema_mismatch" },
  ]);
  assert.equal(schemaFailure.retryable, true);
});

const baseProject = {
  id: "project-adapter-1",
  title: "Adapter Project",
  sourceFileName: "clip.srt",
  mediaKind: "subtitle",
  noSourceMedia: true,
  lifecycle: "draft",
  createdAt: "2026-07-13 11:00",
  updatedAt: "2026-07-13 11:00",
  activeSourceTrackId: "source-adapter",
  pendingConfirmations: [],
  notes: [],
  config: {
    sourceLanguage: "auto",
    targetLanguages: ["zh-CN"],
    provider: "OpenAI",
    model: "GPT-4.1",
    glossary: "g",
    styleGuide: "s",
    outputFormat: "SRT",
    burnVideo: false,
    copyMediaIntoProject: false,
  },
  sourceTracks: [
    {
      id: "source-adapter",
      label: "Main",
      kind: "external_subtitle",
      languageState: "pending",
      defaultLanguage: "auto",
      isActive: true,
      summary: "s",
      segments: [
        {
          id: "seg-1",
          start: "00:00:01,000",
          end: "00:00:02,000",
          sourceLanguage: "auto",
          sourceText: { original: "hello", normalized: "hello" },
          targetTexts: {
            "zh-CN": { model: "nihao", postProcessed: "nihao", qaFlags: [] },
          },
        },
      ],
      targetTracks: [
        {
          id: "target-zh",
          languageCode: "zh-CN",
          languageLabel: "Chinese",
          status: "draft",
          isActive: true,
          qaIssues: [],
          snapshotIds: [],
          deliveryLabel: "draft",
          lastHumanAction: "none",
        },
      ],
    },
  ],
  recentRunIds: [],
};

function makeAdapter(openPort = openDesktopPersistencePort, options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "p02-adapter-"));
  const fakeMainFrame = { url: "file:///app/index.html" };
  const fakeWebContents = { id: 1, mainFrame: fakeMainFrame };
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: fakeWebContents,
    minimize() {},
    maximize() {},
    unmaximize() {},
    isMaximized: () => false,
    destroy() {},
  };
  const adapter = createIpcAdapter({
    openDesktopPersistencePort: openPort,
    openCredentialStore: options.openCredentialStore ?? openCredentialStore,
    safeStorage: options.safeStorage ?? createMemorySafeStorage(),
    appDir: join(rootDir, "app"),
    projectsDir: join(rootDir, "projects"),
    appMigrationsDir,
    projectMigrationsDir,
    mediaService: options.mediaService,
    asrRuntimePort: options.asrRuntimePort,
    asrModelInstaller: options.asrModelInstaller,
    songClassifierInstaller: options.songClassifierInstaller,
    asrDeviceSelector: options.asrDeviceSelector,
    asrProjectService: options.asrProjectService,
    taskCoordinator: options.taskCoordinator,
    taskService: options.taskService,
    publishWorkerEvent: options.publishWorkerEvent,
    openAsrInfo: options.openAsrInfo,
    onBeforePermanentProjectDelete: options.onBeforePermanentProjectDelete,
    appSettingsService: options.appSettingsService,
    capabilityService: options.capabilityService,
    backupService: options.backupService,
    diagnosticsService: options.diagnosticsService,
    structuredLogger: options.structuredLogger,
    showItemInFolder: options.showItemInFolder,
    selectSettingsDirectory: options.selectSettingsDirectory,
    selectModelStorageDestination: options.selectModelStorageDestination,
    transferModelStorage: options.transferModelStorage,
    selectSubtitleExportDirectory: options.selectSubtitleExportDirectory,
    selectSourceSubtitleFile: options.selectSourceSubtitleFile,
    getMainWindow: () => fakeWindow,
    requestCloseAfterFlush: () => {
      fakeWindow.destroy();
    },
  });
  return {
    adapter,
    rootDir,
    event: { sender: fakeWebContents, senderFrame: fakeMainFrame },
    cleanup: () => {
      adapter.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

test("Phase 12 services cross the validated adapter without exposing private paths", async () => {
  const calls = [];
  const settings = {
    schemaVersion: 1,
    startupPage: "resume",
    translationProvider: null,
    translationModel: null,
    asrDefaultModelId: "small",
    asrVad: {
      mode: "auto",
      customParameters: { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100, maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1 },
    },
    asrVocalSeparation: "off",
    asrSongHandling: "preserve",
    cachePath: "C:\\private\\cache",
    modelPath: "C:\\private\\models",
    backupPath: "C:\\private\\backups",
    downloadSource: "official",
    customDownloadUrl: "",
    notifications: { taskDone: true, error: true, release: true, system: true },
  };
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    capabilityService: { getStatus: async (request) => ({ probedAt: "now", request, global: { capabilities: [] } }) },
    appSettingsService: {
      get: () => settings,
      save: async (value) => { calls.push(["settings", value]); return value; },
      reset: async () => settings,
    },
    backupService: {
      createAppBackup: () => ({ fileName: "backup.json", sizeBytes: 1, sha256: "a".repeat(64) }),
      selectRestore: async (request) => ({ kind: request.kind, token: "restore-token", fileName: "backup.json", summary: {} }),
      restore: async (request) => ({ restored: request.userConfirmed }),
    },
    diagnosticsService: {
      preview: async () => ({ createdAt: "now", totalBytes: 2, entries: [{ name: "logs.json", content: "[]" }] }),
      exportPackage: async () => ({ canceled: false, fileName: "support.json", sizeBytes: 2 }),
    },
    selectSettingsDirectory: async (pathKey) => ({ canceled: false, directoryPath: `C:\\selected\\${pathKey}` }),
    selectModelStorageDestination: async () => ({ canceled: false, directoryPath: "C:\\selected\\models", selectionToken: "12345678-1234-1234-1234-123456789abc" }),
    transferModelStorage: async () => ({ destinationPath: "C:\\selected\\models", fileCount: 2, sizeBytes: 10, oldDirectoryRemoved: true }),
  });
  try {
    for (const envelope of [
      { method: "capability.status", request: { projectId: baseProject.id } },
      { method: "settings.get", request: {} },
      { method: "settings.selectDirectory", request: { pathKey: "cachePath" } },
      { method: "settings.selectModelStorageDestination", request: {} },
      { method: "settings.transferModelStorage", request: { selectionToken: "12345678-1234-1234-1234-123456789abc" } },
      { method: "settings.save", request: { settings } },
      { method: "settings.reset", request: {} },
      { method: "backup.app.create", request: {} },
      { method: "backup.restore.select", request: { kind: "app" } },
      { method: "backup.restore.apply", request: { token: "restore-token", userConfirmed: true } },
      { method: "diagnostics.preview", request: {} },
      { method: "diagnostics.export", request: {} },
    ]) {
      const result = await adapter.handle(event, envelope);
      assert.equal(result.ok, true, `${envelope.method}: ${JSON.stringify(result)}`);
    }
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test("settings project backup uses the configured backup directory without exposing its path", async () => {
  const backupRoot = mkdtempSync(join(tmpdir(), "phase12-ipc-project-backup-"));
  const revealed = [];
  const { adapter, event, rootDir, cleanup } = makeAdapter(openDesktopPersistencePort, {
    appSettingsService: { get: () => ({ backupPath: backupRoot }) },
    showItemInFolder: (path) => revealed.push(path),
  });
  try {
    assert.equal((await adapter.handle(event, {
      method: "project.create",
      request: { project: baseProject },
    })).ok, true);
    const result = await adapter.handle(event, {
      method: "project.package",
      request: { projectId: baseProject.id, kind: "archive", includeTrash: true, destination: "backup" },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const archivePath = join(backupRoot, result.data.fileName);
    assert.equal(existsSync(archivePath), true);
    assert.deepEqual(revealed, [archivePath]);
    assert.equal(JSON.stringify(result).includes(backupRoot), false);
    assert.equal(existsSync(join(rootDir, "projects", baseProject.id, "exports", result.data.fileName)), false);

    const repository = openProjectRepository(join(rootDir, "projects", baseProject.id), { migrationsDir: projectMigrationsDir });
    try {
      const record = repository.listExportRecords().at(-1);
      assert.equal(record.path, archivePath);
      assert.equal(record.destinationKind, "external");
    } finally {
      repository.close();
    }

    assert.equal((await adapter.handle(event, {
      method: "project.save",
      request: { project: { ...baseProject, title: "Changed after backup" } },
    })).ok, true);
    const backupService = createBackupService({
      backupPath: () => backupRoot,
      projectsDir: join(rootDir, "projects"),
      getAppState: () => ({ settings: {}, resources: [] }),
      restoreAppState: async () => {},
      selectBackupFile: async () => ({ canceled: false, filePath: archivePath }),
    });
    const selected = await backupService.selectRestore({ kind: "project" });
    const restored = await backupService.restore({ token: selected.token, userConfirmed: true });
    assert.match(restored.safetyBackupFileName, /archive/);
    const reopened = await adapter.handle(event, {
      method: "project.open",
      request: { projectId: baseProject.id },
    });
    assert.equal(reopened.ok, true);
    assert.equal(reopened.data.title, baseProject.title);
  } finally {
    cleanup();
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test("rejected IPC envelopes never copy attacker-controlled method text into structured logs", async () => {
  const entries = [];
  const structuredLogger = Object.fromEntries(
    ["info", "warn", "error"].map((level) => [level, (event, details) => entries.push({ level, event, details })]),
  );
  const attackerText = "sk-attacker-controlled-method-secret";
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, { structuredLogger });
  try {
    const result = await adapter.handle(event, { method: attackerText, request: {} });
    assert.equal(result.ok, false);
    const serialized = JSON.stringify(entries);
    assert.equal(serialized.includes(attackerText), false);
    assert.deepEqual(entries, [{
      level: "warn",
      event: "ipc.rejected",
      details: { errorCode: "INVALID_INPUT" },
    }]);
  } finally {
    cleanup();
  }
});

test("permanent deletion closes cached project resources before removing the container", async () => {
  const closed = [];
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    onBeforePermanentProjectDelete: (projectId) => closed.push(projectId),
  });
  try {
    assert.equal((await adapter.handle(event, {
      method: "project.create",
      request: { project: baseProject },
    })).ok, true);
    assert.equal((await adapter.handle(event, {
      method: "project.save",
      request: { project: { ...baseProject, trashedAt: "2026-07-23T12:00:00.000Z" } },
    })).ok, true);
    const result = await adapter.handle(event, {
      method: "project.deletePermanently",
      request: { projectId: baseProject.id, confirmed: true },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(closed, [baseProject.id]);
  } finally {
    cleanup();
  }
});

test("task subscription returns the durable public queue without recovery request snapshots", async () => {
  const task = {
    id: "task-1",
    projectId: "project-adapter-1",
    kind: "translate",
    label: "Translate zh-CN",
    detail: "Waiting for confirmation",
    stage: "translate",
    status: "recoverable",
    progress: 50,
    targetLanguageCode: "zh-CN",
    checkpointStage: null,
    lastErrorCode: "WORKER_INTERRUPTED",
    runSnapshotId: null,
    sequence: 3,
    attempt: 0,
    pauseCapability: "checkpoint",
    request: { credentialId: "openai-default", targetLanguages: ["zh-CN"] },
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:01:00.000Z",
  };
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    taskCoordinator: { list: () => [task] },
  });
  try {
    const result = await adapter.handle(event, {
      method: "tasks.subscribe",
      request: { projectId: "project-adapter-1" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.subscribed, true);
    assert.equal(result.data.tasks.length, 1);
    assert.equal(result.data.tasks[0].status, "recoverable");
    assert.equal("request" in result.data.tasks[0], false);
    assert.equal(JSON.stringify(result).includes("openai-default"), false);
  } finally {
    cleanup();
  }
});

test("task control delegates a bounded command and never returns the durable request snapshot", async () => {
  const calls = [];
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    taskService: {
      control: (command) => {
        calls.push(command);
        return {
          id: command.taskId,
          projectId: command.projectId,
          kind: "translate",
          label: "Translate",
          detail: "Resumed",
          stage: "translate",
          status: "running",
          progress: 50,
          sequence: 4,
          attempt: 1,
          pauseCapability: "checkpoint",
          request: { credentialId: "must-not-leak" },
          createdAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:01:00.000Z",
        };
      },
    },
  });
  try {
    const result = await adapter.handle(event, {
      method: "tasks.control",
      request: {
        taskId: "task-1",
        projectId: "project-adapter-1",
        action: "retry",
        userConfirmed: true,
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.task.status, "running");
    assert.equal("request" in result.data.task, false);
    assert.deepEqual(calls, [{
      taskId: "task-1",
      projectId: "project-adapter-1",
      action: "retry",
      userConfirmed: true,
    }]);
  } finally {
    cleanup();
  }
});

test("real media work is persisted through the task service and publishes monotonic status", async () => {
  const taskRoot = mkdtempSync(join(tmpdir(), "phase8-ipc-task-"));
  const taskRepository = openAppRepository(taskRoot);
  const taskCoordinator = createTaskCoordinator({ queueRepository: taskRepository });
  const events = [];
  const mediaCalls = [];
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    taskCoordinator,
    publishWorkerEvent: (workerEvent) => events.push(workerEvent),
    mediaService: {
      probe: async (request) => {
        mediaCalls.push(request);
        return { availability: "available" };
      },
      cancelOperation: async () => ({ cancelled: false }),
    },
  });
  try {
    const result = await adapter.handle(event, {
      method: "media.probe",
      request: { projectId: "project-adapter-1" },
    });
    assert.deepEqual(result, { ok: true, data: { availability: "available" } });
    const [task] = taskCoordinator.list();
    assert.equal(task.kind, "media");
    assert.equal(task.status, "completed");
    assert.equal(task.progress, 100);
    assert.equal(mediaCalls[0].operationId, task.id);
    assert.deepEqual(events.map((workerEvent) => workerEvent.status), ["pending", "running", "completed"]);
    assert.deepEqual(events.map((workerEvent) => workerEvent.sequence), [0, 1, 2]);
  } finally {
    cleanup();
    taskRepository.close();
    rmSync(taskRoot, { recursive: true, force: true });
  }
});

test("batch session delegates private file paths to media service and returns only public probe data", async () => {
  const calls = [];
  const session = {
    id: "batch-1",
    createdAt: "2026-07-22T00:00:00.000Z",
    files: [{ id: "file-1", name: "clip.mkv", mediaKind: "video", probe: { mediaKind: "video" } }],
    groups: [{ id: "group-1", title: "clip", confidence: "low", fileIds: ["file-1"] }],
  };
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    mediaService: {
      createBatchSession: async (request) => {
        calls.push(request);
        return session;
      },
      discardBatchSession: (request) => ({ discarded: request.sessionId === session.id }),
      commitBatchSession: async () => ({ projectIds: [baseProject.id], projects: [baseProject] }),
    },
  });
  try {
    const filePaths = ["C:\\Media\\clip.mkv", "C:\\Media\\captions.srt"];
    const result = await adapter.handle(event, {
      method: "batch.createSession",
      request: { filePaths },
    });
    assert.deepEqual(result, { ok: true, data: session });
    assert.deepEqual(calls, [{ filePaths }]);
    assert.equal(JSON.stringify(result).includes("C:\\Media"), false);
    const committed = await adapter.handle(event, {
      method: "batch.commitSession",
      request: {
        sessionId: session.id,
        defaults: { provider: "OpenAI", model: "GPT-4.1", targetLanguages: ["zh-CN"] },
        groups: [{ id: "group-1", title: "clip", fileIds: ["file-1"], overrides: {} }],
      },
    });
    assert.deepEqual(committed, {
      ok: true,
      data: { projectIds: [baseProject.id], projects: [baseProject] },
    });
    assert.deepEqual(await adapter.handle(event, {
      method: "batch.discardSession",
      request: { sessionId: session.id },
    }), { ok: true, data: { discarded: true } });
  } finally {
    cleanup();
  }
});

test("batch start enqueues independent durable project tasks exactly once", async () => {
  const enqueued = [];
  const taskCoordinator = { list: () => enqueued };
  const taskService = {
    register() {},
    enqueue(operation, input) {
      const task = {
        id: `task-${input.projectId}`,
        projectId: input.projectId,
        kind: "translate",
        label: "Translate project",
        detail: "Queued",
        stage: "translate",
        status: "pending",
        progress: 0,
        sequence: 0,
        attempt: 0,
        pauseCapability: "never",
        request: { operation, input },
        createdAt: "2026-07-22T12:00:00.000Z",
        updatedAt: "2026-07-22T12:00:00.000Z",
      };
      enqueued.push(task);
      return task;
    },
  };
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    taskCoordinator,
    taskService,
  });
  try {
    const created = await adapter.handle(event, {
      method: "project.create",
      request: { project: baseProject },
    });
    assert.equal(created.ok, true);

    const request = {
      batchId: "batch-1",
      projectIds: [baseProject.id],
      userConfirmed: true,
      provider: "OpenAI",
      model: "GPT-4.1",
    };
    const started = await adapter.handle(event, { method: "batch.start", request });
    assert.equal(started.ok, true);
    assert.equal(started.data.tasks.length, 1);
    assert.equal(started.data.tasks[0].batchId, "batch-1");
    assert.equal("request" in started.data.tasks[0], false);
    assert.ok(started.data.tasks[0].batchEstimatedTokens > 0);
    assert.equal(enqueued[0].request.input.batchId, "batch-1");
    assert.ok(enqueued[0].request.input.batchEstimatedTokens > 0);

    const repeated = await adapter.handle(event, { method: "batch.start", request });
    assert.equal(repeated.ok, true);
    assert.equal(enqueued.length, 1, "restart-safe batch start must not enqueue a duplicate");
    assert.equal(repeated.data.tasks[0].id, started.data.tasks[0].id);
  } finally {
    cleanup();
  }
});

test("ASR capability delegates to the verified public status without path fields", async () => {
  const publicStatus = {
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtime: { id: "whisper-cpp-cpu-x64", version: "1.9.1", installState: "not_installed", reason: "missing" },
    model: { id: "small", version: "rev", modelHash: "a".repeat(64), installState: "not_installed", reason: "missing" },
    optionalRuntimes: [],
    ready: false,
  };
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    asrRuntimePort: { getCapabilityStatus: async () => publicStatus },
  });
  try {
    const result = await adapter.handle(event, { method: "asr.capability", request: {} });
    assert.deepEqual(result, { ok: true, data: publicStatus });
    const serialized = JSON.stringify(result);
    assert.equal(/path|url|argv|cwd/i.test(serialized), false);
  } finally {
    cleanup();
  }
});

test("resource CRUD crosses the validated adapter and keeps revisions", async () => {
  const { adapter, event, cleanup } = makeAdapter();
  const resource = {
    id: "guide-adapter",
    kind: "style_guide",
    name: "Adapter guide",
    description: "",
    payload: {
      targetLanguageCode: "zh-CN",
      tags: [],
      scenes: [],
      rules: [{ id: "rule-1", title: "Tone", instruction: "Keep it concise", enabled: true }],
    },
  };
  try {
    const created = await adapter.handle(event, {
      method: "resource.save",
      request: { resource },
    });
    assert.equal(created.ok, true);
    assert.equal(created.data.revision, 1);

    const listed = await adapter.handle(event, {
      method: "resource.list",
      request: { kind: "style_guide" },
    });
    assert.deepEqual(listed.data, [created.data]);

    const deleted = await adapter.handle(event, {
      method: "resource.delete",
      request: { resourceId: resource.id, expectedRevision: 1 },
    });
    assert.deepEqual(deleted, { ok: true, data: { deleted: true } });
  } finally {
    cleanup();
  }
});

test("ASR model management delegates bounded requests and keeps manual paths inside main", async () => {
  const calls = [];
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    asrModelInstaller: {
      install: async (request) => { calls.push(["install", request]); return { installState: "ready" }; },
      importModel: async (request) => { calls.push(["import", request]); return { installState: "ready" }; },
      uninstall: async (request) => { calls.push(["uninstall", request]); return { uninstalled: true }; },
      installRuntime: async (request) => { calls.push(["runtime-install", request]); return { installState: "ready" }; },
      importRuntime: async (request) => { calls.push(["runtime-import", request]); return { installState: "ready" }; },
      uninstallRuntime: async (request) => { calls.push(["runtime-uninstall", request]); return { uninstalled: true }; },
      cancel: (request) => { calls.push(["cancel", request]); return { cancelled: true }; },
    },
    songClassifierInstaller: {
      install: async (request) => { calls.push(["song-install", request]); return { installState: "ready" }; },
      uninstall: async (request) => { calls.push(["song-uninstall", request]); return { uninstalled: true }; },
      cancel: (request) => { calls.push(["song-cancel", request]); return { cancelled: true }; },
    },
  });
  try {
    for (const envelope of [
      { method: "asr.model.install", request: { assetId: "small", source: "official", operationId: "install-1" } },
      { method: "asr.model.import", request: { assetId: "small", operationId: "import-1" } },
      { method: "asr.model.uninstall", request: { assetId: "small", operationId: "uninstall-1" } },
      { method: "asr.model.cancel", request: { operationId: "cancel-1" } },
      { method: "asr.runtime.install", request: { assetId: "whisper-cpp-cuda-12.4-x64", source: "official", operationId: "runtime-install-1" } },
      { method: "asr.runtime.import", request: { assetId: "whisper-cpp-cuda-12.4-x64", operationId: "runtime-import-1" } },
      { method: "asr.runtime.uninstall", request: { assetId: "whisper-cpp-cuda-12.4-x64", operationId: "runtime-uninstall-1" } },
      { method: "asr.runtime.cancel", request: { operationId: "runtime-cancel-1" } },
      { method: "asr.songClassifier.install", request: { assetId: "ina-speech-music-noise-v1", source: "official", operationId: "song-install-1" } },
      { method: "asr.songClassifier.uninstall", request: { assetId: "ina-speech-music-noise-v1", operationId: "song-uninstall-1" } },
      { method: "asr.songClassifier.cancel", request: { operationId: "song-cancel-1" } },
    ]) {
      assert.equal((await adapter.handle(event, envelope)).ok, true);
    }
    assert.deepEqual(calls, [
      ["install", { assetId: "small", source: "official", operationId: "install-1" }],
      ["import", { assetId: "small", operationId: "import-1" }],
      ["uninstall", { assetId: "small", operationId: "uninstall-1" }],
      ["cancel", { operationId: "cancel-1" }],
      ["runtime-install", { assetId: "whisper-cpp-cuda-12.4-x64", source: "official", operationId: "runtime-install-1" }],
      ["runtime-import", { assetId: "whisper-cpp-cuda-12.4-x64", operationId: "runtime-import-1" }],
      ["runtime-uninstall", { assetId: "whisper-cpp-cuda-12.4-x64", operationId: "runtime-uninstall-1" }],
      ["cancel", { operationId: "runtime-cancel-1" }],
      ["song-install", { assetId: "ina-speech-music-noise-v1", source: "official", operationId: "song-install-1" }],
      ["song-uninstall", { assetId: "ina-speech-music-noise-v1", operationId: "song-uninstall-1" }],
      ["song-cancel", { operationId: "song-cancel-1" }],
    ]);
    assert.equal(/path|url|sha256/i.test(JSON.stringify(calls)), false);
  } finally {
    cleanup();
  }
});

test("ASR device status preference detection and cancellation delegate bounded values", async () => {
  const calls = [];
  const publicStatus = {
    requestedDevice: "auto",
    allowCudaFallback: false,
    actualDevice: "cpu",
    actualRuntimeId: "whisper-cpp-cpu-x64",
    actualRuntimeVersion: "1.9.1",
    fallbackReason: "cuda_not_ready",
    detection: {
      cpu: { status: "available", runtimeId: "whisper-cpp-cpu-x64", runtimeVersion: "1.9.1" },
      cuda: { status: "unavailable", runtimeId: "whisper-cpp-cuda-12.4-x64", runtimeVersion: "1.9.1", reason: "runtime_not_ready" },
    },
    updatedAt: "2026-07-19T20:00:00.000Z",
  };
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    asrDeviceSelector: {
      getStatus: async () => { calls.push(["status", {}]); return publicStatus; },
      setPreference: async (request) => { calls.push(["preference", request]); return publicStatus; },
      detect: async (request) => { calls.push(["detect", request]); return publicStatus; },
      cancel: (request) => { calls.push(["cancel", request]); return { cancelled: true }; },
    },
  });
  try {
    for (const envelope of [
      { method: "asr.device.status", request: {} },
      { method: "asr.device.preference", request: { requestedDevice: "auto", allowCudaFallback: false } },
      { method: "asr.device.detect", request: { operationId: "detect-1" } },
      { method: "asr.device.cancel", request: { operationId: "detect-1" } },
    ]) {
      const result = await adapter.handle(event, envelope);
      assert.equal(result.ok, true);
      assert.equal(/path|argv|cwd/i.test(JSON.stringify(result)), false);
    }
    assert.deepEqual(calls, [
      ["status", {}],
      ["preference", { requestedDevice: "auto", allowCudaFallback: false }],
      ["detect", { operationId: "detect-1" }],
      ["cancel", { operationId: "detect-1" }],
    ]);
  } finally {
    cleanup();
  }
});

test("ASR project workflow delegates only validated identifiers and returns restart-safe state", async () => {
  const calls = [];
  const project = { ...baseProject, id: "project-asr-ui" };
  const service = {
    getStatus: async (request) => { calls.push(["status", request]); return { project, runs: [], candidates: [] }; },
    transcribe: async (request) => { calls.push(["transcribe", request]); return { runId: "asr-run-1", segmentCount: 1, wordCount: 2 }; },
    segment: async (request) => { calls.push(["segment", request]); return { project, sourceTrackId: "asr-candidate-1", deduplicated: false }; },
    detectLanguages: async (request) => { calls.push(["detect", request]); return { project, sourceTrackId: "asr-candidate-1", pendingSegmentIds: [] }; },
    updateLanguages: async (request) => { calls.push(["update", request]); return { project, sourceTrackId: "asr-candidate-1", affectedSegmentIds: ["asr-seg-1"], pendingSegmentIds: [] }; },
    cancel: async (request) => { calls.push(["cancel", request]); return { cancelled: true }; },
  };
  const opened = [];
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    asrProjectService: service,
    openAsrInfo: async (request) => { opened.push(request); return { opened: true }; },
  });
  try {
    const envelopes = [
      { method: "asr.project.status", request: { projectId: "project-asr-ui" } },
      { method: "asr.transcribe", request: { projectId: "project-asr-ui", audioStreamId: "s:1", languageMode: "auto", languageHint: null, requestedDevice: "cpu", allowCudaFallback: false, operationId: "asr-op-1" } },
      { method: "asr.segment", request: { projectId: "project-asr-ui", asrRunId: "asr-run-1", configVersion: "asr-segmentation-v2", operationId: "segment-op-1" } },
      { method: "asr.language.detect", request: { projectId: "project-asr-ui", sourceTrackId: "asr-candidate-1", requestedDevice: "cpu", allowCudaFallback: false, operationId: "language-op-1" } },
      { method: "asr.language.update", request: { projectId: "project-asr-ui", sourceTrackId: "asr-candidate-1", changes: [{ segmentId: "asr-seg-1", manualLanguage: "en" }], confirmTrackConvergence: false } },
      { method: "asr.cancel", request: { projectId: "project-asr-ui", operationId: "asr-op-1" } },
      { method: "asr.info.open", request: { target: "model-source", modelId: "large-v3-turbo-q5_0" } },
    ];
    for (const envelope of envelopes) {
      const result = await adapter.handle(event, envelope);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(/path|url|argv|cwd/i.test(JSON.stringify(result)), false);
    }
    assert.deepEqual(calls.map(([name]) => name), ["status", "transcribe", "segment", "detect", "update", "cancel"]);
    assert.deepEqual(opened, [{ target: "model-source", modelId: "large-v3-turbo-q5_0" }]);

    const denied = await adapter.handle(
      { sender: { id: 999 }, senderFrame: { url: "file:///app/index.html" } },
      envelopes[1],
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "PERMISSION_DENIED");
  } finally {
    cleanup();
  }
});

test("encoding confirmation is returned as a successful retryable import response", async () => {
  const { adapter, event, cleanup } = makeAdapter(() => ({
    importSubtitle() {
      return {
        ok: false,
        needsEncodingConfirmation: true,
        encodingCandidates: ["gbk", "shift_jis"],
      };
    },
    rebuildProjectIndex() {},
    close() {},
  }));
  try {
    const result = await adapter.handle(event, {
      method: "subtitle.import",
      request: { fileName: "ambiguous.srt", bytes: new Uint8Array([0x82, 0xa0]) },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.needsEncodingConfirmation, true);
    assert.deepEqual(result.data.encodingCandidates, ["gbk", "shift_jis"]);
    assert.equal(Object.hasOwn(result.data, "project"), false);
  } finally {
    cleanup();
  }
});

test("media cancellation delegates to the media service", async () => {
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    mediaService: {
      cancelOperation: async ({ operationId }) => ({ cancelled: operationId === "operation-1" }),
    },
  });
  try {
    const result = await adapter.handle(event, {
      method: "media.cancel",
      request: { projectId: "project-adapter-1", operationId: "operation-1" },
    });
    assert.deepEqual(result, { ok: true, data: { cancelled: true } });
  } finally {
    cleanup();
  }
});

test("create delegates to port and hides containerPath", async () => {
  const { adapter, event, cleanup } = makeAdapter();
  try {
    const created = await adapter.handle(event, {
      method: "project.create",
      request: { project: baseProject },
    });
    assert.equal(created.ok, true);
    assert.equal(created.data.projectId, baseProject.id);
    assert.equal(Object.hasOwn(created.data, "containerPath"), false);

    const opened = await adapter.handle(event, {
      method: "project.open",
      request: { projectId: baseProject.id },
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.data.title, "Adapter Project");
  } finally {
    cleanup();
  }
});

test("foreign sender is denied", async () => {
  const { adapter, cleanup } = makeAdapter();
  try {
    const denied = await adapter.handle(
      { sender: { id: 999 }, senderFrame: { url: "file:///app/index.html" } },
      { method: "project.listRecent", request: {} },
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "PERMISSION_DENIED");
  } finally {
    cleanup();
  }
});

test("child frame from the main webContents is denied", async () => {
  const { adapter, event, cleanup } = makeAdapter();
  try {
    const denied = await adapter.handle(
      { sender: event.sender, senderFrame: { url: "file:///app/child.html" } },
      { method: "project.listRecent", request: {} },
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "PERMISSION_DENIED");
  } finally {
    cleanup();
  }
});

test("missing project open returns null data not a new container", async () => {
  const { adapter, event, cleanup } = makeAdapter();
  try {
    const opened = await adapter.handle(event, {
      method: "project.open",
      request: { projectId: "project-missing" },
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.data, null);
  } finally {
    cleanup();
  }
});

test("credential save/status/delete never returns secret material", async () => {
  const secret = "sk-ipc-adapter-secret-value";
  const { adapter, event, cleanup } = makeAdapter();
  try {
    const saved = await adapter.handle(event, {
      method: "credential.save",
      request: {
        credentialId: "openai-default",
        secret,
        providerId: "openai",
        label: "OpenAI",
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.configured, true);
    assert.equal(JSON.stringify(saved).includes(secret), false);

    const status = await adapter.handle(event, {
      method: "credential.status",
      request: { credentialId: "openai-default" },
    });
    assert.equal(status.ok, true);
    assert.equal(status.data.configured, true);
    assert.equal(JSON.stringify(status).includes(secret), false);

    // Internal bridge only; not on DesktopApi.
    assert.equal(adapter.revealCredentialSecret("openai-default"), secret);

    const deleted = await adapter.handle(event, {
      method: "credential.delete",
      request: { credentialId: "openai-default" },
    });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.data.deleted, true);
  } finally {
    cleanup();
  }
});

test("replacing a referenced credential invalidates readiness even without providerId", async () => {
  const { adapter, event, rootDir, cleanup } = makeAdapter();
  const appDir = join(rootDir, "app");
  try {
    const repository = openAppRepository(appDir);
    repository.upsertProviderReadiness({
      providerId: "openai",
      providerName: "OpenAI",
      status: "ready",
      credentialId: "openai-default",
      profileKey: "profile-1",
      requestedModel: "GPT-4.1",
      modelId: "gpt-4.1",
      baseUrlDisplay: "https://api.openai.com/v1",
      transportMode: "responses",
      testedAt: "2026-07-16T00:00:00.000Z",
    });
    repository.close();

    const saved = await adapter.handle(event, {
      method: "credential.save",
      request: { credentialId: "openai-default", secret: "replacement-secret" },
    });
    assert.equal(saved.ok, true);

    const reopened = openAppRepository(appDir);
    const readiness = reopened.getProviderReadiness("openai");
    reopened.close();
    assert.equal(readiness, null);
  } finally {
    cleanup();
  }
});

test("credential operations fail closed when safeStorage is unavailable", async () => {
  const { adapter, event, cleanup } = makeAdapter(openDesktopPersistencePort, {
    safeStorage: createUnavailableSafeStorage(),
  });
  try {
    const saved = await adapter.handle(event, {
      method: "credential.save",
      request: { credentialId: "openai-default", secret: "x" },
    });
    assert.equal(saved.ok, false);
    assert.equal(saved.error.code, "INTERNAL");
    assert.match(saved.error.message, /unavailable/i);
    assert.equal(JSON.stringify(saved).includes("x"), false);
  } finally {
    cleanup();
  }
});

function makeProviderModelsAdapter(translationPort) {
  const rootDir = mkdtempSync(join(tmpdir(), "p02-models-"));
  const fakeMainFrame = { url: "file:///app/index.html" };
  const fakeWebContents = { id: 1, mainFrame: fakeMainFrame };
  const adapter = createIpcAdapter({
    openDesktopPersistencePort,
    openCredentialStore,
    openProjectRepository,
    createDesktopTranslationPort: () => translationPort,
    safeStorage: createMemorySafeStorage(),
    appDir: join(rootDir, "app"),
    projectsDir: join(rootDir, "projects"),
    appMigrationsDir,
    projectMigrationsDir,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: fakeWebContents }),
    requestCloseAfterFlush: () => {},
  });
  return {
    adapter,
    event: { sender: fakeWebContents, senderFrame: fakeMainFrame },
    cleanup: () => {
      adapter.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

test("subtitle delivery asks main for a user folder and never exposes its path", async () => {
  const externalDir = mkdtempSync(join(tmpdir(), "subtitle-delivery-"));
  const sourceOutputPath = join(externalDir, "chosen-source.srt");
  const revealed = [];
  let directoryPickerCalls = 0;
  const { adapter, event, rootDir, cleanup } = makeAdapter(openDesktopPersistencePort, {
    selectSubtitleExportDirectory: async () => {
      directoryPickerCalls += 1;
      return { canceled: false, directoryPath: externalDir };
    },
    selectSourceSubtitleFile: async () => ({ canceled: false, filePath: sourceOutputPath }),
    showItemInFolder: (path) => revealed.push(path),
  });
  try {
    assert.equal((await adapter.handle(event, {
      method: "project.create",
      request: { project: baseProject },
    })).ok, true);
    const sourceResult = await adapter.handle(event, {
      method: "subtitle.exportSource",
      request: { projectId: baseProject.id, mode: "normalized", format: "srt", destination: "user" },
    });
    assert.equal(sourceResult.ok, true, JSON.stringify(sourceResult));
    assert.equal(sourceResult.data.canceled, false);
    assert.equal(existsSync(sourceOutputPath), true);
    assert.equal(JSON.stringify(sourceResult).includes(externalDir), false);
    const result = await adapter.handle(event, {
      method: "subtitle.exportMatrix",
      request: {
        projectId: baseProject.id,
        destination: "user",
        requests: [{ id: "target-zh", exportKind: "target", targetLanguageCode: "zh-CN", format: "srt" }],
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.canceled, false);
    assert.equal(existsSync(join(externalDir, result.data.succeeded[0].fileName)), true);
    assert.equal(existsSync(join(rootDir, "projects", baseProject.id, "exports", result.data.succeeded[0].fileName)), false);
    const approvedFirst = structuredClone(baseProject);
    approvedFirst.sourceTracks[0].targetTracks[0].status = "approved";
    const approvedSecond = structuredClone(approvedFirst);
    approvedSecond.id = "project-adapter-2";
    approvedSecond.title = "Second Adapter Project";
    const draftThird = structuredClone(baseProject);
    draftThird.id = "project-adapter-3";
    draftThird.title = "Draft Adapter Project";
    assert.equal((await adapter.handle(event, {
      method: "project.save",
      request: { project: approvedFirst },
    })).ok, true);
    assert.equal((await adapter.handle(event, {
      method: "project.create",
      request: { project: approvedSecond },
    })).ok, true);
    assert.equal((await adapter.handle(event, {
      method: "project.create",
      request: { project: draftThird },
    })).ok, true);
    const batch = await adapter.handle(event, {
      method: "subtitle.exportApprovedBatch",
      request: { projectIds: [approvedFirst.id, approvedSecond.id, draftThird.id] },
    });
    assert.equal(batch.ok, true, JSON.stringify(batch));
    assert.equal(batch.data.canceled, false);
    assert.equal(batch.data.projects.length, 2);
    assert.deepEqual(batch.data.skippedProjectIds, [draftThird.id]);
    assert.equal(batch.data.projects.every((entry) => entry.summary.succeeded.length === 1), true);
    assert.equal(directoryPickerCalls, 2, "one picker for the earlier single export and one for the whole batch");
    assert.equal(JSON.stringify(batch).includes(externalDir), false);
    assert.equal(revealed.length, 3);
    assert.deepEqual(revealed.slice(0, 2), [sourceOutputPath, join(externalDir, result.data.succeeded[0].fileName)]);
    assert.equal(JSON.stringify(result).includes(externalDir), false);
  } finally {
    cleanup();
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("provider.listModels crosses the validated adapter and refuses smuggled secrets", async () => {
  const seen = [];
  const { adapter, event, cleanup } = makeProviderModelsAdapter({
    listProviderModels: async (request) => {
      seen.push(request);
      return {
        ok: true,
        data: {
          providerId: "openai",
          providerName: "OpenAI",
          baseUrlDisplay: "https://api.openai.com/v1",
          models: [{ id: "gpt-4.1", label: "gpt-4.1" }],
          truncated: false,
        },
      };
    },
  });
  try {
    const ok = await adapter.handle(event, {
      method: "provider.listModels",
      request: { provider: "OpenAI", credentialId: "openai-default" },
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.data.models, [{ id: "gpt-4.1", label: "gpt-4.1" }]);
    assert.deepEqual(seen, [{ provider: "OpenAI", credentialId: "openai-default" }]);

    const smuggled = await adapter.handle(event, {
      method: "provider.listModels",
      request: { provider: "OpenAI", apiKey: "sk-should-never-cross-ipc" },
    });
    assert.equal(smuggled.ok, false);
    assert.equal(smuggled.error.code, "INVALID_INPUT");
    assert.equal(JSON.stringify(smuggled).includes("sk-should-never-cross-ipc"), false);
    assert.equal(seen.length, 1);
  } finally {
    cleanup();
  }
});

test("provider.listModels fails closed when the translation port cannot list models", async () => {
  const { adapter, event, cleanup } = makeProviderModelsAdapter({});
  try {
    const result = await adapter.handle(event, {
      method: "provider.listModels",
      request: { provider: "OpenAI" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INTERNAL");
    assert.equal(result.error.message, "模型列表服务不可用");
  } finally {
    cleanup();
  }
});

/**
 * 「开始翻译」必须是入队语义。
 *
 * 旧版走 runtimeTaskService.run()，那个调用要到最后一条字幕译完才 resolve，
 * 于是渲染层的 `await startProject(...)` 会挂住整轮翻译：按钮按下去既不跳转
 * 也没有任何反馈，用户只能反复点，一次点击排一轮付费任务。
 */
function makeTranslationStartAdapter({ enqueued, registered, translateRequests = [] }) {
  const rootDir = mkdtempSync(join(tmpdir(), "p02-translate-start-"));
  const fakeMainFrame = { url: "file:///app/index.html" };
  const fakeWebContents = { id: 1, mainFrame: fakeMainFrame };
  const taskService = {
    register: (operation, descriptor) => registered.set(operation, descriptor),
    enqueue: (operation, input) => {
      enqueued.push({ operation, input });
      return {
        id: "task-translate-start-1",
        projectId: input.projectId,
        kind: "translate",
        label: "Translate project",
        detail: "Queued",
        stage: "translate",
        status: "pending",
        progress: 0,
        pauseCapability: "checkpoint",
        request: { operation, input },
      };
    },
    run: async () => {
      throw new Error("translation.start must not block the IPC call until the whole run finishes");
    },
    control: () => {},
    hasActiveTasks: () => false,
    waitForIdle: () => Promise.resolve(),
    stopAll: async () => {},
  };
  const adapter = createIpcAdapter({
    openDesktopPersistencePort,
    openCredentialStore,
    openProjectRepository,
    createDesktopTranslationPort: () => ({
      translateProject: async (request) => {
        translateRequests.push(request);
        return { ok: true, data: { results: [] } };
      },
    }),
    safeStorage: createMemorySafeStorage(),
    appDir: join(rootDir, "app"),
    projectsDir: join(rootDir, "projects"),
    appMigrationsDir,
    projectMigrationsDir,
    taskService,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: fakeWebContents }),
    requestCloseAfterFlush: () => {},
  });
  return {
    adapter,
    event: { sender: fakeWebContents, senderFrame: fakeMainFrame },
    cleanup: () => {
      adapter.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

test("translation.start enqueues and returns the queued task instead of awaiting the whole run", async () => {
  const enqueued = [];
  const registered = new Map();
  const { adapter, event, cleanup } = makeTranslationStartAdapter({ enqueued, registered });
  try {
    const result = await adapter.handle(event, {
      method: "translation.start",
      request: { projectId: baseProject.id, userConfirmed: true },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.projectId, baseProject.id);
    assert.equal(result.data.task.id, "task-translate-start-1");
    assert.equal(result.data.task.status, "pending");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].operation, "translation.start");

    // 翻译能在批次之间暂停后继续，而不是只能取消。
    assert.equal(registered.get("translation.start").pauseCapability, "checkpoint");
  } finally {
    cleanup();
  }
});

test("translation task retries resume existing target text while fresh runs do not", async () => {
  const enqueued = [];
  const registered = new Map();
  const translateRequests = [];
  const { adapter, cleanup } = makeTranslationStartAdapter({ enqueued, registered, translateRequests });
  try {
    const execute = registered.get("translation.start").execute;
    const context = (attempt) => ({
      taskId: "task-translate-start-1",
      task: { attempt, status: "running", progress: 0 },
      reportProgress() {},
    });
    await execute({ projectId: baseProject.id }, context(0));
    await execute({ projectId: baseProject.id }, context(1));
    assert.deepEqual(
      translateRequests.map((request) => request.resumeExistingTargetText),
      [false, true],
    );
  } finally {
    cleanup();
  }
});
