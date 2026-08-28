import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const INSTALL_STATES = Object.freeze({
  NOT_INSTALLED: "not_installed",
  READY: "ready",
  CORRUPT: "corrupt",
  INCOMPATIBLE: "incompatible",
});

function fail(message, code = "INVALID_ARTIFACT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`${field} is required`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw fail(`${field} is required`);
  }
  return value.trim();
}

function requireSha256(value, field) {
  const hex = requireString(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw fail(`${field} must be a SHA-256 digest`);
  }
  return hex;
}

function requireSize(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw fail(`${field}.sizeBytes must be a positive safe integer`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw fail(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw fail(`${field} must be a boolean`);
  return value;
}

function requireEnum(value, allowed, field) {
  const normalized = requireString(value, field);
  if (!allowed.has(normalized)) throw fail(`${field} is invalid`);
  return normalized;
}

function requireSafeId(value, field) {
  const id = requireString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw fail(`${field} is invalid`);
  return id;
}

function requireHttpsUrl(value, field) {
  const raw = requireString(value, field);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw fail(`${field} must be a trusted HTTPS URL`);
  }
}

function normalizeRelativePath(value, field) {
  const path = requireString(value, field).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0")) {
    throw fail(`${field} must be a safe relative path`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw fail(`${field} must be a safe relative path`);
  }
  return parts.join("/");
}

function validateFiles(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(`${field} must declare files`);
  }
  const seen = new Set();
  return value.map((raw, index) => {
    const entry = requireObject(raw, `${field}[${index}]`);
    const relativePath = normalizeRelativePath(entry.relativePath, `${field}[${index}].relativePath`);
    if (seen.has(relativePath)) throw fail(`${field} contains a duplicate path`);
    seen.add(relativePath);
    return {
      relativePath,
      role: requireString(entry.role, `${field}[${index}].role`),
      sizeBytes: requireSize(entry.sizeBytes, `${field}[${index}]`),
      sha256: requireSha256(entry.sha256, `${field}[${index}].sha256`),
    };
  });
}

function validateRuntimeArchive(value, files, field) {
  const archive = requireObject(value, field);
  const fileName = normalizeRelativePath(archive.fileName, `${field}.fileName`);
  if (fileName.includes("/")) throw fail(`${field}.fileName must be a file name`);
  const prefixValue = requireString(archive.entryPrefix, `${field}.entryPrefix`);
  if (!prefixValue.endsWith("/")) throw fail(`${field}.entryPrefix must end with /`);
  const entryPrefix = `${normalizeRelativePath(prefixValue.slice(0, -1), `${field}.entryPrefix`)}/`;
  const ignoredRaw = archive.ignoredEntries;
  if (!Array.isArray(ignoredRaw) || ignoredRaw.length > 128) {
    throw fail(`${field}.ignoredEntries must be a bounded array`);
  }
  const declared = new Set(
    files
      .filter((entry) => entry.role !== "notice")
      .map((entry) => `${entryPrefix}${entry.relativePath}`),
  );
  const ignoredEntries = ignoredRaw.map((raw, index) => {
    const itemField = `${field}.ignoredEntries[${index}]`;
    const item = requireObject(raw, itemField);
    const archivePath = normalizeRelativePath(item.archivePath, `${itemField}.archivePath`);
    if (declared.has(archivePath)) throw fail(`${field} contains a duplicate archive entry`);
    declared.add(archivePath);
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
      throw fail(`${itemField}.sizeBytes must be a non-negative safe integer`);
    }
    return { archivePath, sizeBytes: item.sizeBytes };
  });
  return {
    fileName,
    sizeBytes: requireSize(archive.sizeBytes, field),
    sha256: requireSha256(archive.sha256, `${field}.sha256`),
    sourceUrl: requireHttpsUrl(archive.sourceUrl, `${field}.sourceUrl`),
    entryPrefix,
    ignoredEntries,
  };
}

const LEGACY_SMALL_CATALOG = Object.freeze({
  displayName: "Small",
  family: "small",
  variant: "full",
  quantization: "none",
  format: "ggml",
  repository: "ggerganov/whisper.cpp",
  license: "MIT",
  minimumMemoryBytes: 1_073_741_824,
  recommendedMemoryBytes: 2_147_483_648,
  recommendedVramBytes: 1_073_741_824,
  supportsCpu: true,
  supportsCuda: true,
  languageScope: "multilingual",
  timestampSupport: "segment-and-token",
  productStatus: "stable",
});
const verifiedFileHashes = new Map();

function validateModel(raw, field, requireCatalog) {
  const model = requireObject(raw, field);
  const id = requireSafeId(model.id, `${field}.id`);
  const files = validateFiles(model.files, `${field}.files`);
  const roles = new Set(["model", "notice"]);
  if (files.some((entry) => !roles.has(entry.role))) {
    throw fail(`${field} contains an unsupported file role`);
  }
  if (!files.some((entry) => entry.role === "notice")) {
    throw fail(`${field} must declare at least one compliance notice`);
  }
  const modelFiles = files.filter((entry) => entry.role === "model");
  if (modelFiles.length !== 1) throw fail(`${field} must declare exactly one model file`);
  const modelHash = requireSha256(model.modelHash, `${field}.modelHash`);
  if (modelFiles[0].sha256 !== modelHash) throw fail(`${field}.modelHash must match the declared model file`);
  const compatibleEngineVersion = requireString(model.compatibleEngineVersion, `${field}.compatibleEngineVersion`);
  const version = requireString(model.version, `${field}.version`);

  let sourceUrl = null;
  let mirrorUrl = null;
  let catalog = LEGACY_SMALL_CATALOG;
  if (requireCatalog) {
    sourceUrl = requireHttpsUrl(model.sourceUrl, `${field}.sourceUrl`);
    mirrorUrl = requireHttpsUrl(model.mirrorUrl, `${field}.mirrorUrl`);
    if (sourceUrl === mirrorUrl) throw fail(`${field} official and mirror URLs must be distinct`);
    const variant = requireEnum(model.variant, new Set(["full", "q5_0", "q8_0"]), `${field}.variant`);
    const quantization = requireEnum(model.quantization, new Set(["none", "q5_0", "q8_0"]), `${field}.quantization`);
    if ((variant === "full" ? "none" : variant) !== quantization) {
      throw fail(`${field}.quantization must match the declared variant`);
    }
    const minimumMemoryBytes = requirePositiveInteger(model.minimumMemoryBytes, `${field}.minimumMemoryBytes`);
    const recommendedMemoryBytes = requirePositiveInteger(model.recommendedMemoryBytes, `${field}.recommendedMemoryBytes`);
    if (recommendedMemoryBytes < minimumMemoryBytes) {
      throw fail(`${field}.recommendedMemoryBytes must not be below minimumMemoryBytes`);
    }
    catalog = {
      displayName: requireString(model.displayName, `${field}.displayName`),
      family: requireEnum(model.family, new Set(["small", "large-v3-turbo", "large-v3"]), `${field}.family`),
      variant,
      quantization,
      format: requireEnum(model.format, new Set(["ggml"]), `${field}.format`),
      repository: requireString(model.repository, `${field}.repository`),
      license: requireString(model.license, `${field}.license`),
      minimumMemoryBytes,
      recommendedMemoryBytes,
      recommendedVramBytes: requirePositiveInteger(model.recommendedVramBytes, `${field}.recommendedVramBytes`),
      supportsCpu: requireBoolean(model.supportsCpu, `${field}.supportsCpu`),
      supportsCuda: requireBoolean(model.supportsCuda, `${field}.supportsCuda`),
      languageScope: requireEnum(model.languageScope, new Set(["multilingual"]), `${field}.languageScope`),
      timestampSupport: requireEnum(model.timestampSupport, new Set(["segment-and-token"]), `${field}.timestampSupport`),
      productStatus: requireEnum(model.productStatus, new Set(["stable", "preview", "evaluating"]), `${field}.productStatus`),
    };
  } else {
    if (id !== "small") throw fail("legacy ASR manifest model must be small");
    if (model.sourceUrl !== undefined) sourceUrl = requireHttpsUrl(model.sourceUrl, `${field}.sourceUrl`);
    if (model.mirrorUrl !== undefined) mirrorUrl = requireHttpsUrl(model.mirrorUrl, `${field}.mirrorUrl`);
  }
  return {
    id,
    version,
    compatibleEngineVersion,
    modelHash,
    sourceUrl,
    mirrorUrl,
    ...catalog,
    files,
  };
}

function validateVadModel(raw) {
  const field = "manifest.vadModel";
  const model = requireObject(raw, field);
  const files = validateFiles(model.files, `${field}.files`);
  if (files.some((entry) => entry.role !== "vad-model" && entry.role !== "notice")) {
    throw fail(`${field} contains an unsupported file role`);
  }
  const modelFiles = files.filter((entry) => entry.role === "vad-model");
  if (modelFiles.length !== 1) throw fail(`${field} must declare exactly one VAD model file`);
  if (!files.some((entry) => entry.role === "notice")) throw fail(`${field} must declare a compliance notice`);
  const modelHash = requireSha256(model.modelHash, `${field}.modelHash`);
  if (modelFiles[0].sha256 !== modelHash) throw fail(`${field}.modelHash must match the declared VAD model file`);
  const id = requireSafeId(model.id, `${field}.id`);
  const version = requireString(model.version, `${field}.version`);
  const sourceRevision = requireString(model.sourceRevision, `${field}.sourceRevision`);
  const compatibleEngineVersion = requireString(model.compatibleEngineVersion, `${field}.compatibleEngineVersion`);
  const repository = requireString(model.repository, `${field}.repository`);
  const license = requireString(model.license, `${field}.license`);
  if (
    id !== "silero-vad-v6.2.0" ||
    version !== "6.2.0" ||
    sourceRevision !== "9ffd54a1e1ee413ddf265af9913beaf518d1639b" ||
    compatibleEngineVersion !== "1.9.1" ||
    repository !== "ggml-org/whisper-vad" ||
    license !== "MIT"
  ) {
    throw fail(`${field} must match the accepted Silero VAD v6.2.0 resource`);
  }
  return {
    id,
    displayName: requireString(model.displayName, `${field}.displayName`),
    version,
    sourceRevision,
    compatibleEngineVersion,
    modelHash,
    repository,
    sourceUrl: requireHttpsUrl(model.sourceUrl, `${field}.sourceUrl`),
    license,
    licenseUrl: requireHttpsUrl(model.licenseUrl, `${field}.licenseUrl`),
    files,
  };
}

export function validateAsrManifest(rawManifest) {
  const manifest = requireObject(rawManifest, "manifest");
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2 && manifest.schemaVersion !== 3) {
    throw fail("unsupported ASR manifest schemaVersion");
  }
  const engine = requireObject(manifest.engine, "manifest.engine");
  const runtime = requireObject(manifest.runtime, "manifest.runtime");
  const engineId = requireString(engine.id, "manifest.engine.id");
  const engineVersion = requireString(engine.version, "manifest.engine.version");
  if (engineId !== "whisper.cpp" || engineVersion !== "1.9.1") {
    throw fail("engine must match the accepted whisper.cpp 1.9.1 ADR");
  }
  const runtimeFiles = validateFiles(runtime.files, "manifest.runtime.files");
  const runtimeRoles = new Set(["executable", "vad-executable", "library", "notice"]);
  if (runtimeFiles.some((entry) => !runtimeRoles.has(entry.role))) {
    throw fail("runtime manifest contains an unsupported file role");
  }
  if (runtimeFiles.filter((entry) => entry.role === "executable").length !== 1) {
    throw fail("runtime manifest must declare exactly one executable role");
  }
  if (!runtimeFiles.some((entry) => entry.role === "notice")) {
    throw fail("runtime manifest must declare at least one compliance notice");
  }
  const executable = normalizeRelativePath(runtime.executable, "manifest.runtime.executable");
  if (!runtimeFiles.some((entry) => entry.relativePath === executable && entry.role === "executable")) {
    throw fail("runtime executable must be declared exactly as an executable file");
  }
  const vadExecutable = manifest.schemaVersion === 3
    ? normalizeRelativePath(runtime.vadExecutable, "manifest.runtime.vadExecutable")
    : null;
  if (vadExecutable && (
    runtimeFiles.filter((entry) => entry.role === "vad-executable").length !== 1 ||
    !runtimeFiles.some((entry) => entry.relativePath === vadExecutable && entry.role === "vad-executable")
  )) {
    throw fail("runtime VAD executable must be declared exactly as a VAD executable file");
  }
  if (!vadExecutable && runtimeFiles.some((entry) => entry.role === "vad-executable")) {
    throw fail("legacy runtime cannot declare a VAD executable");
  }
  const runtimeArchive = validateRuntimeArchive(runtime.archive, runtimeFiles, "manifest.runtime.archive");
  const rawModels = manifest.schemaVersion === 1
    ? [requireObject(manifest.model, "manifest.model")]
    : manifest.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0 || rawModels.length > 32) {
    throw fail("manifest.models must be a bounded non-empty array");
  }
  const models = rawModels.map((model, index) => validateModel(
    model,
    manifest.schemaVersion === 1 ? "manifest.model" : `manifest.models[${index}]`,
    manifest.schemaVersion !== 1,
  ));
  const modelIds = new Set(models.map((model) => model.id));
  if (modelIds.size !== models.length) throw fail("manifest.models must contain unique model ids");
  const compatibilityModel = models.find((model) => model.id === "small");
  if (!compatibilityModel) throw fail("manifest.models must preserve the Small compatibility model");
  const vadModel = manifest.schemaVersion === 3 ? validateVadModel(manifest.vadModel) : null;
  const optionalRuntimesRaw = manifest.optionalRuntimes ?? [];
  if (!Array.isArray(optionalRuntimesRaw) || optionalRuntimesRaw.length > 1) {
    throw fail("optionalRuntimes must contain at most the accepted CUDA runtime");
  }
  const optionalRuntimes = optionalRuntimesRaw.map((raw, index) => {
    const field = `manifest.optionalRuntimes[${index}]`;
    const item = requireObject(raw, field);
    const files = validateFiles(item.files, `${field}.files`);
    const roles = new Set(["executable", "library", "notice"]);
    if (files.some((entry) => !roles.has(entry.role))) throw fail(`${field} contains an unsupported file role`);
    if (files.filter((entry) => entry.role === "executable").length !== 1) {
      throw fail(`${field} must declare exactly one executable role`);
    }
    if (!files.some((entry) => entry.role === "notice")) {
      throw fail(`${field} must declare a compliance notice`);
    }
    const executablePath = normalizeRelativePath(item.executable, `${field}.executable`);
    if (!files.some((entry) => entry.role === "executable" && entry.relativePath === executablePath)) {
      throw fail(`${field} executable must match the declared executable file`);
    }
    const device = requireString(item.device, `${field}.device`);
    if (device !== "cuda") throw fail(`${field}.device must be cuda`);
    const id = requireString(item.id, `${field}.id`);
    if (id === requireString(runtime.id, "manifest.runtime.id")) throw fail("runtime ids must be unique");
    const archive = validateRuntimeArchive(item.archive, files, `${field}.archive`);
    return {
      id,
      version: requireString(item.version, `${field}.version`),
      device,
      platform: requireString(item.platform, `${field}.platform`),
      arch: requireString(item.arch, `${field}.arch`),
      executable: executablePath,
      archive,
      files,
    };
  });
  return {
    schemaVersion: manifest.schemaVersion,
    engine: {
      id: engineId,
      version: engineVersion,
    },
    runtime: {
      id: requireString(runtime.id, "manifest.runtime.id"),
      version: requireString(runtime.version, "manifest.runtime.version"),
      platform: requireString(runtime.platform, "manifest.runtime.platform"),
      arch: requireString(runtime.arch, "manifest.runtime.arch"),
      executable,
      ...(vadExecutable ? { vadExecutable } : {}),
      archive: runtimeArchive,
      files: runtimeFiles,
    },
    model: compatibilityModel,
    models,
    vadModel,
    optionalRuntimes,
  };
}

async function pathType(path) {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) return "reparse";
    if (value.isDirectory()) return "directory";
    if (value.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

async function sha256File(path, value) {
  const key = `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`;
  const cached = verifiedFileHashes.get(key);
  if (cached) return cached;
  const hash = createHash("sha256");
  const pending = (async () => {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  })();
  verifiedFileHashes.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (verifiedFileHashes.get(key) === pending) verifiedFileHashes.delete(key);
    throw error;
  }
}

async function listFiles(root) {
  const files = new Map();
  let hasReparsePoint = false;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        hasReparsePoint = true;
      } else if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const rel = relative(root, absolute);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw fail("asset path escaped managed root");
        files.set(rel.split(sep).join("/"), absolute);
      } else {
        hasReparsePoint = true;
      }
    }
  }
  await walk(root);
  return { files, hasReparsePoint };
}

export async function inspectAsrAsset(root, entries) {
  const rootType = await pathType(root);
  if (rootType === "missing") return { installState: INSTALL_STATES.NOT_INSTALLED, reason: "missing" };
  if (rootType !== "directory") return { installState: INSTALL_STATES.CORRUPT, reason: "reparse_or_invalid_root" };
  try {
    const onDisk = await listFiles(root);
    if (onDisk.hasReparsePoint) return { installState: INSTALL_STATES.CORRUPT, reason: "reparse_point" };
    const declared = new Set(entries.map((entry) => entry.relativePath));
    for (const relativePath of onDisk.files.keys()) {
      if (!declared.has(relativePath)) {
        return { installState: INSTALL_STATES.CORRUPT, reason: "undeclared_file" };
      }
    }
    for (const entry of entries) {
      const absolute = onDisk.files.get(entry.relativePath);
      if (!absolute) return { installState: INSTALL_STATES.CORRUPT, reason: "missing_file" };
      const value = await stat(absolute);
      if (!value.isFile()) return { installState: INSTALL_STATES.CORRUPT, reason: "invalid_file" };
      if (value.size !== entry.sizeBytes) return { installState: INSTALL_STATES.CORRUPT, reason: "size_mismatch" };
      if ((await sha256File(absolute, value)) !== entry.sha256) {
        return { installState: INSTALL_STATES.CORRUPT, reason: "hash_mismatch" };
      }
    }
    return { installState: INSTALL_STATES.READY };
  } catch {
    return { installState: INSTALL_STATES.CORRUPT, reason: "verification_failed" };
  }
}

export function createAsrRuntimePort({
  manifest: rawManifest,
  appOwnedRoot,
  bundledRuntimeRoot = null,
  platform,
  arch,
}) {
  if (typeof appOwnedRoot !== "string" || !isAbsolute(appOwnedRoot)) {
    throw fail("appOwnedRoot must be absolute", "INVALID_INPUT");
  }
  if (bundledRuntimeRoot !== null && (typeof bundledRuntimeRoot !== "string" || !isAbsolute(bundledRuntimeRoot))) {
    throw fail("bundledRuntimeRoot must be an absolute path", "INVALID_INPUT");
  }
  const manifest = validateAsrManifest(rawManifest);
  const runtimeRoot = bundledRuntimeRoot ?? join(appOwnedRoot, "runtimes", manifest.runtime.id);
  const modelsById = new Map(manifest.models.map((model) => [model.id, model]));
  const vadRoot = manifest.vadModel ? join(appOwnedRoot, "auxiliary", manifest.vadModel.id) : null;

  function modelCapability(model, status) {
    const modelEntry = model.files.find((entry) => entry.role === "model");
    return {
      id: model.id,
      version: model.version,
      modelHash: model.modelHash,
      displayName: model.displayName,
      family: model.family,
      variant: model.variant,
      quantization: model.quantization,
      format: model.format,
      sizeBytes: modelEntry.sizeBytes,
      license: model.license,
      minimumMemoryBytes: model.minimumMemoryBytes,
      recommendedMemoryBytes: model.recommendedMemoryBytes,
      recommendedVramBytes: model.recommendedVramBytes,
      supportsCpu: model.supportsCpu,
      supportsCuda: model.supportsCuda,
      languageScope: model.languageScope,
      timestampSupport: model.timestampSupport,
      productStatus: model.productStatus,
      ...status,
    };
  }

  function compatibilityCapability(model) {
    return {
      id: model.id,
      version: model.version,
      modelHash: model.modelHash,
      installState: model.installState,
      ...(model.reason ? { reason: model.reason } : {}),
    };
  }

  function vadCapability(model, status) {
    const modelEntry = model.files.find((entry) => entry.role === "vad-model");
    return {
      id: model.id,
      displayName: model.displayName,
      version: model.version,
      modelHash: model.modelHash,
      sizeBytes: modelEntry.sizeBytes,
      license: model.license,
      ...status,
    };
  }

  async function getCapabilityStatus() {
    const managedRootType = await pathType(appOwnedRoot);
    const invalidRoot = managedRootType !== "directory" && managedRootType !== "missing"
      ? { installState: INSTALL_STATES.CORRUPT, reason: "reparse_root" }
      : null;
    const runtimeCompatible =
      manifest.runtime.platform === platform &&
      manifest.runtime.arch === arch &&
      manifest.runtime.version === manifest.engine.version;
    const runtimeStatus = invalidRoot ?? (runtimeCompatible
      ? await inspectAsrAsset(runtimeRoot, manifest.runtime.files)
      : { installState: INSTALL_STATES.INCOMPATIBLE, reason: "runtime_incompatible" });
    const models = [];
    for (const model of manifest.models) {
      const compatible = model.compatibleEngineVersion === manifest.engine.version;
      const status = invalidRoot ?? (compatible
        ? await inspectAsrAsset(join(appOwnedRoot, "models", model.id), model.files)
        : { installState: INSTALL_STATES.INCOMPATIBLE, reason: "model_incompatible" });
      models.push(modelCapability(model, status));
    }
    const compatibilityModel = models.find((model) => model.id === manifest.model.id);
    const vadModel = manifest.vadModel
      ? vadCapability(
          manifest.vadModel,
          invalidRoot ?? (manifest.vadModel.compatibleEngineVersion === manifest.engine.version
            ? await inspectAsrAsset(vadRoot, manifest.vadModel.files)
            : { installState: INSTALL_STATES.INCOMPATIBLE, reason: "vad_model_incompatible" }),
        )
      : null;
    const optionalRuntimes = [];
    for (const runtime of manifest.optionalRuntimes) {
      const compatible =
        runtime.platform === platform && runtime.arch === arch && runtime.version === manifest.engine.version;
      const runtimeStatus = invalidRoot ?? (compatible
        ? await inspectAsrAsset(join(appOwnedRoot, "runtimes", runtime.id), runtime.files)
        : { installState: INSTALL_STATES.INCOMPATIBLE, reason: "runtime_incompatible" });
      optionalRuntimes.push({
        id: runtime.id,
        version: runtime.version,
        device: runtime.device,
        ...runtimeStatus,
      });
    }
    return {
      engineId: manifest.engine.id,
      engineVersion: manifest.engine.version,
      runtime: {
        id: manifest.runtime.id,
        version: manifest.runtime.version,
        // 核心运行时随安装包交付时由应用自己管理，用户既不用装也装不了。界面靠
        // 这个标记区分"安装包缺件"和"开发版本来就没有"，不再说"只读展示"这种
        // 只有开发者看得懂的话。
        bundled: bundledRuntimeRoot !== null,
        ...runtimeStatus,
      },
      model: compatibilityCapability(compatibilityModel),
      models,
      ...(vadModel ? { vadModel } : {}),
      optionalRuntimes,
      ready:
        runtimeStatus.installState === INSTALL_STATES.READY &&
        compatibilityModel.installState === INSTALL_STATES.READY,
    };
  }

  async function resolveRuntime(device, requireModel, modelId = "small") {
    if (device !== "cpu" && device !== "cuda") {
      throw fail("device must be cpu or cuda", "INVALID_INPUT");
    }
    const selectedModel = requireModel ? modelsById.get(modelId) : null;
    if (requireModel && !selectedModel) throw fail("modelId is not declared", "INVALID_INPUT");
    const status = await getCapabilityStatus();
    const selectedRuntime = device === "cpu"
      ? manifest.runtime
      : manifest.optionalRuntimes.find((runtime) => runtime.device === "cuda");
    const selectedStatus = device === "cpu"
      ? status.runtime
      : status.optionalRuntimes.find((runtime) => runtime.device === "cuda");
    if (!selectedRuntime || !selectedStatus) {
      throw fail("cuda runtime is not declared", "NOT_AVAILABLE");
    }
    const selectedModelStatus = requireModel ? status.models.find((model) => model.id === modelId) : null;
    if (selectedStatus.installState !== INSTALL_STATES.READY || (requireModel && selectedModelStatus.installState !== INSTALL_STATES.READY)) {
      const failed = selectedStatus.installState !== INSTALL_STATES.READY ? selectedStatus : selectedModelStatus;
      throw fail(
        `${failed === selectedStatus ? "runtime" : "model"} is not ready: ${failed.reason}`,
        failed.installState === INSTALL_STATES.NOT_INSTALLED || failed.installState === INSTALL_STATES.INSTALLING
          ? "NOT_AVAILABLE"
          : "INVALID_ARTIFACT",
      );
    }
    const selectedRoot = device === "cpu"
      ? runtimeRoot
      : join(appOwnedRoot, "runtimes", selectedRuntime.id);
    const resolved = {
      engineId: manifest.engine.id,
      engineVersion: manifest.engine.version,
      runtimeId: selectedRuntime.id,
      runtimeVersion: selectedRuntime.version,
      device,
      executablePath: join(selectedRoot, ...selectedRuntime.executable.split("/")),
      cwd: selectedRoot,
    };
    if (!requireModel) return resolved;
    const modelEntry = selectedModel.files.find((entry) => entry.role === "model");
    const modelRoot = join(appOwnedRoot, "models", selectedModel.id);
    const selected = {
      ...resolved,
      modelId: selectedModel.id,
      modelVersion: selectedModel.version,
      modelHash: selectedModel.modelHash,
      modelPath: join(modelRoot, ...modelEntry.relativePath.split("/")),
    };
    if (manifest.vadModel && status.vadModel?.installState === INSTALL_STATES.READY) {
      const vadEntry = manifest.vadModel.files.find((entry) => entry.role === "vad-model");
      Object.assign(selected, {
        vadModelId: manifest.vadModel.id,
        vadModelVersion: manifest.vadModel.version,
        vadModelHash: manifest.vadModel.modelHash,
        vadModelPath: join(vadRoot, ...vadEntry.relativePath.split("/")),
      });
    }
    return selected;
  }

  async function resolveVadRuntime() {
    const status = await getCapabilityStatus();
    const failed = status.runtime.installState !== INSTALL_STATES.READY
      ? status.runtime
      : status.vadModel?.installState !== INSTALL_STATES.READY
        ? status.vadModel
        : null;
    if (!manifest.runtime.vadExecutable || !manifest.vadModel || failed) {
      throw fail(
        `VAD runtime is not ready${failed?.reason ? `: ${failed.reason}` : ""}`,
        failed?.installState === INSTALL_STATES.NOT_INSTALLED ? "NOT_AVAILABLE" : "INVALID_ARTIFACT",
      );
    }
    const vadEntry = manifest.vadModel.files.find((entry) => entry.role === "vad-model");
    return {
      vadExecutablePath: join(runtimeRoot, ...manifest.runtime.vadExecutable.split("/")),
      vadModelId: manifest.vadModel.id,
      vadModelVersion: manifest.vadModel.version,
      vadModelHash: manifest.vadModel.modelHash,
      vadModelPath: join(vadRoot, ...vadEntry.relativePath.split("/")),
    };
  }

  return {
    getCapabilityStatus,
    resolveReadyRuntime(device = "cpu", modelId = "small") {
      return resolveRuntime(device, true, modelId);
    },
    resolveReadyRuntimeForProbe(device = "cpu") {
      return resolveRuntime(device, false);
    },
    resolveReadyVadRuntime: resolveVadRuntime,
  };
}

export { INSTALL_STATES };
