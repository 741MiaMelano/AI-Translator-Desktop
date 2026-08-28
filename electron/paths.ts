import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function resolveMigrationsRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "migrations");
  }
  return join(moduleDir, "..", "migrations");
}

export function resolveFfmpegRoots() {
  if (app.isPackaged) {
    return {
      manifestPath: join(process.resourcesPath, "ffmpeg", "manifest.json"),
      artifactRootDir: join(process.resourcesPath, "ffmpeg", "win32-x64"),
    };
  }
  return {
    manifestPath: join(moduleDir, "..", "docs", "third-party", "ffmpeg", "manifest.json"),
    artifactRootDir: join(moduleDir, "..", "resources", "ffmpeg", "win32-x64"),
  };
}

export function loadFfmpegManifestJson() {
  const { manifestPath } = resolveFfmpegRoots();
  if (!existsSync(manifestPath)) {
    const error = new Error("FFmpeg manifest is not available");
    // @ts-expect-error code
    error.code = "not_available";
    throw error;
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function resolveAsrRoots(appOwnedRoot = join(app.getPath("userData"), "asr")) {
  return {
    appOwnedRoot,
    bundledRuntimeRoot: app.isPackaged
      ? join(process.resourcesPath, "asr", "runtime", "whisper-cpp-cpu-x64")
      : null,
    bundledVadRoot: app.isPackaged
      ? join(process.resourcesPath, "asr", "vad", "silero-v6.2.0")
      : join(moduleDir, "..", "resources", "asr", "vad", "silero-v6.2.0"),
    manifestPath: app.isPackaged
      ? join(process.resourcesPath, "asr", "manifest.json")
      : join(moduleDir, "..", "docs", "third-party", "asr", "manifest.json"),
    qwenManifestPath: app.isPackaged
      ? join(process.resourcesPath, "asr", "qwen-manifest.json")
      : join(moduleDir, "..", "docs", "third-party", "asr", "qwen-manifest.json"),
    qwenResourceRoot: app.isPackaged ? process.resourcesPath : join(moduleDir, ".."),
    trustedNoticeRoot: app.isPackaged
      ? join(process.resourcesPath, "asr", "licenses")
      : join(moduleDir, "..", "docs", "third-party", "asr", "licenses"),
  };
}

export function loadAsrManifestJson() {
  const { manifestPath } = resolveAsrRoots();
  if (!existsSync(manifestPath)) {
    const error = new Error("ASR manifest is not available");
    // @ts-expect-error code
    error.code = "NOT_AVAILABLE";
    throw error;
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function loadQwenAsrManifestJson() {
  const { qwenManifestPath } = resolveAsrRoots();
  if (!existsSync(qwenManifestPath)) {
    const error = new Error("Qwen ASR manifest is not available");
    // @ts-expect-error code
    error.code = "NOT_AVAILABLE";
    throw error;
  }
  return JSON.parse(readFileSync(qwenManifestPath, "utf8"));
}

export function resolveAppDataDirs() {
  const userData = app.getPath("userData");
  const migrationsRoot = resolveMigrationsRoot();
  return {
    appDir: userData,
    projectsDir: join(userData, "projects"),
    appMigrationsDir: join(migrationsRoot, "app"),
    projectMigrationsDir: join(migrationsRoot, "project"),
    cacheDir: join(userData, "cache"),
    modelDir: join(userData, "asr"),
    backupDir: join(userData, "backups"),
    logsDir: join(userData, "logs"),
  };
}

export function resolvePreloadPath(): string {
  // vite-plugin-electron emits preload as .mjs next to main output
  return join(moduleDir, "preload.mjs");
}

export function resolveRendererEntry(
  devServerUrl: string | undefined,
): { type: "url" | "file"; value: string } {
  if (devServerUrl) {
    return { type: "url", value: devServerUrl };
  }
  return { type: "file", value: join(moduleDir, "..", "dist", "index.html") };
}
