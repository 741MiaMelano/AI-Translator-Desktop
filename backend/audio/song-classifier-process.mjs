import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { runManagedProcess } from "../media/process-runner.mjs";

export const SONG_CLASSIFIER_IDENTITY = Object.freeze({
  detectorId: "ina-speech-music-noise-v1",
  engineId: "ina-speech-segmenter",
  engineVersion: "7a41b809c3cc6d8d36b24e70784779f8d16f7b5e",
  modelId: "ina-speech-music-noise-v1",
  modelFileName: "keras_speech_music_noise_cnn.hdf5",
  modelSizeBytes: 3_244_808,
  modelSha256: "f04b5e3c86fa2e81666d106b0867350fe7858c7bd006c2a74c27b5b45507e7d8",
  h5pyVersion: "3.15.1",
  sidecarProtocolVersion: 1,
});

const MAX_INTERVALS = 100_000;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024 * 1024;
const PASSTHROUGH_CODES = new Set([
  "CANCELLED", "TIMEOUT", "OUTPUT_TOO_LARGE", "NOT_AVAILABLE", "INVALID_ARTIFACT",
  "INVALID_INPUT", "CONFLICT", "CUDA_INITIALIZATION_FAILED",
]);

function fail(message, code = "INVALID_INPUT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeOperation(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail("operationId is invalid");
  return value;
}

function samePath(left, right) {
  const values = [left, right].map((value) => normalize(resolve(value)));
  return process.platform === "win32" ? values[0].toLowerCase() === values[1].toLowerCase() : values[0] === values[1];
}

function isInside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function regular(path, field, { directory = false, missingCode = "INVALID_ARTIFACT" } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) throw fail(`${field} is invalid`, "INVALID_ARTIFACT");
  const value = await lstat(path).catch((error) => {
    throw fail(`${field} is unavailable`, error?.code === "ENOENT" ? missingCode : "INVALID_ARTIFACT");
  });
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) {
    throw fail(`${field} is invalid`, "INVALID_ARTIFACT");
  }
  return value;
}

async function sha256(path, signal) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw fail("Song classification was cancelled", "CANCELLED");
    throw fail("Song classifier model could not be verified", "INVALID_ARTIFACT");
  }
  return hash.digest("hex");
}

async function validateRuntime(runtime, signal, verifyArtifact) {
  if (!runtime || runtime.detectorId !== SONG_CLASSIFIER_IDENTITY.detectorId ||
    runtime.modelHash !== SONG_CLASSIFIER_IDENTITY.modelSha256 ||
    !new Set(["cpu", "cuda"]).has(runtime.device)) {
    throw fail("Verified song classifier runtime is required", "INVALID_ARTIFACT");
  }
  const paths = ["pythonPath", "sidecarPath", "sitePackagesPath", "modelPath", "cwd"];
  if (paths.some((key) => typeof runtime[key] !== "string" || !isAbsolute(runtime[key]))) {
    throw fail("Song classifier runtime paths are invalid", "INVALID_ARTIFACT");
  }
  const [python, sidecar, site, model, cwd] = await Promise.all([
    regular(runtime.pythonPath, "classifier Python", { missingCode: "NOT_AVAILABLE" }),
    regular(runtime.sidecarPath, "classifier sidecar", { missingCode: "NOT_AVAILABLE" }),
    regular(runtime.sitePackagesPath, "classifier packages", { directory: true, missingCode: "NOT_AVAILABLE" }),
    regular(runtime.modelPath, "classifier model", { missingCode: "NOT_AVAILABLE" }),
    regular(runtime.cwd, "classifier working directory", { directory: true, missingCode: "NOT_AVAILABLE" }),
  ]);
  if (python.size <= 0 || sidecar.size <= 0 || model.size !== SONG_CLASSIFIER_IDENTITY.modelSizeBytes ||
    basename(runtime.modelPath) !== SONG_CLASSIFIER_IDENTITY.modelFileName || !samePath(dirname(runtime.modelPath), runtime.cwd)) {
    throw fail("Song classifier runtime artifact is invalid", "INVALID_ARTIFACT");
  }
  if (await verifyArtifact(runtime.modelPath, signal) !== SONG_CLASSIFIER_IDENTITY.modelSha256) {
    throw fail("Song classifier model hash is invalid", "INVALID_ARTIFACT");
  }
  return runtime;
}

function processEnvironment(runtime) {
  const blockedProxy = "http://127.0.0.1:9";
  return {
    PYTHONPATH: runtime.sitePackagesPath,
    PYTHONUTF8: "1",
    PYTHONNOUSERSITE: "1",
    HF_HUB_OFFLINE: "1",
    HTTP_PROXY: blockedProxy,
    HTTPS_PROXY: blockedProxy,
    ALL_PROXY: blockedProxy,
    NO_PROXY: "",
    http_proxy: blockedProxy,
    https_proxy: blockedProxy,
    all_proxy: blockedProxy,
    no_proxy: "",
    ...(runtime.device === "cpu" ? { CUDA_VISIBLE_DEVICES: "-1" } : {}),
  };
}

function normalizeIntervals(value, field, durationMs) {
  if (!Array.isArray(value) || value.length > MAX_INTERVALS) throw fail(`${field} is invalid`, "INVALID_ARTIFACT");
  let previousEnd = 0;
  return value.map((raw) => {
    const startMs = raw?.startMs;
    const endMs = raw?.endMs;
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < previousEnd ||
      endMs <= startMs || endMs > durationMs || Object.keys(raw).some((key) => key !== "startMs" && key !== "endMs")) {
      throw fail(`${field} is invalid`, "INVALID_ARTIFACT");
    }
    previousEnd = endMs;
    return { startMs, endMs };
  });
}

async function validateOutput({ outputDir, jsonPath, audioPath, durationMs, device }) {
  const [json, audio] = await Promise.all([regular(jsonPath, "classifier result"), regular(audioPath, "filtered audio")]);
  if (json.size <= 0 || json.size > MAX_RESULT_BYTES || audio.size <= 44 || audio.size > MAX_AUDIO_BYTES) {
    throw fail("Song classifier output is invalid", json.size > MAX_RESULT_BYTES || audio.size > MAX_AUDIO_BYTES
      ? "OUTPUT_TOO_LARGE" : "INVALID_ARTIFACT");
  }
  const [root, result, filtered] = await Promise.all([realpath(outputDir), realpath(jsonPath), realpath(audioPath)]);
  if (![result, filtered].every((path) => isInside(root, path) && samePath(dirname(path), root))) {
    throw fail("Song classifier output location is invalid", "INVALID_ARTIFACT");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(result, "utf8"));
  } catch {
    throw fail("Song classifier result is invalid", "INVALID_ARTIFACT");
  }
  if (parsed?.schemaVersion !== 1 || parsed.detector !== SONG_CLASSIFIER_IDENTITY.detectorId ||
    parsed.modelHash !== SONG_CLASSIFIER_IDENTITY.modelSha256 || parsed.device !== device ||
    !Number.isSafeInteger(parsed.durationMs) || Math.abs(parsed.durationMs - durationMs) > 1_000 ||
    Object.keys(parsed).some((key) => !new Set(["schemaVersion", "detector", "modelHash", "device", "durationMs", "filteredIntervals", "uncertainIntervals"]).has(key))) {
    throw fail("Song classifier result identity is invalid", "INVALID_ARTIFACT");
  }
  return {
    detector: parsed.detector,
    modelHash: parsed.modelHash,
    device: parsed.device,
    durationMs,
    filteredIntervals: normalizeIntervals(parsed.filteredIntervals, "filteredIntervals", durationMs),
    uncertainIntervals: normalizeIntervals(parsed.uncertainIntervals, "uncertainIntervals", durationMs),
    filteredAudioPath: filtered,
  };
}

function normalizedError(error, device, cancelled) {
  if (cancelled || error?.code === "CANCELLED") return fail("Song classification was cancelled", "CANCELLED");
  if (error?.code === "PROCESS_FAILED" && device === "cuda") {
    return fail("Song classifier CUDA initialization or execution failed", "CUDA_INITIALIZATION_FAILED");
  }
  if (PASSTHROUGH_CODES.has(error?.code)) return fail("Song classification failed", error.code);
  return fail("Song classification failed", "PROCESS_FAILED");
}

export function createSongClassifierProcess({
  runProcess = runManagedProcess,
  cancelProcess = null,
  verifyArtifact = sha256,
} = {}) {
  if (typeof runProcess !== "function" || typeof verifyArtifact !== "function" ||
    (cancelProcess !== null && typeof cancelProcess !== "function")) {
    throw fail("Song classifier process dependencies are invalid");
  }
  const active = new Map();

  function begin(operationId) {
    safeOperation(operationId);
    if (active.has(operationId)) throw fail("operationId is already active", "CONFLICT");
    const state = { controller: new AbortController(), cancelled: false };
    active.set(operationId, state);
    return state;
  }

  async function invoke(operationId, state, runtime, argv, timeoutMs) {
    try {
      const result = await runProcess({
        operationId,
        absoluteExe: runtime.pythonPath,
        argv,
        cwd: runtime.cwd,
        timeoutMs,
        stdoutMaxBytes: 1024 * 1024,
        stderrMaxBytes: 256 * 1024,
        truncateStderr: true,
        envOverrides: processEnvironment(runtime),
        shell: false,
        ...(cancelProcess ? {} : { signal: state.controller.signal }),
      });
      if (state.cancelled) throw fail("Song classification was cancelled", "CANCELLED");
      return result;
    } catch (error) {
      throw normalizedError(error, runtime?.device, state.cancelled);
    }
  }

  return {
    async probe({ operationId, runtime }) {
      const state = begin(operationId);
      try {
        await validateRuntime(runtime, state.controller.signal, verifyArtifact);
        const result = await invoke(operationId, state, runtime, [
          runtime.sidecarPath, "--self-check", "--model", runtime.modelPath,
        ], 60_000);
        const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout.toString("utf8")
          : Buffer.from(result?.stdoutBase64 ?? "", "base64").toString("utf8");
        const last = stdout.trim().split(/\r?\n/).at(-1);
        const parsed = JSON.parse(last || "null");
        if (parsed?.ok !== true || parsed.detector !== SONG_CLASSIFIER_IDENTITY.detectorId || parsed.h5py !== SONG_CLASSIFIER_IDENTITY.h5pyVersion) {
          throw fail("Song classifier self-check failed", "INVALID_ARTIFACT");
        }
        return { available: true, detectorId: parsed.detector, device: runtime.device };
      } catch (error) {
        throw normalizedError(error, runtime?.device, state.cancelled);
      } finally {
        active.delete(operationId);
      }
    },

    async classify({ operationId, runtime, inputPath, outputDir, mediaDurationMs, onProgress = null }) {
      const state = begin(operationId);
      let jsonPath;
      let audioPath;
      try {
        await validateRuntime(runtime, state.controller.signal, verifyArtifact);
        await regular(inputPath, "classifier input");
        await regular(outputDir, "classifier output directory", { directory: true });
        if (!Number.isSafeInteger(mediaDurationMs) || mediaDurationMs <= 0 || mediaDurationMs > 12 * 60 * 60_000) {
          throw fail("mediaDurationMs is invalid");
        }
        jsonPath = resolve(outputDir, "classification.json");
        audioPath = resolve(outputDir, "filtered.wav");
        for (const path of [jsonPath, audioPath]) {
          if (!isInside(outputDir, path) || await lstat(path).catch(() => null)) throw fail("classifier output conflicts", "CONFLICT");
        }
        const result = await invoke(operationId, state, runtime, [
          runtime.sidecarPath,
          "--input", inputPath,
          "--model", runtime.modelPath,
          "--output-json", jsonPath,
          "--output-audio", audioPath,
          "--device", runtime.device,
          "--chunk-seconds", "600",
          "--batch-size", runtime.device === "cuda" ? "256" : "64",
        ], Math.min(12 * 60 * 60_000, Math.max(10 * 60_000, mediaDurationMs * 2)));
        if (typeof onProgress === "function") {
          const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout.toString("utf8")
            : Buffer.from(result?.stdoutBase64 ?? "", "base64").toString("utf8");
          for (const line of stdout.split(/\r?\n/)) {
            try {
              const event = JSON.parse(line);
              if (event?.type === "progress" && Number.isFinite(event.progress)) onProgress(event.progress);
            } catch { /* ignore non-protocol diagnostics */ }
          }
        }
        return await validateOutput({ outputDir, jsonPath, audioPath, durationMs: mediaDurationMs, device: runtime.device });
      } catch (error) {
        await Promise.all([jsonPath, audioPath].filter(Boolean).map((path) => rm(path, { force: true }).catch(() => {})));
        throw normalizedError(error, runtime?.device, state.cancelled);
      } finally {
        active.delete(operationId);
      }
    },

    cancel(operationId) {
      safeOperation(operationId);
      const state = active.get(operationId);
      if (!state) return { cancelled: false };
      state.cancelled = true;
      state.controller.abort();
      if (cancelProcess) Promise.resolve(cancelProcess({ operationId })).catch(() => {});
      return { cancelled: true };
    },
  };
}
