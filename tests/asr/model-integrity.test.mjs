import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractVerifiedZip } from "../../backend/asr/verified-zip.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const bytes = Buffer.from(value);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, bytes);

    const record = Buffer.alloc(46 + nameBytes.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    nameBytes.copy(record, 46);
    central.push(record);
    offset += local.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

test("verified ZIP extracts only declared files and rejects traversal extra entries and bounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-verified-zip-"));
  const selectedBytes = Buffer.from("selected-runtime");
  const ignoredBytes = Buffer.from("known-ignored-tool");
  const selected = [{
    archivePath: "Release/whisper-cli.exe",
    relativePath: "whisper-cli.exe",
    sizeBytes: selectedBytes.length,
    sha256: sha256(selectedBytes),
  }];
  const ignored = [{ archivePath: "Release/bench.exe", sizeBytes: ignoredBytes.length }];
  try {
    const validArchive = join(root, "valid.zip");
    const destination = join(root, "out");
    writeFileSync(validArchive, storedZip([
      ["Release/whisper-cli.exe", selectedBytes],
      ["Release/bench.exe", ignoredBytes],
    ]));
    assert.deepEqual(
      await extractVerifiedZip({ archivePath: validArchive, destinationRoot: destination, selected, ignored }),
      { extractedFiles: 1, ignoredFiles: 1, totalEntries: 2 },
    );
    assert.deepEqual(readFileSync(join(destination, "whisper-cli.exe")), selectedBytes);

    for (const [name, entries, limits, pattern] of [
      ["traversal", [["../escape.exe", Buffer.from("bad")]], undefined, /unsafe|traversal/i],
      ["extra", [["Release/whisper-cli.exe", selectedBytes], ["Release/extra.exe", Buffer.from("bad")]], undefined, /undeclared|extra/i],
      ["count", [["Release/whisper-cli.exe", selectedBytes], ["Release/bench.exe", ignoredBytes]], { maxEntries: 1 }, /count|entries|limit/i],
      ["size", [["Release/whisper-cli.exe", selectedBytes], ["Release/bench.exe", ignoredBytes]], { maxTotalBytes: 4 }, /size|bytes|limit/i],
    ]) {
      const archive = join(root, `${name}.zip`);
      writeFileSync(archive, storedZip(entries));
      await assert.rejects(
        () => extractVerifiedZip({ archivePath: archive, destinationRoot: join(root, `out-${name}`), selected, ignored, limits }),
        (error) => error?.code === "INVALID_ARCHIVE" && pattern.test(String(error.message)),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
