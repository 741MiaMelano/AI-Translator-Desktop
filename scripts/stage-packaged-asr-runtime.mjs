import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateAsrManifest } from "../backend/asr/runtime-registry.mjs";
import { extractVerifiedZip } from "../backend/asr/verified-zip.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyFile(path, expected) {
  const value = await lstat(path).catch(() => null);
  return Boolean(
    value?.isFile() && !value.isSymbolicLink() && value.size === expected.sizeBytes &&
    await sha256File(path) === expected.sha256,
  );
}

async function downloadArchive(archive, destination) {
  const url = new URL(archive.sourceUrl);
  if (url.protocol !== "https:") throw new Error("CPU runtime source must be HTTPS");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`CPU runtime download failed: ${response.status}`);
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  const file = await open(partial, "wx");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > archive.sizeBytes) throw new Error("CPU runtime download exceeds trusted length");
      hash.update(value);
      await file.write(value);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  if (bytes !== archive.sizeBytes || hash.digest("hex") !== archive.sha256) {
    await rm(partial, { force: true });
    throw new Error("CPU runtime download failed trusted size/hash verification");
  }
  await rename(partial, destination);
}

async function resolveArchive(archive) {
  const explicit = process.env.PHASE7_ASR_CPU_ARCHIVE;
  if (explicit && !isAbsolute(explicit)) throw new Error("PHASE7_ASR_CPU_ARCHIVE must be absolute");
  const buildCache = join(tmpdir(), "desktop-ai-translator-asr-cache", archive.fileName);
  const candidates = [
    ...(explicit ? [explicit] : []),
    buildCache,
    join(tmpdir(), "desktop-ai-translator-phase7-t01-20260719", "whisper-bin-x64-v1.9.1.zip"),
  ];
  for (const candidate of candidates) {
    const value = await lstat(candidate).catch(() => null);
    if (!value) continue;
    if (!await verifyFile(candidate, archive)) throw new Error(`CPU runtime cache failed verification: ${candidate}`);
    return candidate;
  }
  if (process.env.PHASE7_ASR_ALLOW_DOWNLOAD !== "1") {
    throw new Error(
      `Verified CPU runtime archive is missing. Set PHASE7_ASR_CPU_ARCHIVE to an absolute local file matching ` +
      `${archive.fileName} (${archive.sizeBytes} bytes, SHA-256 ${archive.sha256}). ` +
      "Automatic download is disabled; PHASE7_ASR_ALLOW_DOWNLOAD=1 requires explicit approval.",
    );
  }
  await downloadArchive(archive, buildCache);
  return buildCache;
}

export async function stagePackagedAsrRuntime({
  manifestPath = join(rootDir, "docs", "third-party", "asr", "manifest.json"),
  noticeRoot = join(rootDir, "docs", "third-party", "asr", "licenses"),
  vadSourceRoot = join(rootDir, "resources", "asr", "vad", "silero-v6.2.0"),
  stagingRoot = join(rootDir, "release", "asr-runtime-staging"),
} = {}) {
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = validateAsrManifest(rawManifest);
  if (manifest.vadModel) {
    for (const entry of manifest.vadModel.files) {
      const source = entry.role === "notice"
        ? join(noticeRoot, basename(entry.relativePath))
        : join(vadSourceRoot, ...entry.relativePath.split("/"));
      if (!await verifyFile(source, entry)) throw new Error(`Bundled VAD resource failed verification: ${entry.relativePath}`);
    }
  }
  const archivePath = await resolveArchive(manifest.runtime.archive);
  const selected = manifest.runtime.files
    .filter((entry) => entry.role !== "notice")
    .map((entry) => ({
      archivePath: `${manifest.runtime.archive.entryPrefix}${entry.relativePath}`,
      relativePath: entry.relativePath,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    }));
  await rm(stagingRoot, { recursive: true, force: true });
  await extractVerifiedZip({
    archivePath,
    destinationRoot: stagingRoot,
    selected,
    ignored: manifest.runtime.archive.ignoredEntries,
  });
  for (const entry of manifest.runtime.files.filter((item) => item.role === "notice")) {
    const source = join(noticeRoot, basename(entry.relativePath));
    if (!await verifyFile(source, entry)) throw new Error(`CPU runtime notice failed verification: ${entry.relativePath}`);
    const destination = join(stagingRoot, ...entry.relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    if (!await verifyFile(destination, entry)) throw new Error(`Staged CPU runtime failed verification: ${entry.relativePath}`);
  }
  console.log(`Staged verified ${manifest.runtime.id} ${manifest.runtime.version} and bundled VAD resources from ${archivePath}`);
  return { stagingRoot, runtimeId: manifest.runtime.id, runtimeVersion: manifest.runtime.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await stagePackagedAsrRuntime();
}
