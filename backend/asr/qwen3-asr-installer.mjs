import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { inspectAsrAsset } from "./runtime-registry.mjs";
import { normalizeInstallError, openFetchDownload } from "./model-installer.mjs";
import { validateQwenManifest } from "./qwen3-asr-port.mjs";
import { extractVerifiedZip } from "./verified-zip.mjs";

function fail(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function safeId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail("INVALID_INPUT", `${field} is invalid`);
  return value;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function removeUvPythonAlias(managedPython) {
  const managedRoot = dirname(managedPython);
  const match = /^cpython-(\d+\.\d+)\.\d+-windows-x86_64-none$/.exec(basename(managedRoot));
  if (!match) return;
  const alias = join(dirname(managedRoot), `cpython-${match[1]}-windows-x86_64-none`);
  const value = await lstat(alias).catch(() => null);
  if (!value) return;
  if (!value.isSymbolicLink() || await realpath(alias) !== await realpath(managedRoot)) {
    throw fail("INVALID_ARTIFACT", "Managed Qwen Python alias is invalid");
  }
  await unlink(alias);
}

async function repairRuntimePythonHome(runtimeRoot, finalRoot, pythonVersion) {
  if (typeof pythonVersion !== "string") return false;
  const pythonName = `cpython-${pythonVersion}-windows-x86_64-none`;
  const python = await lstat(join(runtimeRoot, "python", pythonName, "python.exe")).catch(() => null);
  const configPath = join(runtimeRoot, "venv", "pyvenv.cfg");
  const config = await readFile(configPath, "utf8").catch(() => null);
  if (!python?.isFile() || python.isSymbolicLink() || !config || !/^home\s*=.*$/mi.test(config)) return false;
  const expected = join(finalRoot, "python", pythonName);
  const current = /^home\s*=\s*(.*)$/mi.exec(config)?.[1]?.trim();
  if (current && normalize(current).toLowerCase() === normalize(expected).toLowerCase()) return false;
  await writeFile(configPath, config.replace(/^home\s*=.*$/mi, `home = ${expected}`));
  return true;
}

async function responseBodyToFile(response, path, entry, startBytes, signal, onProgress) {
  const canResume = startBytes > 0 && response?.status === 206 &&
    response.headers?.get?.("content-range") === `bytes ${startBytes}-${entry.sizeBytes - 1}/${entry.sizeBytes}`;
  const start = canResume ? startBytes : 0;
  if (response?.status !== 200 && !canResume) throw fail("DOWNLOAD_FAILED", "Qwen snapshot download failed", true);
  const file = await open(path, start ? "a" : "w");
  let received = start;
  try {
    for await (const chunk of response.body ?? []) {
      if (signal.aborted) throw fail("CANCELLED", "Qwen snapshot download was paused", true);
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > entry.sizeBytes) throw fail("LENGTH_MISMATCH", "Qwen snapshot file exceeds its trusted size");
      await file.write(bytes);
      await onProgress(received);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  if (received !== entry.sizeBytes) throw fail("LENGTH_MISMATCH", "Qwen snapshot file length is incomplete", true);
  return start;
}

function downloadUrl(baseUrl, relativePath) {
  return new URL(relativePath.split("/").map(encodeURIComponent).join("/"), baseUrl).href;
}

export function createQwenInstaller({
  manifest: rawManifest,
  appOwnedRoot,
  trustedNoticeRoot,
  resourceRoot,
  validateManifest = validateQwenManifest,
  openDownload = openFetchDownload,
  extractArchive = extractVerifiedZip,
  runProcess = null,
  cancelProcess = () => ({ cancelled: false }),
  isAssetInUse = () => false,
  reportProgress = () => {},
}) {
  if (![appOwnedRoot, trustedNoticeRoot, resourceRoot].every((value) => typeof value === "string" && isAbsolute(value))) {
    throw fail("INVALID_INPUT", "Qwen installer roots must be absolute");
  }
  const manifest = validateManifest(rawManifest);
  const active = new Map();
  const progressStates = new Map();
  let locked = false;

  function model(assetId) {
    const value = manifest.models.find(({ id }) => id === assetId);
    if (!value) throw fail("INVALID_INPUT", "Qwen model is not allowed");
    return value;
  }

  async function progress(operationId, assetId, stage, receivedBytes, totalBytes, status = "active") {
    const event = { operationId, assetId, assetKind: assetId === manifest.runtime.id ? "runtime" : "model", stage,
      progress: totalBytes ? Math.min(1, receivedBytes / totalBytes) : 0, receivedBytes, totalBytes, status };
    progressStates.set(assetId, event);
    await Promise.resolve(reportProgress(event)).catch(() => {});
  }

  async function copyNotice(entry, publishRoot) {
    const source = join(trustedNoticeRoot, basename(entry.relativePath));
    const value = await lstat(source).catch(() => null);
    if (!value?.isFile() || value.isSymbolicLink() || value.size !== entry.sizeBytes || await sha256File(source) !== entry.sha256) {
      throw fail("INVALID_ARTIFACT", "Trusted Qwen notice is missing or invalid");
    }
    const destination = join(publishRoot, ...entry.relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  async function installSnapshot(snapshot, source, operationId, controller, progressBase, progressTotal) {
    const kind = snapshot.id === manifest.aligner.id ? "auxiliary" : "models";
    const finalRoot = join(appOwnedRoot, kind, snapshot.id);
    if ((await inspectAsrAsset(finalRoot, snapshot.files)).installState === "ready") {
      return { downloadedBytes: 0, resumedFromBytes: 0 };
    }
    const stagingRoot = join(appOwnedRoot, "staging", "qwen", snapshot.id);
    const downloadsRoot = join(stagingRoot, "downloads");
    const publishRoot = join(stagingRoot, `publish-${operationId}`);
    await mkdir(downloadsRoot, { recursive: true });
    await rm(publishRoot, { recursive: true, force: true });
    const baseUrl = source === "mirror" ? snapshot.mirrorBaseUrl : snapshot.sourceBaseUrl;
    let completed = 0;
    let resumedFromBytes = 0;
    for (const entry of snapshot.files.filter(({ role }) => role !== "notice")) {
      if (controller.signal.aborted) throw fail("CANCELLED", "Qwen snapshot download was paused", true);
      const partial = join(downloadsRoot, ...`${entry.relativePath}.partial`.split("/"));
      await mkdir(dirname(partial), { recursive: true });
      const current = await stat(partial).catch(() => null);
      const startBytes = current?.isFile() && current.size > 0 && current.size < entry.sizeBytes ? current.size : 0;
      if (current?.size === entry.sizeBytes && await sha256File(partial) === entry.sha256) {
        completed += entry.sizeBytes;
        resumedFromBytes += entry.sizeBytes;
        await progress(operationId, snapshot.id, "download", progressBase + completed, progressTotal);
        continue;
      }
      if (current && startBytes === 0) await rm(partial, { force: true });
      const response = await openDownload({
        url: downloadUrl(baseUrl, entry.relativePath),
        headers: startBytes ? { Range: `bytes=${startBytes}-` } : {},
        signal: controller.signal,
      });
      const resumed = await responseBodyToFile(response, partial, entry, startBytes, controller.signal, (received) =>
        progress(operationId, snapshot.id, "download", progressBase + completed + received, progressTotal));
      resumedFromBytes += resumed;
      if (await sha256File(partial) !== entry.sha256) {
        await rm(partial, { force: true });
        throw fail("HASH_MISMATCH", "Qwen snapshot file hash does not match the trusted manifest");
      }
      completed += entry.sizeBytes;
    }
    await progress(operationId, snapshot.id, "verify", progressBase + completed, progressTotal);
    await mkdir(publishRoot, { recursive: true });
    for (const entry of snapshot.files) {
      if (entry.role === "notice") {
        await copyNotice(entry, publishRoot);
        continue;
      }
      const sourcePath = join(downloadsRoot, ...`${entry.relativePath}.partial`.split("/"));
      const destination = join(publishRoot, ...entry.relativePath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await rename(sourcePath, destination);
    }
    if ((await inspectAsrAsset(publishRoot, snapshot.files)).installState !== "ready") {
      throw fail("INVALID_ARTIFACT", "Qwen snapshot failed verification");
    }
    await rm(finalRoot, { recursive: true, force: true });
    await mkdir(dirname(finalRoot), { recursive: true });
    await rename(publishRoot, finalRoot);
    await rm(stagingRoot, { recursive: true, force: true });
    return { downloadedBytes: completed, resumedFromBytes };
  }

  async function install({ assetId, source, operationId }) {
    safeId(operationId, "operationId");
    const selected = model(assetId);
    if (!new Set(["official", "mirror", "auto"]).has(source)) throw fail("INVALID_INPUT", "Qwen download source is invalid");
    if (locked || active.has(operationId)) throw fail("CONFLICT", "A Qwen installation is already active", true);
    locked = true;
    const controller = new AbortController();
    active.set(operationId, controller);
    const totalBytes = selected.sizeBytes + manifest.aligner.sizeBytes;
    try {
      let lastError;
      for (const actualSource of source === "auto" ? ["official", "mirror"] : [source]) {
        try {
          const first = await installSnapshot(selected, actualSource, operationId, controller, 0, totalBytes);
          const second = await installSnapshot(manifest.aligner, actualSource, operationId, controller, selected.sizeBytes, totalBytes);
          await progress(operationId, assetId, "ready", totalBytes, totalBytes, "ready");
          return {
            assetId, installState: "ready", source: actualSource,
            sizeBytes: first.downloadedBytes + second.downloadedBytes,
            sha256: selected.snapshotHash,
            resumedFromBytes: first.resumedFromBytes + second.resumedFromBytes,
          };
        } catch (error) {
          lastError = normalizeInstallError(error, controller.signal);
          if (source !== "auto" || lastError.code !== "DOWNLOAD_FAILED" || lastError.retryable !== true) throw lastError;
        }
      }
      throw lastError;
    } catch (error) {
      const normalized = normalizeInstallError(error, controller.signal);
      const code = normalized.code;
      progressStates.set(assetId, { ...(progressStates.get(assetId) ?? {}), operationId, assetId, status: code === "CANCELLED" ? "paused" : "failed", errorCode: code });
      throw normalized;
    } finally {
      active.delete(operationId);
      locked = false;
    }
  }

  async function uninstall({ assetId, operationId }) {
    safeId(operationId, "operationId");
    model(assetId);
    if (locked || await Promise.resolve(isAssetInUse(assetId))) throw fail("CONFLICT", "Qwen model is in use", true);
    const root = join(appOwnedRoot, "models", assetId);
    const existed = Boolean(await lstat(root).catch(() => null));
    await rm(root, { recursive: true, force: true });
    const remaining = await Promise.all(manifest.models.filter(({ id }) => id !== assetId)
      .map((entry) => inspectAsrAsset(join(appOwnedRoot, "models", entry.id), entry.files)));
    if (!remaining.some(({ installState }) => installState === "ready")) {
      await rm(join(appOwnedRoot, "auxiliary", manifest.aligner.id), { recursive: true, force: true });
    }
    progressStates.delete(assetId);
    return { assetId, uninstalled: existed };
  }

  function stdout(result) {
    if (Buffer.isBuffer(result?.stdout)) return result.stdout.toString("utf8").trim();
    if (typeof result?.stdoutBase64 === "string") return Buffer.from(result.stdoutBase64, "base64").toString("utf8").trim();
    return "";
  }

  async function installRuntime({ assetId, source, operationId }) {
    safeId(operationId, "operationId");
    if (assetId !== manifest.runtime.id || source !== "official") throw fail("INVALID_INPUT", "Qwen runtime request is invalid");
    if (typeof runProcess !== "function") throw fail("NOT_AVAILABLE", "Qwen runtime process installer is unavailable");
    if (locked || active.has(operationId)) throw fail("CONFLICT", "A Qwen installation is already active", true);
    locked = true;
    const controller = new AbortController();
    active.set(operationId, controller);
    const runtimeRoot = join(appOwnedRoot, "runtimes", manifest.runtime.id);
    const stagingRoot = join(appOwnedRoot, "staging", "qwen", manifest.runtime.id);
    const buildRoot = join(stagingRoot, "publish-runtime");
    const previousRoot = join(stagingRoot, "previous-runtime");
    const archive = manifest.runtime.bootstrap.archive;
    const archivePath = join(stagingRoot, archive.fileName ?? "uv.zip");
    const partialPath = `${archivePath}.partial`;
    const toolsRoot = join(buildRoot, "tools");
    const requirementsPath = join(resourceRoot, manifest.runtime.requirementsFile);
    const sidecarPath = join(resourceRoot, manifest.runtime.sidecarFile);
    try {
      for (const path of [requirementsPath, sidecarPath]) {
        const value = await lstat(path).catch(() => null);
        if (!value?.isFile() || value.isSymbolicLink()) throw fail("INVALID_ARTIFACT", "Qwen runtime resource is missing");
      }
      await mkdir(stagingRoot, { recursive: true });
      const runtimeExists = Boolean(await lstat(runtimeRoot).catch(() => null));
      const previousExists = Boolean(await lstat(previousRoot).catch(() => null));
      if (!runtimeExists && previousExists) await rename(previousRoot, runtimeRoot);
      else if (previousExists) await rm(previousRoot, { recursive: true, force: true });
      await rm(buildRoot, { recursive: true, force: true });
      const cachedArchive = await stat(archivePath).catch(() => null);
      if (!cachedArchive?.isFile() || cachedArchive.size !== archive.sizeBytes || await sha256File(archivePath) !== archive.sha256) {
        await rm(archivePath, { force: true });
        const response = await openDownload({ url: archive.sourceUrl, headers: {}, signal: controller.signal });
        await responseBodyToFile(response, partialPath, archive, 0, controller.signal, (received) =>
          progress(operationId, assetId, "download", received, archive.sizeBytes));
        if (await sha256File(partialPath) !== archive.sha256) throw fail("HASH_MISMATCH", "Qwen bootstrap archive hash mismatch");
        await rename(partialPath, archivePath);
      } else {
        await progress(operationId, assetId, "download", archive.sizeBytes, archive.sizeBytes);
      }
      await extractArchive({
        archivePath,
        destinationRoot: toolsRoot,
        selected: archive.entries,
        ignored: archive.ignoredEntries,
      });
      const uvPath = join(toolsRoot, manifest.runtime.bootstrap.executable ?? "uv.exe");
      const envOverrides = {
        UV_PYTHON_INSTALL_DIR: join(buildRoot, "python"),
        UV_CACHE_DIR: join(stagingRoot, "cache"),
        PYTHONUTF8: "1",
      };
      const run = (absoluteExe, argv, timeoutMs) => runProcess({
        operationId,
        absoluteExe,
        argv,
        cwd: buildRoot,
        timeoutMs,
        stdoutMaxBytes: 1024 * 1024,
        stderrMaxBytes: 1024 * 1024,
        envOverrides,
      });
      await progress(operationId, assetId, "python", 0, 0);
      await run(uvPath, ["python", "install", manifest.runtime.pythonVersion, "--python-preference", "only-managed"], 30 * 60_000);
      const found = await run(uvPath, ["python", "find", manifest.runtime.pythonVersion, "--python-preference", "only-managed"], 60_000);
      const managedPython = stdout(found);
      if (!isAbsolute(managedPython) || !await lstat(managedPython).then((value) => value.isFile()).catch(() => false)) {
        throw fail("INVALID_ARTIFACT", "Managed Qwen Python was not resolved");
      }
      const venvRoot = join(buildRoot, "venv");
      const venvPython = join(venvRoot, "Scripts", "python.exe");
      await run(uvPath, ["venv", venvRoot, "--python", managedPython, "--relocatable"], 5 * 60_000);
      await progress(operationId, assetId, "packages", 0, 0);
      await run(uvPath, [
        "pip", "install",
        "--python", venvPython,
        "--index-strategy", "unsafe-best-match",
        "--extra-index-url", "https://download.pytorch.org/whl/cu128",
        "-r", requirementsPath,
      ], 2 * 60 * 60_000);
      await run(venvPython, [sidecarPath, "--self-check"], 3 * 60_000);
      await removeUvPythonAlias(managedPython);
      await repairRuntimePythonHome(buildRoot, runtimeRoot, manifest.runtime.pythonVersion);
      await writeFile(join(buildRoot, ".ready.json"), JSON.stringify({
        runtimeId: manifest.runtime.id,
        runtimeVersion: manifest.runtime.version,
        pythonVersion: manifest.runtime.pythonVersion,
      }));
      await mkdir(dirname(runtimeRoot), { recursive: true });
      await rm(previousRoot, { recursive: true, force: true });
      if (await lstat(runtimeRoot).catch(() => null)) await rename(runtimeRoot, previousRoot);
      try {
        await rename(buildRoot, runtimeRoot);
      } catch (error) {
        if (!await lstat(runtimeRoot).catch(() => null) && await lstat(previousRoot).catch(() => null)) {
          await rename(previousRoot, runtimeRoot);
        }
        throw error;
      }
      await rm(previousRoot, { recursive: true, force: true });
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      await progress(operationId, assetId, "ready", archive.sizeBytes, archive.sizeBytes, "ready");
      return {
        assetId,
        installState: "ready",
        source: "official",
        sizeBytes: archive.sizeBytes,
        sha256: archive.sha256,
      };
    } catch (error) {
      await rm(buildRoot, { recursive: true, force: true }).catch(() => {});
      if (!await lstat(runtimeRoot).catch(() => null) && await lstat(previousRoot).catch(() => null)) {
        await rename(previousRoot, runtimeRoot).catch(() => {});
      }
      const normalized = normalizeInstallError(error, controller.signal);
      const code = normalized.code;
      progressStates.set(assetId, { ...(progressStates.get(assetId) ?? {}), operationId, assetId, status: code === "CANCELLED" ? "paused" : "failed", errorCode: code });
      throw normalized;
    } finally {
      active.delete(operationId);
      locked = false;
    }
  }

  async function uninstallRuntime({ assetId, operationId }) {
    safeId(operationId, "operationId");
    if (assetId !== manifest.runtime.id) throw fail("INVALID_INPUT", "Qwen runtime is not allowed");
    if (locked || await Promise.resolve(isAssetInUse(assetId))) throw fail("CONFLICT", "Qwen runtime is in use", true);
    const root = join(appOwnedRoot, "runtimes", assetId);
    const existed = Boolean(await lstat(root).catch(() => null));
    await rm(root, { recursive: true, force: true });
    progressStates.delete(assetId);
    return { assetId, uninstalled: existed };
  }

  async function reconcileSnapshot(snapshot) {
    const stagingRoot = join(appOwnedRoot, "staging", "qwen", snapshot.id);
    const entries = await readdir(stagingRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    let abandonedPublishesRemoved = 0;
    for (const entry of entries.filter(({ name }) => name.startsWith("publish-"))) {
      await rm(join(stagingRoot, entry.name), { recursive: true, force: true });
      abandonedPublishesRemoved += 1;
    }
    let resumablePartialsPreserved = 0;
    let invalidPartialsRemoved = 0;
    for (const entry of snapshot.files.filter(({ role }) => role !== "notice")) {
      const partial = join(stagingRoot, "downloads", ...`${entry.relativePath}.partial`.split("/"));
      const value = await lstat(partial).catch(() => null);
      if (!value) continue;
      const valid = value.isFile() && !value.isSymbolicLink() && value.size > 0 && value.size <= entry.sizeBytes &&
        (value.size < entry.sizeBytes || await sha256File(partial) === entry.sha256);
      if (valid) resumablePartialsPreserved += 1;
      else {
        await rm(partial, { recursive: true, force: true });
        invalidPartialsRemoved += 1;
      }
    }
    return { abandonedPublishesRemoved, resumablePartialsPreserved, invalidPartialsRemoved };
  }

  return {
    install,
    uninstall,
    importModel() { throw fail("NOT_AVAILABLE", "Qwen snapshots are installed from verified download channels"); },
    cancel({ operationId }) {
      safeId(operationId, "operationId");
      const controller = active.get(operationId);
      controller?.abort();
      if (controller) Promise.resolve(cancelProcess({ operationId })).catch(() => {});
      return { cancelled: Boolean(controller) };
    },
    getDownloadStatus: () => [...progressStates.values()].map((value) => ({ ...value })),
    async reconcile() {
      await repairRuntimePythonHome(
        join(appOwnedRoot, "runtimes", manifest.runtime.id),
        join(appOwnedRoot, "runtimes", manifest.runtime.id),
        manifest.runtime.pythonVersion,
      );
      const results = await Promise.all([...manifest.models, manifest.aligner].map(reconcileSnapshot));
      return results.reduce((total, result) => ({
        abandonedPublishesRemoved: total.abandonedPublishesRemoved + result.abandonedPublishesRemoved,
        resumablePartialsPreserved: total.resumablePartialsPreserved + result.resumablePartialsPreserved,
        invalidPartialsRemoved: total.invalidPartialsRemoved + result.invalidPartialsRemoved,
      }), { abandonedPublishesRemoved: 0, resumablePartialsPreserved: 0, invalidPartialsRemoved: 0 });
    },
    async getSourceHealth() { return { official: { ok: true, latencyMs: 0 }, mirror: { ok: true, latencyMs: 0 } }; },
    installRuntime,
    importRuntime() { throw fail("NOT_AVAILABLE", "Qwen runtime is installed from its verified channel"); },
    uninstallRuntime,
  };
}

export function createUnifiedAsrInstaller({ whisper, qwen }) {
  const model = (request) => request?.assetId?.startsWith("qwen3-asr-") ? qwen : whisper;
  const runtime = (request) => request?.assetId === "qwen3-asr-transformers-cu128-x64" ? qwen : whisper;
  return {
    install: (request) => model(request).install(request),
    importModel: (request) => model(request).importModel(request),
    uninstall: (request) => model(request).uninstall(request),
    installRuntime: (request) => runtime(request).installRuntime(request),
    importRuntime: (request) => runtime(request).importRuntime(request),
    uninstallRuntime: (request) => runtime(request).uninstallRuntime(request),
    cancel(request) {
      const a = whisper.cancel(request);
      const b = qwen.cancel(request);
      return { cancelled: a.cancelled || b.cancelled };
    },
    pause(request) {
      const result = this.cancel(request);
      return { paused: result.cancelled };
    },
    getDownloadStatus: () => [...whisper.getDownloadStatus(), ...qwen.getDownloadStatus()],
    async reconcile() {
      const [a, b] = await Promise.all([whisper.reconcile(), qwen.reconcile()]);
      return { whisper: a, qwen: b };
    },
    getSourceHealth: () => whisper.getSourceHealth(),
  };
}
