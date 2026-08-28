import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeInstallError, openFetchDownload } from "../asr/model-installer.mjs";
import { SONG_CLASSIFIER_IDENTITY } from "./song-classifier-process.mjs";

const MODEL_SOURCE_URL = "https://github.com/ina-foss/inaSpeechSegmenter/releases/download/models/keras_speech_music_noise_cnn.hdf5";
const MARKER_FILE = ".ready.json";

function fail(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail("INVALID_INPUT", "operationId is invalid");
  return value;
}

function isInside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function ordinary(path, directory = false) {
  const value = await lstat(path).catch(() => null);
  return Boolean(value && !value.isSymbolicLink() && (directory ? value.isDirectory() : value.isFile()));
}

async function writeDownload(response, path, signal, onProgress) {
  if (response?.status !== 200 || !response.body) throw fail("DOWNLOAD_FAILED", "Song classifier download failed", true);
  const file = await open(path, "wx");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw fail("CANCELLED", "Song classifier installation was cancelled", true);
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > SONG_CLASSIFIER_IDENTITY.modelSizeBytes) throw fail("LENGTH_MISMATCH", "Song classifier model exceeds its trusted size");
      await file.write(bytes);
      await onProgress(received);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  if (received !== SONG_CLASSIFIER_IDENTITY.modelSizeBytes) {
    throw fail("LENGTH_MISMATCH", "Song classifier model download is incomplete", true);
  }
}

export function createSongClassifierInstaller({
  appOwnedRoot,
  qwenRuntimeId,
  sidecarPath,
  openDownload = openFetchDownload,
  runProcess,
  cancelProcess = () => ({ cancelled: false }),
  reportProgress = () => {},
  isInUse = () => false,
  verifyArtifact = sha256,
}) {
  if (![appOwnedRoot, sidecarPath].every((value) => typeof value === "string" && isAbsolute(value)) ||
    typeof qwenRuntimeId !== "string" || typeof openDownload !== "function" || typeof runProcess !== "function" ||
    typeof cancelProcess !== "function" || typeof reportProgress !== "function" || typeof isInUse !== "function" ||
    typeof verifyArtifact !== "function") {
    throw fail("INVALID_INPUT", "Song classifier installer dependencies are invalid");
  }
  const active = new Map();
  const progressStates = new Map();
  const componentRoot = join(appOwnedRoot, "auxiliary", SONG_CLASSIFIER_IDENTITY.modelId);
  const runtimeRoot = join(appOwnedRoot, "runtimes", qwenRuntimeId);

  function runtimePaths() {
    return {
      pythonPath: join(runtimeRoot, "venv", "Scripts", "python.exe"),
      uvPath: join(runtimeRoot, "tools", "uv.exe"),
    };
  }

  async function status() {
    const { pythonPath, uvPath } = runtimePaths();
    if (!await ordinary(pythonPath) || !await ordinary(uvPath)) {
      return { id: SONG_CLASSIFIER_IDENTITY.modelId, installState: "not_installed", reason: "shared_runtime_missing" };
    }
    const modelPath = join(componentRoot, SONG_CLASSIFIER_IDENTITY.modelFileName);
    const sitePackagesPath = join(componentRoot, "site-packages");
    const markerPath = join(componentRoot, MARKER_FILE);
    const [model, site, marker] = await Promise.all([
      lstat(modelPath).catch(() => null), lstat(sitePackagesPath).catch(() => null), readFile(markerPath, "utf8").catch(() => null),
    ]);
    if (!model && !site && !marker) return { id: SONG_CLASSIFIER_IDENTITY.modelId, installState: "not_installed", reason: "missing" };
    if (!model?.isFile() || model.isSymbolicLink() || model.size !== SONG_CLASSIFIER_IDENTITY.modelSizeBytes ||
      !site?.isDirectory() || site.isSymbolicLink() || !marker) {
      return { id: SONG_CLASSIFIER_IDENTITY.modelId, installState: "corrupt", reason: "component_incomplete" };
    }
    let parsed;
    try { parsed = JSON.parse(marker); } catch { parsed = null; }
    if (parsed?.detectorId !== SONG_CLASSIFIER_IDENTITY.detectorId || parsed?.modelHash !== SONG_CLASSIFIER_IDENTITY.modelSha256 ||
      parsed?.h5pyVersion !== SONG_CLASSIFIER_IDENTITY.h5pyVersion || await verifyArtifact(modelPath) !== SONG_CLASSIFIER_IDENTITY.modelSha256) {
      return { id: SONG_CLASSIFIER_IDENTITY.modelId, installState: "corrupt", reason: "verification_failed" };
    }
    return {
      id: SONG_CLASSIFIER_IDENTITY.modelId,
      version: SONG_CLASSIFIER_IDENTITY.engineVersion,
      displayName: "INA speech/music/noise 唱词检测",
      modelHash: SONG_CLASSIFIER_IDENTITY.modelSha256,
      sizeBytes: SONG_CLASSIFIER_IDENTITY.modelSizeBytes,
      license: "MIT",
      installState: "ready",
    };
  }

  async function progress(operationId, stage, receivedBytes, totalBytes, state = "active") {
    const value = {
      operationId,
      assetId: SONG_CLASSIFIER_IDENTITY.modelId,
      assetKind: "model",
      stage,
      status: state,
      progress: totalBytes ? Math.min(1, receivedBytes / totalBytes) : 0,
      receivedBytes,
      totalBytes,
    };
    progressStates.set(SONG_CLASSIFIER_IDENTITY.modelId, value);
    await Promise.resolve(reportProgress(value)).catch(() => {});
  }

  async function install({ assetId, source, operationId }) {
    safeId(operationId);
    if (assetId !== SONG_CLASSIFIER_IDENTITY.modelId || source !== "official") {
      throw fail("INVALID_INPUT", "Song classifier install request is invalid");
    }
    if (active.size) throw fail("CONFLICT", "A song classifier installation is already active", true);
    const controller = new AbortController();
    active.set(operationId, controller);
    const stagingRoot = join(appOwnedRoot, "staging", "song-classifier", `${operationId}-${randomUUID()}`);
    const publishRoot = join(stagingRoot, "publish");
    const modelPath = join(publishRoot, SONG_CLASSIFIER_IDENTITY.modelFileName);
    const sitePackagesPath = join(publishRoot, "site-packages");
    const { pythonPath, uvPath } = runtimePaths();
    try {
      if (!await ordinary(pythonPath) || !await ordinary(uvPath) || !await ordinary(sidecarPath)) {
        throw fail("NOT_AVAILABLE", "Install the shared Qwen Python runtime before the song classifier");
      }
      await mkdir(sitePackagesPath, { recursive: true });
      await progress(operationId, "download", 0, SONG_CLASSIFIER_IDENTITY.modelSizeBytes);
      const response = await openDownload({ url: MODEL_SOURCE_URL, headers: {}, signal: controller.signal });
      await writeDownload(response, modelPath, controller.signal, (received) =>
        progress(operationId, "download", received, SONG_CLASSIFIER_IDENTITY.modelSizeBytes));
      if (await verifyArtifact(modelPath) !== SONG_CLASSIFIER_IDENTITY.modelSha256) {
        throw fail("HASH_MISMATCH", "Song classifier model hash does not match the trusted manifest");
      }
      await progress(operationId, "packages", 0, 0);
      await runProcess({
        operationId,
        absoluteExe: uvPath,
        argv: ["pip", "install", "--python", pythonPath, "--target", sitePackagesPath, "--no-deps", `h5py==${SONG_CLASSIFIER_IDENTITY.h5pyVersion}`],
        cwd: publishRoot,
        timeoutMs: 30 * 60_000,
        stdoutMaxBytes: 1024 * 1024,
        stderrMaxBytes: 1024 * 1024,
        truncateStderr: true,
        envOverrides: { UV_CACHE_DIR: join(appOwnedRoot, "staging", "song-classifier", "uv-cache"), PYTHONUTF8: "1" },
      });
      await runProcess({
        operationId,
        absoluteExe: pythonPath,
        argv: [sidecarPath, "--self-check", "--model", modelPath],
        cwd: publishRoot,
        timeoutMs: 3 * 60_000,
        stdoutMaxBytes: 64 * 1024,
        stderrMaxBytes: 64 * 1024,
        envOverrides: { PYTHONPATH: sitePackagesPath, PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" },
      });
      await writeFile(join(publishRoot, MARKER_FILE), JSON.stringify({
        detectorId: SONG_CLASSIFIER_IDENTITY.detectorId,
        modelHash: SONG_CLASSIFIER_IDENTITY.modelSha256,
        h5pyVersion: SONG_CLASSIFIER_IDENTITY.h5pyVersion,
      }));
      const [resolvedStaging, resolvedPublish] = await Promise.all([realpath(stagingRoot), realpath(publishRoot)]);
      if (!isInside(resolvedStaging, resolvedPublish)) throw fail("INVALID_ARTIFACT", "Song classifier staging path is invalid");
      await rm(componentRoot, { recursive: true, force: true });
      await mkdir(dirname(componentRoot), { recursive: true });
      await rename(publishRoot, componentRoot);
      await rm(stagingRoot, { recursive: true, force: true });
      const completed = await status();
      if (completed.installState !== "ready") throw fail("INVALID_ARTIFACT", "Song classifier failed post-install verification");
      await progress(operationId, "ready", SONG_CLASSIFIER_IDENTITY.modelSizeBytes, SONG_CLASSIFIER_IDENTITY.modelSizeBytes, "ready");
      return { assetId, installState: "ready", source: "official", sizeBytes: SONG_CLASSIFIER_IDENTITY.modelSizeBytes, sha256: SONG_CLASSIFIER_IDENTITY.modelSha256 };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      const normalized = normalizeInstallError(error, controller.signal);
      progressStates.set(SONG_CLASSIFIER_IDENTITY.modelId, {
        ...(progressStates.get(SONG_CLASSIFIER_IDENTITY.modelId) ?? {}), operationId,
        assetId: SONG_CLASSIFIER_IDENTITY.modelId, status: normalized.code === "CANCELLED" ? "paused" : "failed", errorCode: normalized.code,
      });
      throw normalized;
    } finally {
      active.delete(operationId);
    }
  }

  async function uninstall({ assetId, operationId }) {
    safeId(operationId);
    if (assetId !== SONG_CLASSIFIER_IDENTITY.modelId) throw fail("INVALID_INPUT", "Song classifier asset is invalid");
    if (active.size || await Promise.resolve(isInUse())) throw fail("CONFLICT", "Song classifier is in use", true);
    const existed = Boolean(await lstat(componentRoot).catch(() => null));
    await rm(componentRoot, { recursive: true, force: true });
    progressStates.delete(SONG_CLASSIFIER_IDENTITY.modelId);
    return { assetId, uninstalled: existed };
  }

  function cancel({ operationId }) {
    safeId(operationId);
    const controller = active.get(operationId);
    controller?.abort();
    if (controller) Promise.resolve(cancelProcess({ operationId })).catch(() => {});
    return { cancelled: Boolean(controller) };
  }

  async function resolveRuntime({ device }) {
    if (!new Set(["cpu", "cuda"]).has(device)) throw fail("INVALID_INPUT", "Song classifier device is invalid");
    const current = await status();
    if (current.installState !== "ready") throw fail(current.installState === "corrupt" ? "INVALID_ARTIFACT" : "NOT_AVAILABLE", "Song classifier is unavailable");
    const { pythonPath } = runtimePaths();
    return {
      detectorId: SONG_CLASSIFIER_IDENTITY.detectorId,
      modelHash: SONG_CLASSIFIER_IDENTITY.modelSha256,
      pythonPath,
      sidecarPath,
      sitePackagesPath: join(componentRoot, "site-packages"),
      modelPath: join(componentRoot, SONG_CLASSIFIER_IDENTITY.modelFileName),
      cwd: componentRoot,
      device,
    };
  }

  return {
    install,
    uninstall,
    cancel,
    getStatus: status,
    resolveRuntime,
    getDownloadStatus: () => [...progressStates.values()].map((value) => ({ ...value })),
  };
}
