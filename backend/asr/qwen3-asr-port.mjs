import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inspectAsrAsset } from "./runtime-registry.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISIONS = Object.freeze({
  "qwen3-asr-0.6b": "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
  "qwen3-asr-1.7b": "7278e1e70fe206f11671096ffdd38061171dd6e5",
  "qwen3-forced-aligner-0.6b": "c7cbfc2048c462b0d63a45797104fc9db3ad62b7",
});

function fail(message, code = "INVALID_ARTIFACT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${field} is required`);
  return value;
}

function string(value, field) {
  if (typeof value !== "string" || value.length === 0) throw fail(`${field} is required`);
  return value;
}

function safeId(value, field) {
  const id = string(value, field);
  if (!SAFE_ID.test(id)) throw fail(`${field} is invalid`);
  return id;
}

function sha256(value, field) {
  const hash = string(value, field).toLowerCase();
  if (!SHA256.test(hash)) throw fail(`${field} is invalid`);
  return hash;
}

function positive(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw fail(`${field} is invalid`);
  return value;
}

function https(value, field) {
  try {
    const url = new URL(string(value, field));
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw fail(`${field} must be HTTPS`);
  }
}

function relativePath(value, field) {
  const path = string(value, field).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw fail(`${field} is invalid`);
  }
  return path;
}

function files(value, field) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32) throw fail(`${field} is invalid`);
  const seen = new Set();
  const parsed = value.map((raw, index) => {
    const item = object(raw, `${field}[${index}]`);
    const path = relativePath(item.relativePath, `${field}[${index}].relativePath`);
    if (seen.has(path)) throw fail(`${field} contains duplicate paths`);
    seen.add(path);
    const role = string(item.role, `${field}[${index}].role`);
    if (!new Set(["config", "tokenizer", "weight", "notice"]).has(role)) throw fail(`${field} role is invalid`);
    return { relativePath: path, role, sizeBytes: positive(item.sizeBytes, field), sha256: sha256(item.sha256, field) };
  });
  if (!parsed.some(({ role }) => role === "weight") || !parsed.some(({ role }) => role === "notice")) {
    throw fail(`${field} must contain weights and a notice`);
  }
  return parsed;
}

function snapshot(raw, field, expectedId) {
  const value = object(raw, field);
  const id = safeId(value.id, `${field}.id`);
  if (id !== expectedId || value.revision !== REVISIONS[id]) throw fail(`${field} revision is not accepted`);
  const parsedFiles = files(value.files, `${field}.files`);
  const total = parsedFiles.filter(({ role }) => role !== "notice").reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (total !== value.sizeBytes) throw fail(`${field}.sizeBytes must equal its downloadable files`);
  return {
    id,
    displayName: string(value.displayName, `${field}.displayName`),
    repository: string(value.repository, `${field}.repository`),
    revision: value.revision,
    snapshotHash: sha256(value.snapshotHash, `${field}.snapshotHash`),
    sourceBaseUrl: https(value.sourceBaseUrl, `${field}.sourceBaseUrl`),
    mirrorBaseUrl: https(value.mirrorBaseUrl, `${field}.mirrorBaseUrl`),
    sizeBytes: positive(value.sizeBytes, `${field}.sizeBytes`),
    license: string(value.license, `${field}.license`),
    files: parsedFiles,
  };
}

export function validateQwenManifest(raw) {
  const manifest = object(raw, "manifest");
  if (manifest.schemaVersion !== 1) throw fail("unsupported Qwen manifest schemaVersion");
  const engine = object(manifest.engine, "manifest.engine");
  if (engine.id !== "qwen3-asr" || engine.version !== "0.0.6" || engine.license !== "Apache-2.0") {
    throw fail("Qwen engine identity is not accepted");
  }
  const rawRuntime = object(manifest.runtime, "manifest.runtime");
  if (
    rawRuntime.id !== "qwen3-asr-transformers-cu128-x64" ||
    rawRuntime.device !== "cuda" || rawRuntime.platform !== "win32" || rawRuntime.arch !== "x64" ||
    rawRuntime.pythonVersion !== "3.12.13"
  ) throw fail("Qwen runtime identity is not accepted");
  const bootstrap = object(rawRuntime.bootstrap, "manifest.runtime.bootstrap");
  const archive = object(bootstrap.archive, "manifest.runtime.bootstrap.archive");
  const entries = archive.entries;
  if (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.archivePath !== "uv.exe") {
    throw fail("Qwen bootstrap archive entries are invalid");
  }
  const models = ["qwen3-asr-0.6b", "qwen3-asr-1.7b"].map((id, index) => {
    const base = snapshot(manifest.models?.[index], `manifest.models[${index}]`, id);
    const value = manifest.models[index];
    if (
      value.family !== "qwen3-asr" || !new Set(["0.6b", "1.7b"]).has(value.variant) ||
      value.format !== "safetensors" || value.productStatus !== "preview" ||
      value.supportsCpu !== false || value.supportsCuda !== true ||
      value.languageScope !== "multilingual" || value.timestampSupport !== "forced-aligner"
    ) throw fail(`manifest.models[${index}] catalog is invalid`);
    return {
      ...base,
      family: value.family,
      variant: value.variant,
      format: value.format,
      quantization: "none",
      productStatus: value.productStatus,
      supportsCpu: value.supportsCpu,
      supportsCuda: value.supportsCuda,
      languageScope: value.languageScope,
      timestampSupport: value.timestampSupport,
      minimumMemoryBytes: positive(value.minimumMemoryBytes, "minimumMemoryBytes"),
      recommendedMemoryBytes: positive(value.recommendedMemoryBytes, "recommendedMemoryBytes"),
      recommendedVramBytes: positive(value.recommendedVramBytes, "recommendedVramBytes"),
    };
  });
  const aligner = snapshot(manifest.aligner, "manifest.aligner", "qwen3-forced-aligner-0.6b");
  return {
    schemaVersion: 1,
    engine: {
      id: engine.id,
      version: engine.version,
      repository: string(engine.repository, "manifest.engine.repository"),
      sourceUrl: https(engine.sourceUrl, "manifest.engine.sourceUrl"),
      license: engine.license,
      licenseUrl: https(engine.licenseUrl, "manifest.engine.licenseUrl"),
    },
    runtime: {
      id: rawRuntime.id,
      version: string(rawRuntime.version, "manifest.runtime.version"),
      platform: rawRuntime.platform,
      arch: rawRuntime.arch,
      device: rawRuntime.device,
      pythonVersion: rawRuntime.pythonVersion,
      requirementsFile: relativePath(rawRuntime.requirementsFile, "manifest.runtime.requirementsFile"),
      sidecarFile: relativePath(rawRuntime.sidecarFile, "manifest.runtime.sidecarFile"),
      bootstrap: {
        id: safeId(bootstrap.id, "manifest.runtime.bootstrap.id"),
        version: string(bootstrap.version, "manifest.runtime.bootstrap.version"),
        executable: relativePath(bootstrap.executable, "manifest.runtime.bootstrap.executable"),
        archive: {
          fileName: relativePath(archive.fileName, "archive.fileName"),
          sizeBytes: positive(archive.sizeBytes, "archive.sizeBytes"),
          sha256: sha256(archive.sha256, "archive.sha256"),
          sourceUrl: https(archive.sourceUrl, "archive.sourceUrl"),
          entries: entries.map((entry) => ({
            archivePath: relativePath(entry.archivePath, "entry.archivePath"),
            relativePath: relativePath(entry.relativePath, "entry.relativePath"),
            sizeBytes: positive(entry.sizeBytes, "entry.sizeBytes"),
            sha256: sha256(entry.sha256, "entry.sha256"),
          })),
          ignoredEntries: archive.ignoredEntries.map((entry) => ({
            archivePath: relativePath(entry.archivePath, "ignored.archivePath"),
            sizeBytes: positive(entry.sizeBytes, "ignored.sizeBytes"),
          })),
        },
      },
    },
    aligner,
    models,
  };
}

async function regularFile(path) {
  const value = await lstat(path).catch(() => null);
  return Boolean(value?.isFile() && !value.isSymbolicLink());
}

async function runtimeState(root, runtime) {
  try {
    const marker = JSON.parse(await readFile(join(root, ".ready.json"), "utf8"));
    const python = join(root, "venv", "Scripts", "python.exe");
    return marker.runtimeId === runtime.id && marker.runtimeVersion === runtime.version &&
      marker.pythonVersion === runtime.pythonVersion && await regularFile(python)
      ? { installState: "ready", python }
      : { installState: "corrupt", reason: "runtime_marker_mismatch" };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { installState: "not_installed", reason: "missing" }
      : { installState: "corrupt", reason: "runtime_verification_failed" };
  }
}

function modelCapability(model, status, dependencySizeBytes) {
  return {
    id: model.id,
    displayName: model.displayName,
    version: model.revision,
    modelHash: model.snapshotHash,
    family: model.family,
    variant: model.variant,
    quantization: model.quantization,
    format: model.format,
    sizeBytes: model.sizeBytes,
    license: model.license,
    minimumMemoryBytes: model.minimumMemoryBytes,
    recommendedMemoryBytes: model.recommendedMemoryBytes,
    recommendedVramBytes: model.recommendedVramBytes,
    supportsCpu: model.supportsCpu,
    supportsCuda: model.supportsCuda,
    languageScope: model.languageScope,
    timestampSupport: model.timestampSupport,
    productStatus: model.productStatus,
    dependencySizeBytes,
    ...status,
  };
}

export function createQwenRuntimePort({ manifest: raw, appOwnedRoot, resourceRoot, platform, arch }) {
  if (!isAbsolute(appOwnedRoot) || !isAbsolute(resourceRoot)) throw fail("Qwen roots must be absolute", "INVALID_INPUT");
  const manifest = validateQwenManifest(raw);
  const compatible = platform === manifest.runtime.platform && arch === manifest.runtime.arch;
  const runtimeRoot = join(appOwnedRoot, "runtimes", manifest.runtime.id);
  const modelRoot = (id) => join(appOwnedRoot, "models", id);
  const alignerRoot = join(appOwnedRoot, "auxiliary", manifest.aligner.id);

  async function getCapabilityStatus() {
    const runtime = compatible
      ? await runtimeState(runtimeRoot, manifest.runtime)
      : { installState: "incompatible", reason: "platform_or_arch" };
    const alignerStatus = compatible
      ? await inspectAsrAsset(alignerRoot, manifest.aligner.files)
      : { installState: "incompatible", reason: "platform_or_arch" };
    const models = await Promise.all(manifest.models.map(async (model) => modelCapability(
      model,
      compatible
        ? await inspectAsrAsset(modelRoot(model.id), model.files)
        : { installState: "incompatible", reason: "platform_or_arch" },
      manifest.aligner.sizeBytes,
    )));
    return {
      engine: { id: manifest.engine.id, version: manifest.engine.version },
      runtime: {
        id: manifest.runtime.id,
        version: manifest.runtime.version,
        device: "cuda",
        installState: runtime.installState,
        ...(runtime.reason ? { reason: runtime.reason } : {}),
      },
      aligner: {
        id: manifest.aligner.id,
        version: manifest.aligner.revision,
        modelHash: manifest.aligner.snapshotHash,
        sizeBytes: manifest.aligner.sizeBytes,
        ...alignerStatus,
      },
      models,
      ready: runtime.installState === "ready" && alignerStatus.installState === "ready" &&
        models.some(({ installState }) => installState === "ready"),
    };
  }

  async function resolveReadyRuntime(device, modelId) {
    if (device !== "cuda") throw fail("Qwen Preview requires CUDA", "NOT_AVAILABLE");
    const model = manifest.models.find(({ id }) => id === modelId);
    if (!model) throw fail("Qwen model is not allowed", "INVALID_INPUT");
    const status = await getCapabilityStatus();
    if (status.runtime.installState !== "ready" || status.aligner.installState !== "ready" ||
      status.models.find(({ id }) => id === modelId)?.installState !== "ready") {
      throw fail("Qwen runtime, model, or aligner is not ready", "NOT_AVAILABLE");
    }
    return {
      engineId: manifest.engine.id,
      engineVersion: manifest.engine.version,
      runtimeId: manifest.runtime.id,
      runtimeVersion: manifest.runtime.version,
      device: "cuda",
      executablePath: join(runtimeRoot, "venv", "Scripts", "python.exe"),
      cwd: runtimeRoot,
      sidecarPath: join(resourceRoot, manifest.runtime.sidecarFile),
      modelPath: modelRoot(model.id),
      modelId: model.id,
      modelVersion: model.revision,
      modelHash: model.snapshotHash,
      alignerPath: alignerRoot,
      alignerId: manifest.aligner.id,
      alignerVersion: manifest.aligner.revision,
      alignerHash: manifest.aligner.snapshotHash,
    };
  }

  return { getCapabilityStatus, resolveReadyRuntime, manifest };
}

export function createUnifiedAsrRuntimePort({ whisper, qwen }) {
  async function resolveQwenRuntime(device, modelId) {
    const runtime = await qwen.resolveReadyRuntime(device, modelId);
    try {
      return { ...runtime, ...await whisper.resolveReadyVadRuntime() };
    } catch {
      // VAD off remains usable; enabled VAD is rejected by the ASR service before media work.
      return runtime;
    }
  }

  return {
    async getCapabilityStatus() {
      const [base, preview] = await Promise.all([whisper.getCapabilityStatus(), qwen.getCapabilityStatus()]);
      const whisperModels = base.models.map((model) => ({
        ...model, engineId: base.engineId, engineVersion: base.engineVersion,
      }));
      const qwenRuntime = { ...preview.runtime, engineId: preview.engine.id, engineVersion: preview.engine.version };
      return {
        ...base,
        engines: [
          { id: base.engineId, version: base.engineVersion, runtime: base.runtime },
          { id: preview.engine.id, version: preview.engine.version, runtime: qwenRuntime },
        ],
        models: [...whisperModels, ...preview.models.map((model) => ({
          ...model, engineId: preview.engine.id, engineVersion: preview.engine.version,
        }))],
        optionalRuntimes: [...base.optionalRuntimes.map((runtime) => ({
          ...runtime, engineId: base.engineId, engineVersion: base.engineVersion,
        })), qwenRuntime],
        qwenAligner: preview.aligner,
        ready: base.ready || preview.ready,
      };
    },
    resolveReadyRuntime(device, modelId) {
      return modelId?.startsWith("qwen3-asr-")
        ? resolveQwenRuntime(device, modelId)
        : whisper.resolveReadyRuntime(device, modelId);
    },
    resolveReadyRuntimeForProbe(device, modelId) {
      return modelId?.startsWith("qwen3-asr-")
        ? qwen.resolveReadyRuntime(device, modelId)
        : whisper.resolveReadyRuntimeForProbe(device);
    },
  };
}
