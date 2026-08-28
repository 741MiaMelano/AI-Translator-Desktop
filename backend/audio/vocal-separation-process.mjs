import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { runManagedProcess } from "../media/process-runner.mjs";

export const VOCAL_SEPARATION_IDENTITY = Object.freeze({
  engineId: "audio-separator",
  engineVersion: "0.44.5",
  modelId: "vocal-separation-melband-v1",
  modelRevision: "ac9b0614ab3cd7f77219e18ba494dfd93956c348",
  modelFileName: "vocals_mel_band_roformer.ckpt",
  modelSizeBytes: 913_106_900,
  modelSha256: "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e",
  configFileName: "vocals_mel_band_roformer.yaml",
  configSizeBytes: 944,
  configSha256: "b958b29c8f7195f0d86bee6759a33980db675c4ecaf2fcaa80fa125828e6cd38",
  outputFileName: "vocals.wav",
  outputSampleRate: 44_100,
});

export const VOCAL_SEPARATION_LIMITS = Object.freeze({
  PROBE_TIMEOUT_MS: 30_000,
  PROCESS_TIMEOUT_DEFAULT_MS: 6 * 60 * 60_000,
  PROCESS_TIMEOUT_MIN_MS: 60_000,
  PROCESS_TIMEOUT_MAX_MS: 12 * 60 * 60_000,
  CHUNK_DURATION_DEFAULT_SECONDS: null,
  CHUNK_DURATION_MIN_SECONDS: 30,
  CHUNK_DURATION_MAX_SECONDS: 3_600,
  STDOUT_MAX_BYTES: 1 * 1024 * 1024,
  STDERR_MAX_BYTES: 256 * 1024,
  OUTPUT_MAX_BYTES: 64 * 1024 * 1024 * 1024,
});

const DOWNLOAD_CHECKS = Object.freeze({
  demucs_download_list: {},
  vr_download_list: {},
  mdx_download_list: {},
  mdx_download_vip_list: {},
  mdx23c_download_list: {},
  mdx23c_download_vip_list: {},
  roformer_download_list: {},
});
const DOWNLOAD_CHECKS_TEXT = `${JSON.stringify(DOWNLOAD_CHECKS)}\n`;
const PASSTHROUGH_CODES = new Set([
  "CANCELLED",
  "TIMEOUT",
  "OUTPUT_TOO_LARGE",
  "NOT_AVAILABLE",
  "INVALID_ARTIFACT",
  "INVALID_INPUT",
  "CONFLICT",
  "CUDA_INITIALIZATION_FAILED",
]);

function fail(message, code = "INVALID_INPUT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeOperation(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw fail("operationId is invalid");
  }
  return value;
}

function samePath(left, right) {
  const paths = [left, right].map((value) => normalize(resolve(value)));
  return process.platform === "win32"
    ? paths[0].toLowerCase() === paths[1].toLowerCase()
    : paths[0] === paths[1];
}

function isInside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function regularAbsolute(path, field, { directory = false, missingCode = "INVALID_ARTIFACT" } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw fail(`${field} is invalid`, "INVALID_ARTIFACT");
  }
  let value;
  try {
    value = await lstat(path);
  } catch (error) {
    throw fail(`${field} is unavailable`, error?.code === "ENOENT" ? missingCode : "INVALID_ARTIFACT");
  }
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) {
    throw fail(`${field} is invalid`, "INVALID_ARTIFACT");
  }
  return value;
}

function artifactSignature(value) {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

async function verifySha256Artifact({ path, expectedSha256, signature, signal }) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || artifactSignature(after) !== signature ||
      hash.digest("hex") !== expectedSha256) {
      throw fail("Verified vocal separation artifact hash is invalid", "INVALID_ARTIFACT");
    }
  } catch (error) {
    if (error?.code === "INVALID_ARTIFACT" || error?.code === "CANCELLED") throw error;
    if (error?.code === "ABORT_ERR" || error?.name === "AbortError") {
      throw fail("Vocal separation was cancelled", "CANCELLED");
    }
    throw fail("Verified vocal separation artifact could not be hashed", "INVALID_ARTIFACT");
  }
}

async function validateRuntime(runtime, verifyArtifact) {
  if (
    !runtime ||
    runtime.engineId !== VOCAL_SEPARATION_IDENTITY.engineId ||
    runtime.engineVersion !== VOCAL_SEPARATION_IDENTITY.engineVersion ||
    runtime.modelId !== VOCAL_SEPARATION_IDENTITY.modelId ||
    runtime.modelRevision !== VOCAL_SEPARATION_IDENTITY.modelRevision ||
    runtime.modelHash !== VOCAL_SEPARATION_IDENTITY.modelSha256 ||
    runtime.modelSizeBytes !== VOCAL_SEPARATION_IDENTITY.modelSizeBytes ||
    runtime.configHash !== VOCAL_SEPARATION_IDENTITY.configSha256 ||
    runtime.configSizeBytes !== VOCAL_SEPARATION_IDENTITY.configSizeBytes ||
    !new Set(["cpu", "cuda"]).has(runtime.device)
  ) {
    throw fail("Verified vocal separation runtime is required", "INVALID_ARTIFACT");
  }
  for (const path of [runtime.executablePath, runtime.cwd, runtime.ffmpegPath, runtime.modelDir,
    runtime.modelPath, runtime.configPath]) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw fail("Verified vocal separation paths are invalid", "INVALID_ARTIFACT");
    }
  }
  if (
    basename(runtime.executablePath).toLowerCase() !== "audio-separator.exe" ||
    basename(runtime.ffmpegPath).toLowerCase() !== "ffmpeg.exe" ||
    basename(runtime.modelPath) !== VOCAL_SEPARATION_IDENTITY.modelFileName ||
    basename(runtime.configPath) !== VOCAL_SEPARATION_IDENTITY.configFileName ||
    !samePath(dirname(runtime.executablePath), runtime.cwd) ||
    !samePath(dirname(runtime.modelPath), runtime.modelDir) ||
    !samePath(dirname(runtime.configPath), runtime.modelDir)
  ) {
    throw fail("Verified vocal separation paths are invalid", "INVALID_ARTIFACT");
  }
  const [executable, cwd, ffmpeg, modelDir, model, config] = await Promise.all([
    regularAbsolute(runtime.executablePath, "runtime executable", { missingCode: "NOT_AVAILABLE" }),
    regularAbsolute(runtime.cwd, "runtime directory", { directory: true, missingCode: "NOT_AVAILABLE" }),
    regularAbsolute(runtime.ffmpegPath, "ffmpeg", { missingCode: "NOT_AVAILABLE" }),
    regularAbsolute(runtime.modelDir, "model directory", { directory: true, missingCode: "NOT_AVAILABLE" }),
    regularAbsolute(runtime.modelPath, "vocal separation model", { missingCode: "NOT_AVAILABLE" }),
    regularAbsolute(runtime.configPath, "vocal separation config", { missingCode: "NOT_AVAILABLE" }),
  ]);
  if (
    executable.size <= 0 || ffmpeg.size <= 0 ||
    model.size !== VOCAL_SEPARATION_IDENTITY.modelSizeBytes ||
    config.size !== VOCAL_SEPARATION_IDENTITY.configSizeBytes
  ) {
    throw fail("Verified vocal separation artifact size is invalid", "INVALID_ARTIFACT");
  }
  let resolvedPaths;
  try {
    resolvedPaths = await Promise.all([
      realpath(runtime.cwd),
      realpath(runtime.executablePath),
      realpath(runtime.modelDir),
      realpath(runtime.modelPath),
      realpath(runtime.configPath),
    ]);
  } catch {
    throw fail("Verified vocal separation artifact location is invalid", "INVALID_ARTIFACT");
  }
  const [realCwd, realExecutable, realModelDir, realModel, realConfig] = resolvedPaths;
  if (
    !samePath(dirname(realExecutable), realCwd) ||
    !samePath(dirname(realModel), realModelDir) ||
    !samePath(dirname(realConfig), realModelDir)
  ) {
    throw fail("Verified vocal separation artifact location is invalid", "INVALID_ARTIFACT");
  }
  try {
    await verifyArtifact({
      path: realConfig,
      expectedSha256: VOCAL_SEPARATION_IDENTITY.configSha256,
      expectedSizeBytes: VOCAL_SEPARATION_IDENTITY.configSizeBytes,
      signature: artifactSignature(config),
    });
    await verifyArtifact({
      path: realModel,
      expectedSha256: VOCAL_SEPARATION_IDENTITY.modelSha256,
      expectedSizeBytes: VOCAL_SEPARATION_IDENTITY.modelSizeBytes,
      signature: artifactSignature(model),
    });
  } catch (error) {
    if (error?.code === "INVALID_ARTIFACT" || error?.code === "CANCELLED") throw error;
    throw fail("Verified vocal separation artifact hash is invalid", "INVALID_ARTIFACT");
  }
  return runtime;
}

function normalizedChunkDuration(value = VOCAL_SEPARATION_LIMITS.CHUNK_DURATION_DEFAULT_SECONDS) {
  if (value === null) return null;
  if (
    !Number.isInteger(value) ||
    value < VOCAL_SEPARATION_LIMITS.CHUNK_DURATION_MIN_SECONDS ||
    value > VOCAL_SEPARATION_LIMITS.CHUNK_DURATION_MAX_SECONDS
  ) {
    throw fail("chunkDurationSeconds is invalid");
  }
  return value;
}

function normalizedTimeout(value = VOCAL_SEPARATION_LIMITS.PROCESS_TIMEOUT_DEFAULT_MS) {
  if (
    !Number.isInteger(value) ||
    value < VOCAL_SEPARATION_LIMITS.PROCESS_TIMEOUT_MIN_MS ||
    value > VOCAL_SEPARATION_LIMITS.PROCESS_TIMEOUT_MAX_MS
  ) {
    throw fail("timeoutMs is invalid");
  }
  return value;
}

export function buildVocalSeparationArgv({
  inputPath,
  outputDir,
  modelDir,
  device,
  chunkDurationSeconds = VOCAL_SEPARATION_LIMITS.CHUNK_DURATION_DEFAULT_SECONDS,
}) {
  if (
    ![inputPath, outputDir, modelDir].every((value) => typeof value === "string" && isAbsolute(value)) ||
    !new Set(["cpu", "cuda"]).has(device)
  ) {
    throw fail("Vocal separation process arguments are invalid");
  }
  const chunkDuration = normalizedChunkDuration(chunkDurationSeconds);
  return [
    inputPath,
    "--model_filename", VOCAL_SEPARATION_IDENTITY.modelFileName,
    "--model_file_dir", modelDir,
    "--output_dir", outputDir,
    "--output_format", "WAV",
    "--single_stem", "Vocals",
    "--sample_rate", String(VOCAL_SEPARATION_IDENTITY.outputSampleRate),
    "--use_soundfile",
    ...(chunkDuration === null ? [] : ["--chunk_duration", String(chunkDuration)]),
    // audio-separator's long-file chunker matches this key case-sensitively and emits "vocals".
    "--custom_output_names", JSON.stringify({ vocals: "vocals" }),
    "--log_level", "info",
    ...(device === "cuda" ? ["--use_autocast"] : []),
  ];
}

function processEnvironment(runtime) {
  const blockedProxy = "http://127.0.0.1:9";
  const ffmpegDir = dirname(runtime.ffmpegPath);
  return {
    PATH: ffmpegDir,
    Path: ffmpegDir,
    PYTHONUTF8: "1",
    PYTHONNOUSERSITE: "1",
    HF_HUB_OFFLINE: "1",
    AUDIO_SEPARATOR_MODEL_DIR: runtime.modelDir,
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

async function verifyOfflineCatalog(path) {
  let value;
  try {
    value = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw fail("Offline model catalog is invalid", "INVALID_ARTIFACT");
  }
  if (!value) return false;
  if (!value.isFile() || value.isSymbolicLink() || value.size !== Buffer.byteLength(DOWNLOAD_CHECKS_TEXT)) {
    throw fail("Offline model catalog is invalid", "INVALID_ARTIFACT");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw fail("Offline model catalog is invalid", "INVALID_ARTIFACT");
  }
  if (JSON.stringify(parsed) !== JSON.stringify(DOWNLOAD_CHECKS)) {
    throw fail("Offline model catalog is invalid", "INVALID_ARTIFACT");
  }
  return true;
}

async function ensureOfflineCatalog(modelDir) {
  const destination = join(modelDir, "download_checks.json");
  if (await verifyOfflineCatalog(destination)) return destination;
  const temporary = join(modelDir, `.download_checks.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(DOWNLOAD_CHECKS_TEXT, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (!await verifyOfflineCatalog(destination)) {
      throw fail("Offline model catalog is unavailable", "INVALID_ARTIFACT");
    }
    return destination;
  } catch (error) {
    if (error?.code === "INVALID_ARTIFACT") throw error;
    throw fail("Offline model catalog could not be prepared", "INVALID_ARTIFACT");
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function validateRequestFiles(inputPath, outputDir) {
  if (
    typeof inputPath !== "string" || !isAbsolute(inputPath) ||
    typeof outputDir !== "string" || !isAbsolute(outputDir) ||
    !inputPath.toLowerCase().endsWith(".wav")
  ) {
    throw fail("Vocal separation work paths are invalid");
  }
  let input;
  let output;
  try {
    [input, output] = await Promise.all([lstat(inputPath), lstat(outputDir)]);
  } catch {
    throw fail("Vocal separation work paths are unavailable", "INVALID_INPUT");
  }
  if (
    !input.isFile() || input.isSymbolicLink() || input.size <= 44 ||
    !output.isDirectory() || output.isSymbolicLink()
  ) {
    throw fail("Vocal separation work paths are invalid");
  }
  const outputPath = join(outputDir, VOCAL_SEPARATION_IDENTITY.outputFileName);
  let existing;
  try {
    existing = await lstat(outputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw fail("Vocal separation output cannot be inspected", "INVALID_INPUT");
  }
  if (existing) {
    throw fail("Vocal separation output already exists", "CONFLICT");
  }
  return outputPath;
}

async function validateOutput(outputDir, outputPath) {
  const value = await lstat(outputPath).catch(() => null);
  if (
    !value?.isFile() || value.isSymbolicLink() || value.size <= 44 ||
    value.size > VOCAL_SEPARATION_LIMITS.OUTPUT_MAX_BYTES
  ) {
    throw fail("Vocal separation output is invalid", value?.size > VOCAL_SEPARATION_LIMITS.OUTPUT_MAX_BYTES
      ? "OUTPUT_TOO_LARGE" : "INVALID_ARTIFACT");
  }
  let resolvedPaths;
  try {
    resolvedPaths = await Promise.all([realpath(outputDir), realpath(outputPath)]);
  } catch {
    throw fail("Vocal separation output location is invalid", "INVALID_ARTIFACT");
  }
  const [realOutputDir, realOutputPath] = resolvedPaths;
  if (!isInside(realOutputDir, realOutputPath) || !samePath(dirname(realOutputPath), realOutputDir)) {
    throw fail("Vocal separation output location is invalid", "INVALID_ARTIFACT");
  }
  return realOutputPath;
}

function normalizedProcessError(error, device, cancelled = false) {
  if (cancelled || error?.code === "CANCELLED") return fail("Vocal separation was cancelled", "CANCELLED");
  if (error?.code === "PROCESS_FAILED" && device === "cuda") {
    return fail("Vocal separation CUDA initialization or execution failed", "CUDA_INITIALIZATION_FAILED");
  }
  if (PASSTHROUGH_CODES.has(error?.code)) {
    const messages = {
      TIMEOUT: "Vocal separation timed out",
      OUTPUT_TOO_LARGE: "Vocal separation output exceeded the limit",
      NOT_AVAILABLE: "Vocal separation runtime is unavailable",
      INVALID_ARTIFACT: "Vocal separation artifact is invalid",
      INVALID_INPUT: "Vocal separation request is invalid",
      CONFLICT: "Vocal separation operation conflicts with existing state",
      CUDA_INITIALIZATION_FAILED: "Vocal separation CUDA initialization or execution failed",
    };
    return fail(messages[error.code] ?? "Vocal separation failed", error.code);
  }
  return fail("Vocal separation process failed", "PROCESS_FAILED");
}

export function createVocalSeparationProcess({
  runProcess = runManagedProcess,
  cancelProcess = null,
  now = Date.now,
  verifyArtifact = verifySha256Artifact,
} = {}) {
  if (
    typeof runProcess !== "function" ||
    (cancelProcess !== null && typeof cancelProcess !== "function") ||
    typeof now !== "function" ||
    typeof verifyArtifact !== "function"
  ) {
    throw fail("Vocal separation process dependencies are invalid");
  }
  const active = new Map();
  const verifiedArtifacts = new Map();

  async function verifyArtifactOnce(spec) {
    const key = process.platform === "win32" ? spec.path.toLowerCase() : spec.path;
    const cached = verifiedArtifacts.get(key);
    if (cached?.signature === spec.signature && cached.expectedSha256 === spec.expectedSha256) {
      return;
    }
    await verifyArtifact(spec);
    verifiedArtifacts.set(key, { signature: spec.signature, expectedSha256: spec.expectedSha256 });
  }

  function begin(operationId) {
    safeOperation(operationId);
    if (active.has(operationId)) throw fail("operationId is already active", "CONFLICT");
    const state = { controller: new AbortController(), cancelled: false };
    active.set(operationId, state);
    return state;
  }

  async function invoke(operationId, state, spec) {
    try {
      const result = await runProcess({
        ...spec,
        shell: false,
        ...(cancelProcess ? {} : { signal: state.controller.signal }),
      });
      if (state.cancelled) throw fail("Vocal separation was cancelled", "CANCELLED");
      return result;
    } catch (error) {
      throw normalizedProcessError(error, spec.device, state.cancelled);
    }
  }

  function requestCancel(operationId, state) {
    state.cancelled = true;
    state.controller.abort();
    if (cancelProcess) {
      try {
        Promise.resolve(cancelProcess({ operationId })).catch(() => {});
      } catch {
        /* the local cancellation state remains authoritative */
      }
    }
  }

  return {
    async probe({ operationId, runtime }) {
      const state = begin(operationId);
      try {
        await validateRuntime(runtime, (spec) => verifyArtifactOnce({ ...spec, signal: state.controller.signal }));
        if (state.cancelled) throw fail("Vocal separation was cancelled", "CANCELLED");
        const result = await invoke(operationId, state, {
          absoluteExe: runtime.executablePath,
          argv: ["--version"],
          cwd: runtime.cwd,
          timeoutMs: VOCAL_SEPARATION_LIMITS.PROBE_TIMEOUT_MS,
          stdoutMaxBytes: 64 * 1024,
          stderrMaxBytes: 64 * 1024,
          envOverrides: processEnvironment(runtime),
          device: runtime.device,
        });
        const stdout = Buffer.isBuffer(result?.stdout)
          ? result.stdout
          : typeof result?.stdoutBase64 === "string"
            ? Buffer.from(result.stdoutBase64, "base64")
            : Buffer.from(String(result?.stdout ?? ""), "utf8");
        const version = stdout.toString("utf8").trim();
        if (!/^audio-separator(?:\.exe)?\s+0\.44\.5$/iu.test(version)) {
          throw fail("Vocal separation runtime version is invalid", "INVALID_ARTIFACT");
        }
        return {
          available: true,
          engineId: VOCAL_SEPARATION_IDENTITY.engineId,
          engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
          modelId: VOCAL_SEPARATION_IDENTITY.modelId,
          modelRevision: VOCAL_SEPARATION_IDENTITY.modelRevision,
          device: runtime.device,
        };
      } catch (error) {
        throw normalizedProcessError(error, runtime?.device, state.cancelled);
      } finally {
        active.delete(operationId);
      }
    },

    async separate({
      operationId,
      runtime,
      inputPath,
      outputDir,
      chunkDurationSeconds = VOCAL_SEPARATION_LIMITS.CHUNK_DURATION_DEFAULT_SECONDS,
      timeoutMs = VOCAL_SEPARATION_LIMITS.PROCESS_TIMEOUT_DEFAULT_MS,
    }) {
      const state = begin(operationId);
      let outputPath = null;
      let validatedRuntime = runtime;
      try {
        [validatedRuntime, outputPath] = await Promise.all([
          validateRuntime(runtime, (spec) => verifyArtifactOnce({ ...spec, signal: state.controller.signal })),
          validateRequestFiles(inputPath, outputDir),
        ]);
        const chunkDuration = normalizedChunkDuration(chunkDurationSeconds);
        const timeout = normalizedTimeout(timeoutMs);
        await ensureOfflineCatalog(validatedRuntime.modelDir);
        if (state.cancelled) throw fail("Vocal separation was cancelled", "CANCELLED");
        const startedAt = now();
        await invoke(operationId, state, {
          absoluteExe: validatedRuntime.executablePath,
          argv: buildVocalSeparationArgv({
            inputPath,
            outputDir,
            modelDir: validatedRuntime.modelDir,
            device: validatedRuntime.device,
            chunkDurationSeconds: chunkDuration,
          }),
          cwd: validatedRuntime.cwd,
          timeoutMs: timeout,
          stdoutMaxBytes: VOCAL_SEPARATION_LIMITS.STDOUT_MAX_BYTES,
          stderrMaxBytes: VOCAL_SEPARATION_LIMITS.STDERR_MAX_BYTES,
          truncateStderr: true,
          envOverrides: processEnvironment(validatedRuntime),
          device: validatedRuntime.device,
        });
        if (state.cancelled) throw fail("Vocal separation was cancelled", "CANCELLED");
        const vocalsPath = await validateOutput(outputDir, outputPath);
        return {
          vocalsPath,
          device: validatedRuntime.device,
          engineId: VOCAL_SEPARATION_IDENTITY.engineId,
          engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
          modelId: VOCAL_SEPARATION_IDENTITY.modelId,
          modelRevision: VOCAL_SEPARATION_IDENTITY.modelRevision,
          modelHash: VOCAL_SEPARATION_IDENTITY.modelSha256,
          configHash: VOCAL_SEPARATION_IDENTITY.configSha256,
          chunkDurationSeconds: chunkDuration,
          processingDurationMs: Math.max(0, now() - startedAt),
        };
      } catch (error) {
        if (outputPath) await rm(outputPath, { force: true }).catch(() => {});
        throw normalizedProcessError(error, validatedRuntime?.device, state.cancelled);
      } finally {
        active.delete(operationId);
      }
    },

    cancel(operationId) {
      safeOperation(operationId);
      const state = active.get(operationId);
      if (!state) return { cancelled: false };
      requestCancel(operationId, state);
      return { cancelled: true };
    },

    close() {
      const operations = [...active.entries()];
      for (const [operationId, state] of operations) requestCancel(operationId, state);
      return { cancelled: operations.length };
    },
  };
}
