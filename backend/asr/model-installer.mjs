import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, parse, relative, resolve } from "node:path";
import { isIP } from "node:net";
import { inspectAsrAsset, validateAsrManifest } from "./runtime-registry.mjs";
import { extractVerifiedZip } from "./verified-zip.mjs";
import { isProcessAlive as defaultIsProcessAlive } from "../media/process-runner.mjs";

const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);

function defaultGetProcessStartTime(pid) {
  if (pid === process.pid) return PROCESS_STARTED_AT_MS;
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const powershell = join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = execFileSync(powershell, [
      "-NoProfile", "-NonInteractive", "-Command",
      `$p=Get-Process -Id ${pid} -ErrorAction Stop; ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
    ], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim();
    const value = Number(output);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function installError(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

const INSTALL_ERROR_CODES = new Set([
  "INVALID_INPUT",
  "INVALID_ARTIFACT",
  "CONFLICT",
  "DOWNLOAD_FAILED",
  "LENGTH_MISMATCH",
  "HASH_MISMATCH",
  "INVALID_ARCHIVE",
  "CANCELLED",
]);

export function normalizeInstallError(error, signal) {
  if (signal?.aborted || error?.code === "ABORT_ERR" || error?.name === "AbortError") {
    return installError("CANCELLED", "Model installation was cancelled", true);
  }
  if (error?.code === "ENOSPC") {
    return installError("DISK_FULL", "There is not enough disk space to install the model", true);
  }
  if (error?.code === "INVALID_ARCHIVE") {
    return installError("INVALID_ARCHIVE", String(error.message || "Runtime archive is invalid"), false);
  }
  if (INSTALL_ERROR_CODES.has(error?.code) && typeof error?.retryable === "boolean") return error;
  if (
    error?.code === "DOWNLOAD_FAILED" ||
    error instanceof TypeError ||
    ["ECONNRESET", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code)
  ) {
    return installError("DOWNLOAD_FAILED", "Model download failed", true);
  }
  return installError("INSTALL_FAILED", "Model installation failed", false);
}

function requireSafeId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw installError("INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function trustedHttpsUrl(value, field) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw installError("INVALID_ARTIFACT", `${field} is not a trusted HTTPS URL`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertNoReparsePath(path, label) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const parts = relative(root, absolute).split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    const value = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!value) break;
    if (value.isSymbolicLink()) throw installError("INVALID_ARTIFACT", `${label} contains a reparse point`);
  }
}

async function writeBoundedBody(body, destination, expectedBytes, { startBytes = 0, signal, onProgress } = {}) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    throw installError("DOWNLOAD_FAILED", "Download response body is unavailable", true);
  }
  const file = await open(destination, startBytes > 0 ? "a" : "w");
  let written = startBytes;
  try {
    await onProgress?.(written);
    for await (const chunk of body) {
      if (signal?.aborted) throw installError("CANCELLED", "Model installation was cancelled", true);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += bytes.length;
      if (written > expectedBytes) {
        throw installError("LENGTH_MISMATCH", "Downloaded asset exceeds the trusted length");
      }
      await file.write(bytes);
      await onProgress?.(written);
    }
  } finally {
    try {
      await file.sync();
      if (written > startBytes && written < expectedBytes) {
        await onProgress?.(written, { forceCheckpoint: true });
      }
    } finally {
      await file.close();
    }
  }
  if (written !== expectedBytes) {
    throw installError("LENGTH_MISMATCH", "Downloaded asset length does not match the trusted manifest", true);
  }
  return written;
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return response.headers.get(name);
  const key = Object.keys(response?.headers || {}).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(response.headers[key]) : null;
}

export async function openFetchDownload({ url, headers, signal }) {
  const response = await fetch(url, { method: "GET", headers, signal, redirect: "follow" });
  return { status: response.status, headers: response.headers, body: response.body };
}

async function probeHttpsSource({ source, url }) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(5_000) });
    return { ok: response.ok, latencyMs: Math.max(0, Date.now() - startedAt) };
  } catch {
    return { ok: false, latencyMs: Math.max(0, Date.now() - startedAt) };
  }
}

function trustedCustomSource(value) {
  const href = trustedHttpsUrl(value, "customDownloadUrl");
  const url = new URL(href);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateIp = isIP(host) && /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i.test(host);
  if (host === "localhost" || host.endsWith(".local") || privateIp) {
    throw installError("INVALID_INPUT", "Custom download source is not public");
  }
  return href;
}

async function writeResumeMeta(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

async function readResumeState(partialPath, metaPath, identity) {
  try {
    const [file, raw] = await Promise.all([stat(partialPath), readFile(metaPath, "utf8")]);
    const meta = JSON.parse(raw);
    if (
      !file.isFile() ||
      file.size <= 0 ||
      file.size >= identity.sizeBytes ||
      meta.receivedBytes !== file.size ||
      meta.sourceUrl !== identity.sourceUrl ||
      meta.sha256 !== identity.sha256 ||
      typeof meta.etag !== "string" ||
      meta.etag.length === 0
    ) {
      return null;
    }
    return { receivedBytes: file.size, etag: meta.etag };
  } catch {
    return null;
  }
}

async function assertTrustedNotice(source, entry) {
  await assertNoReparsePath(source, "Trusted notice path");
  const value = await lstat(source).catch(() => null);
  if (!value || !value.isFile() || value.isSymbolicLink() || value.size !== entry.sizeBytes) {
    throw installError("INVALID_ARTIFACT", "Trusted model notice is missing or invalid");
  }
  if ((await sha256File(source)) !== entry.sha256) {
    throw installError("INVALID_ARTIFACT", "Trusted model notice hash mismatch");
  }
}

export function createModelInstaller({
  manifest: rawManifest,
  appOwnedRoot,
  trustedNoticeRoot,
  bundledVadRoot = null,
  openDownload = openFetchDownload,
  selectImportFile,
  isProcessAlive = defaultIsProcessAlive,
  getProcessStartTime = defaultGetProcessStartTime,
  isAssetInUse = () => false,
  reportProgress = () => {},
  getDownloadSettings = () => ({ downloadSource: "official", customDownloadUrl: "" }),
  probeSource = probeHttpsSource,
  now = Date.now,
  progressIntervalMs = 250,
}) {
  if (typeof appOwnedRoot !== "string" || !isAbsolute(appOwnedRoot)) {
    throw installError("INVALID_INPUT", "appOwnedRoot must be absolute");
  }
  if (typeof trustedNoticeRoot !== "string" || !isAbsolute(trustedNoticeRoot)) {
    throw installError("INVALID_INPUT", "trustedNoticeRoot must be absolute");
  }
  if (typeof openDownload !== "function") {
    throw installError("INVALID_INPUT", "openDownload is required");
  }
  if (
    typeof reportProgress !== "function" ||
    typeof isProcessAlive !== "function" ||
    typeof getProcessStartTime !== "function" ||
    typeof now !== "function" ||
    !Number.isSafeInteger(progressIntervalMs) ||
    progressIntervalMs < 50 ||
    progressIntervalMs > 5_000
  ) {
    throw installError("INVALID_INPUT", "progress reporting configuration is invalid");
  }
  const manifest = validateAsrManifest(rawManifest);
  if (bundledVadRoot !== null && (typeof bundledVadRoot !== "string" || !isAbsolute(bundledVadRoot))) {
    throw installError("INVALID_INPUT", "bundledVadRoot must be an absolute path");
  }
  const models = new Map(manifest.models.map((model) => [model.id, {
    model,
    modelEntry: model.files.find((entry) => entry.role === "model"),
    noticeEntries: model.files.filter((entry) => entry.role === "notice"),
    sourceUrls: Object.freeze({
      official: trustedHttpsUrl(model.sourceUrl, `${model.id}.sourceUrl`),
      mirror: trustedHttpsUrl(model.mirrorUrl, `${model.id}.mirrorUrl`),
    }),
  }]));
  const optionalRuntime = manifest.optionalRuntimes[0] ?? null;
  const vadModel = manifest.vadModel;
  const runtimeArchive = optionalRuntime?.archive ?? null;
  const runtimeNotices = optionalRuntime?.files.filter((entry) => entry.role === "notice") ?? [];
  const runtimeArchiveEntries = optionalRuntime?.files
    .filter((entry) => entry.role !== "notice")
    .map((entry) => ({
      archivePath: `${runtimeArchive.entryPrefix}${entry.relativePath}`,
      relativePath: entry.relativePath,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    })) ?? [];
  const locks = new Set();
  const activeOperations = new Map();
  const progressStates = new Map();

  async function ensureBundledVadInstalled() {
    if (!vadModel || !bundledVadRoot) return;
    await assertNoReparsePath(bundledVadRoot, "Bundled VAD root");
    const finalRoot = join(appOwnedRoot, "auxiliary", vadModel.id);
    if ((await inspectAsrAsset(finalRoot, vadModel.files)).installState === "ready") return;
    const modelEntry = vadModel.files.find((entry) => entry.role === "vad-model");
    const sourceStatus = await inspectAsrAsset(bundledVadRoot, [modelEntry]);
    if (sourceStatus.installState !== "ready") throw installError("INVALID_ARTIFACT", "Bundled VAD model is missing or corrupt");

    const stagingRoot = join(appOwnedRoot, "staging", "auxiliary", vadModel.id);
    const publishRoot = join(stagingRoot, "publish-startup");
    const replacedRoot = join(stagingRoot, "replaced-startup");
    await rm(publishRoot, { recursive: true, force: true });
    await rm(replacedRoot, { recursive: true, force: true });
    await mkdir(publishRoot, { recursive: true });
    const modelTarget = join(publishRoot, ...modelEntry.relativePath.split("/"));
    await mkdir(join(modelTarget, ".."), { recursive: true });
    await copyFile(join(bundledVadRoot, ...modelEntry.relativePath.split("/")), modelTarget);
    for (const entry of vadModel.files.filter((item) => item.role === "notice")) {
      const source = join(trustedNoticeRoot, basename(entry.relativePath));
      await assertTrustedNotice(source, entry);
      const target = join(publishRoot, ...entry.relativePath.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(source, target);
    }
    if ((await inspectAsrAsset(publishRoot, vadModel.files)).installState !== "ready") {
      throw installError("INVALID_ARTIFACT", "Staged VAD model failed verification");
    }

    await mkdir(join(finalRoot, ".."), { recursive: true });
    const existing = await lstat(finalRoot).catch(() => null);
    if (existing) await rename(finalRoot, replacedRoot);
    try {
      await rename(publishRoot, finalRoot);
    } catch (error) {
      if (existing) await rename(replacedRoot, finalRoot).catch(() => {});
      throw error;
    }
    await rm(replacedRoot, { recursive: true, force: true });
  }

  function requireModel(assetId) {
    const value = models.get(assetId);
    if (!value) throw installError("INVALID_INPUT", "assetId is not allowed");
    return value;
  }

  function configuredSources(modelConfig) {
    const settings = getDownloadSettings?.() ?? {};
    const values = { ...modelConfig.sourceUrls };
    if (typeof settings.customDownloadUrl === "string" && settings.customDownloadUrl) {
      values.custom = trustedCustomSource(settings.customDownloadUrl);
    }
    const preferred = ["official", "mirror", "custom"].includes(settings.downloadSource)
      && values[settings.downloadSource]
      ? settings.downloadSource
      : "official";
    const order = [preferred, "official", "mirror", ...(values.custom ? ["custom"] : [])]
      .filter((source, index, all) => values[source] && all.indexOf(source) === index);
    return { values, order };
  }

  function createProgressReporter({ operationId, assetId, assetKind, totalBytes }) {
    let lastDownloadAt = Number.NEGATIVE_INFINITY;
    return async (stage, receivedBytes = totalBytes) => {
      const timestamp = now();
      if (
        stage === "download" &&
        receivedBytes < totalBytes &&
        timestamp - lastDownloadAt < progressIntervalMs
      ) {
        return;
      }
      if (stage === "download") lastDownloadAt = timestamp;
      const event = Object.freeze({
        operationId,
        assetId,
        assetKind,
        stage,
        progress: totalBytes === 0 ? 0 : Math.min(1, Math.max(0, receivedBytes / totalBytes)),
        receivedBytes: Math.min(totalBytes, Math.max(0, receivedBytes)),
        totalBytes,
      });
      progressStates.set(assetId, { ...event, status: stage === "ready" ? "ready" : "active" });
      await Promise.resolve(reportProgress(event)).catch(() => {});
    };
  }

  async function runInstall({ assetId, source, operationId, manualPath = null }) {
    requireSafeId(operationId, "operationId");
    const modelConfig = requireModel(assetId);
    const { model, modelEntry, noticeEntries } = modelConfig;
    const manual = source === "manual" && typeof manualPath === "string";
    const downloadUrl = manual ? null : configuredSources(modelConfig).values[source];
    if (!downloadUrl && !manual) {
      throw installError("INVALID_INPUT", "download source is not allowed");
    }
    if (activeOperations.has(operationId)) throw installError("CONFLICT", "operationId is already active", true);
    if (locks.has(assetId)) throw installError("CONFLICT", "Model installation is already active", true);
    locks.add(assetId);
    const controller = new AbortController();
    activeOperations.set(operationId, controller);
    const lockDir = join(appOwnedRoot, "locks");
    const lockPath = join(lockDir, `${assetId}.lock`);
    let lockFile;
    let lockOwned = false;
    const stagingRoot = join(appOwnedRoot, "staging", "models", assetId);
    const partialPath = join(stagingRoot, "download.partial");
    const resumeMetaPath = join(stagingRoot, "download.meta.json");
    const publishRoot = join(stagingRoot, `publish-${operationId}`);
    const finalRoot = join(appOwnedRoot, "models", assetId);
    const progress = createProgressReporter({
      operationId,
      assetId,
      assetKind: "model",
      totalBytes: modelEntry.sizeBytes,
    });
    try {
      await assertNoReparsePath(appOwnedRoot, "Managed root");
      await mkdir(lockDir, { recursive: true });
      try {
        lockFile = await open(lockPath, "wx");
        lockOwned = true;
      } catch (error) {
        if (error?.code === "EEXIST") throw installError("CONFLICT", "Model installation lock is held", true);
        throw error;
      }
      await lockFile.writeFile(JSON.stringify({ assetId, operationId, pid: process.pid, processStartedAtMs: PROCESS_STARTED_AT_MS }));
      await lockFile.sync();
      await mkdir(stagingRoot, { recursive: true });
      await rm(publishRoot, { recursive: true, force: true });
      const identity = {
        sourceUrl: manual ? `manual:${model.id}` : downloadUrl,
        sizeBytes: modelEntry.sizeBytes,
        sha256: modelEntry.sha256,
      };
      const resume = manual ? null : await readResumeState(partialPath, resumeMetaPath, identity);
      const requestHeaders = resume
        ? { Range: `bytes=${resume.receivedBytes}-`, "If-Range": resume.etag }
        : {};
      let response;
      if (manual) {
        if (!isAbsolute(manualPath)) throw installError("INVALID_INPUT", "Manual import selection is invalid");
        await assertNoReparsePath(manualPath, "Manual import selection");
        const selected = await lstat(manualPath).catch(() => null);
        if (!selected || !selected.isFile() || selected.isSymbolicLink()) {
          throw installError("INVALID_INPUT", "Manual import selection is invalid");
        }
        response = { status: 200, headers: {}, body: createReadStream(manualPath) };
      } else {
        response = await openDownload({
          url: downloadUrl,
          headers: requestHeaders,
          signal: controller.signal,
        });
      }
      let responseEtag = responseHeader(response, "etag");
      let contentRange = responseHeader(response, "content-range");
      const expectedRange = resume
        ? `bytes ${resume.receivedBytes}-${modelEntry.sizeBytes - 1}/${modelEntry.sizeBytes}`
        : null;
      let canAppend =
        Boolean(resume) &&
        response?.status === 206 &&
        responseEtag === resume.etag &&
        contentRange === expectedRange;
      if (resume && !canAppend && (response?.status === 206 || response?.status === 416)) {
        await response?.body?.cancel?.().catch?.(() => {});
        await unlink(partialPath).catch(() => {});
        await unlink(resumeMetaPath).catch(() => {});
        response = await openDownload({ url: downloadUrl, headers: {}, signal: controller.signal });
        responseEtag = responseHeader(response, "etag");
        contentRange = responseHeader(response, "content-range");
        canAppend = false;
      }
      if (response?.status !== 200 && !canAppend) {
        throw installError("DOWNLOAD_FAILED", "Model download failed", response?.status >= 500 || response?.status === 429);
      }
      const startBytes = canAppend ? resume.receivedBytes : 0;
      const resumableEtag = typeof responseEtag === "string" && responseEtag.length > 0 ? responseEtag : null;
      let lastResumeCheckpointAt = Number.NEGATIVE_INFINITY;
      if (!canAppend) await unlink(resumeMetaPath).catch(() => {});
      await writeBoundedBody(response.body, partialPath, modelEntry.sizeBytes, {
        startBytes,
        signal: controller.signal,
        onProgress: async (receivedBytes, { forceCheckpoint = false } = {}) => {
          const timestamp = now();
          if (
            resumableEtag &&
            (forceCheckpoint || receivedBytes === modelEntry.sizeBytes || timestamp - lastResumeCheckpointAt >= progressIntervalMs)
          ) {
            await writeResumeMeta(resumeMetaPath, {
                ...identity,
                etag: resumableEtag,
                receivedBytes,
            });
            lastResumeCheckpointAt = timestamp;
          }
          await progress("download", receivedBytes);
        },
      });
      if ((await sha256File(partialPath)) !== modelEntry.sha256) {
        throw installError("HASH_MISMATCH", "Downloaded model hash does not match the trusted manifest");
      }
      await progress("verify");

      await mkdir(publishRoot, { recursive: true });
      for (const entry of noticeEntries) {
        const sourcePath = join(trustedNoticeRoot, basename(entry.relativePath));
        await assertTrustedNotice(sourcePath, entry);
        const targetPath = join(publishRoot, ...entry.relativePath.split("/"));
        await mkdir(join(targetPath, ".."), { recursive: true });
        await copyFile(sourcePath, targetPath);
      }
      const modelTarget = join(publishRoot, ...modelEntry.relativePath.split("/"));
      await mkdir(join(modelTarget, ".."), { recursive: true });
      await rename(partialPath, modelTarget);
      await unlink(resumeMetaPath).catch(() => {});
      await mkdir(join(finalRoot, ".."), { recursive: true });
      const existing = await stat(finalRoot).catch(() => null);
      if (existing) throw installError("CONFLICT", "Model is already installed", false);
      await progress("publish");
      await rename(publishRoot, finalRoot);
      await progress("ready");
      return {
        assetId,
        installState: "ready",
        source,
        sizeBytes: modelEntry.sizeBytes,
        sha256: modelEntry.sha256,
        resumedFromBytes: startBytes,
      };
    } catch (error) {
      const normalized = normalizeInstallError(error, controller.signal);
      const previous = progressStates.get(assetId);
      progressStates.set(assetId, {
        ...(previous ?? { operationId, assetId, assetKind: "model", stage: "download", progress: 0, receivedBytes: 0, totalBytes: modelEntry.sizeBytes }),
        status: normalized.code === "CANCELLED" ? "paused" : "failed",
        errorCode: normalized.code,
      });
      throw normalized;
    } finally {
      await lockFile?.close().catch(() => {});
      if (lockOwned) await unlink(lockPath).catch(() => {});
      await rm(publishRoot, { recursive: true, force: true }).catch(() => {});
      locks.delete(assetId);
      activeOperations.delete(operationId);
    }
  }

  async function runRuntimeInstall({ assetId, source, operationId, manualPath = null }) {
    requireSafeId(operationId, "operationId");
    if (!optionalRuntime || assetId !== optionalRuntime.id) {
      throw installError("INVALID_INPUT", "assetId is not allowed");
    }
    const manual = source === "manual" && typeof manualPath === "string";
    if (source !== "official" && !manual) {
      throw installError("INVALID_INPUT", "runtime source is not allowed");
    }
    if (activeOperations.has(operationId)) throw installError("CONFLICT", "operationId is already active", true);
    if (locks.has(assetId)) throw installError("CONFLICT", "Runtime installation is already active", true);
    locks.add(assetId);
    const controller = new AbortController();
    activeOperations.set(operationId, controller);
    const lockDir = join(appOwnedRoot, "locks");
    const lockPath = join(lockDir, `${assetId}.lock`);
    const stagingRoot = join(appOwnedRoot, "staging", "runtimes", assetId);
    const partialPath = join(stagingRoot, "archive.partial");
    const resumeMetaPath = join(stagingRoot, "archive.meta.json");
    const publishRoot = join(stagingRoot, `publish-${operationId}`);
    const finalRoot = join(appOwnedRoot, "runtimes", assetId);
    const progress = createProgressReporter({
      operationId,
      assetId,
      assetKind: "runtime",
      totalBytes: runtimeArchive.sizeBytes,
    });
    let lockFile;
    let lockOwned = false;
    try {
      await assertNoReparsePath(appOwnedRoot, "Managed root");
      await mkdir(lockDir, { recursive: true });
      try {
        lockFile = await open(lockPath, "wx");
        lockOwned = true;
      } catch (error) {
        if (error?.code === "EEXIST") throw installError("CONFLICT", "Runtime installation lock is held", true);
        throw error;
      }
      await lockFile.writeFile(JSON.stringify({ assetId, operationId, pid: process.pid, processStartedAtMs: PROCESS_STARTED_AT_MS }));
      await lockFile.sync();
      await mkdir(stagingRoot, { recursive: true });
      await rm(publishRoot, { recursive: true, force: true });
      const identity = {
        sourceUrl: manual ? `manual:${optionalRuntime.id}` : runtimeArchive.sourceUrl,
        sizeBytes: runtimeArchive.sizeBytes,
        sha256: runtimeArchive.sha256,
      };
      const resume = manual ? null : await readResumeState(partialPath, resumeMetaPath, identity);
      const requestHeaders = resume
        ? { Range: `bytes=${resume.receivedBytes}-`, "If-Range": resume.etag }
        : {};
      let response;
      if (manual) {
        if (!isAbsolute(manualPath)) throw installError("INVALID_INPUT", "Manual import selection is invalid");
        await assertNoReparsePath(manualPath, "Manual import selection");
        const selected = await lstat(manualPath).catch(() => null);
        if (!selected || !selected.isFile() || selected.isSymbolicLink()) {
          throw installError("INVALID_INPUT", "Manual import selection is invalid");
        }
        response = { status: 200, headers: {}, body: createReadStream(manualPath) };
      } else {
        response = await openDownload({
          url: runtimeArchive.sourceUrl,
          headers: requestHeaders,
          signal: controller.signal,
        });
      }
      let responseEtag = responseHeader(response, "etag");
      let contentRange = responseHeader(response, "content-range");
      const expectedRange = resume
        ? `bytes ${resume.receivedBytes}-${runtimeArchive.sizeBytes - 1}/${runtimeArchive.sizeBytes}`
        : null;
      let canAppend =
        Boolean(resume) &&
        response?.status === 206 &&
        responseEtag === resume.etag &&
        contentRange === expectedRange;
      if (resume && !canAppend && (response?.status === 206 || response?.status === 416)) {
        await response?.body?.cancel?.().catch?.(() => {});
        await unlink(partialPath).catch(() => {});
        await unlink(resumeMetaPath).catch(() => {});
        response = await openDownload({ url: runtimeArchive.sourceUrl, headers: {}, signal: controller.signal });
        responseEtag = responseHeader(response, "etag");
        contentRange = responseHeader(response, "content-range");
        canAppend = false;
      }
      if (response?.status !== 200 && !canAppend) {
        throw installError("DOWNLOAD_FAILED", "Runtime download failed", response?.status >= 500 || response?.status === 429);
      }
      const startBytes = canAppend ? resume.receivedBytes : 0;
      const resumableEtag = typeof responseEtag === "string" && responseEtag.length > 0 ? responseEtag : null;
      let lastResumeCheckpointAt = Number.NEGATIVE_INFINITY;
      if (!canAppend) await unlink(resumeMetaPath).catch(() => {});
      await writeBoundedBody(response.body, partialPath, runtimeArchive.sizeBytes, {
        startBytes,
        signal: controller.signal,
        onProgress: async (receivedBytes, { forceCheckpoint = false } = {}) => {
          const timestamp = now();
          if (
            resumableEtag &&
            (forceCheckpoint || receivedBytes === runtimeArchive.sizeBytes || timestamp - lastResumeCheckpointAt >= progressIntervalMs)
          ) {
            await writeResumeMeta(resumeMetaPath, { ...identity, etag: resumableEtag, receivedBytes });
            lastResumeCheckpointAt = timestamp;
          }
          await progress("download", receivedBytes);
        },
      });
      if ((await sha256File(partialPath)) !== runtimeArchive.sha256) {
        await unlink(partialPath).catch(() => {});
        await unlink(resumeMetaPath).catch(() => {});
        throw installError("HASH_MISMATCH", "Downloaded runtime hash does not match the trusted manifest");
      }
      await progress("verify");

      try {
        await progress("extract");
        await extractVerifiedZip({
          archivePath: partialPath,
          destinationRoot: publishRoot,
          selected: runtimeArchiveEntries,
          ignored: runtimeArchive.ignoredEntries,
        });
      } catch (error) {
        if (error?.code === "INVALID_ARCHIVE") {
          await unlink(partialPath).catch(() => {});
          await unlink(resumeMetaPath).catch(() => {});
        }
        throw error;
      }
      for (const entry of runtimeNotices) {
        const sourcePath = join(trustedNoticeRoot, basename(entry.relativePath));
        await assertTrustedNotice(sourcePath, entry);
        const targetPath = join(publishRoot, ...entry.relativePath.split("/"));
        await mkdir(join(targetPath, ".."), { recursive: true });
        await copyFile(sourcePath, targetPath);
      }
      await mkdir(join(finalRoot, ".."), { recursive: true });
      const existing = await stat(finalRoot).catch(() => null);
      if (existing) throw installError("CONFLICT", "Runtime is already installed", false);
      await progress("publish");
      await rename(publishRoot, finalRoot);
      await unlink(partialPath).catch(() => {});
      await unlink(resumeMetaPath).catch(() => {});
      await progress("ready");
      return {
        assetId,
        installState: "ready",
        source,
        sizeBytes: runtimeArchive.sizeBytes,
        sha256: runtimeArchive.sha256,
      };
    } catch (error) {
      throw normalizeInstallError(error, controller.signal);
    } finally {
      await lockFile?.close().catch(() => {});
      if (lockOwned) await unlink(lockPath).catch(() => {});
      await rm(publishRoot, { recursive: true, force: true }).catch(() => {});
      locks.delete(assetId);
      activeOperations.delete(operationId);
    }
  }

  async function reconcileAsset({ assetId, stagingKind, partialName, metaName, identities }) {
    const lockDir = join(appOwnedRoot, "locks");
    const stagingRoot = join(appOwnedRoot, "staging", stagingKind, assetId);
    await mkdir(lockDir, { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    let staleLocksRemoved = 0;
    let liveWriter = false;
    const lockPath = join(lockDir, `${assetId}.lock`);
    try {
      const lockStat = await lstat(lockPath);
      let alive = false;
      if (lockStat.isFile() && !lockStat.isSymbolicLink()) {
        const value = JSON.parse(await readFile(lockPath, "utf8"));
        const processStartedAtMs = Number.isInteger(value.pid) && isProcessAlive(value.pid)
          ? await getProcessStartTime(value.pid)
          : null;
        alive = Number.isSafeInteger(value.processStartedAtMs) && Number.isSafeInteger(processStartedAtMs) &&
          Math.abs(value.processStartedAtMs - processStartedAtMs) < 2_000;
      }
      liveWriter = alive;
      if (!alive) {
        await unlink(lockPath);
        staleLocksRemoved += 1;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const removed = await unlink(lockPath).then(() => true, () => false);
        if (removed) staleLocksRemoved += 1;
      }
    }
    if (liveWriter) {
      return { staleLocksRemoved: 0, abandonedPublishesRemoved: 0, resumablePartialsPreserved: 0 };
    }

    let abandonedPublishesRemoved = 0;
    for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith("publish-")) continue;
      const path = join(stagingRoot, entry.name);
      if (entry.isSymbolicLink()) await unlink(path).catch(() => {});
      else await rm(path, { recursive: true, force: true });
      abandonedPublishesRemoved += 1;
    }

    const partialPath = join(stagingRoot, partialName);
    const metaPath = join(stagingRoot, metaName);
    await unlink(`${metaPath}.tmp`).catch(() => {});
    let resumablePartialsPreserved = 0;
    for (const identity of identities) {
      if (await readResumeState(partialPath, metaPath, identity)) {
        resumablePartialsPreserved = 1;
        break;
      }
    }
    if (!resumablePartialsPreserved) {
      await unlink(partialPath).catch(() => {});
      await unlink(metaPath).catch(() => {});
    }
    return { staleLocksRemoved, abandonedPublishesRemoved, resumablePartialsPreserved };
  }

  async function runUninstall({ assetId, operationId }, kind) {
    requireSafeId(operationId, "operationId");
    const allowed = kind === "model" ? models.has(assetId) : assetId === optionalRuntime?.id;
    if (!allowed) throw installError("INVALID_INPUT", "assetId is not allowed");
    if (locks.has(assetId)) throw installError("CONFLICT", `${kind === "model" ? "Model" : "Runtime"} installation is active`, true);
    locks.add(assetId);
    const lockDir = join(appOwnedRoot, "locks");
    const lockPath = join(lockDir, `${assetId}.lock`);
    let lockFile;
    let lockOwned = false;
    try {
      await assertNoReparsePath(appOwnedRoot, "Managed root");
      await mkdir(lockDir, { recursive: true });
      try {
        lockFile = await open(lockPath, "wx");
        lockOwned = true;
      } catch (error) {
        if (error?.code === "EEXIST") throw installError("CONFLICT", `${kind === "model" ? "Model" : "Runtime"} installation lock is held`, true);
        throw error;
      }
      await lockFile.writeFile(JSON.stringify({ assetId, operationId, pid: process.pid, processStartedAtMs: PROCESS_STARTED_AT_MS }));
      await lockFile.sync();
      if (await isAssetInUse(assetId)) throw installError("CONFLICT", `语音识别正在运行，请停止任务后再卸载${kind === "model" ? "模型" : "运行时"}。`, true);
      const collection = kind === "model" ? "models" : "runtimes";
      const finalRoot = join(appOwnedRoot, collection, assetId);
      const installed = await lstat(finalRoot).catch(() => null);
      if (!installed) return { assetId, uninstalled: false };
      if (!installed.isDirectory() || installed.isSymbolicLink()) {
        throw installError("INVALID_ARTIFACT", `Installed ${kind} root is invalid`);
      }
      const trashRoot = join(appOwnedRoot, "staging", "trash", `${kind}-${operationId}`);
      await mkdir(join(trashRoot, ".."), { recursive: true });
      await rm(trashRoot, { recursive: true, force: true });
      await rename(finalRoot, trashRoot);
      await rm(trashRoot, { recursive: true, force: true });
      return { assetId, uninstalled: true };
    } catch (error) {
      throw normalizeInstallError(error);
    } finally {
      await lockFile?.close().catch(() => {});
      if (lockOwned) await unlink(lockPath).catch(() => {});
      locks.delete(assetId);
    }
  }

  return {
    async install(request) {
      if (request?.source !== "auto") return runInstall(request);
      const modelConfig = requireModel(request?.assetId);
      const { order } = configuredSources(modelConfig);
      let lastError;
      for (const source of order) {
        try {
          return await runInstall({ ...request, source });
        } catch (error) {
          lastError = error;
          if (error?.code !== "DOWNLOAD_FAILED" || error?.retryable !== true) throw error;
        }
      }
      throw lastError ?? installError("DOWNLOAD_FAILED", "No download source is available", true);
    },
    installRuntime(request) {
      return runRuntimeInstall(request);
    },
    async importModel({ assetId, operationId }) {
      requireSafeId(operationId, "operationId");
      requireModel(assetId);
      if (typeof selectImportFile !== "function") {
        throw installError("NOT_AVAILABLE", "Manual model import is unavailable");
      }
      const selection = await selectImportFile({ assetId, extensions: ["bin"] });
      if (selection?.canceled || !selection?.filePath) return { canceled: true };
      return runInstall({ assetId, operationId, source: "manual", manualPath: selection.filePath });
    },
    async importRuntime({ assetId, operationId }) {
      requireSafeId(operationId, "operationId");
      if (!optionalRuntime || assetId !== optionalRuntime.id) {
        throw installError("INVALID_INPUT", "assetId is not allowed");
      }
      if (typeof selectImportFile !== "function") {
        throw installError("NOT_AVAILABLE", "Manual runtime import is unavailable");
      }
      const selection = await selectImportFile({ assetId, extensions: ["zip"] });
      if (selection?.canceled || !selection?.filePath) return { canceled: true };
      return runRuntimeInstall({ assetId, operationId, source: "manual", manualPath: selection.filePath });
    },
    async reconcile() {
      await assertNoReparsePath(appOwnedRoot, "Managed root");
      const results = [];
      try {
        await ensureBundledVadInstalled();
      } catch {
        if (vadModel) {
          await rm(join(appOwnedRoot, "staging", "auxiliary", vadModel.id, "publish-startup"), { recursive: true, force: true });
        }
      }
      for (const { model, modelEntry, sourceUrls } of models.values()) {
        results.push(await reconcileAsset({
          assetId: model.id,
          stagingKind: "models",
          partialName: "download.partial",
          metaName: "download.meta.json",
          identities: ["official", "mirror"].map((source) => ({
            sourceUrl: sourceUrls[source],
            sizeBytes: modelEntry.sizeBytes,
            sha256: modelEntry.sha256,
          })),
        }));
      }
      if (optionalRuntime) {
        results.push(await reconcileAsset({
          assetId: optionalRuntime.id,
          stagingKind: "runtimes",
          partialName: "archive.partial",
          metaName: "archive.meta.json",
          identities: [{
            sourceUrl: runtimeArchive.sourceUrl,
            sizeBytes: runtimeArchive.sizeBytes,
            sha256: runtimeArchive.sha256,
          }],
        }));
      }
      return results.reduce((total, result) => ({
        staleLocksRemoved: total.staleLocksRemoved + result.staleLocksRemoved,
        abandonedPublishesRemoved: total.abandonedPublishesRemoved + result.abandonedPublishesRemoved,
        resumablePartialsPreserved: total.resumablePartialsPreserved + result.resumablePartialsPreserved,
      }), { staleLocksRemoved: 0, abandonedPublishesRemoved: 0, resumablePartialsPreserved: 0 });
    },
    uninstall(request) {
      return runUninstall(request, "model");
    },
    uninstallRuntime(request) {
      return runUninstall(request, "runtime");
    },
    cancel({ operationId }) {
      const controller = activeOperations.get(operationId);
      if (!controller) return { cancelled: false };
      controller.abort();
      return { cancelled: true };
    },
    pause({ operationId }) {
      const result = this.cancel({ operationId });
      return { paused: result.cancelled };
    },
    getDownloadStatus() {
      return [...progressStates.values()].map((value) => ({ ...value }));
    },
    async getSourceHealth() {
      const { values } = configuredSources(requireModel("small"));
      const sources = ["official", "mirror", ...(values.custom ? ["custom"] : [])];
      return Promise.all(sources.map(async (source) => {
        const value = await probeSource({ source, url: values[source] });
        return {
          source,
          status: value?.ok === true ? "healthy" : "unavailable",
          latencyMs: Number.isFinite(value?.latencyMs) ? Math.max(0, Math.round(value.latencyMs)) : null,
        };
      }));
    },
  };
}
