import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

const REQUIRED_TOP_LEVEL = [
  "schemaVersion",
  "upstreamVersion",
  "provider",
  "recipe",
  "acquiredAt",
  "sourceUrl",
  "archive",
  "platform",
  "configure",
  "licenseClass",
  "linkage",
  "externalLibraries",
  "artifacts",
  "licenseFiles",
  "noticeFiles",
  "sourceDelivery",
  "authenticity",
  "sbom",
  "capabilities",
];

const FORBIDDEN_CONFIGURE = [/(?:^|[\s"'])--enable-gpl(?:$|[\s"'])/i, /(?:^|[\s"'])--enable-nonfree(?:$|[\s"'])/i];

const ALLOWED_AUTH_METHODS = new Set([
  "pinned-hash-in-version-controlled-manifest",
  "publisher-authenticode",
  "rebuild-from-pinned-recipe",
]);

const ALLOWED_ARTIFACT_ROLES = new Set(["ffmpeg", "ffprobe", "dll"]);
const BUILTIN_CONFIGURE_FLAGS = new Set(["--enable-version3", "--enable-shared", "--enable-pthreads"]);

function fail(message, code = "invalid_artifact") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw fail(`missing or empty field: ${field}`);
  }
  return value.trim();
}

function requireObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`missing or invalid field: ${field}`);
  }
  return value;
}

function requireSha256(value, field) {
  const hex = requireNonEmptyString(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw fail(`invalid sha256 for ${field}`);
  }
  return hex;
}

function requireSizeBytes(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw fail(`missing or invalid sizeBytes for ${field}`);
  }
  return value;
}

function requireHttpsUrl(value, field) {
  const text = requireNonEmptyString(value, field);
  try {
    if (new URL(text).protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw fail(`${field} must be an HTTPS URL`);
  }
  return text;
}

function requireIsoDate(value, field) {
  const text = requireNonEmptyString(value, field);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.valueOf()) || !parsed.toISOString().startsWith(text)) {
    throw fail(`${field} must be a valid YYYY-MM-DD date`);
  }
  return text;
}

function normalizeRelativePath(value, field) {
  const rel = requireNonEmptyString(value, field).replaceAll("\\", "/");
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.includes("\0")) {
    throw fail(`unsafe relativePath: ${field}`);
  }
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw fail(`unsafe relativePath: ${field}`);
  }
  return parts.join("/");
}

function assertConfigureAllowed(configure) {
  const text = requireNonEmptyString(configure, "configure");
  for (const pattern of FORBIDDEN_CONFIGURE) {
    if (pattern.test(text)) {
      throw fail(`configure contains forbidden flag matching ${pattern}: GPL/nonfree builds are rejected`);
    }
  }
  for (const flag of ["--enable-shared", "--disable-static"]) {
    const pattern = new RegExp(`(?:^|[\\s"'])${flag}(?:$|[\\s"'])`, "i");
    if (!pattern.test(text)) {
      throw fail(`configure must contain ${flag}`);
    }
  }
  return text;
}

function validateRecipe(recipe) {
  const value = requireObject(recipe, "recipe");
  const normalized = {
    repositoryUrl: requireHttpsUrl(value.repositoryUrl, "recipe.repositoryUrl"),
    variant: requireNonEmptyString(value.variant, "recipe.variant"),
  };
  const hasHostedRun = value.workflowRunUrl !== undefined;
  const localRecipeFields = [value.buildScriptPath, value.buildScriptSha256, value.buildEnvironment];
  const hasLocalRecipe = localRecipeFields.some((field) => field !== undefined);
  if (hasHostedRun === hasLocalRecipe) {
    throw fail("recipe must declare exactly one hosted workflow run or pinned local build script");
  }
  if (hasHostedRun) {
    const commit = requireNonEmptyString(value.commit, "recipe.commit").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw fail("recipe.commit must be a full 40-character commit");
    }
    return {
      ...normalized,
      commit,
      workflowRunUrl: requireHttpsUrl(value.workflowRunUrl, "recipe.workflowRunUrl"),
    };
  }
  return {
    ...normalized,
    buildScriptPath: normalizeRelativePath(value.buildScriptPath, "recipe.buildScriptPath"),
    buildScriptSha256: requireSha256(value.buildScriptSha256, "recipe.buildScriptSha256"),
    buildEnvironment: requireNonEmptyString(value.buildEnvironment, "recipe.buildEnvironment"),
  };
}

function validateArchive(archive) {
  const value = requireObject(archive, "archive");
  const fileName = requireNonEmptyString(value.fileName, "archive.fileName");
  if (fileName.includes("/") || fileName.includes("\\") || !fileName.toLowerCase().endsWith(".zip")) {
    throw fail("archive.fileName must be a plain .zip filename");
  }
  const sha256 = requireSha256(value.sha256, "archive.sha256");
  const providerDigest = requireNonEmptyString(value.providerDigest, "archive.providerDigest").toLowerCase();
  if (providerDigest !== `sha256:${sha256}`) {
    throw fail("archive.providerDigest must match archive.sha256");
  }
  return {
    fileName,
    sizeBytes: requireSizeBytes(value.sizeBytes, "archive"),
    sha256,
    providerDigest,
  };
}

function validateFileEntries(entries, field, { minCount = 1 } = {}) {
  if (!Array.isArray(entries) || entries.length < minCount) {
    throw fail(`missing ${field} evidence`);
  }
  return entries.map((entry, index) => {
    const item = requireObject(entry, `${field}[${index}]`);
    return {
      relativePath: normalizeRelativePath(item.relativePath, `${field}[${index}].relativePath`),
      sha256: requireSha256(item.sha256, `${field}[${index}].sha256`),
      sizeBytes: requireSizeBytes(item.sizeBytes, `${field}[${index}]`),
    };
  });
}

function validateArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw fail("missing artifacts");
  }
  const normalized = artifacts.map((entry, index) => {
    const item = requireObject(entry, `artifacts[${index}]`);
    const role = requireNonEmptyString(item.role, `artifacts[${index}].role`).toLowerCase();
    if (!ALLOWED_ARTIFACT_ROLES.has(role)) {
      throw fail(`unsupported artifact role: ${role}`);
    }
    const relativePath = normalizeRelativePath(item.relativePath, `artifacts[${index}].relativePath`);
    if ((role === "ffmpeg" || role === "ffprobe") && !relativePath.toLowerCase().endsWith(".exe")) {
      throw fail(`${role} artifact must be an .exe`);
    }
    if (role === "dll" && !relativePath.toLowerCase().endsWith(".dll")) {
      throw fail("dll artifact must be a .dll");
    }
    return {
      relativePath,
      role,
      sha256: requireSha256(item.sha256, `artifacts[${index}].sha256`),
      sizeBytes: requireSizeBytes(item.sizeBytes, `artifacts[${index}]`),
    };
  });
  for (const role of ["ffmpeg", "ffprobe"]) {
    if (normalized.filter((item) => item.role === role).length !== 1) {
      throw fail(`incomplete artifacts: exactly one ${role} role required`);
    }
  }
  if (!normalized.some((item) => item.role === "dll")) {
    throw fail("incomplete artifacts: shared build DLL inventory required");
  }
  return normalized;
}

function enabledExternalFlags(configure) {
  return new Set(
    [...configure.matchAll(/(?:^|[\s"'])(--enable-[a-z0-9-]+)(?=$|[\s"'])/gi)]
      .map((match) => match[1].toLowerCase())
      .filter((flag) => !BUILTIN_CONFIGURE_FLAGS.has(flag)),
  );
}

function validateExternalLibraries(externalLibraries, configure, evidencePaths) {
  if (!Array.isArray(externalLibraries)) {
    throw fail("missing or invalid field: externalLibraries");
  }
  const names = new Set();
  const flags = new Set();
  const normalized = externalLibraries.map((entry, index) => {
    const field = `externalLibraries[${index}]`;
    const item = requireObject(entry, field);
    const linkage = requireNonEmptyString(item.linkage, `${field}.linkage`);
    if (linkage !== "dynamic" && linkage !== "static") {
      throw fail(`invalid linkage for ${field}`);
    }
    const name = requireNonEmptyString(item.name, `${field}.name`);
    if (names.has(name.toLowerCase())) {
      throw fail(`duplicate external library: ${name}`);
    }
    names.add(name.toLowerCase());
    const hasConfigureFlag = item.configureFlag !== undefined;
    const hasRequiredBy = item.requiredBy !== undefined;
    if (hasConfigureFlag === hasRequiredBy) {
      throw fail(`${field} must declare exactly one configureFlag or requiredBy`);
    }
    const configureFlag = hasConfigureFlag
      ? requireNonEmptyString(item.configureFlag, `${field}.configureFlag`).toLowerCase()
      : null;
    if (configureFlag && (!/^--enable-[a-z0-9-]+$/.test(configureFlag) || flags.has(configureFlag))) {
      throw fail(`invalid or duplicate configureFlag for ${field}`);
    }
    if (configureFlag) flags.add(configureFlag);
    const noticePath = normalizeRelativePath(item.noticePath, `${field}.noticePath`);
    if (!evidencePaths.has(noticePath)) {
      throw fail(`${field}.noticePath is not declared in licenseFiles or noticeFiles: ${noticePath}`);
    }
    return {
      name,
      license: requireNonEmptyString(item.license, `${field}.license`),
      linkage,
      version: requireNonEmptyString(item.version, `${field}.version`),
      sourceUrl: requireHttpsUrl(item.sourceUrl, `${field}.sourceUrl`),
      ...(configureFlag
        ? { configureFlag }
        : { requiredBy: requireNonEmptyString(item.requiredBy, `${field}.requiredBy`) }),
      noticePath,
    };
  });
  for (const item of normalized) {
    if (item.requiredBy && (!names.has(item.requiredBy.toLowerCase()) || item.requiredBy.toLowerCase() === item.name.toLowerCase())) {
      throw fail(`external library requiredBy must name another declared component: ${item.name}`);
    }
  }
  const configured = enabledExternalFlags(configure);
  for (const flag of configured) {
    if (!flags.has(flag)) {
      throw fail(`externalLibraries is missing configured component: ${flag}`);
    }
  }
  for (const flag of flags) {
    if (!configured.has(flag)) {
      throw fail(`externalLibraries declares component absent from configure: ${flag}`);
    }
  }
  return normalized;
}

function assertUniqueDeclaredPaths(groups) {
  const seen = new Map();
  for (const [field, entries] of groups) {
    for (const entry of entries) {
      const previous = seen.get(entry.relativePath);
      if (previous) {
        throw fail(`duplicate relativePath reused by ${previous} and ${field}: ${entry.relativePath}`);
      }
      seen.set(entry.relativePath, field);
    }
  }
}

function validateSourceDelivery(sourceDelivery) {
  const value = requireObject(sourceDelivery, "sourceDelivery");
  requireNonEmptyString(value.method, "sourceDelivery.method");
  requireNonEmptyString(value.reference, "sourceDelivery.reference");
  return {
    method: value.method.trim(),
    reference: value.reference.trim(),
    notes: typeof value.notes === "string" ? value.notes : undefined,
  };
}

function validateAuthenticity(authenticity) {
  const value = requireObject(authenticity, "authenticity");
  const method = requireNonEmptyString(value.method, "authenticity.method");
  if (method === "same-download-page-hash-only") {
    throw fail("authenticity method rejected: same-download-page-hash-only is not an independent trust anchor");
  }
  if (!ALLOWED_AUTH_METHODS.has(method)) {
    throw fail(`authenticity method not allowed: ${method}`);
  }
  requireNonEmptyString(value.trustAnchor, "authenticity.trustAnchor");
  return {
    method,
    trustAnchor: value.trustAnchor.trim(),
  };
}

function validateSbom(sbom) {
  const value = requireObject(sbom, "sbom");
  requireNonEmptyString(value.componentName, "sbom.componentName");
  requireNonEmptyString(value.componentVersion, "sbom.componentVersion");
  const purl = requireNonEmptyString(value.purl, "sbom.purl");
  if (!purl.startsWith("pkg:")) {
    throw fail("sbom.purl must be a package URL");
  }
  return {
    componentName: value.componentName.trim(),
    componentVersion: value.componentVersion.trim(),
    purl,
  };
}

function validateCapabilities(capabilities) {
  const value = requireObject(capabilities, "capabilities");
  if (
    value.probe !== true
    || value.textSubtitleExtract !== true
    || value.softSubtitleMux !== true
    || value.assBurn !== true
  ) {
    throw fail("capabilities must confirm probe, textSubtitleExtract, softSubtitleMux, and assBurn");
  }
  return { probe: true, textSubtitleExtract: true, softSubtitleMux: true, assBurn: true };
}

export function validateFfmpegArtifactManifest(manifest) {
  const root = requireObject(manifest, "manifest");
  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in root) || root[field] === undefined || root[field] === null) {
      throw fail(`missing or empty field: ${field}`);
    }
  }
  if (root.schemaVersion !== 1) {
    throw fail("unsupported manifest schemaVersion");
  }

  const licenseClass = requireNonEmptyString(root.licenseClass, "licenseClass");
  if (licenseClass !== "LGPL-2.1-or-later" && licenseClass !== "LGPL-3.0-or-later") {
    throw fail("licenseClass must be LGPL-oriented for V1");
  }

  const artifacts = validateArtifacts(root.artifacts);
  const licenseFiles = validateFileEntries(root.licenseFiles, "licenseFiles");
  const noticeFiles = validateFileEntries(root.noticeFiles, "noticeFiles");
  assertUniqueDeclaredPaths([
    ["artifacts", artifacts],
    ["licenseFiles", licenseFiles],
    ["noticeFiles", noticeFiles],
  ]);

  const platform = requireNonEmptyString(root.platform, "platform");
  if (platform !== "win32-x64") {
    throw fail("platform must be win32-x64");
  }
  const linkage = requireNonEmptyString(root.linkage, "linkage");
  if (linkage !== "dynamic") {
    throw fail("linkage must be dynamic for the V1 LGPL build");
  }
  const configure = assertConfigureAllowed(root.configure);
  const evidencePaths = new Set([...licenseFiles, ...noticeFiles].map((entry) => entry.relativePath));
  const externalLibraries = validateExternalLibraries(root.externalLibraries, configure, evidencePaths);

  return {
    ok: true,
    schemaVersion: 1,
    upstreamVersion: requireNonEmptyString(root.upstreamVersion, "upstreamVersion"),
    provider: requireNonEmptyString(root.provider, "provider"),
    recipe: validateRecipe(root.recipe),
    acquiredAt: requireIsoDate(root.acquiredAt, "acquiredAt"),
    sourceUrl: requireHttpsUrl(root.sourceUrl, "sourceUrl"),
    archive: validateArchive(root.archive),
    platform,
    licenseClass,
    linkage,
    configure,
    externalLibraries,
    artifacts,
    licenseFiles,
    noticeFiles,
    sourceDelivery: validateSourceDelivery(root.sourceDelivery),
    authenticity: validateAuthenticity(root.authenticity),
    sbom: validateSbom(root.sbom),
    capabilities: validateCapabilities(root.capabilities),
  };
}

function sha256File(absolutePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(absolutePath));
  return hash.digest("hex");
}

function listFilesRecursive(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        out.push(absolute);
      }
    }
  };
  walk(rootDir);
  return out;
}

function toPosixRelative(rootDir, absolutePath) {
  const rel = relative(rootDir, absolutePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw fail("packaged path escaped artifact root");
  }
  return rel.split(sep).join("/");
}

function expectedDeclaredPaths(manifest) {
  const paths = new Set();
  for (const group of [manifest.artifacts, manifest.licenseFiles, manifest.noticeFiles]) {
    for (const entry of group) {
      paths.add(entry.relativePath);
    }
  }
  return paths;
}

export function verifyPackagedArtifacts(rawManifest, artifactRootDir) {
  const manifest = validateFfmpegArtifactManifest(rawManifest);
  const root = requireNonEmptyString(artifactRootDir, "artifactRootDir");
  if (!isAbsolute(root)) {
    throw fail("artifactRootDir must be absolute", "invalid_artifact");
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw fail("artifact root missing or incomplete", "invalid_artifact");
  }

  const declared = expectedDeclaredPaths(manifest);
  const onDisk = listFilesRecursive(root);
  const onDiskRel = new Map();
  for (const absolute of onDisk) {
    onDiskRel.set(toPosixRelative(root, absolute), absolute);
  }

  for (const relativePath of declared) {
    const absolute = onDiskRel.get(relativePath);
    if (!absolute) {
      throw fail(`packaged artifact missing: incomplete tree (${relativePath})`);
    }
  }

  for (const relativePath of onDiskRel.keys()) {
    if (!declared.has(relativePath)) {
      throw fail(`undeclared packaged file mismatch: ${relativePath}`);
    }
  }

  const checkHash = (entry) => {
    const absolute = onDiskRel.get(entry.relativePath);
    const actual = sha256File(absolute);
    if (actual !== entry.sha256) {
      throw fail(`hash mismatch for ${entry.relativePath}`);
    }
    if (entry.sizeBytes !== undefined) {
      const size = statSync(absolute).size;
      if (size !== entry.sizeBytes) {
        throw fail(`size mismatch for ${entry.relativePath}`);
      }
    }
  };

  for (const entry of manifest.artifacts) checkHash(entry);
  for (const entry of manifest.licenseFiles) checkHash(entry);
  for (const entry of manifest.noticeFiles) checkHash(entry);

  return {
    ok: true,
    artifactRootDir: normalize(root),
    artifactCount: manifest.artifacts.length,
  };
}

export function resolveVerifiedArtifactPaths(rawManifest, options = {}) {
  if (options.allowPathLookup) {
    throw fail("PATH lookup is forbidden for FFmpeg artifacts", "invalid_artifact");
  }
  const root = options.artifactRootDir;
  if (typeof root !== "string" || root.trim().length === 0) {
    throw fail("artifactRootDir is required", "not_available");
  }
  if (!isAbsolute(root)) {
    throw fail("artifactRootDir must be an absolute path", "invalid_artifact");
  }

  const manifest = validateFfmpegArtifactManifest(rawManifest);
  verifyPackagedArtifacts(manifest, root);

  const byRole = Object.fromEntries(
    manifest.artifacts.map((entry) => [entry.role, join(root, ...entry.relativePath.split("/"))]),
  );

  return {
    ok: true,
    ffmpegPath: byRole.ffmpeg,
    ffprobePath: byRole.ffprobe,
    artifactRootDir: normalize(root),
    upstreamVersion: manifest.upstreamVersion,
    licenseClass: manifest.licenseClass,
  };
}
