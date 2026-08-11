import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ASR_RESULT_LIMITS, validateAsrResult } from "./asr-contract.mjs";
import { isAsrModelId } from "../../shared/asr-model-ids.mjs";
import {
  ASR_VAD_RECOMMENDED_PARAMETERS,
  effectiveAsrVadParameters,
  normalizeAsrVadSettings,
} from "../../shared/asr-vad-config.mjs";
import { VOCAL_SEPARATION_IDENTITY } from "../audio/vocal-separation-process.mjs";
import { SONG_CLASSIFIER_IDENTITY } from "../audio/song-classifier-process.mjs";

const MAX_INPUT_MEDIA_BYTES = 512 * 1024 ** 3;
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const SEPARATION_SAMPLE_RATE_HZ = 44_100;
const SEPARATION_CHANNELS = 2;
const SEPARATION_BYTES_PER_SECOND = SEPARATION_SAMPLE_RATE_HZ * SEPARATION_CHANNELS * 2;
const PCM_SIZE_SLACK_BYTES = 1024 * 1024;
const DISK_RESERVE_BYTES = 128 * 1024 ** 2;
const FIXED_PARAMETERS = Object.freeze({
  threads: 6,
  beamSize: 5,
  bestOf: 5,
  temperature: 0,
  wordTimestamps: true,
  silenceAlignment: "adaptive-pcm-v1",
  sampleRateHz: 16_000,
  channels: 1,
  sampleFormat: "s16le",
});

const ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: "ASR request is invalid",
  INVALID_ASR_RESULT: "ASR result failed validation",
  NO_SPEECH_DETECTED: "No speech was detected with the current VAD settings",
  INVALID_ARTIFACT: "A verified ASR or media artifact is invalid",
  NOT_AVAILABLE: "A required ASR component is not installed",
  NOT_FOUND: "The project media source is unavailable",
  OUTPUT_TOO_LARGE: "ASR input or output exceeds the supported limit",
  DISK_FULL: "There is not enough free disk space for ASR",
  PROCESS_FAILED: "ASR subprocess failed",
  TIMEOUT: "ASR processing timed out",
  WORKER_CRASHED: "ASR processing worker stopped unexpectedly",
  CUDA_UNAVAILABLE: "CUDA ASR is unavailable",
  CUDA_INITIALIZATION_FAILED: "CUDA initialization or execution failed during ASR preprocessing",
  CANCELLED: "ASR processing was cancelled",
  CONFLICT: "The ASR operation conflicts with existing work",
  INTERNAL: "ASR processing failed",
});

const SAFE_PUBLIC_ERROR_MESSAGES = Object.freeze({
  "Qwen audio path must use a safe task-local file name": "Filtered audio could not be prepared for speech recognition",
});

function asrError(code, message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicError(error) {
  const code = typeof error?.code === "string" && ERROR_MESSAGES[error.code]
    ? error.code
    : "INTERNAL";
  const details = error?.safeDetails;
  const safeMessage = Object.hasOwn(SAFE_PUBLIC_ERROR_MESSAGES, error?.message)
    ? SAFE_PUBLIC_ERROR_MESSAGES[error.message]
    : null;
  if (safeMessage) return asrError(code, safeMessage);
  if (code === "INVALID_ASR_RESULT" && Number.isSafeInteger(details?.chunkIndex) && details.chunkIndex >= 0 &&
    Number.isSafeInteger(details?.startMs) && details.startMs >= 0 &&
    Number.isSafeInteger(details?.endMs) && details.endMs > details.startMs) {
    const safe = { chunkIndex: details.chunkIndex, startMs: details.startMs, endMs: details.endMs };
    const result = asrError(code, `${ERROR_MESSAGES[code]} (chunk ${safe.chunkIndex + 1}, ${safe.startMs}-${safe.endMs} ms)`);
    result.safeDetails = safe;
    return result;
  }
  return asrError(code);
}

function removeAsrWorkRoot(workRoot) {
  const aliasRoot = join(workRoot, ".native-assets");
  try {
    const root = lstatSync(aliasRoot, { throwIfNoEntry: false });
    if (root?.isSymbolicLink()) {
      unlinkSync(aliasRoot);
    } else if (root?.isDirectory()) {
      for (const name of readdirSync(aliasRoot)) {
        const path = join(aliasRoot, name);
        if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(path);
      }
    }
    rmSync(workRoot, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function safeId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw asrError("INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function ensureAbsolutePath(value, field) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw asrError("INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertRegularFile(path, code = "INVALID_ARTIFACT") {
  let value;
  try {
    value = lstatSync(path);
  } catch {
    throw asrError(code);
  }
  if (!value.isFile() || value.isSymbolicLink()) throw asrError(code);
  return value;
}

function defaultDiskFreeBytes(path) {
  const value = statfsSync(path);
  return Number(value.bavail) * Number(value.bsize);
}

function validateLanguage(languageMode, languageHint) {
  if (languageMode === "auto" && languageHint === null) return;
  if (languageMode === "fixed" && typeof languageHint === "string" && /^[A-Za-z]{2,3}$/.test(languageHint)) return;
  throw asrError("INVALID_INPUT", "ASR language selection is invalid");
}

function validatePreference(requestedDevice, allowCudaFallback) {
  if (!new Set(["auto", "cpu", "cuda"]).has(requestedDevice) || typeof allowCudaFallback !== "boolean") {
    throw asrError("INVALID_INPUT", "ASR device selection is invalid");
  }
}

function expectedPcmBytes(durationMs) {
  return Math.ceil(durationMs / 1_000) * PCM_BYTES_PER_SECOND + PCM_SIZE_SLACK_BYTES;
}

function expectedSeparationPcmBytes(durationMs) {
  return Math.ceil(durationMs / 1_000) * SEPARATION_BYTES_PER_SECOND + PCM_SIZE_SLACK_BYTES;
}

function reusablePcm(path, maximumBytes) {
  try {
    const value = lstatSync(path);
    return value.isFile() && !value.isSymbolicLink() && value.size > 44 && value.size <= maximumBytes;
  } catch {
    return false;
  }
}

function buildAudioFingerprint(project, audioStreamId, durationMs) {
  const identity = project.mediaSource?.identity;
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    assetId: project.mediaSource?.assetId,
    audioStreamId,
    durationMs,
    fingerprint: identity?.fingerprint ?? null,
    sizeBytes: identity?.sizeBytes ?? null,
    mtimeMs: identity?.mtimeMs ?? null,
    pcm: { sampleRateHz: 16_000, channels: 1, sampleFormat: "s16le" },
  })).digest("hex");
}

function buildSeparatedAudioFingerprint(project, audioStreamId, durationMs, separation) {
  const identity = project.mediaSource?.identity;
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    assetId: project.mediaSource?.assetId,
    audioStreamId,
    durationMs,
    fingerprint: identity?.fingerprint ?? null,
    sizeBytes: identity?.sizeBytes ?? null,
    mtimeMs: identity?.mtimeMs ?? null,
    separator: {
      engineId: VOCAL_SEPARATION_IDENTITY.engineId,
      engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
      modelId: VOCAL_SEPARATION_IDENTITY.modelId,
      modelRevision: VOCAL_SEPARATION_IDENTITY.modelRevision,
      modelHash: VOCAL_SEPARATION_IDENTITY.modelSha256,
      configHash: VOCAL_SEPARATION_IDENTITY.configSha256,
      device: separation.device,
    },
    pcm: { sampleRateHz: 16_000, channels: 1, sampleFormat: "s16le" },
  })).digest("hex");
}

function validateCapability(capability, modelId) {
  const model = capability?.models?.find((entry) => entry.id === modelId)
    ?? (modelId === "small" ? capability?.model : null);
  const engineId = model?.engineId ?? capability?.engineId;
  const engineVersion = model?.engineVersion ?? capability?.engineVersion;
  const runtimeState = engineId === "qwen3-asr"
    ? capability?.optionalRuntimes?.find((entry) => entry.engineId === engineId)?.installState
    : capability?.runtime?.installState;
  const modelState = model?.installState;
  if (runtimeState !== "ready") {
    throw asrError(runtimeState === "corrupt" ? "INVALID_ARTIFACT" : "NOT_AVAILABLE");
  }
  if (modelState !== "ready") {
    throw asrError(modelState === "corrupt" ? "INVALID_ARTIFACT" : "NOT_AVAILABLE");
  }
  if (
    !((engineId === "whisper.cpp" && engineVersion === "1.9.1") ||
      (engineId === "qwen3-asr" && engineVersion === "0.0.6" && capability?.qwenAligner?.installState === "ready")) ||
    model?.id !== modelId ||
    typeof model.version !== "string" ||
    model.version.length === 0 ||
    !/^[a-f0-9]{64}$/.test(model.modelHash)
  ) {
    throw asrError("INVALID_ARTIFACT");
  }
  return { id: model.id, version: model.version, hash: model.modelHash, engineId, engineVersion };
}

function resolveVadConfiguration(capability, rawSettings, engineId) {
  const settings = normalizeAsrVadSettings(rawSettings);
  const parameters = effectiveAsrVadParameters(settings);
  if (!parameters) return { mode: "off", model: null, parameters: null };
  if (engineId === "qwen3-asr" && capability?.runtime?.installState !== "ready") {
    throw asrError(
      capability?.runtime?.installState === "corrupt" || capability?.runtime?.installState === "incompatible"
        ? "INVALID_ARTIFACT"
        : "NOT_AVAILABLE",
      "The verified Silero VAD runtime is not ready",
    );
  }
  const model = capability?.vadModel;
  if (model?.installState !== "ready") {
    throw asrError(model?.installState === "corrupt" || model?.installState === "incompatible"
      ? "INVALID_ARTIFACT"
      : "NOT_AVAILABLE");
  }
  if (
    model.id !== "silero-vad-v6.2.0" ||
    model.version !== "6.2.0" ||
    !/^[a-f0-9]{64}$/.test(model.modelHash)
  ) {
    throw asrError("INVALID_ARTIFACT");
  }
  return {
    mode: settings.mode,
    model: { id: model.id, version: model.version, hash: model.modelHash },
    parameters,
  };
}

function validateResolvedVad(runtime, vad) {
  if (vad.mode === "off") return;
  if (
    runtime?.vadModelId !== vad.model.id ||
    runtime?.vadModelVersion !== vad.model.version ||
    runtime?.vadModelHash !== vad.model.hash
  ) {
    throw asrError("INVALID_ARTIFACT", "Resolved VAD model changed during the task");
  }
}

function buildCacheFingerprint({ project, audioStreamId, durationMs, model, request, vocalSeparation, songHandling }) {
  const identity = project.mediaSource?.identity;
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 4,
    input: {
      assetId: project.mediaSource?.assetId,
      audioStreamId,
      durationMs,
      fingerprint: identity?.fingerprint ?? null,
      sizeBytes: identity?.sizeBytes ?? null,
      mtimeMs: identity?.mtimeMs ?? null,
    },
    engine: { id: model.engineId, version: model.engineVersion },
    model,
    vad: request.vad,
    vocalSeparation,
    songHandling,
    language: { mode: request.languageMode, hint: request.languageHint },
    device: { requested: request.requestedDevice, allowCudaFallback: request.allowCudaFallback },
    parameters: FIXED_PARAMETERS,
  })).digest("hex");
}

function readCanonicalResult(path, workRoot) {
  ensureAbsolutePath(path, "canonicalResultPath");
  const root = realpathSync(workRoot);
  let resolved;
  try {
    resolved = realpathSync(path);
  } catch {
    throw asrError("INVALID_ASR_RESULT");
  }
  if (!isInside(root, resolved)) throw asrError("INVALID_ASR_RESULT");
  const file = assertRegularFile(resolved, "INVALID_ASR_RESULT");
  if (file.size <= 0) throw asrError("INVALID_ASR_RESULT");
  if (file.size > ASR_RESULT_LIMITS.MAX_ARTIFACT_BYTES) throw asrError("OUTPUT_TOO_LARGE");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw asrError("INVALID_ASR_RESULT");
  }
  return validateAsrResult(parsed);
}

function writeArtifactAtomically(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    const descriptor = openSync(temporary, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function buildPcmExtractionArgv(inputPath, streamIndex, outputPath) {
  ensureAbsolutePath(inputPath, "inputPath");
  ensureAbsolutePath(outputPath, "outputPath");
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0 || streamIndex > 4_096) {
    throw asrError("INVALID_INPUT", "audio stream index is invalid");
  }
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-map", `0:${streamIndex}`,
    "-vn", "-sn", "-dn",
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    outputPath,
  ];
}

export function buildSeparationExtractionArgv(inputPath, streamIndex, outputPath) {
  ensureAbsolutePath(inputPath, "inputPath");
  ensureAbsolutePath(outputPath, "outputPath");
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0 || streamIndex > 4_096) {
    throw asrError("INVALID_INPUT", "audio stream index is invalid");
  }
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-map", `0:${streamIndex}`,
    "-vn", "-sn", "-dn",
    "-ar", String(SEPARATION_SAMPLE_RATE_HZ), "-ac", String(SEPARATION_CHANNELS), "-c:a", "pcm_s16le",
    outputPath,
  ];
}

export function buildCanonicalPcmArgv(inputPath, outputPath) {
  ensureAbsolutePath(inputPath, "inputPath");
  ensureAbsolutePath(outputPath, "outputPath");
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-vn", "-sn", "-dn",
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    outputPath,
  ];
}

export function createAsrService({
  getProjectRepository,
  resolveMediaPath,
  resolveFfmpegArtifacts,
  getAsrCapabilityStatus,
  getDefaultModelId = () => "small",
  getVadSettings = () => ({
    mode: "off",
    customParameters: ASR_VAD_RECOMMENDED_PARAMETERS,
  }),
  getVocalSeparationSettings = () => "off",
  vocalSeparation = null,
  getSongHandlingSettings = () => "preserve",
  songClassifier = null,
  getDiskFreeBytes = defaultDiskFreeBytes,
  runMediaProcess,
  cancelMediaProcess,
  deviceSelector,
  transcribe,
  cancelTranscription,
  makeRunId = () => `asr-${randomUUID()}`,
  now = () => new Date().toISOString(),
}) {
  const dependencies = [
    getProjectRepository,
    resolveMediaPath,
    resolveFfmpegArtifacts,
    getAsrCapabilityStatus,
    getDefaultModelId,
    getVadSettings,
    getVocalSeparationSettings,
    getSongHandlingSettings,
    getDiskFreeBytes,
    runMediaProcess,
    cancelMediaProcess,
    deviceSelector?.run,
    transcribe,
    cancelTranscription,
    makeRunId,
    now,
  ];
  if (dependencies.some((dependency) => typeof dependency !== "function")) {
    throw asrError("INVALID_INPUT", "ASR service dependencies are invalid");
  }

  const active = new Map();

  function completedForOperation(repo, operationId, cacheFingerprint) {
    const run = repo.listAsrRuns().find((entry) => entry.operationId === operationId);
    if (!run) return null;
    if (run.cacheFingerprint !== cacheFingerprint) {
      throw asrError("CONFLICT", "ASR recovery fingerprint no longer matches the configured model");
    }
    return {
      runId: run.id,
      operationId,
      segmentCount: run.rawSegmentCount ?? run.segmentCount ?? 0,
      wordCount: run.wordCount ?? 0,
      deduplicated: true,
    };
  }

  async function execute(request, token) {
    let workRoot = null;
    let checkpointPath = null;
    let audioCachePath = null;
    let temporaryAudioPath = null;
    let finalizedArtifactPath = null;
    let preserveAudioCache = false;
    let songClassification = null;
    let committed = false;
    let reportedProgress = 0;
    const reportProgress = (value, detail) => {
      const next = Math.min(99, Math.max(0, value));
      if (!request.reportProgress || !Number.isFinite(next) || next <= reportedProgress) return;
      reportedProgress = next;
      try {
        request.reportProgress(reportedProgress, detail);
      } catch {
        /* UI progress must not affect recognition */
      }
    };
    try {
      const repo = getProjectRepository(request.projectId);
      const project = repo.loadProject();
      if (!project || project.id !== request.projectId) throw asrError("NOT_FOUND");
      if (project.noSourceMedia || !project.mediaSource || project.mediaSource.assetId !== "primary") {
        throw asrError("NOT_FOUND");
      }
      if (project.mediaSource.availability !== "available") throw asrError("NOT_FOUND");
      const streamId = project.mediaSource.selectedAudioStreamId;
      if (typeof streamId !== "string" || !/^s:\d+$/.test(streamId)) throw asrError("INVALID_INPUT");
      if (request.audioStreamId !== streamId) throw asrError("CONFLICT", "The confirmed audio stream is no longer selected");
      const probe = project.sourceProbeSummary?.media;
      const audioStream = probe?.streams?.find((stream) => stream.streamId === streamId && stream.kind === "audio");
      if (!audioStream || !Number.isSafeInteger(audioStream.index)) throw asrError("INVALID_INPUT");
      const durationMs = probe?.format?.durationMs;
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw asrError("INVALID_INPUT");
      if (durationMs > ASR_RESULT_LIMITS.MAX_MEDIA_DURATION_MS) throw asrError("OUTPUT_TOO_LARGE");
      const declaredSize = probe?.format?.sizeBytes;
      if (declaredSize != null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) throw asrError("INVALID_INPUT");
      if (declaredSize > MAX_INPUT_MEDIA_BYTES) throw asrError("OUTPUT_TOO_LARGE");

      const modelId = project.config?.asrModelId ?? await getDefaultModelId();
      if (!isAsrModelId(modelId)) throw asrError("INVALID_INPUT", "Configured ASR model is invalid");
      const capability = await getAsrCapabilityStatus();
      const model = validateCapability(capability, modelId);
      const vad = resolveVadConfiguration(capability, await getVadSettings(), model.engineId);
      const separationMode = await getVocalSeparationSettings();
      const songHandlingMode = await getSongHandlingSettings();
      if (token.cancelled) throw asrError("CANCELLED");
      if (separationMode !== "off" && separationMode !== "on") {
        throw asrError("INVALID_INPUT", "Vocal separation setting is invalid");
      }
      if (songHandlingMode !== "preserve" && songHandlingMode !== "filter") {
        throw asrError("INVALID_INPUT", "Song handling setting is invalid");
      }
      const artifacts = await resolveFfmpegArtifacts();
      const ffmpegPath = ensureAbsolutePath(artifacts?.ffmpegPath, "ffmpegPath");
      let separatorRuntime = null;
      let songClassifierRuntime = null;
      let separation = { requestedMode: separationMode, actualMode: "off", model: null, device: null };
      if (separationMode === "on") {
        if (
          !vocalSeparation ||
          typeof vocalSeparation.resolveRuntime !== "function" ||
          typeof vocalSeparation.probe !== "function" ||
          typeof vocalSeparation.separate !== "function"
        ) {
          throw asrError("NOT_AVAILABLE", "Vocal separation is not installed");
        }
        token.vocalSeparationEnabled = true;
        separatorRuntime = await vocalSeparation.resolveRuntime({
          ffmpegPath,
          device: request.requestedDevice === "cpu" ? "cpu" : "cuda",
        });
        if (token.cancelled) throw asrError("CANCELLED");
        separation = {
          requestedMode: "on",
          actualMode: "on",
          model: {
            engineId: VOCAL_SEPARATION_IDENTITY.engineId,
            engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
            id: VOCAL_SEPARATION_IDENTITY.modelId,
            revision: VOCAL_SEPARATION_IDENTITY.modelRevision,
            hash: VOCAL_SEPARATION_IDENTITY.modelSha256,
            configHash: VOCAL_SEPARATION_IDENTITY.configSha256,
          },
          device: separatorRuntime?.device ?? null,
        };
      }
      const songHandling = {
        requestedMode: songHandlingMode,
        actualMode: songHandlingMode,
        detector: songHandlingMode === "filter" ? {
          id: SONG_CLASSIFIER_IDENTITY.detectorId,
          engineId: SONG_CLASSIFIER_IDENTITY.engineId,
          engineVersion: SONG_CLASSIFIER_IDENTITY.engineVersion,
          modelHash: SONG_CLASSIFIER_IDENTITY.modelSha256,
        } : null,
        device: null,
      };
      if (songHandlingMode === "filter") {
        if (!songClassifier || typeof songClassifier.resolveRuntime !== "function" ||
          typeof songClassifier.probe !== "function" || typeof songClassifier.classify !== "function") {
          throw asrError("NOT_AVAILABLE", "Song filtering is not installed");
        }
        token.songClassifierEnabled = true;
        songClassifierRuntime = await songClassifier.resolveRuntime({
          device: request.requestedDevice === "cpu" ? "cpu" : "cuda",
        });
        songHandling.device = songClassifierRuntime?.device ?? null;
        if (token.cancelled) throw asrError("CANCELLED");
      }
      const cacheFingerprint = buildCacheFingerprint({
        project,
        audioStreamId: streamId,
        durationMs,
        model,
        request: { ...request, vad },
        vocalSeparation: separation,
        songHandling,
      });
      const duplicate = completedForOperation(repo, request.operationId, cacheFingerprint);
      if (duplicate) return duplicate;
      if (separationMode === "on") {
        const probed = await vocalSeparation.probe({ operationId: request.operationId, runtime: separatorRuntime });
        if (token.cancelled) throw asrError("CANCELLED");
        if (
          probed?.engineId !== VOCAL_SEPARATION_IDENTITY.engineId ||
          probed?.engineVersion !== VOCAL_SEPARATION_IDENTITY.engineVersion ||
          probed?.modelId !== VOCAL_SEPARATION_IDENTITY.modelId ||
          probed?.modelRevision !== VOCAL_SEPARATION_IDENTITY.modelRevision ||
          probed?.device !== separation.device
        ) {
          throw asrError("INVALID_ARTIFACT", "Resolved vocal separation runtime changed during the task");
        }
      }
      if (songHandlingMode === "filter") {
        const probed = await songClassifier.probe({ operationId: request.operationId, runtime: songClassifierRuntime });
        if (token.cancelled) throw asrError("CANCELLED");
        if (probed?.available !== true || probed?.detectorId !== SONG_CLASSIFIER_IDENTITY.detectorId ||
          probed?.device !== songHandling.device) {
          throw asrError("INVALID_ARTIFACT", "Resolved song classifier changed during the task");
        }
      }
      if (model.engineId === "qwen3-asr") {
        const checkpointRoot = join(repo.containerDir, "cache", "asr-checkpoints");
        mkdirSync(checkpointRoot, { recursive: true });
        checkpointPath = join(checkpointRoot, `${cacheFingerprint}.json`);
      }
      if (token.cancelled) throw asrError("CANCELLED");
      const sourcePath = ensureAbsolutePath(resolveMediaPath(request.projectId), "mediaPath");
      const sourceFile = assertRegularFile(sourcePath, "NOT_FOUND");
      if (sourceFile.size > MAX_INPUT_MEDIA_BYTES) throw asrError("OUTPUT_TOO_LARGE");
      const maximumPcmBytes = expectedPcmBytes(durationMs);
      const maximumSeparationPcmBytes = expectedSeparationPcmBytes(durationMs);
      const audioCacheRoot = separationMode === "on"
        ? join(repo.containerDir, "cache", "audio-separation")
        : join(repo.containerDir, "cache", "asr-audio");
      mkdirSync(audioCacheRoot, { recursive: true });
      audioCachePath = join(audioCacheRoot, `${separationMode === "on"
        ? buildSeparatedAudioFingerprint(project, streamId, durationMs, separation)
        : buildAudioFingerprint(project, streamId, durationMs)}.wav`);
      preserveAudioCache = separationMode === "on";
      if (existsSync(audioCachePath) && !reusablePcm(audioCachePath, maximumPcmBytes)) {
        rmSync(audioCachePath, { force: true });
      }
      const hasReusableAudio = reusablePcm(audioCachePath, maximumPcmBytes);
      const separationWorkBytes = separationMode === "on" && !hasReusableAudio
        ? maximumSeparationPcmBytes * 2
        : 0;
      const songWorkBytes = songHandlingMode === "filter" ? maximumPcmBytes : 0;
      const requiredFreeBytes = (hasReusableAudio ? 0 : maximumPcmBytes) + separationWorkBytes + songWorkBytes +
        ASR_RESULT_LIMITS.MAX_ARTIFACT_BYTES + DISK_RESERVE_BYTES;
      if (Number(await getDiskFreeBytes(repo.containerDir)) < requiredFreeBytes) {
        throw asrError("DISK_FULL");
      }

      workRoot = join(repo.containerDir, "cache", "asr", request.operationId);
      mkdirSync(dirname(workRoot), { recursive: true });
      if (!removeAsrWorkRoot(workRoot)) {
        throw asrError("INVALID_ARTIFACT", "ASR temporary model link could not be removed safely");
      }
      mkdirSync(workRoot, { recursive: false });
      const audioPath = join(workRoot, "audio.wav");
      reportProgress(2, "Preparing audio");
      if (!hasReusableAudio) {
        temporaryAudioPath = `${audioCachePath}.partial.wav`;
        rmSync(temporaryAudioPath, { force: true });
        if (separationMode === "on") {
          const separationInputPath = join(workRoot, "separation-input.wav");
          const separationOutputDir = join(workRoot, "separation-output");
          mkdirSync(separationOutputDir, { recursive: false });
          reportProgress(5, "Extracting audio for vocal separation");
          await runMediaProcess({
            operationId: request.operationId,
            absoluteExe: ffmpegPath,
            argv: buildSeparationExtractionArgv(sourcePath, audioStream.index, separationInputPath),
            cwd: workRoot,
            timeoutMs: Math.min(6 * 60 * 60 * 1_000, Math.max(60_000, durationMs)),
            stdoutMaxBytes: 64 * 1024,
            stderrMaxBytes: 64 * 1024,
          });
          if (token.cancelled) throw asrError("CANCELLED");
          const separationInput = assertRegularFile(separationInputPath, "PROCESS_FAILED");
          if (separationInput.size <= 44) throw asrError("PROCESS_FAILED");
          if (separationInput.size > maximumSeparationPcmBytes) throw asrError("OUTPUT_TOO_LARGE");
          reportProgress(10, "Separating dialogue vocals from background audio");
          const separated = await vocalSeparation.separate({
            operationId: request.operationId,
            runtime: separatorRuntime,
            inputPath: separationInputPath,
            outputDir: separationOutputDir,
            chunkDurationSeconds: durationMs > 60 * 60_000 ? 600 : null,
            timeoutMs: Math.min(12 * 60 * 60_000, Math.max(10 * 60_000, durationMs * 2)),
          });
          if (token.cancelled) throw asrError("CANCELLED");
          if (
            separated?.engineId !== VOCAL_SEPARATION_IDENTITY.engineId ||
            separated?.engineVersion !== VOCAL_SEPARATION_IDENTITY.engineVersion ||
            separated?.modelId !== VOCAL_SEPARATION_IDENTITY.modelId ||
            separated?.modelRevision !== VOCAL_SEPARATION_IDENTITY.modelRevision ||
            separated?.modelHash !== VOCAL_SEPARATION_IDENTITY.modelSha256 ||
            separated?.configHash !== VOCAL_SEPARATION_IDENTITY.configSha256 ||
            separated?.device !== separation.device
          ) {
            throw asrError("INVALID_ARTIFACT", "Vocal separation identity changed during the task");
          }
          const vocalsPath = ensureAbsolutePath(separated.vocalsPath, "vocalsPath");
          const vocals = assertRegularFile(vocalsPath, "INVALID_ARTIFACT");
          if (vocals.size <= 44) throw asrError("INVALID_ARTIFACT");
          if (vocals.size > maximumSeparationPcmBytes) throw asrError("OUTPUT_TOO_LARGE");
          reportProgress(30, "Vocal separation completed");
          await runMediaProcess({
            operationId: request.operationId,
            absoluteExe: ffmpegPath,
            argv: buildCanonicalPcmArgv(vocalsPath, temporaryAudioPath),
            cwd: workRoot,
            timeoutMs: Math.min(6 * 60 * 60 * 1_000, Math.max(60_000, durationMs)),
            stdoutMaxBytes: 64 * 1024,
            stderrMaxBytes: 64 * 1024,
          });
        } else {
          await runMediaProcess({
            operationId: request.operationId,
            absoluteExe: ffmpegPath,
            argv: buildPcmExtractionArgv(sourcePath, audioStream.index, temporaryAudioPath),
            cwd: workRoot,
            timeoutMs: Math.min(6 * 60 * 60 * 1_000, Math.max(60_000, durationMs)),
            stdoutMaxBytes: 64 * 1024,
            stderrMaxBytes: 64 * 1024,
          });
        }
        if (token.cancelled) throw asrError("CANCELLED");
        if (!reusablePcm(temporaryAudioPath, maximumPcmBytes)) throw asrError("PROCESS_FAILED");
        renameSync(temporaryAudioPath, audioCachePath);
        temporaryAudioPath = null;
      }
      try {
        linkSync(audioCachePath, audioPath);
      } catch {
        copyFileSync(audioCachePath, audioPath);
      }
      if (token.cancelled) throw asrError("CANCELLED");
      const pcmFile = assertRegularFile(audioPath, "PROCESS_FAILED");
      if (pcmFile.size <= 44) throw asrError("PROCESS_FAILED");
      if (pcmFile.size > maximumPcmBytes) throw asrError("OUTPUT_TOO_LARGE");
      let recognitionAudioPath = audioPath;
      let recognitionProgressStart = separationMode === "on" ? 35 : 10;
      reportProgress(recognitionProgressStart, separationMode === "on" ? "Separated vocals ready" : "Audio ready");
      if (songHandlingMode === "filter") {
        const classificationEnd = separationMode === "on" ? 50 : 25;
        const classificationOutputDir = join(workRoot, "song-filter");
        mkdirSync(classificationOutputDir, { recursive: false });
        reportProgress(recognitionProgressStart, "Detecting singing and music");
        songClassification = await songClassifier.classify({
          operationId: request.operationId,
          runtime: songClassifierRuntime,
          inputPath: audioPath,
          outputDir: classificationOutputDir,
          mediaDurationMs: durationMs,
          onProgress: (progress) => {
            if (Number.isFinite(progress)) {
              reportProgress(recognitionProgressStart + Math.min(100, Math.max(0, progress)) *
                ((classificationEnd - recognitionProgressStart) / 100), "Detecting singing and music");
            }
          },
        });
        if (token.cancelled) throw asrError("CANCELLED");
        const classifierAudioPath = ensureAbsolutePath(songClassification?.filteredAudioPath, "filteredAudioPath");
        const filteredAudio = assertRegularFile(classifierAudioPath, "INVALID_ARTIFACT");
        if (filteredAudio.size <= 44 || filteredAudio.size > maximumPcmBytes) throw asrError("INVALID_ARTIFACT");
        recognitionAudioPath = join(workRoot, "song-filtered.wav");
        renameSync(classifierAudioPath, recognitionAudioPath);
        recognitionProgressStart = classificationEnd;
        reportProgress(recognitionProgressStart, "Song filtering completed");
      }

      const selected = await deviceSelector.run({
        operationId: request.operationId,
        modelId,
        requestedDevice: request.requestedDevice,
        allowCudaFallback: request.allowCudaFallback,
        executeStagedAttempt: async ({ runtime }) => {
          validateResolvedVad(runtime, vad);
          return {
            output: await transcribe({
              operationId: request.operationId,
              runtime,
              vad,
              workRoot,
              audioPath: recognitionAudioPath,
              outputName: "result",
              mediaDurationMs: durationMs,
              languageMode: request.languageMode,
              languageHint: request.languageHint,
              checkpointPath,
              checkpointFingerprint: checkpointPath ? cacheFingerprint : null,
              onProgress: (event) => {
                const progress = Number(event?.progress);
                if (Number.isFinite(progress)) {
                  const bounded = Math.min(100, Math.max(0, progress));
                  reportProgress(
                    recognitionProgressStart + bounded * ((90 - recognitionProgressStart) / 100),
                    "Recognizing speech",
                  );
                }
              },
            }),
            modelId: runtime.modelId,
            modelVersion: runtime.modelVersion,
            modelHash: runtime.modelHash,
          };
        },
      });
      if (token.cancelled) throw asrError("CANCELLED");
      reportProgress(92, "Validating recognition result");
      let result = readCanonicalResult(selected.result?.output?.canonicalResultPath, workRoot);
      if (songClassification) {
        result = validateAsrResult({
          ...result,
          songActivity: {
            detector: SONG_CLASSIFIER_IDENTITY.detectorId,
            mode: "filter",
            filteredIntervals: songClassification.filteredIntervals,
            uncertainIntervals: songClassification.uncertainIntervals,
          },
        });
      }
      if (result.mediaDurationMs !== durationMs) throw asrError("INVALID_ASR_RESULT");
      const processingDurationMs = selected.result?.output?.processingDurationMs;
      if (!Number.isSafeInteger(processingDurationMs) || processingDurationMs < 0 || processingDurationMs > 24 * 60 * 60 * 1_000) {
        throw asrError("INVALID_ASR_RESULT");
      }
      if (
        selected.result?.modelId !== model.id ||
        selected.result?.modelVersion !== model.version ||
        selected.result?.modelHash !== model.hash
      ) {
        throw asrError("INVALID_ARTIFACT", "Resolved ASR model changed during the task");
      }

      const runId = safeId(makeRunId(), "runId");
      const artifactBytes = Buffer.from(JSON.stringify(result));
      if (artifactBytes.length > ASR_RESULT_LIMITS.MAX_ARTIFACT_BYTES) throw asrError("OUTPUT_TOO_LARGE");
      const rawArtifactRelativePath = `artifacts/asr/${runId}.json`;
      finalizedArtifactPath = join(repo.containerDir, ...rawArtifactRelativePath.split("/"));
      if (existsSync(finalizedArtifactPath)) throw asrError("CONFLICT");
      try {
        writeArtifactAtomically(finalizedArtifactPath, artifactBytes);
      } catch {
        throw asrError("DISK_FULL");
      }
      if (token.cancelled) throw asrError("CANCELLED");

      const completed = repo.commitAsrRun({
        run: {
          id: runId,
          operationId: request.operationId,
          projectId: request.projectId,
          audioStreamId: streamId,
          engineId: model.engineId,
          engineVersion: model.engineVersion,
          runtimeId: selected.runtimeId,
          runtimeVersion: selected.runtimeVersion,
          modelId: selected.result?.modelId,
          modelVersion: selected.result?.modelVersion,
          modelHash: selected.result?.modelHash,
          cacheFingerprint,
          requestedDevice: selected.requestedDevice,
          actualDevice: selected.actualDevice,
          fallbackReason: selected.fallbackReason,
          languageMode: request.languageMode,
          languageHint: request.languageHint,
          parameters: { ...FIXED_PARAMETERS, vad, vocalSeparation: separation, songHandling },
          canonicalizerVersion: model.engineId === "qwen3-asr" ? "qwen3-asr-0.0.6-v2" : "whisper.cpp-1.9.1-v2",
          rawArtifactRelativePath,
          rawArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
          rawArtifactSizeBytes: artifactBytes.length,
          processingDurationMs,
          createdAt: request.createdAt,
          completedAt: now(),
        },
        result,
      });
      if (completed.deduplicated) {
        rmSync(finalizedArtifactPath, { force: true });
        finalizedArtifactPath = null;
      }
      committed = true;
      reportProgress(99, "Recognition completed");
      return completed;
    } catch (error) {
      throw publicError(error);
    } finally {
      if (!committed && finalizedArtifactPath) rmSync(finalizedArtifactPath, { force: true });
      if (temporaryAudioPath) rmSync(temporaryAudioPath, { force: true });
      if (committed && checkpointPath) {
        rmSync(checkpointPath, { force: true });
        rmSync(`${checkpointPath}.partial`, { force: true });
      }
      if (committed && audioCachePath && !preserveAudioCache) rmSync(audioCachePath, { force: true });
      if (workRoot) removeAsrWorkRoot(workRoot);
    }
  }

  function run(rawRequest) {
    const request = {
      projectId: safeId(rawRequest?.projectId, "projectId"),
      audioStreamId: typeof rawRequest?.audioStreamId === "string" && /^s:\d+$/.test(rawRequest.audioStreamId)
        ? rawRequest.audioStreamId
        : (() => { throw asrError("INVALID_INPUT", "audioStreamId is invalid"); })(),
      operationId: safeId(rawRequest?.operationId, "operationId"),
      requestedDevice: rawRequest?.requestedDevice,
      allowCudaFallback: rawRequest?.allowCudaFallback,
      languageMode: rawRequest?.languageMode,
      languageHint: rawRequest?.languageHint ?? null,
      createdAt: now(),
      reportProgress: typeof rawRequest?.reportProgress === "function" ? rawRequest.reportProgress : null,
    };
    validatePreference(request.requestedDevice, request.allowCudaFallback);
    validateLanguage(request.languageMode, request.languageHint);
    const current = active.get(request.operationId);
    if (current) {
      if (current.projectId !== request.projectId) return Promise.reject(asrError("CONFLICT"));
      return current.promise;
    }
    const token = { cancelled: false, vocalSeparationEnabled: false, songClassifierEnabled: false };
    const promise = execute(request, token).finally(() => {
      if (active.get(request.operationId)?.promise === promise) active.delete(request.operationId);
    });
    active.set(request.operationId, { projectId: request.projectId, token, promise });
    return promise;
  }

  async function cancel({ operationId }) {
    safeId(operationId, "operationId");
    const current = active.get(operationId);
    if (!current) return { cancelled: false };
    current.token.cancelled = true;
    const cancellations = [
      Promise.resolve().then(() => cancelMediaProcess(operationId)),
      Promise.resolve().then(() => cancelTranscription(operationId)),
    ];
    if (current.token.vocalSeparationEnabled && typeof vocalSeparation?.cancel === "function") {
      cancellations.push(Promise.resolve().then(() => vocalSeparation.cancel(operationId)));
    }
    if (current.token.songClassifierEnabled && typeof songClassifier?.cancel === "function") {
      cancellations.push(Promise.resolve().then(() => songClassifier.cancel(operationId)));
    }
    await Promise.allSettled(cancellations);
    return { cancelled: true };
  }

  return { run, cancel };
}

export const ASR_SERVICE_LIMITS = Object.freeze({
  MAX_INPUT_MEDIA_BYTES,
  PCM_BYTES_PER_SECOND,
  DISK_RESERVE_BYTES,
});
