import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

const SIGNATURES = Object.freeze({ local: 0x04034b50, central: 0x02014b50, eocd: 0x06054b50 });
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 128,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 768 * 1024 * 1024,
  maxCentralBytes: 4 * 1024 * 1024,
});

function archiveError(message) {
  const error = new Error(message);
  error.code = "INVALID_ARCHIVE";
  return error;
}

function safePath(value, field) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    throw archiveError(`${field} is unsafe`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw archiveError(`${field} is unsafe`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw archiveError(`${field} contains traversal`);
  }
  return parts.join("/");
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw archiveError("ZIP structure is truncated");
  return buffer;
}

function findEocd(tail) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== SIGNATURES.eocd) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) return offset;
  }
  throw archiveError("ZIP end record is missing");
}

async function readCentralDirectory(archivePath, limits) {
  const handle = await open(archivePath, "r");
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size < 22) throw archiveError("ZIP file is missing or empty");
    const tailLength = Math.min(file.size, 65_557);
    const tailStart = file.size - tailLength;
    const tail = await readExact(handle, tailLength, tailStart);
    const eocdOffset = findEocd(tail);
    const eocd = tail.subarray(eocdOffset, eocdOffset + 22);
    if (eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0) {
      throw archiveError("multi-disk ZIP archives are not allowed");
    }
    const diskEntries = eocd.readUInt16LE(8);
    const totalEntries = eocd.readUInt16LE(10);
    const centralSize = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);
    if (
      diskEntries !== totalEntries ||
      totalEntries === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw archiveError("ZIP64 or inconsistent entry counts are not allowed");
    }
    if (totalEntries > limits.maxEntries) throw archiveError("ZIP entry count exceeds the limit");
    if (centralSize > limits.maxCentralBytes) throw archiveError("ZIP central directory exceeds the limit");
    if (centralOffset + centralSize > tailStart + eocdOffset) {
      throw archiveError("ZIP central directory is out of bounds");
    }
    const central = await readExact(handle, centralSize, centralOffset);
    const entries = [];
    const names = new Set();
    let cursor = 0;
    let totalBytes = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== SIGNATURES.central) {
        throw archiveError("ZIP central directory entry is invalid");
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const sizeBytes = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const diskStart = central.readUInt16LE(cursor + 34);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localOffset = central.readUInt32LE(cursor + 42);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (cursor + recordLength > central.length) throw archiveError("ZIP central entry is truncated");
      const name = safePath(central.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"), "ZIP entry");
      if (names.has(name)) throw archiveError("ZIP contains duplicate entries");
      names.add(name);
      if (flags & 1) throw archiveError("encrypted ZIP entries are not allowed");
      if (method !== 0 && method !== 8) throw archiveError("ZIP compression method is not allowed");
      if (diskStart !== 0 || localOffset === 0xffffffff || compressedSize === 0xffffffff || sizeBytes === 0xffffffff) {
        throw archiveError("ZIP64 entries are not allowed");
      }
      if (((externalAttributes >>> 16) & 0xf000) === 0xa000) throw archiveError("ZIP symlink entries are not allowed");
      if (sizeBytes > limits.maxEntryBytes) throw archiveError("ZIP entry size exceeds the limit");
      totalBytes += sizeBytes;
      if (totalBytes > limits.maxTotalBytes) throw archiveError("ZIP total bytes exceed the limit");
      entries.push({ name, flags, method, compressedSize, sizeBytes, localOffset });
      cursor += recordLength;
    }
    if (cursor !== central.length) throw archiveError("ZIP central directory has trailing data");
    return { handle, entries, centralOffset };
  } catch (error) {
    await handle.close();
    throw error?.code === "INVALID_ARCHIVE" ? error : archiveError("ZIP archive could not be read");
  }
}

function normalizeContract(selected, ignored) {
  const declared = new Map();
  for (const entry of selected) {
    const archivePath = safePath(entry.archivePath, "selected.archivePath");
    const relativePath = safePath(entry.relativePath, "selected.relativePath");
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw archiveError("selected ZIP contract is invalid");
    }
    if (declared.has(archivePath)) throw archiveError("ZIP contract contains duplicate entries");
    declared.set(archivePath, { ...entry, archivePath, relativePath, extract: true });
  }
  for (const entry of ignored) {
    const archivePath = safePath(entry.archivePath, "ignored.archivePath");
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || declared.has(archivePath)) {
      throw archiveError("ignored ZIP contract is invalid");
    }
    declared.set(archivePath, { ...entry, archivePath, extract: false });
  }
  return declared;
}

async function extractEntry(archivePath, handle, centralOffset, entry, contract, destinationRoot) {
  const local = await readExact(handle, 30, entry.localOffset);
  if (local.readUInt32LE(0) !== SIGNATURES.local) throw archiveError("ZIP local header is invalid");
  const flags = local.readUInt16LE(6);
  const method = local.readUInt16LE(8);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const name = (await readExact(handle, nameLength, entry.localOffset + 30)).toString("utf8");
  if (name !== entry.name || flags !== entry.flags || method !== entry.method) {
    throw archiveError("ZIP local and central headers disagree");
  }
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize - 1;
  if (entry.compressedSize <= 0 || dataEnd >= centralOffset) throw archiveError("ZIP entry data is out of bounds");
  const target = join(destinationRoot, ...contract.relativePath.split("/"));
  const temporary = `${target}.partial`;
  await mkdir(join(target, ".."), { recursive: true });
  let bytes = 0;
  const hash = createHash("sha256");
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > contract.sizeBytes) return callback(archiveError("ZIP entry expands beyond its trusted size"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source = createReadStream(archivePath, { start: dataStart, end: dataEnd });
  const streams = entry.method === 8
    ? [source, createInflateRaw(), verifier, createWriteStream(temporary, { flags: "wx" })]
    : [source, verifier, createWriteStream(temporary, { flags: "wx" })];
  await pipeline(...streams);
  if (bytes !== contract.sizeBytes || hash.digest("hex") !== contract.sha256) {
    throw archiveError("ZIP extracted file does not match the trusted manifest");
  }
  await rename(temporary, target);
}

export async function extractVerifiedZip({
  archivePath,
  destinationRoot,
  selected = [],
  ignored = [],
  limits = {},
}) {
  if (!isAbsolute(archivePath) || !isAbsolute(destinationRoot)) {
    throw archiveError("ZIP paths must be absolute");
  }
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const contract = normalizeContract(selected, ignored);
  const parsed = await readCentralDirectory(archivePath, effectiveLimits);
  try {
    for (const entry of parsed.entries) {
      const expected = contract.get(entry.name);
      if (!expected) throw archiveError(`ZIP contains undeclared extra entry: ${entry.name}`);
      if (entry.sizeBytes !== expected.sizeBytes) throw archiveError(`ZIP entry size mismatch: ${entry.name}`);
    }
    for (const name of contract.keys()) {
      if (!parsed.entries.some((entry) => entry.name === name)) throw archiveError(`ZIP entry is missing: ${name}`);
    }
    const existing = await lstat(destinationRoot).catch(() => null);
    if (existing) throw archiveError("ZIP destination must not already exist");
    await mkdir(destinationRoot, { recursive: true });
    for (const entry of parsed.entries) {
      const expected = contract.get(entry.name);
      if (expected.extract) {
        await extractEntry(archivePath, parsed.handle, parsed.centralOffset, entry, expected, destinationRoot);
      }
    }
    return {
      extractedFiles: selected.length,
      ignoredFiles: ignored.length,
      totalEntries: parsed.entries.length,
    };
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true }).catch(() => {});
    throw error?.code === "INVALID_ARCHIVE" ? error : archiveError("ZIP extraction failed");
  } finally {
    await parsed.handle.close();
  }
}

export { DEFAULT_LIMITS as VERIFIED_ZIP_LIMITS };
