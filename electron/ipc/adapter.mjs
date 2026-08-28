import { validateIpcEnvelope, mapPortError } from "./validate.mjs";
import { createTaskService } from "../../backend/tasks/task-service.mjs";
import { planBatchTranslation } from "../../backend/tasks/batch-translation-plan.mjs";
import { isAbsolute, join } from "node:path";

function toIndexSummary(row) {
  return {
    id: row.id,
    title: row.title,
    sourceFileName: row.sourceFileName,
    mediaKind: row.mediaKind,
    lifecycle: row.lifecycle,
    updatedAt: row.updatedAt,
    latestRunSummary: row.latestRunSummary,
    ...(row.trashedAt ? { trashedAt: row.trashedAt } : {}),
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
  };
}

function toPublicTask({ request, ...task }) {
  const input = request?.input;
  const batchId = input?.batchId;
  return {
    ...task,
    ...(typeof batchId === "string" && /^[A-Za-z0-9._-]+$/.test(batchId) ? { batchId } : {}),
    ...(Number.isFinite(input?.batchEstimatedTokens) && input.batchEstimatedTokens >= 0
      ? { batchEstimatedTokens: input.batchEstimatedTokens }
      : {}),
  };
}

const RETRYABLE_PROVIDER_FAILURES = new Set(["network", "rate_limit", "schema_mismatch", "server", "timeout"]);

export function translationTaskError(results) {
  const interrupted = Array.isArray(results)
    ? results.find((result) => result?.status !== "completed")
    : null;
  if (!interrupted) return null;

  const language = typeof interrupted.targetLanguage === "string"
    ? ` for ${interrupted.targetLanguage}`
    : "";
  // 翻译结果只有 completed / failed / running 三种；
  // 唯一会产出 paused 的预算闸门已随预算功能一并移除。
  const error = new Error(`Translation did not complete${language}`);
  const errorClass = typeof interrupted.errorClass === "string" && /^[a-z_]{2,32}$/.test(interrupted.errorClass)
    ? interrupted.errorClass
    : "unknown";
  error.code = errorClass === "cancelled" ? "CANCELLED" : `PROVIDER_${errorClass.toUpperCase()}`;
  error.retryable = RETRYABLE_PROVIDER_FAILURES.has(errorClass);
  return error;
}

export function createIpcAdapter({
  openDesktopPersistencePort,
  openCredentialStore,
  openProjectRepository,
  createDesktopTranslationPort,
  translationWorkerClient,
  mediaService = null,
  videoExportService = null,
  audioSeparationService = null,
  asrRuntimePort = null,
  getAsrCapabilityStatus = null,
  asrModelInstaller = null,
  songClassifierInstaller = null,
  asrDeviceSelector = null,
  asrProjectService = null,
  taskCoordinator = null,
  taskService = null,
  publishWorkerEvent = () => {},
  openAsrInfo = null,
  issueMediaPreviewUrl = null,
  onBeforePermanentProjectDelete = null,
  persistencePort = null,
  safeStorage,
  appDir,
  projectsDir,
  appMigrationsDir,
  projectMigrationsDir,
  getMainWindow,
  requestCloseAfterFlush,
  appSettingsService = null,
  capabilityService = null,
  backupService = null,
  diagnosticsService = null,
  structuredLogger = null,
  showItemInFolder = null,
  selectSettingsDirectory = null,
  selectModelStorageDestination = null,
  transferModelStorage = null,
  selectSubtitleExportDirectory = null,
  selectSourceSubtitleFile = null,
  selectAudioExportFile = null,
  allowLoopbackHttp = false,
}) {
  const port =
    persistencePort ||
    openDesktopPersistencePort({
      appDir,
      projectsDir,
      appMigrationsDir,
      projectMigrationsDir,
    });

  let credentialStore = null;
  let downloadSourceHealth = [];
  const log = (level, event, details) => {
    try {
      structuredLogger?.[level]?.(event, details);
    } catch {
      // Logging must never break the user operation it observes.
    }
  };
  let credentialStoreError = null;
  if (typeof openCredentialStore === "function") {
    try {
      credentialStore = openCredentialStore({
        rootDir: appDir,
        safeStorage,
      });
    } catch (error) {
      credentialStoreError = error;
      credentialStore = null;
    }
  }

  function requireCredentialStore() {
    if (credentialStore) {
      return credentialStore;
    }
    if (credentialStoreError) {
      throw credentialStoreError;
    }
    const error = new Error("Secure credential storage is unavailable");
    error.code = "CREDENTIAL_STORE_UNAVAILABLE";
    throw error;
  }

  let translationPort = null;
  if (typeof createDesktopTranslationPort === "function" && typeof openProjectRepository === "function") {
    translationPort = createDesktopTranslationPort({
      openProjectRepository,
      projectsDir,
      projectMigrationsDir,
      allowLoopbackHttp,
      workerClient: translationWorkerClient,
      loadProviderReadiness: (providerId) => port.loadProviderReadiness(providerId),
      saveProviderReadiness: (readiness) => port.saveProviderReadiness(readiness),
      revealSecret(credentialId) {
        return requireCredentialStore().revealSecret({ credentialId });
      },
    });
  }

  const runtimeTaskService = taskService ?? (
    taskCoordinator && typeof taskCoordinator.create === "function"
      ? createTaskService({ coordinator: taskCoordinator, publish: publishWorkerEvent })
      : null
  );

  function operationError(result, fallbackMessage) {
    const error = new Error(result?.error?.message || fallbackMessage);
    error.code = result?.error?.code || "INTERNAL";
    error.retryable = Boolean(result?.error?.retryable ?? result?.error?.details?.retryable);
    return error;
  }

  async function exportSourceOperation(request) {
    let destinationPath;
    if (request.destination === "user") {
      if (typeof selectSourceSubtitleFile !== "function") {
        throw Object.assign(new Error("Source subtitle destination picker is unavailable"), { code: "NOT_AVAILABLE" });
      }
      const selection = await selectSourceSubtitleFile(request);
      if (selection?.canceled) return { ok: true, canceled: true };
      destinationPath = selection?.filePath;
      if (typeof destinationPath !== "string" || !isAbsolute(destinationPath)) {
        throw Object.assign(new Error("Source subtitle destination must be absolute"), { code: "INVALID_INPUT" });
      }
    }
    const result = port.exportSourceSubtitle({ ...request, ...(destinationPath ? { destinationPath } : {}) });
    if (!result.ok) throw operationError(result, "Subtitle export failed");
    if (destinationPath) {
      try {
        showItemInFolder?.(destinationPath);
      } catch {
        log("warn", "source_subtitle_export.reveal_failed", { errorCode: "SHELL_FAILED" });
      }
    }
    return {
      canceled: false,
      exportRecordId: result.exportRecordId,
      fileName: result.fileName,
      format: result.format,
      warnings: result.warnings || [],
    };
  }

  async function exportMatrixOperation(request) {
    let destinationDir;
    if (request.destination === "user") {
      if (typeof selectSubtitleExportDirectory !== "function") {
        throw Object.assign(new Error("Subtitle export destination picker is unavailable"), { code: "NOT_AVAILABLE" });
      }
      const selection = await selectSubtitleExportDirectory();
      if (selection?.canceled) {
        return { ok: true, partial: false, canceled: true, succeeded: [], failed: [] };
      }
      destinationDir = selection?.directoryPath;
      if (typeof destinationDir !== "string" || !isAbsolute(destinationDir)) {
        throw Object.assign(new Error("Subtitle export destination must be absolute"), { code: "INVALID_INPUT" });
      }
    }
    const result = port.exportSubtitleMatrix({ ...request, ...(destinationDir ? { destinationDir } : {}) });
    if (!result.ok) throw operationError(result, "Subtitle export failed");
    const summary = { ...result.summary, canceled: false };
    if (destinationDir && summary.succeeded[0]) {
      try {
        showItemInFolder?.(join(destinationDir, summary.succeeded[0].fileName));
      } catch {
        log("warn", "subtitle_export.reveal_failed", { errorCode: "SHELL_FAILED" });
      }
    }
    return summary;
  }

  async function exportApprovedBatchOperation(request) {
    if (typeof port.exportApprovedBatch !== "function" || typeof selectSubtitleExportDirectory !== "function") {
      throw Object.assign(new Error("Approved batch export is unavailable"), { code: "NOT_AVAILABLE" });
    }
    const selection = await selectSubtitleExportDirectory();
    if (selection?.canceled) {
      return { canceled: true, projects: [], skippedProjectIds: [], failedProjects: [] };
    }
    const destinationDir = selection?.directoryPath;
    if (typeof destinationDir !== "string" || !isAbsolute(destinationDir)) {
      throw Object.assign(new Error("Subtitle export destination must be absolute"), { code: "INVALID_INPUT" });
    }
    const result = port.exportApprovedBatch({ ...request, destinationDir });
    if (!result.ok) throw operationError(result, "Approved batch export failed");
    const projects = result.summary.projects.map((entry) => ({
      ...entry,
      summary: { ...entry.summary, canceled: false },
    }));
    const first = projects.flatMap((entry) => entry.summary.succeeded)[0];
    if (first) {
      try {
        showItemInFolder?.(join(destinationDir, first.fileName));
      } catch {
        log("warn", "approved_batch_export.reveal_failed", { errorCode: "SHELL_FAILED" });
      }
    }
    return { canceled: false, ...result.summary, projects };
  }

  async function videoExportOperation(request, context) {
    if (!videoExportService) {
      throw Object.assign(new Error("Video export services are unavailable"), { code: "NOT_AVAILABLE" });
    }
    return videoExportService.exportVideo({
      ...request,
      operationId: request.operationId ?? context?.taskId,
    });
  }

  async function audioSeparationOperation(request, context) {
    if (!audioSeparationService) {
      throw Object.assign(new Error("Audio separation services are unavailable"), { code: "NOT_AVAILABLE" });
    }
    return audioSeparationService.separate({
      ...request,
      operationId: request.operationId ?? context?.taskId,
    });
  }

  /**
   * 把语言级 / 批次级事件折算成 0-99 的任务进度。
   * 逐批事件是唯一能让进度条在长任务中间动起来的信号：
   * 语言级事件只有开始(0)和结束(1)两点，单语言项目会在 0% 停留整轮。
   */
  function translationTaskProgress(event, current) {
    const count = Number(event.languageCount) || 1;
    const index = Number(event.languageIndex) || 0;
    return Math.min(99, Math.max(current.progress, ((index + Number(event.progress || 0)) / count) * 100));
  }

  async function translationOperation(request, context) {
    if (!translationPort) {
      throw Object.assign(new Error("Translation services are unavailable"), { code: "NOT_AVAILABLE" });
    }
    const result = await translationPort.translateProject({
      ...request,
      resumeExistingTargetText: (context.task?.attempt ?? 0) > 0,
      managedTaskId: context.taskId,
      operationId: context.taskId,
      onTaskEvent: (event) => {
        const current = context.task;
        if (!["running", "pausing"].includes(current?.status)) return undefined;
        const taskProgress = translationTaskProgress(event, current);
        // 用户点了暂停：批次之间就是安全点——已完成的批次都已落盘，
        // 停在这里既不丢结果，也不会把一次已经付费的请求半途丢弃。
        if (current.status === "pausing") {
          return context.checkpoint("translate", {
            progress: taskProgress,
            detail: `Paused before the next batch of ${event.targetLanguage}`,
          });
        }
        context.reportProgress(taskProgress, `Translate ${event.targetLanguage}`);
        return undefined;
      },
    });
    if (!result.ok) throw operationError(result, "Translation failed");
    const incomplete = translationTaskError(result.data?.results);
    if (incomplete) throw incomplete;
    return result.data;
  }

  async function mediaOperation(method, request, context) {
    if (!mediaService) {
      throw Object.assign(new Error("Media services are unavailable"), { code: "NOT_AVAILABLE" });
    }
    const value = { ...request, operationId: request.operationId ?? context.taskId };
    if (method === "media.probe") return mediaService.probe(value);
    if (method === "media.extractSubtitle") return mediaService.extractSubtitle(value);
    return mediaService.relink(value);
  }

  async function extractAudioOperation(request, context = null) {
    if (!mediaService || typeof selectAudioExportFile !== "function") {
      throw Object.assign(new Error("Audio extraction is unavailable"), { code: "NOT_AVAILABLE" });
    }
    const selection = await selectAudioExportFile(request);
    if (selection?.canceled) return { canceled: true };
    const destinationPath = selection?.filePath;
    if (typeof destinationPath !== "string" || !isAbsolute(destinationPath) || !destinationPath.toLowerCase().endsWith(".wav")) {
      throw Object.assign(new Error("Audio extraction destination must be an absolute WAV path"), { code: "INVALID_INPUT" });
    }
    const result = await mediaService.extractAudio({
      ...request,
      destinationPath,
      operationId: request.operationId ?? context?.taskId,
    });
    try {
      showItemInFolder?.(destinationPath);
    } catch {
      log("warn", "audio_extract.reveal_failed", { errorCode: "SHELL_FAILED" });
    }
    return { canceled: false, ...result };
  }

  async function asrOperation(method, request, context = null) {
    if (!asrProjectService) {
      throw Object.assign(new Error("ASR project services are unavailable"), { code: "NOT_AVAILABLE" });
    }
    if (method === "asr.transcribe") {
      return asrProjectService.transcribe(context
        ? { ...request, reportProgress: context.reportProgress }
        : request);
    }
    if (method === "asr.segment") return asrProjectService.segment(request);
    return asrProjectService.detectLanguages(request);
  }

  if (runtimeTaskService && typeof runtimeTaskService.register === "function") {
    runtimeTaskService.register("subtitle.exportSource", {
      kind: "export",
      stage: "export",
      label: () => "Export source subtitles",
      pauseCapability: "never",
      execute: exportSourceOperation,
    });
    runtimeTaskService.register("subtitle.exportMatrix", {
      kind: "export",
      stage: "export",
      label: () => "Export subtitle deliverables",
      pauseCapability: "never",
      execute: exportMatrixOperation,
    });
    runtimeTaskService.register("subtitle.videoExport", {
      kind: "export",
      stage: "export",
      label: (request) => request.mode === "soft_subtitle" ? "Mux soft subtitles" : "Burn ASS subtitles",
      pauseCapability: "never",
      execute: videoExportOperation,
      cancel: (request, context) => videoExportService?.cancel({
        operationId: request.operationId ?? context.taskId,
      }),
    });
    runtimeTaskService.register("audio.separation.start", {
      kind: "audio",
      stage: "separate",
      label: () => "Separate vocals, accompaniment, and background",
      pauseCapability: "never",
      execute: audioSeparationOperation,
      cancel: (request, context) => audioSeparationService?.cancel({
        operationId: request.operationId ?? context.taskId,
      }),
    });
    runtimeTaskService.register("translation.start", {
      kind: "translate",
      stage: "translate",
      label: (request) => request.targetLanguages?.length === 1
        ? `Translate ${request.targetLanguages[0]}`
        : "Translate project",
      targetLanguageCode: (request) => request.targetLanguages?.length === 1 ? request.targetLanguages[0] : null,
      // 批次之间是真正的安全点，所以翻译可以暂停后再继续，而不是只能取消。
      pauseCapability: "checkpoint",
      execute: translationOperation,
      cancel: (_request, context) => translationWorkerClient?.cancelTranslation?.({ operationId: context.taskId }),
    });
    runtimeTaskService.register("media.extractAudio", {
      kind: "media",
      stage: "extract",
      label: () => "Extract audio",
      pauseCapability: "never",
      execute: extractAudioOperation,
      cancel: (request, context) => mediaService?.cancelOperation({
        projectId: request.projectId,
        operationId: request.operationId ?? context.taskId,
      }),
    });
    for (const [operation, stage, label] of [
      ["media.probe", "detect", "Probe media"],
      ["media.extractSubtitle", "extract", "Extract subtitle"],
      ["media.relink", "detect", "Relink media"],
    ]) {
      runtimeTaskService.register(operation, {
        kind: "media",
        stage,
        label: () => label,
        pauseCapability: "never",
        execute: (request, context) => mediaOperation(operation, request, context),
        cancel: (request, context) => mediaService?.cancelOperation({
          projectId: request.projectId,
          operationId: request.operationId ?? context.taskId,
        }),
      });
    }
    for (const [operation, stage, label] of [
      ["asr.transcribe", "asr", "Transcribe media"],
      ["asr.segment", "segment", "Segment ASR result"],
      ["asr.language.detect", "detect", "Detect segment languages"],
    ]) {
      runtimeTaskService.register(operation, {
        kind: "asr",
        stage,
        label: () => label,
        pauseCapability: "never",
        execute: (request, context) => asrOperation(operation, request, context),
        // operationId 缺失时退回 taskId，与上面媒体那组保持一致：没有兜底的话
        // 取消会打空，子进程一直跑到超时才停，界面就长期卡在"停止中"。
        cancel: (request, context) => asrProjectService?.cancel({
          projectId: request.projectId,
          operationId: request.operationId ?? context.taskId,
        }),
      });
    }
  }

  async function runTracked(operation, request, fallback) {
    return runtimeTaskService && typeof runtimeTaskService.run === "function"
      ? runtimeTaskService.run(operation, request)
      : fallback();
  }

  function assertMainSender(event) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return {
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "Main window is unavailable" },
      };
    }
    if (
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      return {
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "IPC sender frame is not allowed" },
      };
    }
    return null;
  }

  async function handleWindowControl(action) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Main window is unavailable" },
      };
    }
    if (action === "minimize") {
      mainWindow.minimize();
      return { ok: true, data: { ok: true } };
    }
    if (action === "maximizeOrRestore") {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      return { ok: true, data: { ok: true } };
    }
    if (action === "close") {
      setTimeout(() => {
        void Promise.resolve()
          .then(() => requestCloseAfterFlush())
          .catch(() => log("error", "window.close_failed", { errorCode: "INTERNAL" }));
      }, 0);
      return { ok: true, data: { ok: true } };
    }
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "window action is invalid" },
    };
  }

  function reconcileProjectIndex() {
    return port.rebuildProjectIndex();
  }

  async function dispatch(method, request) {
    switch (method) {
      case "project.create": {
        const result = port.createProject(request.project);
        return { ok: true, data: { projectId: result.projectId } };
      }
      case "project.save": {
        port.saveProject(request.project);
        return { ok: true, data: { ok: true } };
      }
      case "project.open": {
        const project = port.openProject(request.projectId);
        return { ok: true, data: project };
      }
      case "project.runtimeState": {
        if (!translationPort) {
          return {
            ok: false,
            error: { code: "INTERNAL", message: "Translation services are unavailable" },
          };
        }
        return translationPort.getProjectRuntimeState(request);
      }
      case "project.listRecent": {
        const rows = port.listRecentProjects().map(toIndexSummary);
        return { ok: true, data: rows };
      }
      case "capability.status": {
        if (!capabilityService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Capability service is unavailable" } };
        return { ok: true, data: await capabilityService.getStatus(request) };
      }
      case "settings.get": {
        if (!appSettingsService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Application settings are unavailable" } };
        return { ok: true, data: appSettingsService.get() };
      }
      case "settings.selectDirectory": {
        if (typeof selectSettingsDirectory !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Directory picker is unavailable" } };
        }
        return { ok: true, data: await selectSettingsDirectory(request.pathKey) };
      }
      case "settings.selectModelStorageDestination": {
        if (typeof selectModelStorageDestination !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Model storage destination picker is unavailable" } };
        }
        return { ok: true, data: await selectModelStorageDestination() };
      }
      case "settings.transferModelStorage": {
        if (typeof transferModelStorage !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Model storage transfer is unavailable" } };
        }
        return { ok: true, data: await transferModelStorage(request.selectionToken) };
      }
      case "settings.save": {
        if (!appSettingsService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Application settings are unavailable" } };
        return { ok: true, data: await appSettingsService.save(request.settings) };
      }
      case "settings.reset": {
        if (!appSettingsService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Application settings are unavailable" } };
        return { ok: true, data: await appSettingsService.reset() };
      }
      case "downloads.status": {
        return { ok: true, data: { items: [
          ...(asrModelInstaller?.getDownloadStatus?.() ?? []),
          ...(songClassifierInstaller?.getDownloadStatus?.() ?? []),
        ], sources: downloadSourceHealth } };
      }
      case "downloads.probeSources": {
        if (!asrModelInstaller?.getSourceHealth) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Download source probe is unavailable" } };
        downloadSourceHealth = await asrModelInstaller.getSourceHealth();
        return { ok: true, data: { items: [
          ...(asrModelInstaller.getDownloadStatus?.() ?? []),
          ...(songClassifierInstaller?.getDownloadStatus?.() ?? []),
        ], sources: downloadSourceHealth } };
      }
      case "backup.app.create": {
        if (!backupService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Backup service is unavailable" } };
        return { ok: true, data: backupService.createAppBackup() };
      }
      case "backup.restore.select": {
        if (!backupService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Backup service is unavailable" } };
        return { ok: true, data: await backupService.selectRestore(request) };
      }
      case "backup.restore.apply": {
        if (!backupService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Backup service is unavailable" } };
        return { ok: true, data: await backupService.restore(request) };
      }
      case "diagnostics.preview": {
        if (!diagnosticsService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Diagnostics service is unavailable" } };
        return { ok: true, data: await diagnosticsService.preview() };
      }
      case "diagnostics.export": {
        if (!diagnosticsService) return { ok: false, error: { code: "NOT_AVAILABLE", message: "Diagnostics service is unavailable" } };
        return { ok: true, data: await diagnosticsService.exportPackage() };
      }
      case "project.package": {
        if (request.destination === "backup" && !appSettingsService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Application settings are unavailable" } };
        }
        const result = port.createProjectPackage({
          ...request,
          ...(request.destination === "backup" ? { outputDir: appSettingsService.get().backupPath } : {}),
        });
        if (!result.ok) return result;
        const { outputPath, ...publicPackage } = result.package;
        if (request.destination === "backup" && outputPath) {
          try {
            showItemInFolder?.(outputPath);
          } catch {
            log("warn", "backup.reveal_failed", { errorCode: "SHELL_FAILED" });
          }
        }
        return { ok: true, data: publicPackage };
      }
      case "project.deletePermanently": {
        const busyTask = (taskCoordinator?.list() ?? port.listTasks?.() ?? []).find(
          (task) => task.projectId === request.projectId
            && ["pending", "running", "pausing", "paused", "cancelling"].includes(task.status),
        );
        if (busyTask) {
          return { ok: false, error: { code: "CONFLICT", message: "Project has an active task" } };
        }
        await onBeforePermanentProjectDelete?.(request.projectId);
        const result = port.deleteProjectPermanently(request.projectId);
        if (!result.ok) return result;
        return { ok: true, data: { projectId: result.projectId, deleted: true } };
      }
      case "resource.list":
        return { ok: true, data: port.listResources(request) };
      case "resource.save":
        return {
          ok: true,
          data: port.saveResource(
            request.resource,
            request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision },
          ),
        };
      case "resource.delete":
        return {
          ok: true,
          data: {
            deleted: port.deleteResource(request.resourceId, { expectedRevision: request.expectedRevision }),
          },
        };
      case "resource.snapshot.list":
        return {
          ok: true,
          data: port.listProjectResourceSnapshots(
            request.projectId,
            request.kind === undefined ? {} : { kind: request.kind },
          ),
        };
      case "resource.snapshot.refresh":
        return { ok: true, data: port.refreshProjectResourceSnapshot(request) };
      case "subtitle.import": {
        const result = port.importSubtitle({
          fileName: request.fileName,
          bytes: request.bytes,
          encoding: request.encoding,
          defaults: request.defaults,
        });
        if (result.needsEncodingConfirmation) {
          return {
            ok: true,
            data: {
              needsEncodingConfirmation: true,
              encodingCandidates: result.encodingCandidates || [],
              warnings: result.warnings || [],
            },
          };
        }
        if (!result.ok) {
          return {
            ok: false,
            error: result.error || {
              code: "INTERNAL",
              message: "Subtitle import failed",
            },
          };
        }
        return {
          ok: true,
          data: {
            project: result.project,
            warnings: result.warnings || [],
          },
        };
      }
      case "subtitle.exportSource": {
        const operationRequest = {
          projectId: request.projectId,
          mode: request.mode,
          format: request.format,
          ...(request.destination ? { destination: request.destination } : {}),
        };
        return {
          ok: true,
          data: await runTracked(
            "subtitle.exportSource",
            operationRequest,
            () => exportSourceOperation(operationRequest),
          ),
        };
      }
      case "window.control":
        return handleWindowControl(request.action);
      case "tasks.subscribe":
        return {
          ok: true,
          data: {
            subscribed: true,
            tasks: (taskCoordinator?.list() ?? port.listTasks?.() ?? [])
              .filter((task) => !request.projectId || task.projectId === request.projectId)
              .map(toPublicTask),
          },
        };
      case "tasks.control": {
        const controller = runtimeTaskService ?? taskCoordinator;
        if (!controller || typeof controller.control !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Task controls are unavailable" } };
        }
        return { ok: true, data: { task: toPublicTask(controller.control(request)) } };
      }
      case "tasks.purge": {
        // 只删终态任务。运行中、暂停中、以及还能重试的 recoverable 一律留下——
        // 删掉一条 recoverable 等于悄悄拿走用户的恢复能力。
        if (typeof port.purgeTerminalTasks !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Task history cannot be purged" } };
        }
        const purged = port.purgeTerminalTasks({ projectId: request.projectId ?? null });
        return { ok: true, data: { deletedCount: purged.deletedCount, keptCount: purged.keptCount } };
      }
      case "credential.save": {
        const store = requireCredentialStore();
        const status = store.saveCredential({
          credentialId: request.credentialId,
          secret: request.secret,
          providerId: request.providerId ?? "",
          label: request.label ?? "",
        });
        // 换钥匙要重新验证连通性，但「这个服务商提供哪些型号」跟钥匙无关，
        // 已拉取的模型列表必须保留（整行删除会把它一起抹掉）。
        if (request.providerId) port.invalidateProviderReadiness(request.providerId);
        else port.clearProviderReadinessByCredentialId(request.credentialId);
        return { ok: true, data: status };
      }
      case "credential.delete": {
        const store = requireCredentialStore();
        const previous = store.getStatus({ credentialId: request.credentialId });
        const result = store.deleteCredential({ credentialId: request.credentialId });
        port.clearProviderReadinessByCredentialId(request.credentialId);
        if (previous.providerId) port.clearProviderReadiness(previous.providerId);
        return { ok: true, data: { deleted: true, existed: result.existed } };
      }
      case "credential.status": {
        const store = requireCredentialStore();
        const status = store.getStatus(
          request.credentialId !== undefined ? { credentialId: request.credentialId } : {},
        );
        return { ok: true, data: status };
      }
      case "provider.testConnection": {
        if (!translationPort) {
          return {
            ok: false,
            error: { code: "INTERNAL", message: "Translation services are unavailable" },
          };
        }
        return translationPort.testProviderConnection(request);
      }
      case "provider.listModels": {
        if (typeof translationPort?.listProviderModels !== "function") {
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: "模型列表服务不可用",
              details: { providerErrorClass: "unknown" },
            },
          };
        }
        return translationPort.listProviderModels(request);
      }
      case "provider.runtimeState": {
        if (!translationPort) {
          return {
            ok: false,
            error: { code: "INTERNAL", message: "Translation services are unavailable" },
          };
        }
        return translationPort.getProviderRuntimeState(request);
      }
      case "asr.capability": {
        if (!asrRuntimePort && typeof getAsrCapabilityStatus !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "ASR services are unavailable" } };
        }
        return { ok: true, data: await (getAsrCapabilityStatus ?? (() => asrRuntimePort.getCapabilityStatus()))() };
      }
      case "asr.model.install":
      case "asr.model.import":
      case "asr.model.uninstall":
      case "asr.model.cancel": {
        if (!asrModelInstaller) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "ASR model management is unavailable" } };
        }
        const action = method.slice("asr.model.".length);
        const handler = {
          install: (value) => asrModelInstaller.install(value),
          import: (value) => asrModelInstaller.importModel(value),
          uninstall: (value) => asrModelInstaller.uninstall(value),
          cancel: (value) => asrModelInstaller.cancel(value),
        }[action];
        return { ok: true, data: await handler(request) };
      }
      case "asr.runtime.install":
      case "asr.runtime.import":
      case "asr.runtime.uninstall":
      case "asr.runtime.cancel": {
        if (!asrModelInstaller) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "ASR runtime management is unavailable" } };
        }
        const action = method.slice("asr.runtime.".length);
        const handler = {
          install: (value) => asrModelInstaller.installRuntime(value),
          import: (value) => asrModelInstaller.importRuntime(value),
          uninstall: (value) => asrModelInstaller.uninstallRuntime(value),
          cancel: (value) => asrModelInstaller.cancel(value),
        }[action];
        return { ok: true, data: await handler(request) };
      }
      case "asr.songClassifier.install":
      case "asr.songClassifier.uninstall":
      case "asr.songClassifier.cancel": {
        if (!songClassifierInstaller) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Song classifier management is unavailable" } };
        }
        const action = method.slice("asr.songClassifier.".length);
        const handler = {
          install: (value) => songClassifierInstaller.install(value),
          uninstall: (value) => songClassifierInstaller.uninstall(value),
          cancel: (value) => songClassifierInstaller.cancel(value),
        }[action];
        return { ok: true, data: await handler(request) };
      }
      case "asr.device.status":
      case "asr.device.preference":
      case "asr.device.detect":
      case "asr.device.cancel": {
        if (!asrDeviceSelector) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "ASR device services are unavailable" } };
        }
        const action = method.slice("asr.device.".length);
        const handler = {
          status: () => asrDeviceSelector.getStatus(),
          preference: (value) => asrDeviceSelector.setPreference(value),
          detect: (value) => asrDeviceSelector.detect(value),
          cancel: (value) => asrDeviceSelector.cancel(value),
        }[action];
        return { ok: true, data: await handler(request) };
      }
      case "asr.project.status":
      case "asr.language.update":
      case "asr.cancel": {
        if (!asrProjectService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "ASR project services are unavailable" } };
        }
        const handler = {
          "asr.project.status": (value) => asrProjectService.getStatus(value),
          "asr.language.update": (value) => asrProjectService.updateLanguages(value),
          "asr.cancel": (value) => asrProjectService.cancel(value),
        }[method];
        return { ok: true, data: await handler(request) };
      }
      case "asr.transcribe":
      case "asr.segment":
      case "asr.language.detect": {
        return {
          ok: true,
          data: await runTracked(method, request, () => asrOperation(method, request)),
        };
      }
      case "subtitle.exportMatrix": {
        const operationRequest = {
          projectId: request.projectId,
          requests: request.requests,
          ...(request.destination ? { destination: request.destination } : {}),
        };
        return {
          ok: true,
          data: await runTracked(
            "subtitle.exportMatrix",
            operationRequest,
            () => exportMatrixOperation(operationRequest),
          ),
        };
      }
      case "subtitle.exportApprovedBatch": {
        return { ok: true, data: await exportApprovedBatchOperation(request) };
      }
      case "subtitle.videoExport": {
        const operationRequest = {
          projectId: request.projectId,
          subtitleExportRecordId: request.subtitleExportRecordId,
          mode: request.mode,
          operationId: request.operationId,
        };
        return {
          ok: true,
          data: await runTracked(
            "subtitle.videoExport",
            operationRequest,
            () => videoExportOperation(operationRequest),
          ),
        };
      }
      case "audio.separation.capability": {
        if (!audioSeparationService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Audio separation services are unavailable" } };
        }
        return { ok: true, data: await audioSeparationService.getCapability() };
      }
      case "audio.separation.start": {
        const operationRequest = {
          projectId: request.projectId,
          operationId: request.operationId,
        };
        return {
          ok: true,
          data: await runTracked(
            "audio.separation.start",
            operationRequest,
            () => audioSeparationOperation(operationRequest),
          ),
        };
      }
      case "asr.info.open": {
        if (typeof openAsrInfo !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "ASR source information is unavailable" } };
        }
        return { ok: true, data: await openAsrInfo(request) };
      }
      case "translation.start": {
        if (!translationPort) {
          return {
            ok: false,
            error: { code: "INTERNAL", message: "Translation services are unavailable" },
          };
        }
        /*
         * 入队后立刻返回，不等整轮翻译跑完。
         *
         * 旧版走的是 runtimeTaskService.run()，它要等到最后一条字幕译完才 resolve，
         * 于是渲染层那句 `await startProject(...)` 会挂住十几分钟，
         * 「开始翻译」按下去之后既不跳转也没有任何反馈——用户只能反复点。
         * 批量入口（batch.start）本来就用 enqueue，这里对齐它。
         *
         * 失败不会被吞掉：执行期的错误会把任务置为 failed 并带上错误码，
         * 经 worker 事件推给界面的进度横幅。
         */
        if (runtimeTaskService && typeof runtimeTaskService.enqueue === "function") {
          const task = runtimeTaskService.enqueue("translation.start", request);
          return { ok: true, data: { projectId: request.projectId, task: toPublicTask(task) } };
        }
        return translationPort.translateProject(request);
      }
      case "batch.createSession": {
        if (!mediaService || typeof mediaService.createBatchSession !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Batch media services are unavailable" } };
        }
        return { ok: true, data: await mediaService.createBatchSession(request) };
      }
      case "batch.discardSession": {
        if (!mediaService || typeof mediaService.discardBatchSession !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Batch media services are unavailable" } };
        }
        return { ok: true, data: mediaService.discardBatchSession(request) };
      }
      case "batch.commitSession": {
        if (!mediaService || typeof mediaService.commitBatchSession !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Batch media services are unavailable" } };
        }
        return { ok: true, data: await mediaService.commitBatchSession(request) };
      }
      case "batch.start": {
        if (!runtimeTaskService || typeof runtimeTaskService.enqueue !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Batch task scheduling is unavailable" } };
        }
        const projects = request.projectIds.map((projectId) => port.openProject(projectId));
        if (projects.some((project) => !project)) {
          return { ok: false, error: { code: "NOT_FOUND", message: "Batch project not found" } };
        }
        const existingTasks = taskCoordinator?.list() ?? port.listTasks?.() ?? [];
        const plan = planBatchTranslation({
          batchId: request.batchId,
          projects,
          existingTasks,
        });
        const { batchId, projectIds: _projectIds, ...translationOptions } = request;
        const startedTasks = plan.starts.map((entry) => runtimeTaskService.enqueue(
          "translation.start",
          {
            ...translationOptions,
            projectId: entry.projectId,
            targetLanguages: entry.targetLanguages,
            batchId,
            batchEstimatedTokens: entry.estimatedTokens,
          },
        ));
        const taskByProject = new Map(
          [...plan.existingTasks, ...startedTasks].map((task) => [task.projectId, task]),
        );
        return {
          ok: true,
          data: {
            batchId,
            tasks: request.projectIds.map((projectId) => toPublicTask(taskByProject.get(projectId))),
          },
        };
      }
      case "media.selectSource": {
        if (!mediaService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media services are unavailable" } };
        }
        const result = await mediaService.selectSource({
          copyIntoProject: Boolean(request.copyIntoProject),
          defaults: request.defaults || {},
          operationId: request.operationId,
        });
        return { ok: true, data: result };
      }
      case "media.probe": {
        if (!mediaService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media services are unavailable" } };
        }
        const result = await runTracked("media.probe", request, () => mediaService.probe(request));
        return { ok: true, data: result };
      }
      case "media.selectStreams": {
        if (!mediaService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media services are unavailable" } };
        }
        const result = mediaService.selectStreams(request);
        return { ok: true, data: result };
      }
      case "media.extractSubtitle": {
        if (!mediaService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media services are unavailable" } };
        }
        const result = await runTracked(
          "media.extractSubtitle",
          request,
          () => mediaService.extractSubtitle(request),
        );
        return { ok: true, data: result };
      }
      case "media.waveform": {
        if (!mediaService || typeof mediaService.getWaveform !== "function") {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media waveform is unavailable" } };
        }
        return { ok: true, data: await mediaService.getWaveform(request) };
      }
      case "media.extractAudio": {
        const result = await runTracked(
          "media.extractAudio",
          request,
          () => extractAudioOperation(request),
        );
        return { ok: true, data: result };
      }
      case "media.activateSourceTrack": {
        if (!mediaService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media services are unavailable" } };
        }
        const result = mediaService.activateSourceTrack(request);
        return { ok: true, data: result };
      }
      case "media.relink": {
        if (!mediaService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media services are unavailable" } };
        }
        const result = await runTracked("media.relink", request, () => mediaService.relink(request));
        return { ok: true, data: result };
      }
      case "media.previewUrl": {
        if (!issueMediaPreviewUrl) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media preview is unavailable" } };
        }
        const mainWindow = getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
          return { ok: false, error: { code: "INTERNAL", message: "Main window is unavailable" } };
        }
        const result = issueMediaPreviewUrl({
          projectId: request.projectId,
          assetId: request.assetId || "primary",
          webContentsId: mainWindow.webContents.id,
        });
        return { ok: true, data: result };
      }
      case "media.cancel": {
        if (!mediaService) {
          return { ok: false, error: { code: "NOT_AVAILABLE", message: "Media services are unavailable" } };
        }
        return { ok: true, data: await mediaService.cancelOperation(request) };
      }
      default:
        return {
          ok: false,
          error: { code: "INVALID_INPUT", message: "unknown or unsupported method" },
        };
    }
  }

  return {
    async handle(event, envelope) {
      const senderError = assertMainSender(event);
      if (senderError) {
        log("warn", "ipc.denied", { reason: "sender" });
        return senderError;
      }
      const validated = validateIpcEnvelope(envelope);
      if (!validated.ok) {
        // The rejected envelope is attacker-controlled. Keep its contents out of logs.
        log("warn", "ipc.rejected", { errorCode: validated.error?.code });
        return validated;
      }
      try {
        const result = await dispatch(validated.method, validated.request);
        log(result.ok ? "info" : "warn", "ipc.completed", { method: validated.method, errorCode: result.error?.code ?? null });
        return result;
      } catch (error) {
        const mapped = mapPortError(error);
        log("error", "ipc.failed", { method: validated.method, errorCode: mapped.code });
        return { ok: false, error: mapped };
      }
    },
    reconcileProjectIndex,
    hasActiveTasks() {
      return Boolean(runtimeTaskService?.hasActiveTasks?.());
    },
    async stopActiveTasks() {
      await runtimeTaskService?.stopAll?.();
    },
    /** Internal main/worker bridge only — not exposed on DesktopApi. */
    revealCredentialSecret(credentialId) {
      return requireCredentialStore().revealSecret({ credentialId });
    },
    close() {
      credentialStore?.close?.();
      port.close();
    },
  };
}
