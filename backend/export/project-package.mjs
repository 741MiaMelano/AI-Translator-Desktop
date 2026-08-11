import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PACKAGE_KINDS = new Set(["lightweight", "archive"]);
const UTF8_FLAG = 0x0800;
const ZIP_STORE = 0;
const SECRET_PATH = /(?:^|\/)(?:credentials?|secrets?|tokens?|api[-_]?keys?|app\.sqlite)(?:\/|$)/i;
const TRASH_PATH = /(?:^|\/)(?:trash|recycle-bin)(?:\/|$)/i;
const GENERATED_PACKAGE = /\.aitranslator-project\.zip$/i;

function packageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
  }
  return current >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeEntryPath(value) {
  const entry = String(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!entry || entry.includes("\0") || entry.split("/").some((part) => !part || part === "." || part === "..")) {
    throw packageError("INVALID_ARCHIVE", "Project package entry path is unsafe");
  }
  return entry;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(normalizeEntryPath(entry.path), "utf8");
    const data = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes);
    if (name.length > 0xffff || data.length > 0xffffffff) {
      throw packageError("OUTPUT_TOO_LARGE", "Project package exceeds ZIP32 limits");
    }
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(ZIP_STORE, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(ZIP_STORE, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function readStoredZip(bytes) {
  const entries = [];
  const paths = new Set();
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > bytes.length) throw packageError("INVALID_ARCHIVE", "ZIP local header is truncated");
    if (bytes.readUInt16LE(offset + 6) !== UTF8_FLAG) throw packageError("INVALID_ARCHIVE", "ZIP flags are unsupported");
    const method = bytes.readUInt16LE(offset + 8);
    const expectedCrc = bytes.readUInt32LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if (method !== ZIP_STORE || compressedSize !== uncompressedSize) {
      throw packageError("INVALID_ARCHIVE", "Only stored project package entries are supported");
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw packageError("INVALID_ARCHIVE", "ZIP entry is truncated");
    const path = normalizeEntryPath(bytes.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    if (paths.has(path) || entries.length >= 10_000) throw packageError("INVALID_ARCHIVE", "ZIP entries are duplicated or excessive");
    paths.add(path);
    const data = Buffer.from(bytes.subarray(dataStart, dataEnd));
    if (crc32(data) !== expectedCrc) throw packageError("INVALID_ARCHIVE", `ZIP checksum mismatch: ${path}`);
    entries.push({ path, bytes: data, localOffset: offset, crc: expectedCrc });
    offset = dataEnd;
  }
  if (entries.length === 0) throw packageError("INVALID_ARCHIVE", "Project package contains no files");
  const eocdOffset = bytes.length - 22;
  if (eocdOffset < offset || bytes.readUInt32LE(eocdOffset) !== 0x06054b50 || bytes.readUInt16LE(eocdOffset + 20) !== 0) {
    throw packageError("INVALID_ARCHIVE", "ZIP central directory is missing or truncated");
  }
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (
    bytes.readUInt16LE(eocdOffset + 4) !== 0
    || bytes.readUInt16LE(eocdOffset + 6) !== 0
    || bytes.readUInt16LE(eocdOffset + 8) !== entryCount
    || entryCount !== entries.length
    || centralOffset !== offset
    || centralOffset + centralSize !== eocdOffset
  ) {
    throw packageError("INVALID_ARCHIVE", "ZIP central directory is inconsistent");
  }
  let cursor = centralOffset;
  for (let index = 0; index < entries.length; index += 1) {
    if (cursor + 46 > eocdOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw packageError("INVALID_ARCHIVE", "ZIP central directory is truncated");
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    const entry = entries[index];
    const path = normalizeEntryPath(bytes.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    if (
      next > eocdOffset
      || bytes.readUInt16LE(cursor + 8) !== UTF8_FLAG
      || bytes.readUInt16LE(cursor + 10) !== ZIP_STORE
      || bytes.readUInt32LE(cursor + 16) !== entry.crc
      || bytes.readUInt32LE(cursor + 20) !== entry.bytes.length
      || bytes.readUInt32LE(cursor + 24) !== entry.bytes.length
      || bytes.readUInt32LE(cursor + 42) !== entry.localOffset
      || path !== entry.path
    ) {
      throw packageError("INVALID_ARCHIVE", "ZIP central directory entry is inconsistent");
    }
    cursor = next;
  }
  if (cursor !== eocdOffset) throw packageError("INVALID_ARCHIVE", "ZIP central directory length is invalid");
  return entries.map(({ path, bytes: data }) => ({ path, bytes: data }));
}

function walkFiles(rootDir, current = rootDir) {
  const files = [];
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw packageError("INVALID_INPUT", "Project packages cannot contain symbolic links");
    if (stat.isDirectory()) files.push(...walkFiles(rootDir, absolute));
    else if (stat.isFile()) files.push({
      absolute,
      relativePath: relative(rootDir, absolute).split(sep).join("/"),
    });
  }
  return files;
}

function shouldInclude(relativePath, { kind, includeTrash }) {
  if (relativePath === "project.sqlite") return true;
  if (/^project\.sqlite-(?:wal|shm|journal)$/i.test(relativePath)) return false;
  if (/^(?:logs|cache)(?:\/|$)/i.test(relativePath)) return false;
  if (SECRET_PATH.test(relativePath) || GENERATED_PACKAGE.test(relativePath)) return false;
  if (!includeTrash && TRASH_PATH.test(relativePath)) return false;
  if (kind === "lightweight" && /^artifacts\/media(?:\/|$)/i.test(relativePath)) return false;
  return true;
}

function sanitizeDatabase(sourcePath, kind, includeTrash) {
  const tempDir = mkdtempSync(join(tmpdir(), "ai-translator-package-db-"));
  const copyPath = join(tempDir, "project.sqlite");
  copyFileSync(sourcePath, copyPath);
  const db = new DatabaseSync(copyPath);
  try {
    if (kind === "lightweight") {
      db.exec(`UPDATE source_file
        SET original_path = NULL,
            project_relative_path = NULL,
            no_source_media = 1,
            relink_state = 'missing',
            identity_json = '{}'`);
    }
    if (!includeTrash) {
      const sourceColumns = db.prepare("PRAGMA table_info(source_tracks)").all();
      const targetColumns = db.prepare("PRAGMA table_info(target_tracks)").all();
      if (sourceColumns.some((column) => column.name === "trashed_at")) {
        db.exec("DELETE FROM source_tracks WHERE trashed_at IS NOT NULL");
      }
      if (targetColumns.some((column) => column.name === "trashed_at")) {
        db.exec("DELETE FROM target_tracks WHERE trashed_at IS NOT NULL");
      }
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return { copyPath, tempDir };
}

function sanitizeName(value) {
  return String(value || "project")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "project";
}

function writeUniquePackage(outputDir, baseName, bytes) {
  mkdirSync(outputDir, { recursive: true });
  for (let version = 1; version <= 10_000; version += 1) {
    const fileName = version === 1 ? baseName : baseName.replace(/\.zip$/i, `-${version}.zip`);
    const outputPath = join(outputDir, fileName);
    try {
      writeFileSync(outputPath, bytes, { flag: "wx" });
      return { fileName, outputPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw packageError("CONFLICT", "Project package version limit was exceeded");
}

export function createProjectPackage({
  containerDir,
  outputDir = join(containerDir, "exports"),
  kind,
  includeTrash = false,
  now = () => new Date(),
}) {
  if (!isAbsolute(containerDir) || !isAbsolute(outputDir) || !PACKAGE_KINDS.has(kind)) {
    throw packageError("INVALID_INPUT", "Absolute package paths and a valid package kind are required");
  }
  const databasePath = join(containerDir, "project.sqlite");
  if (!existsSync(databasePath)) throw packageError("NOT_FOUND", "Project database is missing");
  const sourceDb = new DatabaseSync(databasePath, { readOnly: true });
  let projectMeta;
  try {
    projectMeta = sourceDb.prepare("SELECT id, title FROM project_meta LIMIT 1").get();
  } finally {
    sourceDb.close();
  }
  if (!projectMeta) throw packageError("INVALID_INPUT", "Project database is incomplete");
  const sanitized = sanitizeDatabase(databasePath, kind, includeTrash);
  try {
    const entries = walkFiles(containerDir)
      .filter((entry) => shouldInclude(entry.relativePath, { kind, includeTrash }))
      .map((entry) => ({
        path: entry.relativePath,
        bytes: entry.relativePath === "project.sqlite"
          ? readFileSync(sanitized.copyPath)
          : readFileSync(entry.absolute),
      }));
    const createdAt = now().toISOString();
    const packageManifest = {
      schemaVersion: 1,
      kind,
      createdAt,
      projectId: projectMeta.id,
      noSourceMedia: kind === "lightweight",
      includesTrash: includeTrash,
      fileCount: entries.length,
    };
    entries.push({
      path: "package-manifest.json",
      bytes: Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`, "utf8"),
    });
    const archive = createStoredZip(entries);
    const baseName = `${sanitizeName(projectMeta.title)}-${kind}.aitranslator-project.zip`;
    const written = writeUniquePackage(outputDir, baseName, archive);
    return {
      ok: true,
      ...written,
      kind,
      sizeBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
      projectId: projectMeta.id,
      createdAt,
    };
  } finally {
    rmSync(sanitized.tempDir, { recursive: true, force: true });
  }
}

export function listProjectPackageEntries(packagePath) {
  if (!isAbsolute(packagePath)) throw packageError("INVALID_INPUT", "Package path must be absolute");
  return readStoredZip(readFileSync(packagePath)).map((entry) => entry.path);
}

export function inspectProjectPackage(packagePath) {
  if (!isAbsolute(packagePath)) throw packageError("INVALID_INPUT", "Package path must be absolute");
  const bytes = readFileSync(packagePath);
  const entries = readStoredZip(bytes);
  const manifestEntry = entries.find((entry) => entry.path === "package-manifest.json");
  if (!manifestEntry) throw packageError("INVALID_ARCHIVE", "Project package manifest is missing");
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.bytes.toString("utf8"));
  } catch {
    throw packageError("INVALID_ARCHIVE", "Project package manifest is invalid");
  }
  if (
    manifest.schemaVersion !== 1
    || !PACKAGE_KINDS.has(manifest.kind)
    || typeof manifest.projectId !== "string"
    || !/^[A-Za-z0-9._-]{1,128}$/.test(manifest.projectId)
    || manifest.projectId === "."
    || manifest.projectId === ".."
    || manifest.fileCount !== entries.length - 1
    || entries.some((entry) => entry.path !== "package-manifest.json" && SECRET_PATH.test(entry.path))
  ) {
    throw packageError("INVALID_ARCHIVE", "Project package manifest or contents are incompatible");
  }
  return {
    kind: manifest.kind,
    projectId: manifest.projectId,
    noSourceMedia: manifest.noSourceMedia === true,
    includesTrash: manifest.includesTrash === true,
    fileCount: manifest.fileCount,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function restoreProjectPackage({ packagePath, destinationDir }) {
  if (!isAbsolute(packagePath) || !isAbsolute(destinationDir)) {
    throw packageError("INVALID_INPUT", "Absolute restore paths are required");
  }
  if (existsSync(destinationDir)) throw packageError("CONFLICT", "Restore destination already exists");
  const inspected = inspectProjectPackage(packagePath);
  const entries = readStoredZip(readFileSync(packagePath));
  const manifestEntry = entries.find((entry) => entry.path === "package-manifest.json");
  if (!manifestEntry) throw packageError("INVALID_ARCHIVE", "Project package manifest is missing");
  const manifest = JSON.parse(manifestEntry.bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || !PACKAGE_KINDS.has(manifest.kind) || manifest.projectId !== inspected.projectId) {
    throw packageError("INVALID_ARCHIVE", "Project package manifest is incompatible");
  }
  mkdirSync(destinationDir, { recursive: false });
  try {
    for (const entry of entries) {
      if (entry.path === "package-manifest.json") continue;
      const outputPath = resolve(destinationDir, ...entry.path.split("/"));
      const escaped = relative(resolve(destinationDir), outputPath);
      if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
        throw packageError("INVALID_ARCHIVE", "Project package entry escapes destination");
      }
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, entry.bytes, { flag: "wx" });
    }
    return {
      ok: true,
      kind: manifest.kind,
      projectId: manifest.projectId,
      noSourceMedia: manifest.noSourceMedia === true,
      destinationDir,
      packageFileName: basename(packagePath),
    };
  } catch (error) {
    rmSync(destinationDir, { recursive: true, force: true });
    throw error;
  }
}
