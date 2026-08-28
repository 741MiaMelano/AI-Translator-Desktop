import { randomUUID } from "node:crypto";
import { copyFile, lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runManagedProcess } from "../media/process-runner.mjs";
import { validateAsrResult } from "./asr-contract.mjs";
import { canonicalizeWhisperCppResult } from "./whisper-cpp-canonicalizer.mjs";
import { alignAsrResultToPcmSilence } from "./pcm-silence-aligner.mjs";
import { normalizeAsrVadParameters } from "../../shared/asr-vad-config.mjs";

const LANGUAGE_CODES = Object.freeze({
  Chinese: "zh", English: "en", Cantonese: "yue", Arabic: "ar", German: "de", French: "fr",
  Spanish: "es", Portuguese: "pt", Indonesian: "id", Italian: "it", Korean: "ko", Russian: "ru",
  Thai: "th", Vietnamese: "vi", Japanese: "ja", Turkish: "tr", Hindi: "hi", Malay: "ms",
  Dutch: "nl", Swedish: "sv", Danish: "da", Finnish: "fi", Polish: "pl", Czech: "cs",
  Filipino: "fil", Persian: "fa", Greek: "el", Hungarian: "hu", Macedonian: "mk", Romanian: "ro",
});
const QWEN_PROCESS_ENV = Object.freeze({
  PYTHONUTF8: "1",
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  USERNAME: "desktop-ai-translator",
});
const MAX_CHUNK_BOUNDARY_DRIFT_MS = 500;
const MAX_VAD_INTERVALS = 100_000;
const VAD_STDOUT_MAX_BYTES = 8 * 1024 * 1024;

function fail(message, code = "INVALID_INPUT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function regularAbsolute(path, field, directory = false) {
  if (typeof path !== "string" || !isAbsolute(path)) throw fail(`${field} is invalid`, "INVALID_ARTIFACT");
  return lstat(path).then((value) => {
    if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) {
      throw fail(`${field} is invalid`, "INVALID_ARTIFACT");
    }
    return path;
  }).catch((error) => {
    if (error?.code === "INVALID_ARTIFACT") throw error;
    throw fail(`${field} is unavailable`, "INVALID_ARTIFACT");
  });
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

async function resolveVadRequest(vad, runtime) {
  if (vad === undefined || (
    exactObject(vad, ["mode", "model", "parameters"]) &&
    vad.mode === "off" && vad.model === null && vad.parameters === null
  )) return null;
  if (!exactObject(vad, ["mode", "model", "parameters"]) || !new Set(["auto", "custom"]).has(vad.mode) ||
    !exactObject(vad.model, ["id", "version", "hash"]) || vad.model.id !== "silero-vad-v6.2.0" ||
    vad.model.version !== "6.2.0" || !/^[a-f0-9]{64}$/.test(vad.model.hash)) {
    throw fail("Qwen VAD configuration is invalid");
  }
  const parameters = normalizeAsrVadParameters(vad.parameters);
  if (runtime.vadModelId !== vad.model.id || runtime.vadModelVersion !== vad.model.version ||
    runtime.vadModelHash !== vad.model.hash) {
    throw fail("Verified Qwen VAD identity is invalid", "INVALID_ARTIFACT");
  }
  await Promise.all([
    regularAbsolute(runtime.vadExecutablePath, "runtime.vadExecutablePath"),
    regularAbsolute(runtime.vadModelPath, "runtime.vadModelPath"),
  ]);
  return { mode: vad.mode, parameters };
}

function complementIntervals(speechIntervals, mediaDurationMs) {
  const excludedIntervals = [];
  let cursor = 0;
  for (const interval of speechIntervals) {
    if (interval.startMs > cursor) excludedIntervals.push({ startMs: cursor, endMs: interval.startMs });
    cursor = interval.endMs;
  }
  if (cursor < mediaDurationMs) excludedIntervals.push({ startMs: cursor, endMs: mediaDurationMs });
  return excludedIntervals;
}

function parseVadOutput(stdout, mediaDurationMs, mode) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? "");
  const header = /Detected\s+(\d+)\s+speech segments:/u.exec(text);
  if (!header) throw fail("Silero VAD output is invalid", "PROCESS_FAILED");
  const declared = Number(header[1]);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_VAD_INTERVALS) {
    throw fail("Silero VAD interval count exceeds the limit", "OUTPUT_TOO_LARGE");
  }
  const raw = [];
  const pattern = /^Speech segment\s+(\d+):\s+start\s+=\s+([0-9]+(?:\.[0-9]+)?),\s+end\s+=\s+([0-9]+(?:\.[0-9]+)?)\s*$/gmu;
  for (const match of text.matchAll(pattern)) {
    if (Number(match[1]) !== raw.length) throw fail("Silero VAD segment order is invalid", "PROCESS_FAILED");
    // whisper.cpp v1.9.1 stores and prints these public VAD values in centiseconds.
    const startMs = Math.round(Number(match[2]) * 10);
    const endMs = Math.round(Number(match[3]) * 10);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs ||
      startMs > mediaDurationMs + 100 || endMs > mediaDurationMs + 100) {
      throw fail("Silero VAD segment time is invalid", "PROCESS_FAILED");
    }
    raw.push({ startMs: Math.min(startMs, mediaDurationMs), endMs: Math.min(endMs, mediaDurationMs) });
  }
  if (raw.length !== declared) throw fail("Silero VAD segment count is invalid", "PROCESS_FAILED");
  const speechIntervals = [];
  for (const interval of raw) {
    if (interval.endMs <= interval.startMs) continue;
    const previous = speechIntervals.at(-1);
    if (previous && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else {
      speechIntervals.push({ ...interval });
    }
  }
  return {
    detector: "silero-vad-v6.2.0",
    mode,
    speechIntervals,
    excludedIntervals: complementIntervals(speechIntervals, mediaDurationMs),
  };
}

function vadArgv({ modelPath, audioPath, parameters }) {
  return [
    "--vad-model", modelPath,
    "--file", audioPath,
    "--vad-threshold", String(parameters.threshold),
    "--vad-min-speech-duration-ms", String(parameters.minSpeechDurationMs),
    "--vad-min-silence-duration-ms", String(parameters.minSilenceDurationMs),
    ...(parameters.maxSpeechDurationSeconds > 0
      ? ["--vad-max-speech-duration-s", String(parameters.maxSpeechDurationSeconds)]
      : []),
    "--vad-speech-pad-ms", String(parameters.speechPadMs),
    "--vad-samples-overlap", String(parameters.samplesOverlapSeconds),
    "--no-prints",
  ];
}

async function validateRuntime(runtime, includeModel = false) {
  if (
    runtime?.engineId !== "qwen3-asr" || runtime.engineVersion !== "0.0.6" ||
    runtime.runtimeId !== "qwen3-asr-transformers-cu128-x64" || runtime.device !== "cuda"
  ) throw fail("Verified Qwen3-ASR runtime is required", "INVALID_ARTIFACT");
  await Promise.all([
    regularAbsolute(runtime.executablePath, "runtime.executablePath"),
    regularAbsolute(runtime.cwd, "runtime.cwd", true),
    regularAbsolute(runtime.sidecarPath, "runtime.sidecarPath"),
  ]);
  if (!includeModel) return;
  if (!new Set(["qwen3-asr-0.6b", "qwen3-asr-1.7b"]).has(runtime.modelId)) {
    throw fail("Qwen model id is invalid", "INVALID_ARTIFACT");
  }
  if (!/^[a-f0-9]{64}$/.test(runtime.modelHash) || !/^[a-f0-9]{64}$/.test(runtime.alignerHash)) {
    throw fail("Qwen snapshot identity is invalid", "INVALID_ARTIFACT");
  }
  await Promise.all([
    regularAbsolute(runtime.modelPath, "runtime.modelPath", true),
    regularAbsolute(runtime.alignerPath, "runtime.alignerPath", true),
  ]);
}

async function checkpointPath(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !isAbsolute(value)) throw fail("checkpointPath is invalid");
  await regularAbsolute(dirname(value), "checkpointRoot", true);
  const file = await lstat(value).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (file && (file.isSymbolicLink() || !file.isFile() || file.size <= 0 || file.size > 128 * 1024 * 1024)) {
    throw fail("checkpointPath is invalid", "INVALID_ARTIFACT");
  }
  return value;
}

async function truncateCheckpoint(path, fingerprint, mediaDurationMs, chunkIndex) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size <= 0 || file.size > 128 * 1024 * 1024) return false;
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.schemaVersion !== 1 || value.fingerprint !== fingerprint || value.mediaDurationMs !== mediaDurationMs ||
      !Array.isArray(value.segments) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= value.segments.length ||
      Object.keys(value).some((key) => !new Set(["schemaVersion", "fingerprint", "mediaDurationMs", "segments"]).has(key))) return false;
    await writeFile(partial, `${JSON.stringify({ ...value, segments: value.segments.slice(0, chunkIndex) })}\n`, { flag: "wx" });
    const descriptor = await open(partial, "r+");
    try {
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await rename(partial, path);
    return true;
  } catch {
    return false;
  } finally {
    await rm(partial, { force: true });
  }
}

function progressParser(callback) {
  if (callback == null) return undefined;
  if (typeof callback !== "function") throw fail("onProgress is invalid");
  let pending = "";
  return (chunk) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type !== "progress" || !Number.isSafeInteger(event.progress) || event.progress < 0 || event.progress > 100 ||
        !Number.isSafeInteger(event.completedChunks) || !Number.isSafeInteger(event.totalChunks) ||
        event.completedChunks < 0 || event.totalChunks <= 0 || event.completedChunks > event.totalChunks) continue;
      Promise.resolve(callback({
        progress: event.progress,
        completedChunks: event.completedChunks,
        totalChunks: event.totalChunks,
      })).catch(() => {});
    }
  };
}

function safeOperation(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail("operationId is invalid");
  return value;
}

function languageCode(value) {
  if (typeof value !== "string") return "und";
  return LANGUAGE_CODES[value] ?? (/^(?:und|[a-z]{2,3})$/i.test(value) ? value.toLowerCase() : "und");
}

function timestampTokenTexts(text, items) {
  const tokens = [];
  let cursor = 0;
  for (const item of items) {
    if (typeof item?.text !== "string" || !item.text) throw fail("Qwen timestamp item is invalid", "INVALID_ASR_RESULT");
    const start = text.indexOf(item.text, cursor);
    if (start < 0) throw fail("Qwen timestamp text does not match its transcript", "INVALID_ASR_RESULT");
    const gap = text.slice(cursor, start);
    const whitespace = gap.match(/\s+$/u)?.[0] ?? "";
    if (tokens.length) tokens[tokens.length - 1] += gap.slice(0, gap.length - whitespace.length);
    tokens.push(`${tokens.length ? whitespace : gap}${item.text}`);
    cursor = start + item.text.length;
  }
  if (tokens.length) tokens[tokens.length - 1] += text.slice(cursor);
  return tokens;
}

function qwenChunk(chunk) {
  const result = chunk?.result?.[0];
  if (result && typeof result.text === "string" && !result.text.trim()) return null;
  const language = languageCode(result?.language);
  const items = result?.time_stamps?.items;
  if (!result || typeof result.text !== "string" || !Array.isArray(items) || items.length === 0) {
    throw fail("Qwen sidecar result is invalid", "INVALID_ASR_RESULT");
  }
  const texts = timestampTokenTexts(result.text, items);
  const clampWarnings = new Set();
  const tokens = items.map((item, index) => {
    const rawFrom = item?.start_time == null ? Number.NaN : chunk.startMs + Math.round(Number(item.start_time) * 1_000);
    const rawTo = item?.end_time == null ? Number.NaN : chunk.startMs + Math.round(Number(item.end_time) * 1_000);
    if (!Number.isSafeInteger(rawFrom) || !Number.isSafeInteger(rawTo)) {
      throw fail("Qwen timestamp item is invalid", "INVALID_ASR_RESULT");
    }
    let from = rawFrom;
    let to = rawTo;
    if (from < chunk.startMs && chunk.startMs - from <= MAX_CHUNK_BOUNDARY_DRIFT_MS) {
      from = chunk.startMs;
      clampWarnings.add("leading_timestamp_clamped");
    }
    if (to < chunk.startMs && chunk.startMs - to <= MAX_CHUNK_BOUNDARY_DRIFT_MS) {
      to = chunk.startMs;
      clampWarnings.add("leading_timestamp_clamped");
    }
    if (from > chunk.endMs && from - chunk.endMs <= MAX_CHUNK_BOUNDARY_DRIFT_MS) {
      from = chunk.endMs;
      clampWarnings.add("terminal_timestamp_clamped");
    }
    if (to > chunk.endMs && to - chunk.endMs <= MAX_CHUNK_BOUNDARY_DRIFT_MS) {
      to = chunk.endMs;
      clampWarnings.add("terminal_timestamp_clamped");
    }
    return { text: texts[index], offsets: { from, to }, p: null };
  });
  return {
    language,
    clampWarnings,
    transcription: {
      text: result.text,
      offsets: { from: chunk.startMs, to: chunk.endMs },
      tokens,
    },
  };
}

function withChunkDetails(error, chunkIndex, chunk) {
  if (error?.code === "INVALID_ASR_RESULT") {
    error.safeDetails = {
      chunkIndex,
      startMs: Number.isSafeInteger(chunk?.startMs) ? chunk.startMs : null,
      endMs: Number.isSafeInteger(chunk?.endMs) ? chunk.endMs : null,
    };
  }
  return error;
}

async function canonicalizeRaw(path, mediaDurationMs) {
  const file = await lstat(path).catch(() => null);
  if (!file?.isFile() || file.isSymbolicLink() || file.size <= 0 || file.size > 128 * 1024 * 1024) {
    throw fail("Qwen sidecar output is missing or too large", "INVALID_ASR_RESULT");
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw fail("Qwen sidecar output is invalid", "INVALID_ASR_RESULT");
  }
  if (raw?.schemaVersion !== 1 || raw.mediaDurationMs !== mediaDurationMs || !Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw fail("Qwen sidecar result contract is invalid", "INVALID_ASR_RESULT");
  }
  let previousEnd = 0;
  const chunks = [];
  for (let index = 0; index < raw.segments.length; index += 1) {
    const chunk = raw.segments[index];
    try {
      if (!Number.isSafeInteger(chunk?.startMs) || !Number.isSafeInteger(chunk?.endMs) ||
        chunk.startMs < previousEnd || chunk.endMs <= chunk.startMs || chunk.endMs > mediaDurationMs) {
        throw fail("Qwen sidecar segment time is invalid", "INVALID_ASR_RESULT");
      }
      previousEnd = chunk.endMs;
      const converted = qwenChunk(chunk);
      if (converted) chunks.push({ ...converted, chunkIndex: index, chunk });
    } catch (error) {
      throw withChunkDetails(error, index, chunk);
    }
  }
  const detectedLanguage = chunks.find(({ language }) => language !== "und")?.language ?? "und";
  for (const { transcription, chunkIndex, chunk } of chunks) {
    try {
      canonicalizeWhisperCppResult({ result: { language: detectedLanguage }, transcription: [transcription] }, { mediaDurationMs });
    } catch (error) {
      throw withChunkDetails(error, chunkIndex, chunk);
    }
  }
  const canonical = canonicalizeWhisperCppResult({
    result: { language: detectedLanguage }, transcription: chunks.map(({ transcription }) => transcription),
  }, { mediaDurationMs });
  const clampWarnings = chunks.flatMap(({ clampWarnings }) => [...clampWarnings]);
  return validateAsrResult({
    ...canonical,
    warnings: [...new Set([...canonical.warnings, ...clampWarnings])],
    ...(raw.activity === undefined ? {} : { activity: raw.activity }),
  });
}

export function createQwenAsrProcess({ runProcess = runManagedProcess, reportChildProcess = () => {}, now = Date.now } = {}) {
  const active = new Map();

  async function owned(operationId, spec) {
    let pid = null;
    try {
      return await runProcess({
        ...spec,
        onSpawn: (value) => {
          pid = value;
          reportChildProcess({ operationId, pid, active: true });
        },
      });
    } finally {
      if (pid) reportChildProcess({ operationId, pid, active: false });
    }
  }

  return {
    async probe({ operationId, runtime }) {
      safeOperation(operationId);
      await validateRuntime(runtime);
      if (active.has(operationId)) throw fail("operationId is already active", "CONFLICT");
      const controller = new AbortController();
      active.set(operationId, controller);
      try {
        await owned(operationId, {
          absoluteExe: runtime.executablePath,
          argv: [runtime.sidecarPath, "probe", "--device", "cuda"],
          cwd: runtime.cwd,
          timeoutMs: 2 * 60_000,
          stdoutMaxBytes: 64 * 1024,
          stderrMaxBytes: 64 * 1024,
          envOverrides: QWEN_PROCESS_ENV,
          signal: controller.signal,
        });
        return { available: true, engineId: runtime.engineId, engineVersion: runtime.engineVersion,
          runtimeId: runtime.runtimeId, runtimeVersion: runtime.runtimeVersion, device: "cuda" };
      } finally {
        active.delete(operationId);
      }
    },
    async transcribe(request) {
      const { operationId, runtime, workRoot, audioPath, outputName, mediaDurationMs } = request;
      safeOperation(operationId);
      await validateRuntime(runtime, true);
      await Promise.all([regularAbsolute(workRoot, "workRoot", true), regularAbsolute(audioPath, "audioPath")]);
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(outputName) || !Number.isSafeInteger(mediaDurationMs) || mediaDurationMs <= 0) {
        throw fail("Qwen transcription request is invalid");
      }
      const language = request.languageMode === "auto" && request.languageHint === null
        ? "auto"
        : request.languageMode === "fixed" && /^[A-Za-z]{2,3}$/.test(request.languageHint)
          ? request.languageHint.toLowerCase()
          : null;
      if (!language) throw fail("Qwen language selection is invalid");
      const vad = await resolveVadRequest(request.vad, runtime);
      if (active.has(operationId)) throw fail("operationId is already active", "CONFLICT");
      const rawPath = join(workRoot, `${outputName}.qwen.json`);
      const canonicalPath = join(workRoot, `${outputName}.canonical.json`);
      const vadIntervalsPath = join(workRoot, `${outputName}.vad-intervals.json`);
      const localVadModelPath = join(workRoot, `${outputName}.silero-vad.bin`);
      const audioName = basename(audioPath);
      if (resolve(dirname(audioPath)) !== resolve(workRoot) || !/^[A-Za-z0-9._-]{1,128}$/.test(audioName)) {
        throw fail("Qwen audio path must use a safe task-local file name");
      }
      const checkpoint = await checkpointPath(request.checkpointPath);
      const fingerprint = request.checkpointFingerprint;
      if ((checkpoint && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) ||
        (!checkpoint && fingerprint != null)) throw fail("checkpointFingerprint is invalid");
      if (checkpoint && new Set([rawPath, canonicalPath, `${canonicalPath}.partial`].map((path) => resolve(path))).has(resolve(checkpoint))) {
        throw fail("checkpointPath conflicts with transcription output");
      }
      const controller = new AbortController();
      active.set(operationId, controller);
      const started = now();
      try {
        let activity = null;
        if (vad) {
          try {
            await copyFile(runtime.vadModelPath, localVadModelPath);
            const detected = await owned(operationId, {
              absoluteExe: runtime.vadExecutablePath,
              argv: vadArgv({ modelPath: basename(localVadModelPath), audioPath: audioName, parameters: vad.parameters }),
              cwd: workRoot,
              timeoutMs: Math.min(2 * 60 * 60_000, Math.max(2 * 60_000, Math.ceil(mediaDurationMs / 10))),
              stdoutMaxBytes: VAD_STDOUT_MAX_BYTES,
              stderrMaxBytes: 64 * 1024,
              signal: controller.signal,
            });
            activity = parseVadOutput(detected.stdout, mediaDurationMs, vad.mode);
          } catch (error) {
            if (error && typeof error === "object") error.asrStage = "vad";
            throw error;
          }
          if (activity.speechIntervals.length === 0) {
            throw fail("Silero VAD did not detect any speech", "NO_SPEECH_DETECTED");
          }
          await writeFile(vadIntervalsPath, `${JSON.stringify({
            schemaVersion: 1,
            mediaDurationMs,
            activity,
          })}\n`, { flag: "wx" });
        }
        let canonical;
        for (let attempt = 0; ; attempt += 1) {
          await owned(operationId, {
            absoluteExe: runtime.executablePath,
            argv: [runtime.sidecarPath, "transcribe", "--model", runtime.modelPath, "--aligner", runtime.alignerPath,
              "--audio", audioPath, "--output", rawPath, "--language", language,
              "--duration-ms", String(mediaDurationMs),
              ...(activity ? ["--speech-intervals", vadIntervalsPath] : []),
              ...(checkpoint ? ["--checkpoint", checkpoint, "--fingerprint", fingerprint] : [])],
            cwd: workRoot,
            timeoutMs: Math.min(6 * 60 * 60_000, Math.max(5 * 60_000, mediaDurationMs * 2)),
            stdoutMaxBytes: 64 * 1024,
            stderrMaxBytes: 64 * 1024,
            truncateStderr: true,
            envOverrides: QWEN_PROCESS_ENV,
            signal: controller.signal,
            onStdout: progressParser(request.onProgress),
          });
          try {
            canonical = await canonicalizeRaw(rawPath, mediaDurationMs);
            break;
          } catch (error) {
            if (error?.code !== "INVALID_ASR_RESULT" || !checkpoint ||
              !await truncateCheckpoint(checkpoint, fingerprint, mediaDurationMs, error.safeDetails?.chunkIndex)) throw error;
            if (attempt >= 1) throw error;
            await rm(rawPath, { force: true });
          }
        }
        canonical = alignAsrResultToPcmSilence(canonical, audioPath);
        const partial = `${canonicalPath}.partial`;
        await writeFile(partial, `${JSON.stringify(canonical)}\n`, { flag: "wx" });
        await rename(partial, canonicalPath);
        await rm(rawPath, { force: true });
        return {
          canonicalResultPath: canonicalPath,
          processingDurationMs: Math.max(0, now() - started),
          summary: {
            schemaVersion: 1,
            mediaDurationMs,
            rawSegmentCount: canonical.segments.length,
            wordCount: canonical.segments.reduce((sum, segment) => sum + segment.words.length, 0),
            detectedLanguage: canonical.detectedLanguage,
            warningCodes: canonical.warnings,
            ...(activity ? {
              vadSpeechIntervalCount: activity.speechIntervals.length,
              vadExcludedIntervalCount: activity.excludedIntervals.length,
              vadSpeechDurationMs: activity.speechIntervals.reduce((sum, item) => sum + item.endMs - item.startMs, 0),
            } : {}),
          },
        };
      } catch (error) {
        await Promise.all([rm(rawPath, { force: true }), rm(canonicalPath, { force: true }), rm(`${canonicalPath}.partial`, { force: true })]);
        if (runtime.device === "cuda" && error?.code === "PROCESS_FAILED" && error?.asrStage !== "vad") {
          throw fail("Qwen CUDA initialization or execution failed", "CUDA_INITIALIZATION_FAILED");
        }
        throw error;
      } finally {
        await Promise.all([rm(vadIntervalsPath, { force: true }), rm(localVadModelPath, { force: true })]);
        active.delete(operationId);
      }
    },
    cancel(operationId) {
      const controller = active.get(operationId);
      controller?.abort();
      return { cancelled: Boolean(controller) };
    },
    close() {
      for (const controller of active.values()) controller.abort();
      return { cancelled: active.size };
    },
  };
}
