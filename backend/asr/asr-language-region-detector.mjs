import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ASR_SERVICE_LIMITS, buildPcmExtractionArgv, removeAsrWorkRoot } from "./asr-service.mjs";
import { isAsrModelId } from "../../shared/asr-model-ids.mjs";

const MESSAGES = Object.freeze({
  INVALID_INPUT: "ASR language request is invalid",
  NOT_FOUND: "Project media for language detection is unavailable",
  NOT_AVAILABLE: "A required ASR component is not installed",
  INVALID_ARTIFACT: "A verified ASR or media artifact is invalid",
  PROCESS_FAILED: "ASR language subprocess failed",
  OUTPUT_TOO_LARGE: "Language detection input exceeds the supported limit",
  CANCELLED: "ASR language detection was cancelled",
  TIMEOUT: "ASR language detection timed out",
  WORKER_CRASHED: "ASR language worker stopped unexpectedly",
  CUDA_UNAVAILABLE: "CUDA ASR is unavailable",
  INTERNAL: "ASR language operation failed",
});

function fail(code) {
  const error = new Error(MESSAGES[code] ?? MESSAGES.INTERNAL);
  error.code = MESSAGES[code] ? code : "INTERNAL";
  return error;
}

function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail("INVALID_INPUT");
  return value;
}

function regularAbsolute(path, code) {
  if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path)) throw fail(code);
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink()) throw fail(code);
  return value;
}

function regionPcmArgv(inputPath, outputPath, startMs, endMs) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw fail("INVALID_INPUT");
  }
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", (startMs / 1_000).toFixed(3),
    "-i", inputPath,
    "-t", ((endMs - startMs) / 1_000).toFixed(3),
    "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    outputPath,
  ];
}

export function createAsrLanguageRegionDetector({
  getProjectRepository,
  resolveMediaPath,
  resolveFfmpegArtifacts,
  runMediaProcess,
  cancelMediaProcess,
  deviceSelector,
  detectLanguageRegion,
  cancelDetection,
}) {
  const dependencies = [getProjectRepository, resolveMediaPath, resolveFfmpegArtifacts, runMediaProcess,
    cancelMediaProcess, deviceSelector?.run, detectLanguageRegion, cancelDetection];
  if (dependencies.some((value) => typeof value !== "function")) throw fail("INVALID_INPUT");
  const active = new Map();

  async function prepare(payload, token) {
    const repo = getProjectRepository(payload.projectId);
    const project = repo.loadProject();
    const track = project?.sourceTracks?.find((item) => item.id === payload.sourceTrackId);
    const asrRun = repo.getAsrRun?.(payload.asrRunId)?.run;
    if (!project || project.id !== payload.projectId || project.noSourceMedia ||
      project.mediaSource?.availability !== "available" || track?.kind !== "asr" || track.asrRunId !== payload.asrRunId ||
      !isAsrModelId(asrRun?.modelId)) {
      throw fail("NOT_FOUND");
    }
    const streamId = track.sourceStreamId;
    const stream = project.sourceProbeSummary?.media?.streams?.find((item) => item.streamId === streamId && item.kind === "audio");
    const durationMs = project.sourceProbeSummary?.media?.format?.durationMs;
    if (!/^s:\d+$/.test(streamId ?? "") || !Number.isSafeInteger(stream?.index) ||
      !Number.isSafeInteger(durationMs) || durationMs <= 0) throw fail("INVALID_INPUT");
    const sourcePath = resolveMediaPath(payload.projectId);
    regularAbsolute(sourcePath, "NOT_FOUND");
    const artifacts = await resolveFfmpegArtifacts();
    regularAbsolute(artifacts?.ffmpegPath, "INVALID_ARTIFACT");
    const workRoot = join(repo.containerDir, "cache", "asr-language", payload.operationId);
    if (!removeAsrWorkRoot(workRoot)) throw fail("INVALID_ARTIFACT");
    mkdirSync(workRoot, { recursive: true });
    const audioPath = join(workRoot, "audio.wav");
    await runMediaProcess({
      operationId: payload.operationId,
      absoluteExe: artifacts.ffmpegPath,
      argv: buildPcmExtractionArgv(sourcePath, stream.index, audioPath),
      cwd: workRoot,
      timeoutMs: Math.min(6 * 60 * 60 * 1_000, Math.max(60_000, durationMs)),
      stdoutMaxBytes: 64 * 1024,
      stderrMaxBytes: 64 * 1024,
    });
    if (token.cancelled) throw fail("CANCELLED");
    const audio = regularAbsolute(audioPath, "PROCESS_FAILED");
    const maximumBytes = Math.ceil(durationMs / 1_000) * ASR_SERVICE_LIMITS.PCM_BYTES_PER_SECOND + 1024 * 1024;
    if (audio.size <= 44) throw fail("PROCESS_FAILED");
    if (audio.size > maximumBytes) throw fail("OUTPUT_TOO_LARGE");
    return { workRoot, audioPath, durationMs, ffmpegPath: artifacts.ffmpegPath, modelId: asrRun.modelId };
  }

  async function detectRegion(rawPayload) {
    const payload = {
      ...rawPayload,
      projectId: safeId(rawPayload?.projectId),
      asrRunId: safeId(rawPayload?.asrRunId),
      sourceTrackId: safeId(rawPayload?.sourceTrackId),
      segmentId: safeId(rawPayload?.segmentId),
      operationId: safeId(rawPayload?.operationId),
    };
    let current = active.get(payload.operationId);
    if (!current) {
      const token = { cancelled: false };
      current = { projectId: payload.projectId, token, prepared: prepare(payload, token) };
      active.set(payload.operationId, current);
    } else if (current.projectId !== payload.projectId) {
      throw fail("INVALID_INPUT");
    }
    try {
      const prepared = await current.prepared;
      if (current.token.cancelled) throw fail("CANCELLED");
      if (!Number.isSafeInteger(payload.startMs) || !Number.isSafeInteger(payload.endMs) ||
        payload.startMs < 0 || payload.endMs <= payload.startMs || payload.endMs > prepared.durationMs) {
        throw fail("INVALID_INPUT");
      }
      const regionDurationMs = payload.endMs - payload.startMs;
      const regionPath = join(prepared.workRoot, `${payload.segmentId}.wav`);
      rmSync(regionPath, { force: true });
      await runMediaProcess({
        operationId: payload.operationId,
        absoluteExe: prepared.ffmpegPath,
        argv: regionPcmArgv(prepared.audioPath, regionPath, payload.startMs, payload.endMs),
        cwd: prepared.workRoot,
        timeoutMs: Math.max(60_000, regionDurationMs),
        stdoutMaxBytes: 64 * 1024,
        stderrMaxBytes: 64 * 1024,
      });
      if (current.token.cancelled) throw fail("CANCELLED");
      const region = regularAbsolute(regionPath, "PROCESS_FAILED");
      const maximumRegionBytes = Math.ceil(regionDurationMs / 1_000) * ASR_SERVICE_LIMITS.PCM_BYTES_PER_SECOND + 1024 * 1024;
      if (region.size <= 44) throw fail("PROCESS_FAILED");
      if (region.size > maximumRegionBytes) throw fail("OUTPUT_TOO_LARGE");
      const selected = await deviceSelector.run({
        operationId: payload.operationId,
        modelId: prepared.modelId,
        requestedDevice: payload.requestedDevice,
        allowCudaFallback: payload.allowCudaFallback,
        executeStagedAttempt: ({ runtime }) => detectLanguageRegion({
          operationId: payload.operationId,
          runtime,
          workRoot: prepared.workRoot,
          audioPath: regionPath,
          outputName: payload.segmentId,
          mediaDurationMs: regionDurationMs,
          segmentId: payload.segmentId,
          startMs: 0,
          endMs: regionDurationMs,
        }),
      });
      if (current.token.cancelled) throw fail("CANCELLED");
      return selected.result;
    } catch (error) {
      throw fail(MESSAGES[error?.code] ? error.code : "INTERNAL");
    }
  }

  async function finish(operationId) {
    safeId(operationId);
    const current = active.get(operationId);
    if (!current) return;
    active.delete(operationId);
    try {
      const prepared = await current.prepared;
      removeAsrWorkRoot(prepared.workRoot);
    } catch {
      // Preparation failures clean their exact operation root below.
      const repo = getProjectRepository(current.projectId);
      removeAsrWorkRoot(join(repo.containerDir, "cache", "asr-language", operationId));
    }
  }

  async function cancel({ operationId }) {
    safeId(operationId);
    const current = active.get(operationId);
    if (!current) return { cancelled: false };
    current.token.cancelled = true;
    await Promise.allSettled([cancelMediaProcess(operationId), cancelDetection(operationId)]);
    return { cancelled: true };
  }

  return { detectRegion, finish, cancel };
}
