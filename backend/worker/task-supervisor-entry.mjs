/**
 * Phase 8 single utilityProcess supervisor for media, ASR, and translation work.
 * Main owns durable task state; this process owns execution and native children.
 */
import { createAsrRuntimeProcess } from "../asr/runtime-process.mjs";
import { MEDIA_ERROR_CODES, MEDIA_LIMITS } from "../media/constants.mjs";
import { runManagedProcess } from "../media/process-runner.mjs";
import { createAnthropicClient } from "../provider/anthropic-client.mjs";
import { createProviderModelsClient } from "../provider/model-list-client.mjs";
import { createOpenAICompatibleClient } from "../provider/openai-compatible-client.mjs";
import { createTranslateService } from "../translation/translate-service.mjs";

const port = process.parentPort;
const activeMedia = new Map();
const activeTranslations = new Map();
const pendingTranslationBatches = new Map();
const inFlight = new Set();
let shuttingDown = false;

function send(message) {
  port.postMessage(message);
}

const asrRuntime = createAsrRuntimeProcess({
  reportChildProcess: (event) => send({ type: "supervisor.childProcess", ...event }),
});
// 按注册表 profile 选择执行客户端；未知 profile 退回 OpenAI 兼容实现。
const realClients = Object.freeze({
  anthropic: createAnthropicClient(),
  openaiCompatible: createOpenAICompatibleClient(),
});

function selectProviderClient(providerProfile) {
  const profile = typeof providerProfile === "string" ? providerProfile : "";
  return profile.startsWith("anthropic") ? realClients.anthropic : realClients.openaiCompatible;
}

// 模型列表按 style 区分鉴权头，单个客户端即可覆盖全部服务商。
const realModelsClient = createProviderModelsClient();
const fakeModelsClient = {
  async listModels({ baseUrl = "https://fake.local/v1", style = "bearer" }) {
    return {
      models: [
        { id: "fake-model-a", label: "fake-model-a" },
        { id: "fake-model-b", label: "fake-model-b" },
      ],
      truncated: false,
      style,
      baseUrlDisplay: baseUrl,
    };
  },
};

const fakeClient = {
  async testConnection({ transportMode = "responses", baseUrl = "https://fake.local/v1", model }) {
    return { ok: true, transportMode, baseUrlDisplay: baseUrl, model: model || null };
  },
  async createStructuredTranslation({ messages, transportMode = "responses" }) {
    const payload = JSON.parse(messages[1].content);
    return {
      rawText: JSON.stringify({
        targetLanguage: payload.targetLanguage,
        segments: payload.segments.map((segment) => ({
          segmentId: segment.segmentId,
          text: `[${payload.targetLanguage}] ${segment.text}`,
        })),
      }),
      usage: { inputTokens: 8, outputTokens: 8 },
      baseUrlDisplay: "https://fake.local/v1",
      transportMode,
    };
  },
};
const realTranslationByClient = new Map();
const fakeTranslation = createTranslateService({ client: fakeClient });

function realTranslationFor(providerProfile) {
  const client = selectProviderClient(providerProfile);
  let service = realTranslationByClient.get(client);
  if (!service) {
    service = createTranslateService({ client });
    realTranslationByClient.set(client, service);
  }
  return service;
}

function waitForFakeDelay(delayMs, signal) {
  if (!delayMs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("Translation cancelled");
      error.code = "CANCELLED";
      error.providerErrorClass = "cancelled";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function publicError(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : "INTERNAL";
  const details = error?.safeDetails;
  const safeDetails = Number.isSafeInteger(details?.chunkIndex) && details.chunkIndex >= 0 &&
    Number.isSafeInteger(details?.startMs) && details.startMs >= 0 &&
    Number.isSafeInteger(details?.endMs) && details.endMs > details.startMs
    ? { chunkIndex: details.chunkIndex, startMs: details.startMs, endMs: details.endMs }
    : null;
  return {
    code,
    message: code === "INTERNAL"
      ? "Task operation failed"
      : String(error?.message || "Task operation failed").slice(0, MEDIA_LIMITS.STDERR_SUMMARY_MAX_CHARS),
    providerErrorClass: error?.providerErrorClass ?? "unknown",
    httpStatus: error?.httpStatus ?? null,
    retryable: Boolean(error?.retryable),
    ...(safeDetails ? { safeDetails } : {}),
  };
}

async function tracked(message, work, transform = (value) => value) {
  const promise = Promise.resolve().then(work);
  inFlight.add(promise);
  try {
    send({
      type: "supervisor.result",
      correlationId: message.correlationId,
      ok: true,
      data: transform(await promise),
    });
  } catch (error) {
    send({
      type: "supervisor.result",
      correlationId: message.correlationId,
      ok: false,
      error: publicError(error),
      partialOutcome: error?.partialOutcome,
    });
  } finally {
    inFlight.delete(promise);
  }
}

function translationService(message) {
  if (!message.useFakeProvider) return realTranslationFor(message.providerProfile);
  const fakeDelayMs = Number.isFinite(message.fakeDelayMs)
    ? Math.min(10_000, Math.max(0, message.fakeDelayMs))
    : 0;
  if (!message.fakeFailureLanguage && fakeDelayMs === 0) return fakeTranslation;
  return createTranslateService({
    client: {
      ...fakeClient,
      async createStructuredTranslation(args) {
        await waitForFakeDelay(fakeDelayMs, args.signal);
        const payload = JSON.parse(args.messages[1].content);
        if (payload.targetLanguage === message.fakeFailureLanguage) {
          const error = new Error("Injected fake provider failure");
          error.providerErrorClass = "server";
          error.retryable = true;
          throw error;
        }
        return fakeClient.createStructuredTranslation(args);
      },
    },
  });
}

function reportTranslationBatch(message, event) {
  const batchId = `${message.correlationId}:${event.batchIndex}`;
  return new Promise((resolve, reject) => {
    pendingTranslationBatches.set(batchId, { resolve, reject });
    send({
      type: "supervisor.translationBatch",
      correlationId: message.correlationId,
      batchId,
      event: { batchIndex: event.batchIndex, batchCount: event.batchCount },
    });
  });
}

function handleTranslationBatchAck(message) {
  const pending = pendingTranslationBatches.get(message.batchId);
  if (!pending) return;
  pendingTranslationBatches.delete(message.batchId);
  if (message.ok) {
    pending.resolve();
    return;
  }
  const error = new Error(message.error?.message || "Translation batch callback failed");
  error.code = message.error?.code || "INTERNAL";
  pending.reject(error);
}

function handleProviderTest(message) {
  return tracked(message, () =>
    (message.useFakeProvider ? fakeClient : selectProviderClient(message.providerProfile))
      .testConnection(message));
}

function handleProviderModels(message) {
  return tracked(message, () =>
    (message.useFakeProvider ? fakeModelsClient : realModelsClient).listModels({
      baseUrl: message.baseUrl,
      apiKey: message.apiKey,
      style: message.style,
      timeoutMs: message.timeoutMs,
    }));
}

async function handleTranslation(message) {
  const operationId = typeof message.operationId === "string" && message.operationId
    ? message.operationId
    : message.correlationId;
  const controller = new AbortController();
  activeTranslations.set(operationId, controller);
  try {
    await tracked(message, () => translationService(message).translateLanguage({
    projectId: message.projectId,
    sourceTrackId: message.sourceTrackId,
    targetLanguage: message.targetLanguage,
    providerId: message.providerId,
    model: message.model,
    baseUrl: message.baseUrl,
    transportMode: message.transportMode,
    apiKey: message.apiKey,
    segments: message.segments,
    projectSegments: message.projectSegments,
    contextSegments: message.contextSegments,
    existingTargetLayers: message.existingTargetLayers,
    parameters: message.parameters,
    resourceSnapshot: message.resourceSnapshot,
    glossaryHint: message.glossaryHint,
    styleHint: message.styleHint,
    signal: controller.signal,
    onBatch: (event) => reportTranslationBatch(message, event),
  }), (outcome) => ({
    status: outcome.status,
    reason: outcome.reason ?? null,
    translations: outcome.translations,
    snapshot: outcome.snapshot,
    networkCalls: outcome.networkCalls,
    cacheHits: outcome.cacheHits,
    usage: outcome.usage,
  }));
  } finally {
    activeTranslations.delete(operationId);
  }
}

function handleTranslationCancel(message) {
  const controller = activeTranslations.get(message.operationId);
  controller?.abort();
  send({
    type: "supervisor.result",
    correlationId: message.correlationId,
    ok: true,
    data: { cancelled: Boolean(controller) },
  });
}

async function handleMediaRun(message) {
  const operationId = typeof message.operationId === "string" && message.operationId
    ? message.operationId
    : message.correlationId;
  const controller = new AbortController();
  activeMedia.set(operationId, controller);
  let pid = null;
  try {
    await tracked(message, () => runManagedProcess({
      absoluteExe: message.absoluteExe,
      argv: Array.isArray(message.argv) ? message.argv : [],
      cwd: message.cwd,
      timeoutMs: typeof message.timeoutMs === "number" ? message.timeoutMs : MEDIA_LIMITS.PROBE_TIMEOUT_MS,
      stdoutMaxBytes: typeof message.stdoutMaxBytes === "number"
        ? message.stdoutMaxBytes
        : MEDIA_LIMITS.STDOUT_MAX_BYTES_PROBE,
      stderrMaxBytes: typeof message.stderrMaxBytes === "number"
        ? message.stderrMaxBytes
        : MEDIA_LIMITS.STDERR_MAX_BYTES,
      truncateStderr: message.truncateStderr === true,
      envOverrides: message.envOverrides,
      signal: controller.signal,
      onSpawn: (value) => {
        pid = value;
        send({ type: "supervisor.childProcess", operationId, pid, active: true });
      },
    }), (result) => ({
      exitCode: result.exitCode,
      stdoutBase64: result.stdout.toString("base64"),
      stdoutBytes: result.stdoutBytes,
      stderrSummary: result.stderrSummary,
    }));
  } finally {
    activeMedia.delete(operationId);
    if (pid) send({ type: "supervisor.childProcess", operationId, pid, active: false });
  }
}

function handleMediaCancel(message) {
  const controller = activeMedia.get(message.operationId);
  controller?.abort();
  send({
    type: "supervisor.result",
    correlationId: message.correlationId,
    ok: true,
    data: { cancelled: Boolean(controller) },
  });
}

function handleAsrProbe(message) {
  return tracked(message, () => asrRuntime.probe({
    operationId: message.operationId,
    runtime: message.runtime,
  }));
}

function handleAsrTranscribe(message) {
  return tracked(message, () => asrRuntime.transcribe({
    operationId: message.operationId,
    runtime: message.runtime,
    workRoot: message.workRoot,
    audioPath: message.audioPath,
    outputName: message.outputName,
    mediaDurationMs: message.mediaDurationMs,
    languageMode: message.languageMode,
    languageHint: message.languageHint,
    vad: message.vad,
    checkpointPath: message.checkpointPath,
    checkpointFingerprint: message.checkpointFingerprint,
    onProgress: (event) => {
      const progress = Number(event?.progress);
      const completedChunks = Number(event?.completedChunks);
      const totalChunks = Number(event?.totalChunks);
      if (!Number.isFinite(progress) || progress < 0 || progress > 100 ||
        !Number.isSafeInteger(completedChunks) || completedChunks < 0 ||
        !Number.isSafeInteger(totalChunks) || totalChunks < completedChunks || totalChunks > 100_000) return;
      send({
        type: "supervisor.asrProgress",
        correlationId: message.correlationId,
        event: { progress, completedChunks, totalChunks },
      });
    },
  }));
}

function handleAsrLanguageDetect(message) {
  return tracked(message, () => asrRuntime.detectLanguageRegion({
    operationId: message.operationId,
    runtime: message.runtime,
    workRoot: message.workRoot,
    audioPath: message.audioPath,
    outputName: message.outputName,
    mediaDurationMs: message.mediaDurationMs,
    segmentId: message.segmentId,
    startMs: message.startMs,
    endMs: message.endMs,
  }));
}

function handleAsrCancel(message) {
  send({
    type: "supervisor.result",
    correlationId: message.correlationId,
    ok: true,
    data: asrRuntime.cancel(message.operationId),
  });
}

async function handleShutdown(message) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  for (const controller of activeMedia.values()) controller.abort();
  for (const controller of activeTranslations.values()) controller.abort();
  for (const pending of pendingTranslationBatches.values()) {
    const error = new Error("Task supervisor is shutting down");
    error.code = "CANCELLED";
    pending.reject(error);
  }
  pendingTranslationBatches.clear();
  asrRuntime.close();
  await Promise.allSettled([...inFlight]);
  send({ type: "supervisor.result", correlationId: message.correlationId, ok: true, data: { closed: true } });
  setImmediate(() => process.exit(0));
}

function onMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "supervisor.shutdown") {
    void handleShutdown(message);
    return;
  }
  if (shuttingDown) return;
  if (message.type === "provider.test") void handleProviderTest(message);
  else if (message.type === "provider.models") void handleProviderModels(message);
  else if (message.type === "translate.run") void handleTranslation(message);
  else if (message.type === "translate.batchAck") handleTranslationBatchAck(message);
  else if (message.type === "translate.cancel") handleTranslationCancel(message);
  else if (message.type === "media.run") void handleMediaRun(message);
  else if (message.type === "media.cancel") handleMediaCancel(message);
  else if (message.type === "asr.runtimeProbe") void handleAsrProbe(message);
  else if (message.type === "asr.transcribe") void handleAsrTranscribe(message);
  else if (message.type === "asr.languageDetect") void handleAsrLanguageDetect(message);
  else if (message.type === "asr.cancel") handleAsrCancel(message);
}

port.on("message", (event) => onMessage(event.data));
const heartbeat = setInterval(() => send({ type: "supervisor.heartbeat" }), 5_000);
heartbeat.unref?.();
send({ type: "supervisor.ready" });
