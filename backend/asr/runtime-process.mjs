import { tmpdir } from "node:os";
import { lstat, mkdir, open, readFile, readlink, rename, symlink, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { runManagedProcess } from "../media/process-runner.mjs";
import { ASR_RESULT_LIMITS } from "./asr-contract.mjs";
import { alignAsrResultToPcmSilence } from "./pcm-silence-aligner.mjs";
import { canonicalizeWhisperCppResult } from "./whisper-cpp-canonicalizer.mjs";
import { ASR_SEGMENTATION_CONFIG } from "../../shared/asr-segmentation-config.mjs";
import { ASR_LANGUAGE_DETECTION_CONFIG } from "../../shared/asr-language-config.mjs";
import { isAsrModelId } from "../../shared/asr-model-ids.mjs";
import { normalizeAsrVadParameters } from "../../shared/asr-vad-config.mjs";
import { createQwenAsrProcess } from "./qwen3-asr-process.mjs";

const LIMITS = Object.freeze({
  PROBE_TIMEOUT_MS: 15_000,
  PROBE_STDOUT_MAX_BYTES: 64 * 1024,
  STDERR_MAX_BYTES: 16 * 1024,
  // 打开 -pp 之后 whisper 会把整份转写文本连同进度一起打到标准流上，长音频很容易
  // 超过原来的 1MB / 64KB。结果只从 -ojf 的 JSON 读，这两条流除了进度都不用，所以
  // 上限放宽到够 6 小时音频用；保留上限是为了仍能拦住失控输出。
  TRANSCRIBE_STDOUT_MAX_BYTES: 16 * 1024 * 1024,
  TRANSCRIBE_STDERR_MAX_BYTES: 4 * 1024 * 1024,
  ENGINE_JSON_MAX_BYTES: 128 * 1024 * 1024,
  TRANSCRIBE_TIMEOUT_MIN_MS: 2 * 60 * 1_000,
  TRANSCRIBE_TIMEOUT_MAX_MS: 6 * 60 * 60 * 1_000,
});

function fail(message, code = "INVALID_INPUT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 从 whisper.cpp 的 `-pp` 输出里取进度。
 *
 * 它打的是形如 `whisper_print_progress_callback: progress =  35%` 的行，但不同
 * 版本走 stdout 还是 stderr 并不一致，所以两条流都挂同一个解析器；重复的百分比
 * 会被丢掉，不会把同一个数字报两遍。
 *
 * 返回 undefined 而不是空函数：没有 onProgress 时不必给子进程挂无用的监听。
 */
function forwardWhisperProgress(onProgress) {
  if (typeof onProgress !== "function") return undefined;
  let carry = "";
  let last = -1;
  return (chunk) => {
    carry = `${carry}${chunk.toString("utf8")}`;
    // 只保留最后一段未完成的行，避免长时间运行时无限增长
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    if (carry.length > 4096) carry = carry.slice(-4096);
    for (const line of lines) {
      const match = /progress\s*=\s*(\d{1,3})\s*%/.exec(line);
      if (!match) continue;
      const progress = Number(match[1]);
      if (!Number.isFinite(progress) || progress === last) continue;
      last = progress;
      onProgress({ progress });
    }
  };
}

function normalizeRuntimeError(runtime, error) {
  return runtime.device === "cuda" && error?.code === "PROCESS_FAILED"
    ? fail("CUDA initialization or execution failed", "CUDA_INITIALIZATION_FAILED")
    : error;
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function cliRelativePath(workRoot, absolutePath, field) {
  const value = relative(workRoot, absolutePath);
  if (!value || isAbsolute(value) || !/^[A-Za-z0-9._/\\-]+$/.test(value)) {
    throw fail(`${field} cannot be represented as a safe relative path`, "INVALID_ARTIFACT");
  }
  return value;
}

function samePath(left, right) {
  const values = [left, right].map((value) => normalize(resolve(value)));
  return process.platform === "win32"
    ? values[0].toLowerCase() === values[1].toLowerCase()
    : values[0] === values[1];
}

async function cliAssetPath(workRoot, absolutePath, aliasName, field) {
  const aliasRoot = join(workRoot, ".native-assets");
  try {
    await mkdir(aliasRoot, { recursive: true });
  } catch {
    throw fail("ASR native asset alias root is invalid", "INVALID_ARTIFACT");
  }
  const root = await lstat(aliasRoot).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) {
    throw fail("ASR native asset alias root is invalid", "INVALID_ARTIFACT");
  }

  const target = dirname(absolutePath);
  const alias = join(aliasRoot, aliasName);
  if (!await lstat(alias).catch(() => null)) {
    try {
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw fail("ASR native asset alias could not be created", "INVALID_ARTIFACT");
      }
    }
  }
  const link = await lstat(alias).catch(() => null);
  const linkedTarget = link?.isSymbolicLink()
    ? await readlink(alias).catch(() => null)
    : null;
  if (!linkedTarget || !samePath(resolve(dirname(alias), linkedTarget), target)) {
    throw fail("ASR native asset alias is invalid", "INVALID_ARTIFACT");
  }
  return cliRelativePath(workRoot, join(alias, basename(absolutePath)), field);
}

function validateProbeInput(operationId, runtime) {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(operationId)) {
    throw fail("operationId is invalid");
  }
  if (!runtime || runtime.engineId !== "whisper.cpp" || runtime.engineVersion !== "1.9.1") {
    throw fail("verified whisper.cpp runtime is required", "INVALID_ARTIFACT");
  }
  const expectedRuntimeId = runtime.device === "cpu"
    ? "whisper-cpp-cpu-x64"
    : runtime.device === "cuda" ? "whisper-cpp-cuda-12.4-x64" : null;
  if (!expectedRuntimeId || runtime.runtimeId !== expectedRuntimeId || runtime.runtimeVersion !== "1.9.1") {
    throw fail("verified ASR device runtime is required", "INVALID_ARTIFACT");
  }
  if (
    typeof runtime.executablePath !== "string" ||
    typeof runtime.cwd !== "string" ||
    !isAbsolute(runtime.executablePath) ||
    !isAbsolute(runtime.cwd) ||
    !runtime.executablePath.toLowerCase().endsWith(".exe") ||
    dirname(normalize(runtime.executablePath)).toLowerCase() !== normalize(runtime.cwd).toLowerCase()
  ) {
    throw fail("verified runtime paths are invalid", "INVALID_ARTIFACT");
  }
  const bundled = typeof process.resourcesPath === "string" && isInside(process.resourcesPath, runtime.cwd);
  if (!bundled && [tmpdir(), process.cwd()].some((root) => isInside(root, runtime.cwd))) {
    throw fail("verified runtime must use a managed root outside temp and the repository", "INVALID_ARTIFACT");
  }
}

async function validateModelWorkInput(request) {
  validateProbeInput(request.operationId, request.runtime);
  if (
    typeof request.runtime.modelPath !== "string" ||
    !isAbsolute(request.runtime.modelPath) ||
    extname(request.runtime.modelPath).toLowerCase() !== ".bin" ||
    !isAsrModelId(request.runtime.modelId) ||
    typeof request.runtime.modelVersion !== "string" ||
    request.runtime.modelVersion.length === 0 ||
    request.runtime.modelVersion.length > 128 ||
    typeof request.runtime.modelHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.runtime.modelHash) ||
    [tmpdir(), process.cwd()].some((root) => isInside(root, request.runtime.modelPath))
  ) {
    throw fail("verified ASR model path is invalid", "INVALID_ARTIFACT");
  }
  if (
    typeof request.workRoot !== "string" ||
    !isAbsolute(request.workRoot) ||
    typeof request.audioPath !== "string" ||
    !isAbsolute(request.audioPath) ||
    !isInside(request.workRoot, request.audioPath) ||
    extname(request.audioPath).toLowerCase() !== ".wav" ||
    typeof request.outputName !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(request.outputName)
  ) {
    throw fail("ASR transcription work paths are invalid", "INVALID_ARTIFACT");
  }
  const [workRoot, audio] = await Promise.all([
    lstat(request.workRoot).catch(() => null),
    lstat(request.audioPath).catch(() => null),
  ]);
  if (
    !workRoot?.isDirectory() || workRoot.isSymbolicLink() ||
    !audio?.isFile() || audio.isSymbolicLink()
  ) {
    throw fail("ASR transcription work files are invalid", "INVALID_ARTIFACT");
  }
  if (
    !Number.isSafeInteger(request.mediaDurationMs) ||
    request.mediaDurationMs <= 0 ||
    request.mediaDurationMs > ASR_RESULT_LIMITS.MAX_MEDIA_DURATION_MS
  ) {
    throw fail("ASR media duration is invalid");
  }
}

async function validateTranscribeInput(request) {
  await validateModelWorkInput(request);
  if (request.languageMode === "auto" && request.languageHint === null) return "auto";
  if (
    request.languageMode === "fixed" &&
    typeof request.languageHint === "string" &&
    /^[A-Za-z]{2,3}$/.test(request.languageHint)
  ) {
    return request.languageHint.toLowerCase();
  }
  throw fail("ASR language selection is invalid");
}

function exactObject(value, keys) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)),
  );
}

function buildVadArgv(vad, runtime) {
  if (vad === undefined || (exactObject(vad, ["mode", "model", "parameters"]) && vad.mode === "off" && vad.model === null && vad.parameters === null)) {
    return [];
  }
  if (!exactObject(vad, ["mode", "model", "parameters"]) || !new Set(["auto", "custom"]).has(vad.mode)) {
    throw fail("VAD configuration is invalid");
  }
  if (
    !exactObject(vad.model, ["id", "version", "hash"]) ||
    vad.model.id !== "silero-vad-v6.2.0" ||
    vad.model.version !== "6.2.0" ||
    !/^[a-f0-9]{64}$/.test(vad.model.hash)
  ) {
    throw fail("VAD model configuration is invalid", "INVALID_ARTIFACT");
  }
  const parameters = normalizeAsrVadParameters(vad.parameters);
  if (
    runtime.vadModelId !== vad.model.id ||
    runtime.vadModelVersion !== vad.model.version ||
    runtime.vadModelHash !== vad.model.hash ||
    typeof runtime.vadModelPath !== "string" ||
    !isAbsolute(runtime.vadModelPath) ||
    extname(runtime.vadModelPath).toLowerCase() !== ".bin" ||
    [tmpdir(), process.cwd()].some((root) => isInside(root, runtime.vadModelPath))
  ) {
    throw fail("Verified VAD model is invalid", "INVALID_ARTIFACT");
  }
  return [
    "--vad",
    "--vad-model", runtime.vadModelPath,
    "--vad-threshold", String(parameters.threshold),
    "--vad-min-speech-duration-ms", String(parameters.minSpeechDurationMs),
    "--vad-min-silence-duration-ms", String(parameters.minSilenceDurationMs),
    "--vad-max-speech-duration-s", String(parameters.maxSpeechDurationSeconds),
    "--vad-speech-pad-ms", String(parameters.speechPadMs),
    "--vad-samples-overlap", String(parameters.samplesOverlapSeconds),
  ];
}

async function readEngineJson(path, maxBytes = LIMITS.ENGINE_JSON_MAX_BYTES) {
  const value = await lstat(path).catch(() => null);
  if (
    !value?.isFile() || value.isSymbolicLink() ||
    value.size <= 0 || value.size > maxBytes
  ) {
    throw fail("ASR engine output is missing or too large", "OUTPUT_TOO_LARGE");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw fail("ASR engine output is invalid", "INVALID_ASR_RESULT");
  }
}

async function writeCanonicalResult(path, result) {
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`, "utf8");
  if (bytes.length > ASR_RESULT_LIMITS.MAX_ARTIFACT_BYTES) {
    throw fail("Canonical ASR result exceeds the limit", "OUTPUT_TOO_LARGE");
  }
  const partial = `${path}.partial`;
  const file = await open(partial, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(partial, path);
  return bytes.length;
}

function createWhisperCppRuntimeProcess({ runProcess = runManagedProcess, reportChildProcess = () => {}, now = Date.now } = {}) {
  if (typeof runProcess !== "function" || typeof reportChildProcess !== "function") {
    throw fail("ASR runtime process dependencies are invalid");
  }
  const active = new Map();

  async function runOwnedProcess(operationId, spec) {
    let pid = null;
    try {
      return await runProcess({
        ...spec,
        onSpawn: (value) => {
          if (!Number.isInteger(value) || value <= 0) throw fail("ASR child process identity is invalid", "PROCESS_FAILED");
          pid = value;
          reportChildProcess({ operationId, pid, active: true });
        },
      });
    } finally {
      if (pid) {
        try {
          reportChildProcess({ operationId, pid, active: false });
        } catch {
          /* parent ownership channel may already be closed */
        }
      }
    }
  }

  return {
    async probe({ operationId, runtime }) {
      validateProbeInput(operationId, runtime);
      if (active.has(operationId)) throw fail("operationId is already active", "CONFLICT");
      const controller = new AbortController();
      active.set(operationId, controller);
      try {
        await runOwnedProcess(operationId, {
          absoluteExe: runtime.executablePath,
          argv: ["--version"],
          cwd: runtime.cwd,
          timeoutMs: LIMITS.PROBE_TIMEOUT_MS,
          stdoutMaxBytes: LIMITS.PROBE_STDOUT_MAX_BYTES,
          stderrMaxBytes: LIMITS.STDERR_MAX_BYTES,
          signal: controller.signal,
        });
        return {
          available: true,
          engineId: "whisper.cpp",
          engineVersion: "1.9.1",
          runtimeId: runtime.runtimeId,
          runtimeVersion: runtime.runtimeVersion,
          device: runtime.device,
        };
      } finally {
        active.delete(operationId);
      }
    },
    async transcribe(request) {
      const language = await validateTranscribeInput(request);
      const vadArgv = buildVadArgv(request.vad, request.runtime);
      const { operationId, runtime, workRoot, audioPath, outputName, mediaDurationMs } = request;
      if (active.has(operationId)) throw fail("operationId is already active", "CONFLICT");
      const outputPrefix = join(workRoot, outputName);
      const audioArg = cliRelativePath(workRoot, audioPath, "audioPath");
      const engineJsonPath = `${outputPrefix}.json`;
      const canonicalResultPath = `${outputPrefix}.canonical.json`;
      for (const path of [engineJsonPath, canonicalResultPath, `${canonicalResultPath}.partial`]) {
        if (await lstat(path).catch(() => null)) throw fail("ASR output already exists", "CONFLICT");
      }
      const modelArg = await cliAssetPath(workRoot, runtime.modelPath, "model", "modelPath");
      if (vadArgv.length) {
        vadArgv[2] = await cliAssetPath(workRoot, runtime.vadModelPath, "vad", "vadModelPath");
      }
      const controller = new AbortController();
      active.set(operationId, controller);
      const startedAt = now();
      try {
        await runOwnedProcess(operationId, {
          absoluteExe: runtime.executablePath,
          argv: [
            "-m", modelArg,
            "-f", audioArg,
            "-l", language,
            "-t", "6",
            "-bs", "5",
            "-bo", "5",
            "-tp", "0",
            "-ojf",
            "-of", outputName,
            // 让 whisper 打进度。原来这里是 -np（除结果外什么都不打），于是识别
            // 全程零输出：界面停在 10% 几十分钟，用户无法区分"在跑"和"死了"。
            // 结果仍然只从 -ojf 的 JSON 读，stdout 只用来取进度。
            "-pp",
            ...(runtime.device === "cpu" ? ["-ng"] : []),
            ...vadArgv,
          ],
          cwd: workRoot,
          timeoutMs: Math.min(
            LIMITS.TRANSCRIBE_TIMEOUT_MAX_MS,
            Math.max(LIMITS.TRANSCRIBE_TIMEOUT_MIN_MS, mediaDurationMs * 2),
          ),
          stdoutMaxBytes: LIMITS.TRANSCRIBE_STDOUT_MAX_BYTES,
          stderrMaxBytes: LIMITS.TRANSCRIBE_STDERR_MAX_BYTES,
          onStdout: forwardWhisperProgress(request.onProgress),
          onStderr: forwardWhisperProgress(request.onProgress),
          signal: controller.signal,
        });
        const source = await readEngineJson(engineJsonPath);
        if (Array.isArray(source.transcription) && source.transcription.length === 0) {
          throw fail("VAD did not detect any speech", "NO_SPEECH_DETECTED");
        }
        const canonical = alignAsrResultToPcmSilence(
          canonicalizeWhisperCppResult(source, { mediaDurationMs }),
          audioPath,
        );
        await writeCanonicalResult(canonicalResultPath, canonical);
        await unlink(engineJsonPath).catch(() => {});
        return {
          canonicalResultPath,
          processingDurationMs: Math.max(0, now() - startedAt),
          summary: {
            schemaVersion: 1,
            mediaDurationMs,
            rawSegmentCount: canonical.segments.length,
            wordCount: canonical.segments.reduce((total, segment) => total + segment.words.length, 0),
            detectedLanguage: canonical.detectedLanguage,
            warningCodes: canonical.warnings,
          },
        };
      } catch (error) {
        await unlink(engineJsonPath).catch(() => {});
        await unlink(canonicalResultPath).catch(() => {});
        await unlink(`${canonicalResultPath}.partial`).catch(() => {});
        throw normalizeRuntimeError(runtime, error);
      } finally {
        active.delete(operationId);
      }
    },
    async detectLanguageRegion(request) {
      await validateModelWorkInput(request);
      if (
        typeof request.segmentId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(request.segmentId) ||
        !Number.isSafeInteger(request.startMs) || !Number.isSafeInteger(request.endMs) ||
        request.startMs < 0 || request.endMs <= request.startMs || request.endMs > request.mediaDurationMs ||
        request.endMs - request.startMs > ASR_SEGMENTATION_CONFIG.maxDurationMs
      ) {
        throw fail("ASR language region is invalid");
      }
      const { operationId, runtime, workRoot, audioPath, outputName } = request;
      if (active.has(operationId)) throw fail("operationId is already active", "CONFLICT");
      const outputPrefix = join(workRoot, outputName);
      const audioArg = cliRelativePath(workRoot, audioPath, "audioPath");
      const engineJsonPath = `${outputPrefix}.json`;
      if (await lstat(engineJsonPath).catch(() => null)) throw fail("ASR language output already exists", "CONFLICT");
      const modelArg = await cliAssetPath(workRoot, runtime.modelPath, "model", "modelPath");
      const controller = new AbortController();
      active.set(operationId, controller);
      try {
        const processResult = await runOwnedProcess(operationId, {
          absoluteExe: runtime.executablePath,
          argv: [
            "-m", modelArg,
            "-f", audioArg,
            "-l", "auto",
            "-dl",
            "-ot", String(request.startMs),
            "-d", String(request.endMs - request.startMs),
            "-t", "6",
            "-ojf",
            "-of", outputName,
          ],
          cwd: workRoot,
          timeoutMs: LIMITS.TRANSCRIBE_TIMEOUT_MIN_MS,
          stdoutMaxBytes: LIMITS.PROBE_STDOUT_MAX_BYTES,
          stderrMaxBytes: LIMITS.TRANSCRIBE_STDERR_MAX_BYTES,
          includeRawStderr: true,
          signal: controller.signal,
        });
        const source = await readEngineJson(engineJsonPath, 1024 * 1024);
        const jsonLanguage = String(source?.result?.language ?? "").toLowerCase();
        const stderr = Buffer.isBuffer(processResult.stderr) ? processResult.stderr.toString("utf8") : "";
        const match = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([0-9.]+)\)/i.exec(stderr);
        const stderrLanguage = match?.[1]?.toLowerCase();
        const confidence = Number(match?.[2]);
        if (
          !/^[a-z]{2,3}$/.test(jsonLanguage) || stderrLanguage !== jsonLanguage ||
          !Number.isFinite(confidence) || confidence < 0 || confidence > 1
        ) {
          throw fail("ASR language evidence is invalid", "INVALID_ASR_RESULT");
        }
        await unlink(engineJsonPath).catch(() => {});
        return {
          segmentId: request.segmentId,
          detectedLanguage: jsonLanguage,
          confidence,
          detectionMethod: ASR_LANGUAGE_DETECTION_CONFIG.method,
          detectionVersion: ASR_LANGUAGE_DETECTION_CONFIG.version,
          overlapStatus: "none",
        };
      } catch (error) {
        await unlink(engineJsonPath).catch(() => {});
        throw normalizeRuntimeError(runtime, error);
      } finally {
        active.delete(operationId);
      }
    },
    cancel(operationId) {
      const controller = active.get(operationId);
      if (!controller) return { cancelled: false };
      controller.abort();
      return { cancelled: true };
    },
    close() {
      const controllers = [...active.values()];
      for (const controller of controllers) controller.abort();
      return { cancelled: controllers.length };
    },
  };
}

export function createAsrRuntimeProcess(options = {}) {
  const whisper = createWhisperCppRuntimeProcess(options);
  const qwen = createQwenAsrProcess(options);
  const selected = (request) => request?.runtime?.engineId === "qwen3-asr" ? qwen : whisper;
  return {
    probe: (request) => selected(request).probe(request),
    transcribe: (request) => selected(request).transcribe(request),
    detectLanguageRegion: (request) => selected(request).detectLanguageRegion?.(request)
      ?? Promise.reject(fail("Qwen language evidence is taken from its timestamped transcript", "NOT_AVAILABLE")),
    cancel(operationId) {
      const a = whisper.cancel(operationId);
      const b = qwen.cancel(operationId);
      return { cancelled: a.cancelled || b.cancelled };
    },
    close() {
      const a = whisper.close();
      const b = qwen.close();
      return { cancelled: a.cancelled + b.cancelled };
    },
  };
}

export { LIMITS as ASR_RUNTIME_PROCESS_LIMITS };

/** 仅供测试：进度解析是纯函数，值得单独测，不必为它跑一次真实识别。 */
export const __testables = { forwardWhisperProgress };
