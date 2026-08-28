import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppSettingsService } from "../../backend/settings/app-settings.mjs";
import { inspectProjectPackage } from "../../backend/export/project-package.mjs";
import { redactDiagnosticValue } from "../../backend/support/diagnostics.mjs";
import { validateIpcEnvelope } from "../../electron/ipc/validate.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localRecords(entries) {
  return Buffer.concat(entries.flatMap(([name, value]) => {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    return [header, nameBytes, bytes];
  }));
}

function storedZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(value);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

test("Phase 12 IPC accepts exact public shapes and rejects paths, argv and prototype objects", () => {
  const settings = {
    schemaVersion: 1, startupPage: "resume", translationProvider: null, translationModel: null, asrDefaultModelId: "small",
    asrVad: { mode: "auto", customParameters: { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100, maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1 } },
    asrVocalSeparation: "off",
    asrSongHandling: "preserve",
    cachePath: "C:\\cache", modelPath: "C:\\models", backupPath: "C:\\backups",
    downloadSource: "official", customDownloadUrl: "", notifications: { taskDone: true, error: true, release: true, system: true },
  };
  for (const envelope of [
    { method: "capability.status", request: {} },
    { method: "settings.save", request: { settings } },
    { method: "settings.selectDirectory", request: { pathKey: "cachePath" } },
    { method: "settings.selectModelStorageDestination", request: {} },
    { method: "settings.transferModelStorage", request: { selectionToken: "12345678-1234-1234-1234-123456789abc" } },
    { method: "downloads.probeSources", request: {} },
    { method: "project.package", request: { projectId: "project", kind: "archive", destination: "backup" } },
    { method: "backup.restore.apply", request: { token: "token-1", userConfirmed: true } },
    { method: "diagnostics.preview", request: {} },
  ]) assert.equal(validateIpcEnvelope(envelope).ok, true, envelope.method);

  for (const envelope of [
    { method: "capability.status", request: { projectId: "project", path: "C:\\private" } },
    { method: "settings.save", request: { settings, argv: ["--exec"] } },
    { method: "settings.selectDirectory", request: { pathKey: "modelPath" } },
    { method: "settings.selectDirectory", request: { pathKey: "cachePath", path: "C:\\attack" } },
    { method: "settings.selectModelStorageDestination", request: { path: "C:\\attack" } },
    { method: "settings.transferModelStorage", request: { path: "C:\\attack" } },
    { method: "backup.restore.select", request: { kind: "project", path: "C:\\attack.zip" } },
    { method: "project.package", request: { projectId: "project", kind: "archive", destination: "backup", outputDir: "C:\\attack" } },
    { method: "project.package", request: { projectId: "project", kind: "archive", destination: "project" } },
    { method: "backup.restore.apply", request: { token: "token-1", userConfirmed: true, command: "rm" } },
    { method: "diagnostics.preview", request: new Date() },
  ]) assert.equal(validateIpcEnvelope(envelope).ok, false, envelope.method);
});

test("system paths and custom sources reject project overlap and private network targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase12-path-security-"));
  const paths = { cachePath: join(root, "cache"), modelPath: join(root, "models"), backupPath: join(root, "backups") };
  const projects = join(root, "projects");
  [...Object.values(paths), projects].forEach((path) => mkdirSync(path));
  let stored = null;
  const repository = { getAppSettings: () => stored, saveAppSettings: (value) => (stored = value) };
  const defaults = { schemaVersion: 1, startupPage: "resume", asrDefaultModelId: "small", ...paths, downloadSource: "official", customDownloadUrl: "", notifications: { taskDone: true, error: true, release: true, system: true } };
  const service = createAppSettingsService({ repository, defaults, protectedRoots: [projects] });
  try {
    await assert.rejects(() => service.save({ ...defaults, backupPath: projects }), /projects directory/i);
    await assert.rejects(() => service.save({ ...defaults, downloadSource: "custom", customDownloadUrl: "https://127.0.0.1/model.bin" }), /public HTTPS/i);
    await assert.rejects(() => service.save({ ...defaults, downloadSource: "custom", customDownloadUrl: "https://[::1]/model.bin" }), /public HTTPS/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malicious project packages cannot carry secret files, traversal or truncated ZIPs", () => {
  const root = mkdtempSync(join(tmpdir(), "phase12-package-security-"));
  const manifest = (fileCount) => JSON.stringify({ schemaVersion: 1, kind: "archive", createdAt: "now", projectId: "safe-project", noSourceMedia: false, includesTrash: false, fileCount });
  try {
    const secretPackage = join(root, "secret.zip");
    writeFileSync(secretPackage, storedZip([["project.sqlite", "db"], ["credentials/api-key", "secret"], ["package-manifest.json", manifest(2)]]));
    assert.throws(() => inspectProjectPackage(secretPackage), /incompatible|secret/i);

    const traversalPackage = join(root, "traversal.zip");
    writeFileSync(traversalPackage, storedZip([["../outside", "attack"], ["package-manifest.json", manifest(1)]]));
    assert.throws(() => inspectProjectPackage(traversalPackage), /unsafe/i);

    const truncatedPackage = join(root, "truncated.zip");
    writeFileSync(truncatedPackage, localRecords([["project.sqlite", "db"], ["package-manifest.json", manifest(1)]]));
    assert.throws(() => inspectProjectPackage(truncatedPackage), /central directory|truncated/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic redaction is bounded for cyclic hostile values", () => {
  const hostile = { apiKey: "sk-super-secret-value", filePath: "C:\\Users\\Private\\movie.srt" };
  hostile.self = hostile;
  const serialized = JSON.stringify(redactDiagnosticValue(hostile));
  assert.equal(serialized.includes("sk-super-secret-value"), false);
  assert.equal(serialized.includes("Users\\Private"), false);
  assert.match(serialized, /REDACTED_DEPTH/);
});
