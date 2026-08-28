import { randomUUID } from "node:crypto";

type SupervisorProcess = {
  pid?: number;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: "message", listener: (message: any) => void): SupervisorProcess;
  on(event: "exit", listener: (code: number) => void): SupervisorProcess;
};

type PendingRequest = {
  resolve(value: any): void;
  reject(error: Error): void;
  onBatch?: (event: Record<string, unknown>) => unknown;
  onProgress?: (event: Record<string, unknown>) => unknown;
};

function runtimeDescriptor(runtime: Record<string, unknown>, includeModel = false) {
  return {
    engineId: runtime.engineId,
    engineVersion: runtime.engineVersion,
    runtimeId: runtime.runtimeId,
    runtimeVersion: runtime.runtimeVersion,
    device: runtime.device,
    executablePath: runtime.executablePath,
    cwd: runtime.cwd,
    sidecarPath: runtime.sidecarPath,
    ...(includeModel ? {
      modelPath: runtime.modelPath,
      modelId: runtime.modelId,
      modelVersion: runtime.modelVersion,
      modelHash: runtime.modelHash,
      alignerPath: runtime.alignerPath,
      alignerId: runtime.alignerId,
      alignerVersion: runtime.alignerVersion,
      alignerHash: runtime.alignerHash,
      vadModelPath: runtime.vadModelPath,
      vadModelId: runtime.vadModelId,
      vadModelVersion: runtime.vadModelVersion,
      vadModelHash: runtime.vadModelHash,
      vadExecutablePath: runtime.vadExecutablePath,
    } : {}),
  };
}

export function createTaskSupervisorClient({
  forkWorker,
  entryPath,
  readyTimeoutMs = 10_000,
  heartbeatTimeoutMs = 15_000,
  shutdownTimeoutMs = 2_500,
  useFakeProvider = false,
  fakeFailureLanguage,
  fakeDelayMs = 0,
  killProcessTree = () => {},
  onCrash = () => {},
  onEvent = () => {},
}: {
  forkWorker: () => SupervisorProcess;
  entryPath: string;
  readyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  useFakeProvider?: boolean;
  fakeFailureLanguage?: string;
  fakeDelayMs?: number;
  killProcessTree?: (pid: number) => void;
  onCrash?: (event: { code: number | null; pid?: number; reason: "exit" | "heartbeat_timeout" }) => void;
  onEvent?: (event: Record<string, unknown>) => void;
}) {
  let child: SupervisorProcess | null = null;
  let readyPromise: Promise<SupervisorProcess> | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let activeAsrRequests = 0;
  const pending = new Map<string, PendingRequest>();
  const externalPids = new Set<number>();

  function supervisorError(message: string, code = "WORKER_CRASHED") {
    const error = new Error(message);
    Object.assign(error, { code });
    return error;
  }

  function rejectPending(error: Error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function rejectFromSupervisor(payload: any) {
    const error = supervisorError(
      payload?.message ?? "Task supervisor failed",
      payload?.code ?? "INTERNAL",
    );
    Object.assign(error, {
      providerErrorClass: payload?.providerErrorClass ?? "unknown",
      httpStatus: payload?.httpStatus ?? null,
      retryable: Boolean(payload?.retryable),
      partialOutcome: payload?.partialOutcome,
    });
    const details = payload?.safeDetails;
    if (Number.isSafeInteger(details?.chunkIndex) && details.chunkIndex >= 0 &&
      Number.isSafeInteger(details?.startMs) && details.startMs >= 0 &&
      Number.isSafeInteger(details?.endMs) && details.endMs > details.startMs) {
      Object.assign(error, { safeDetails: {
        chunkIndex: details.chunkIndex,
        startMs: details.startMs,
        endMs: details.endMs,
      } });
    }
    return error;
  }

  function killExternalChildren() {
    for (const pid of externalPids) killProcessTree(pid);
    externalPids.clear();
  }

  function clearHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  function finishClose() {
    const resolve = resolveClose;
    resolveClose = null;
    resolve?.();
  }

  function armHeartbeat(spawned: SupervisorProcess) {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      if (child !== spawned) return;
      child = null;
      readyPromise = null;
      killExternalChildren();
      spawned.kill();
      rejectPending(supervisorError("Task supervisor heartbeat timed out"));
      onCrash({ code: null, pid: spawned.pid, reason: "heartbeat_timeout" });
    }, heartbeatTimeoutMs);
    heartbeatTimer.unref?.();
  }

  function ensureReady() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise<SupervisorProcess>((resolve, reject) => {
      const spawned = forkWorker();
      child = spawned;
      let ready = false;
      let readySettled = false;
      const rejectBeforeReady = (error: Error) => {
        if (readySettled) return;
        readySettled = true;
        rejectReady = null;
        reject(error);
      };
      rejectReady = rejectBeforeReady;
      const timer = setTimeout(() => {
        if (child === spawned) {
          child = null;
          readyPromise = null;
          killExternalChildren();
        }
        spawned.kill();
        rejectBeforeReady(supervisorError(`Task supervisor did not become ready: ${entryPath}`));
      }, readyTimeoutMs);
      spawned.on("message", (message) => {
        if (message?.type === "supervisor.ready") {
          if (readySettled) return;
          ready = true;
          readySettled = true;
          rejectReady = null;
          clearTimeout(timer);
          armHeartbeat(spawned);
          resolve(spawned);
          return;
        }
        if (message?.type === "supervisor.heartbeat") {
          armHeartbeat(spawned);
          return;
        }
        if (
          message?.type === "supervisor.childProcess" &&
          Number.isInteger(message.pid) && message.pid > 0 &&
          typeof message.active === "boolean"
        ) {
          if (message.active) externalPids.add(message.pid);
          else externalPids.delete(message.pid);
          return;
        }
        if (message?.type === "supervisor.event" && message.event && typeof message.event === "object") {
          onEvent(message.event);
          return;
        }
        if (message?.type === "supervisor.asrProgress") {
          const request = pending.get(message.correlationId);
          const progress = Number(message.event?.progress);
          if (request?.onProgress && Number.isFinite(progress) && progress >= 0 && progress <= 100) {
            try {
              request.onProgress({
                progress,
                completedChunks: Number(message.event?.completedChunks) || 0,
                totalChunks: Number(message.event?.totalChunks) || 0,
              });
            } catch {
              /* UI progress must not affect recognition */
            }
          }
          return;
        }
        if (message?.type === "supervisor.translationBatch") {
          const request = pending.get(message.correlationId);
          if (!request) return;
          Promise.resolve()
            .then(() => request.onBatch?.(message.event))
            .then(
              () => spawned.postMessage({
                type: "translate.batchAck",
                correlationId: message.correlationId,
                batchId: message.batchId,
                ok: true,
              }),
              (error) => spawned.postMessage({
                type: "translate.batchAck",
                correlationId: message.correlationId,
                batchId: message.batchId,
                ok: false,
                error: {
                  code: typeof error?.code === "string" ? error.code : "INTERNAL",
                  message: error instanceof Error ? error.message : "Translation batch callback failed",
                },
              }),
            )
            .catch((error) => {
              if (pending.get(message.correlationId) !== request) return;
              pending.delete(message.correlationId);
              request.reject(supervisorError(error instanceof Error ? error.message : "Task supervisor messaging failed"));
            });
          return;
        }
        const request = pending.get(message?.correlationId);
        if (!request || message?.type !== "supervisor.result") return;
        pending.delete(message.correlationId);
        if (message.ok) request.resolve(message.data);
        else request.reject(rejectFromSupervisor({ ...message.error, partialOutcome: message.partialOutcome }));
      });
      spawned.on("exit", (code) => {
        clearTimeout(timer);
        clearHeartbeat();
        if (shutdownTimer) clearTimeout(shutdownTimer);
        shutdownTimer = null;
        if (!ready) rejectBeforeReady(supervisorError(`Task supervisor exited before ready with code ${code}`));
        if (child !== spawned) return;
        child = null;
        readyPromise = null;
        killExternalChildren();
        if (closing) {
          finishClose();
          return;
        }
        rejectPending(supervisorError(`Task supervisor exited with code ${code}`));
        onCrash({ code, pid: spawned.pid, reason: "exit" });
      });
    });
    return readyPromise;
  }

  async function request(
    type: string,
    payload: Record<string, unknown> = {},
    callbacks: Pick<PendingRequest, "onBatch" | "onProgress"> = {},
  ) {
    if (closing) throw supervisorError("Task supervisor closed", "CANCELLED");
    const supervisor = await ensureReady();
    const correlationId = randomUUID();
    return new Promise<any>((resolve, reject) => {
      pending.set(correlationId, { resolve, reject, ...callbacks });
      try {
        supervisor.postMessage({ type, correlationId, ...payload });
      } catch (error) {
        pending.delete(correlationId);
        reject(supervisorError(error instanceof Error ? error.message : "Task supervisor messaging failed"));
      }
    });
  }

  async function asrRequest(
    type: string,
    payload: Record<string, unknown>,
    callbacks: Pick<PendingRequest, "onProgress"> = {},
  ) {
    activeAsrRequests += 1;
    try {
      return await request(type, payload, callbacks);
    } finally {
      activeAsrRequests -= 1;
    }
  }

  return {
    request,
    testConnection(payload: Record<string, unknown>) {
      return request("provider.test", { useFakeProvider, ...payload });
    },
    listModels(payload: Record<string, unknown>) {
      return request("provider.models", { useFakeProvider, ...payload });
    },
    translateLanguage(payload: Record<string, unknown>) {
      const { onBatch, signal: _signal, ...serializablePayload } = payload;
      return request("translate.run", {
        useFakeProvider,
        fakeFailureLanguage,
        fakeDelayMs: Number.isFinite(fakeDelayMs) ? Math.min(10_000, Math.max(0, fakeDelayMs)) : 0,
        ...serializablePayload,
      }, {
        ...(typeof onBatch === "function" ? { onBatch: onBatch as PendingRequest["onBatch"] } : {}),
      });
    },
    cancelTranslation(payload: { operationId: string }) {
      return request("translate.cancel", payload);
    },
    runMediaProcess(payload: Record<string, unknown>) {
      return request("media.run", payload);
    },
    cancelMedia(payload: { operationId: string }) {
      return request("media.cancel", payload);
    },
    isAsrBusy() {
      return activeAsrRequests > 0;
    },
    probeAsrRuntime(payload: { operationId: string; runtime: Record<string, unknown> }) {
      return asrRequest("asr.runtimeProbe", {
        operationId: payload.operationId,
        runtime: runtimeDescriptor(payload.runtime),
      });
    },
    transcribeAsr(payload: Record<string, any>) {
      return asrRequest("asr.transcribe", {
        operationId: payload.operationId,
        runtime: runtimeDescriptor(payload.runtime, true),
        workRoot: payload.workRoot,
        audioPath: payload.audioPath,
        outputName: payload.outputName,
        mediaDurationMs: payload.mediaDurationMs,
        languageMode: payload.languageMode,
        languageHint: payload.languageHint,
        vad: payload.vad,
        checkpointPath: payload.checkpointPath,
        checkpointFingerprint: payload.checkpointFingerprint,
      }, {
        ...(typeof payload.onProgress === "function" ? { onProgress: payload.onProgress } : {}),
      });
    },
    detectAsrLanguageRegion(payload: Record<string, any>) {
      return asrRequest("asr.languageDetect", {
        operationId: payload.operationId,
        runtime: runtimeDescriptor(payload.runtime, true),
        workRoot: payload.workRoot,
        audioPath: payload.audioPath,
        outputName: payload.outputName,
        mediaDurationMs: payload.mediaDurationMs,
        segmentId: payload.segmentId,
        startMs: payload.startMs,
        endMs: payload.endMs,
      });
    },
    cancelAsr(payload: { operationId: string }) {
      return asrRequest("asr.cancel", payload);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      clearHeartbeat();
      rejectPending(supervisorError("Task supervisor closed", "CANCELLED"));
      if (rejectReady) {
        rejectReady(supervisorError("Task supervisor closed", "CANCELLED"));
        readyPromise = null;
      }
      const current = child;
      if (!current) {
        readyPromise = null;
        finishClose();
        return closePromise;
      }
      try {
        current.postMessage({ type: "supervisor.shutdown", correlationId: randomUUID() });
      } catch {
        current.kill();
      }
      shutdownTimer = setTimeout(() => {
        if (child === current) {
          killExternalChildren();
          current.kill();
          child = null;
          readyPromise = null;
        }
        finishClose();
      }, shutdownTimeoutMs);
      shutdownTimer.unref?.();
      return closePromise;
    },
  };
}
