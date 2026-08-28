import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModelInstaller } from "../../backend/asr/model-installer.mjs";
import { createAsrRuntimePort } from "../../backend/asr/runtime-registry.mjs";

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

function manifestFor(modelBytes, noticeBytes) {
  const exe = Buffer.from("runtime-exe");
  const runtimeArchive = Buffer.from("runtime-archive");
  const runtimeNotice = Buffer.from("runtime notice");
  return {
    schemaVersion: 1,
    engine: { id: "whisper.cpp", version: "1.9.1", tagCommit: "f049fff95a089aa9969deb009cdd4892b3e74916" },
    runtime: {
      id: "whisper-cpp-cpu-x64",
      version: "1.9.1",
      platform: "win32",
      arch: "x64",
      executable: "whisper-cli.exe",
      archive: {
        fileName: "synthetic-cpu.zip",
        sizeBytes: runtimeArchive.length,
        sha256: sha256(runtimeArchive),
        sourceUrl: "https://runtime.example.test/synthetic-cpu.zip",
        entryPrefix: "Release/",
        ignoredEntries: [],
      },
      files: [
        { relativePath: "whisper-cli.exe", role: "executable", sizeBytes: exe.length, sha256: sha256(exe) },
        { relativePath: "licenses/WHISPER-CPP-MIT.txt", role: "notice", sizeBytes: runtimeNotice.length, sha256: sha256(runtimeNotice) },
      ],
    },
    model: {
      id: "small",
      version: "5359861c739e955e79d9a303bcbc70fb988958b1",
      compatibleEngineVersion: "1.9.1",
      modelHash: sha256(modelBytes),
      sourceUrl: "https://models.example.test/ggml-small.bin",
      mirrorUrl: "https://mirror.example.test/ggml-small.bin",
      files: [
        { relativePath: "ggml-small.bin", role: "model", sizeBytes: modelBytes.length, sha256: sha256(modelBytes) },
        { relativePath: "licenses/OPENAI-WHISPER-MIT.txt", role: "notice", sizeBytes: noticeBytes.length, sha256: sha256(noticeBytes) },
      ],
    },
  };
}

function catalogFields({ displayName, family, variant, quantization }) {
  return {
    displayName,
    family,
    variant,
    quantization,
    format: "ggml",
    license: "MIT",
    minimumMemoryBytes: 1_073_741_824,
    recommendedMemoryBytes: 2_147_483_648,
    recommendedVramBytes: 1_073_741_824,
    supportsCpu: true,
    supportsCuda: true,
    languageScope: "multilingual",
    timestampSupport: "segment-and-token",
    productStatus: "stable",
  };
}

function manifestForModels(smallBytes, turboBytes, noticeBytes) {
  const manifest = manifestFor(smallBytes, noticeBytes);
  const small = {
    ...manifest.model,
    ...catalogFields({ displayName: "Small", family: "small", variant: "full", quantization: "none" }),
    repository: "ggerganov/whisper.cpp",
    license: "MIT",
  };
  const turboQ5 = {
    ...small,
    ...catalogFields({ displayName: "Large V3 Turbo Q5_0", family: "large-v3-turbo", variant: "q5_0", quantization: "q5_0" }),
    id: "large-v3-turbo-q5_0",
    modelHash: sha256(turboBytes),
    sourceUrl: "https://models.example.test/ggml-large-v3-turbo-q5_0.bin",
    mirrorUrl: "https://mirror.example.test/ggml-large-v3-turbo-q5_0.bin",
    files: [
      { relativePath: "ggml-large-v3-turbo-q5_0.bin", role: "model", sizeBytes: turboBytes.length, sha256: sha256(turboBytes) },
      { relativePath: "licenses/OPENAI-WHISPER-MIT.txt", role: "notice", sizeBytes: noticeBytes.length, sha256: sha256(noticeBytes) },
    ],
  };
  manifest.schemaVersion = 2;
  manifest.models = [small, turboQ5];
  delete manifest.model;
  return manifest;
}

function addVadModel(manifest, modelBytes, noticeBytes) {
  const vadExecutable = Buffer.from("vad-runtime-exe");
  manifest.schemaVersion = 3;
  manifest.runtime.vadExecutable = "whisper-vad-speech-segments.exe";
  manifest.runtime.files.push({
    relativePath: "whisper-vad-speech-segments.exe",
    role: "vad-executable",
    sizeBytes: vadExecutable.length,
    sha256: sha256(vadExecutable),
  });
  manifest.vadModel = {
    id: "silero-vad-v6.2.0",
    displayName: "Silero VAD v6.2.0",
    version: "6.2.0",
    sourceRevision: "9ffd54a1e1ee413ddf265af9913beaf518d1639b",
    compatibleEngineVersion: "1.9.1",
    modelHash: sha256(modelBytes),
    repository: "ggml-org/whisper-vad",
    sourceUrl: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
    license: "MIT",
    licenseUrl: "https://github.com/snakers4/silero-vad/blob/76e3dc408eb2a5c655c34e230d2d5459b4439daa/LICENSE",
    files: [
      { relativePath: "ggml-silero-v6.2.0.bin", role: "vad-model", sizeBytes: modelBytes.length, sha256: sha256(modelBytes) },
      { relativePath: "licenses/SILERO-VAD-MIT.txt", role: "notice", sizeBytes: noticeBytes.length, sha256: sha256(noticeBytes) },
    ],
  };
}

test("startup reconciliation atomically installs and repairs the bundled auxiliary VAD model", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-vad-reconcile-"));
  const appOwnedRoot = join(root, "managed");
  const bundledVadRoot = join(root, "bundle");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const small = Buffer.from("small-model");
  const turbo = Buffer.from("turbo-model");
  const modelNotice = Buffer.from("OpenAI Whisper MIT notice");
  const vad = Buffer.from("verified-silero-vad-model");
  const vadNotice = Buffer.from("Silero VAD MIT notice");
  const manifest = manifestForModels(small, turbo, modelNotice);
  addVadModel(manifest, vad, vadNotice);
  mkdirSync(bundledVadRoot, { recursive: true });
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(bundledVadRoot, "ggml-silero-v6.2.0.bin"), vad);
  writeFileSync(join(trustedNoticeRoot, "SILERO-VAD-MIT.txt"), vadNotice);
  const installer = createModelInstaller({ manifest, appOwnedRoot, bundledVadRoot, trustedNoticeRoot });
  const registry = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
  const installedPath = join(appOwnedRoot, "auxiliary", "silero-vad-v6.2.0", "ggml-silero-v6.2.0.bin");
  try {
    await installer.reconcile();
    assert.equal((await registry.getCapabilityStatus()).vadModel.installState, "ready");
    assert.deepEqual(readFileSync(installedPath), vad);

    writeFileSync(installedPath, "corrupt");
    await installer.reconcile();
    assert.equal((await registry.getCapabilityStatus()).vadModel.installState, "ready");
    assert.deepEqual(readFileSync(installedPath), vad);

    writeFileSync(installedPath, "corrupt-again");
    writeFileSync(join(bundledVadRoot, "ggml-silero-v6.2.0.bin"), "corrupt-bundle");
    await installer.reconcile();
    assert.equal((await registry.getCapabilityStatus()).vadModel.installState, "corrupt");
    assert.equal(existsSync(join(appOwnedRoot, "staging", "auxiliary", "silero-vad-v6.2.0", "publish-startup")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function addCudaRuntime(manifest, archiveBytes, { ignoredEntries = [{ archivePath: "Release/bench.exe", sizeBytes: 13 }] } = {}) {
  const executable = Buffer.from("cuda-runtime-exe");
  const library = Buffer.from("cuda-runtime-library");
  const whisperNotice = Buffer.from("whisper runtime notice");
  const nvidiaNotice = Buffer.from("NVIDIA CUDA notice");
  manifest.optionalRuntimes = [{
    id: "whisper-cpp-cuda-12.4-x64",
    version: "1.9.1",
    device: "cuda",
    platform: "win32",
    arch: "x64",
    executable: "whisper-cli.exe",
    archive: {
      fileName: "synthetic-cuda.zip",
      sizeBytes: archiveBytes.length,
      sha256: sha256(archiveBytes),
      sourceUrl: "https://runtime.example.test/synthetic-cuda.zip",
      entryPrefix: "Release/",
      ignoredEntries,
    },
    files: [
      { relativePath: "whisper-cli.exe", role: "executable", sizeBytes: executable.length, sha256: sha256(executable) },
      { relativePath: "ggml-cuda.dll", role: "library", sizeBytes: library.length, sha256: sha256(library) },
      { relativePath: "licenses/WHISPER-CPP-MIT.txt", role: "notice", sizeBytes: whisperNotice.length, sha256: sha256(whisperNotice) },
      { relativePath: "licenses/NVIDIA-CUDA-12.4-NOTICE.txt", role: "notice", sizeBytes: nvidiaNotice.length, sha256: sha256(nvidiaNotice) },
    ],
  }];
  return { executable, library, whisperNotice, nvidiaNotice };
}

test("optional CUDA runtime archive verifies before atomic ready publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-runtime-install-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const modelNotice = Buffer.from("OpenAI Whisper MIT notice");
  const executable = Buffer.from("cuda-runtime-exe");
  const library = Buffer.from("cuda-runtime-library");
  const ignored = Buffer.from("ignored-bench");
  const archive = storedZip([
    ["Release/whisper-cli.exe", executable],
    ["Release/ggml-cuda.dll", library],
    ["Release/bench.exe", ignored],
  ]);
  const manifest = manifestFor(modelBytes, modelNotice);
  const notices = addCudaRuntime(manifest, archive);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "WHISPER-CPP-MIT.txt"), notices.whisperNotice);
  writeFileSync(join(trustedNoticeRoot, "NVIDIA-CUDA-12.4-NOTICE.txt"), notices.nvidiaNotice);
  let request = null;
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async (input) => {
      request = input;
      return { status: 200, headers: { etag: '"cuda-v1"' }, body: (async function* () { yield archive; })() };
    },
  });
  try {
    const result = await installer.installRuntime({
      assetId: "whisper-cpp-cuda-12.4-x64",
      source: "official",
      operationId: "cuda-install-1",
    });
    assert.deepEqual(result, {
      assetId: "whisper-cpp-cuda-12.4-x64",
      installState: "ready",
      source: "official",
      sizeBytes: archive.length,
      sha256: sha256(archive),
    });
    assert.equal(request.url, manifest.optionalRuntimes[0].archive.sourceUrl);
    assert.equal(existsSync(join(appOwnedRoot, "runtimes", result.assetId, "bench.exe")), false);
    const status = await createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" }).getCapabilityStatus();
    assert.equal(status.optionalRuntimes[0].installState, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic model download falls back to the healthy configured mirror", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-fallback-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("fallback-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  const urls = [];
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    getDownloadSettings: () => ({ downloadSource: "official", customDownloadUrl: "" }),
    openDownload: async ({ url }) => {
      urls.push(url);
      if (url === manifest.model.sourceUrl) throw new TypeError("official unavailable");
      return { status: 200, headers: { etag: '"mirror-v1"' }, body: (async function* () { yield modelBytes; })() };
    },
  });
  try {
    const result = await installer.install({ assetId: "small", source: "auto", operationId: "fallback-1" });
    assert.equal(result.source, "mirror");
    assert.deepEqual(urls, [manifest.model.sourceUrl, manifest.model.mirrorUrl]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("download source health is real, bounded and does not expose URLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-source-health-"));
  const manifest = manifestFor(Buffer.from("model"), Buffer.from("notice"));
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot: join(root, "managed"),
    trustedNoticeRoot: join(root, "trusted"),
    probeSource: async ({ source }) => ({ ok: source === "mirror", latencyMs: source === "mirror" ? 12 : 40 }),
  });
  try {
    const health = await installer.getSourceHealth();
    assert.deepEqual(health, [
      { source: "official", status: "unavailable", latencyMs: 40 },
      { source: "mirror", status: "healthy", latencyMs: 12 },
    ]);
    assert.equal(/https?:|url/i.test(JSON.stringify(health)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime archive with a manifest-pinned but undeclared executable never publishes ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-runtime-extra-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const modelNotice = Buffer.from("OpenAI Whisper MIT notice");
  const executable = Buffer.from("cuda-runtime-exe");
  const library = Buffer.from("cuda-runtime-library");
  const archive = storedZip([
    ["Release/whisper-cli.exe", executable],
    ["Release/ggml-cuda.dll", library],
    ["Release/extra.exe", Buffer.from("undeclared")],
  ]);
  const manifest = manifestFor(modelBytes, modelNotice);
  const notices = addCudaRuntime(manifest, archive, { ignoredEntries: [] });
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "WHISPER-CPP-MIT.txt"), notices.whisperNotice);
  writeFileSync(join(trustedNoticeRoot, "NVIDIA-CUDA-12.4-NOTICE.txt"), notices.nvidiaNotice);
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async () => ({ status: 200, headers: {}, body: (async function* () { yield archive; })() }),
  });
  try {
    await assert.rejects(
      () => installer.installRuntime({ assetId: "whisper-cpp-cuda-12.4-x64", source: "official", operationId: "cuda-extra" }),
      (error) => error?.code === "INVALID_ARCHIVE" && /undeclared|extra/i.test(String(error.message)),
    );
    const status = await createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" }).getCapabilityStatus();
    assert.equal(status.optionalRuntimes[0].installState, "not_installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual CUDA import stays behind the dialog boundary and uninstall is in-use safe", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-runtime-manual-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const selectedArchive = join(root, "selected-runtime.zip");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const modelNotice = Buffer.from("OpenAI Whisper MIT notice");
  const executable = Buffer.from("cuda-runtime-exe");
  const library = Buffer.from("cuda-runtime-library");
  const ignored = Buffer.from("ignored-bench");
  const archive = storedZip([
    ["Release/whisper-cli.exe", executable],
    ["Release/ggml-cuda.dll", library],
    ["Release/bench.exe", ignored],
  ]);
  const manifest = manifestFor(modelBytes, modelNotice);
  const notices = addCudaRuntime(manifest, archive);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "WHISPER-CPP-MIT.txt"), notices.whisperNotice);
  writeFileSync(join(trustedNoticeRoot, "NVIDIA-CUDA-12.4-NOTICE.txt"), notices.nvidiaNotice);
  writeFileSync(selectedArchive, archive);
  let dialogRequest = null;
  let inUse = true;
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async () => { throw new Error("manual import must not use the network"); },
    selectImportFile: async (request) => {
      dialogRequest = request;
      return { canceled: false, filePath: selectedArchive };
    },
    isAssetInUse: (assetId) => assetId === "whisper-cpp-cuda-12.4-x64" && inUse,
  });
  try {
    const result = await installer.importRuntime({ assetId: "whisper-cpp-cuda-12.4-x64", operationId: "cuda-manual" });
    assert.equal(result.installState, "ready");
    assert.equal(result.source, "manual");
    assert.deepEqual(dialogRequest, { assetId: "whisper-cpp-cuda-12.4-x64", extensions: ["zip"] });
    assert.equal(JSON.stringify(result).includes(selectedArchive), false);

    const cpuSibling = join(appOwnedRoot, "runtimes", "whisper-cpp-cpu-x64", "keep.dll");
    const project = join(appOwnedRoot, "projects", "keep.txt");
    mkdirSync(join(cpuSibling, ".."), { recursive: true });
    mkdirSync(join(project, ".."), { recursive: true });
    writeFileSync(cpuSibling, "keep");
    writeFileSync(project, "keep");
    await assert.rejects(
      () => installer.uninstallRuntime({ assetId: result.assetId, operationId: "cuda-uninstall-blocked" }),
      (error) => error?.code === "CONFLICT" && /语音识别正在运行/.test(String(error.message)),
    );
    inUse = false;
    assert.deepEqual(
      await installer.uninstallRuntime({ assetId: result.assetId, operationId: "cuda-uninstall-ok" }),
      { assetId: result.assetId, uninstalled: true },
    );
    assert.equal(existsSync(cpuSibling), true);
    assert.equal(existsSync(project), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation preserves only a trusted resumable CUDA archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-runtime-reconcile-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const modelNotice = Buffer.from("OpenAI Whisper MIT notice");
  const executable = Buffer.from("cuda-runtime-exe");
  const library = Buffer.from("cuda-runtime-library");
  const ignored = Buffer.from("ignored-bench");
  const archive = storedZip([
    ["Release/whisper-cli.exe", executable],
    ["Release/ggml-cuda.dll", library],
    ["Release/bench.exe", ignored],
  ]);
  const manifest = manifestFor(modelBytes, modelNotice);
  const notices = addCudaRuntime(manifest, archive);
  const runtime = manifest.optionalRuntimes[0];
  const stagingRoot = join(appOwnedRoot, "staging", "runtimes", runtime.id);
  const receivedBytes = 17;
  mkdirSync(trustedNoticeRoot, { recursive: true });
  mkdirSync(join(appOwnedRoot, "locks"), { recursive: true });
  mkdirSync(join(stagingRoot, "publish-abandoned"), { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "WHISPER-CPP-MIT.txt"), notices.whisperNotice);
  writeFileSync(join(trustedNoticeRoot, "NVIDIA-CUDA-12.4-NOTICE.txt"), notices.nvidiaNotice);
  writeFileSync(join(appOwnedRoot, "locks", `${runtime.id}.lock`), JSON.stringify({ pid: 999999, operationId: "dead" }));
  writeFileSync(join(stagingRoot, "archive.partial"), archive.subarray(0, receivedBytes));
  writeFileSync(join(stagingRoot, "archive.meta.json"), JSON.stringify({
    sourceUrl: runtime.archive.sourceUrl,
    sizeBytes: archive.length,
    sha256: sha256(archive),
    etag: '"cuda-reconcile-v1"',
    receivedBytes,
  }));
  let request = null;
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    isProcessAlive: () => false,
    openDownload: async (input) => {
      request = input;
      return {
        status: 206,
        headers: {
          etag: '"cuda-reconcile-v1"',
          "content-range": `bytes ${receivedBytes}-${archive.length - 1}/${archive.length}`,
        },
        body: (async function* () { yield archive.subarray(receivedBytes); })(),
      };
    },
  });
  try {
    assert.deepEqual(await installer.reconcile(), {
      staleLocksRemoved: 1,
      abandonedPublishesRemoved: 1,
      resumablePartialsPreserved: 1,
    });
    const result = await installer.installRuntime({ assetId: runtime.id, source: "official", operationId: "cuda-after-restart" });
    assert.equal(result.installState, "ready");
    assert.deepEqual(request.headers, { Range: `bytes=${receivedBytes}-`, "If-Range": '"cuda-reconcile-v1"' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official model bytes verify in staging before atomic ready publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-install-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  let request = null;
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async (input) => {
      request = input;
      return {
        status: 200,
        headers: { etag: '"model-v1"', "content-length": String(modelBytes.length) },
        body: (async function* () {
          yield modelBytes.subarray(0, 7);
          yield modelBytes.subarray(7);
        })(),
      };
    },
  });

  try {
    const result = await installer.install({ assetId: "small", source: "official", operationId: "install-1" });
    assert.deepEqual(result, {
      assetId: "small",
      installState: "ready",
      source: "official",
      sizeBytes: modelBytes.length,
      sha256: sha256(modelBytes),
      resumedFromBytes: 0,
    });
    assert.equal(request.url, manifest.model.sourceUrl);
    assert.deepEqual(request.headers, {});
    assert.equal(JSON.stringify(result).includes(appOwnedRoot), false);

    const registry = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
    const status = await registry.getCapabilityStatus();
    assert.equal(status.model.installState, "ready");
    assert.equal(status.runtime.installState, "not_installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("modelId installs and uninstalls variants in independent managed roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-variants-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const smallBytes = Buffer.from("exact-small-model-bytes");
  const turboBytes = Buffer.from("exact-turbo-q5-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestForModels(smallBytes, turboBytes, noticeBytes);
  const selectedTurbo = join(root, "selected-turbo.bin");
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  writeFileSync(selectedTurbo, turboBytes);
  const requestedUrls = [];
  let importRequest = null;
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async ({ url }) => {
      requestedUrls.push(url);
      const bytes = url.includes("large-v3-turbo") ? turboBytes : smallBytes;
      return { status: 200, headers: {}, body: (async function* () { yield bytes; })() };
    },
    selectImportFile: async (request) => {
      importRequest = request;
      return { canceled: false, filePath: selectedTurbo };
    },
  });
  try {
    await installer.install({ assetId: "small", source: "official", operationId: "models-small" });
    await installer.importModel({ assetId: "large-v3-turbo-q5_0", operationId: "models-turbo" });
    assert.deepEqual(requestedUrls, [manifest.models[0].sourceUrl]);
    assert.deepEqual(importRequest, { assetId: "large-v3-turbo-q5_0", extensions: ["bin"] });
    assert.equal(existsSync(join(appOwnedRoot, "models", "small", "ggml-small.bin")), true);
    assert.equal(existsSync(join(appOwnedRoot, "models", "large-v3-turbo-q5_0", "ggml-large-v3-turbo-q5_0.bin")), true);

    const registry = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
    let status = await registry.getCapabilityStatus();
    assert.deepEqual(status.models.map(({ id, installState }) => ({ id, installState })), [
      { id: "small", installState: "ready" },
      { id: "large-v3-turbo-q5_0", installState: "ready" },
    ]);
    assert.deepEqual(
      await installer.uninstall({ assetId: "large-v3-turbo-q5_0", operationId: "models-turbo-remove" }),
      { assetId: "large-v3-turbo-q5_0", uninstalled: true },
    );
    status = await registry.getCapabilityStatus();
    assert.equal(status.model.installState, "ready");
    assert.equal(status.models[1].installState, "not_installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a secondary model hash failure leaves an installed Small model untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-variant-hash-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const smallBytes = Buffer.from("exact-small-model-bytes");
  const turboBytes = Buffer.from("exact-turbo-q5-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestForModels(smallBytes, turboBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async ({ url }) => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield url.includes("large-v3-turbo") ? Buffer.alloc(turboBytes.length, 1) : smallBytes;
      })(),
    }),
  });
  try {
    await installer.install({ assetId: "small", source: "official", operationId: "hash-small" });
    await assert.rejects(
      () => installer.install({ assetId: "large-v3-turbo-q5_0", source: "official", operationId: "hash-turbo" }),
      (error) => error?.code === "HASH_MISMATCH",
    );
    const status = await createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" }).getCapabilityStatus();
    assert.equal(status.model.installState, "ready");
    assert.equal(status.models[1].installState, "not_installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a secondary model resumes only its own trusted mirror partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-variant-resume-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const smallBytes = Buffer.from("exact-small-model-bytes");
  const turboBytes = Buffer.from("exact-turbo-q5-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestForModels(smallBytes, turboBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  const requests = [];
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          status: 200,
          headers: { etag: '"turbo-v1"' },
          body: (async function* () {
            yield turboBytes.subarray(0, 7);
            const error = new Error("network interrupted");
            error.code = "DOWNLOAD_FAILED";
            throw error;
          })(),
        };
      }
      return {
        status: 206,
        headers: { etag: '"turbo-v1"', "content-range": `bytes 7-${turboBytes.length - 1}/${turboBytes.length}` },
        body: (async function* () { yield turboBytes.subarray(7); })(),
      };
    },
  });
  try {
    await assert.rejects(
      () => installer.install({ assetId: "large-v3-turbo-q5_0", source: "mirror", operationId: "turbo-resume-1" }),
      (error) => error?.code === "DOWNLOAD_FAILED",
    );
    await installer.install({ assetId: "large-v3-turbo-q5_0", source: "mirror", operationId: "turbo-resume-2" });
    assert.ok(requests.every((request) => request.url === manifest.models[1].mirrorUrl));
    assert.deepEqual(requests[1].headers, { Range: "bytes=7-", "If-Range": '"turbo-v1"' });
    assert.equal(existsSync(join(appOwnedRoot, "models", "small")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installation progress is throttled bounded and contains no source or path fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-progress-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.alloc(100, 7);
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  const progress = [];
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    now: () => 0,
    progressIntervalMs: 250,
    reportProgress: (event) => { progress.push(event); },
    openDownload: async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        for (const byte of modelBytes) yield Buffer.from([byte]);
      })(),
    }),
  });
  try {
    await installer.install({ assetId: "small", source: "official", operationId: "progress-1" });
    assert.ok(progress.length >= 4 && progress.length <= 6, JSON.stringify(progress));
    assert.ok(progress.every((event) =>
      Number.isFinite(event.progress) &&
      event.progress >= 0 &&
      event.progress <= 1 &&
      ["download", "verify", "publish", "ready"].includes(event.stage) &&
      Object.keys(event).every((key) => ["operationId", "assetId", "assetKind", "stage", "progress", "receivedBytes", "totalBytes"].includes(key)),
    ));
    assert.equal(/path|url|sha256/i.test(JSON.stringify(progress)), false);
    assert.ok(progress.filter((event) => event.stage === "download").length <= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling an active download checkpoints the final bytes and resumes without a fake ready model", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-cancel-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  let secondChunkWritten;
  const secondChunk = new Promise((resolve) => {
    secondChunkWritten = resolve;
  });
  const requests = [];
  const progress = [];
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    now: () => 0,
    reportProgress: (event) => { progress.push(event); },
    openDownload: async ({ headers, signal }) => {
      requests.push(headers);
      if (requests.length === 2) {
        return {
          status: 206,
          headers: { etag: '"stable-cancel"', "content-range": `bytes 9-${modelBytes.length - 1}/${modelBytes.length}` },
          body: (async function* () { yield modelBytes.subarray(9); })(),
        };
      }
      return {
        status: 200,
        headers: { etag: '"stable-cancel"' },
        body: (async function* () {
          yield modelBytes.subarray(0, 5);
          yield modelBytes.subarray(5, 9);
          secondChunkWritten();
          await new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                const error = new Error("cancelled");
                error.code = "CANCELLED";
                reject(error);
              },
              { once: true },
            ),
          );
        })(),
      };
    },
  });

  try {
    const pending = installer.install({ assetId: "small", source: "official", operationId: "cancel-1" });
    await secondChunk;
    assert.deepEqual(installer.cancel({ operationId: "cancel-1" }), { cancelled: true });
    await assert.rejects(() => pending, (error) => error?.code === "CANCELLED");
    const stagingRoot = join(appOwnedRoot, "staging", "models", "small");
    const partialSize = statSync(join(stagingRoot, "download.partial")).size;
    assert.equal(partialSize, 9);
    assert.equal(JSON.parse(readFileSync(join(stagingRoot, "download.meta.json"), "utf8")).receivedBytes, partialSize);
    const registry = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
    const status = await registry.getCapabilityStatus();
    assert.equal(status.model.installState, "not_installed");
    assert.deepEqual(installer.cancel({ operationId: "cancel-1" }), { cancelled: false });
    const resumed = await installer.install({ assetId: "small", source: "official", operationId: "cancel-2" });
    assert.equal(resumed.installState, "ready");
    assert.equal(resumed.resumedFromBytes, 9);
    assert.deepEqual(requests[1], { Range: "bytes=9-", "If-Range": '"stable-cancel"' });
    assert.equal(
      progress.find((event) => event.operationId === "cancel-2" && event.stage === "download")?.receivedBytes,
      9,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial download resumes only from the matching ETag byte boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-resume-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  const requests = [];
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          status: 200,
          headers: { etag: '"stable-v1"', "content-length": String(modelBytes.length) },
          body: (async function* () {
            yield modelBytes.subarray(0, 6);
            const error = new Error("network interrupted");
            error.code = "DOWNLOAD_FAILED";
            throw error;
          })(),
        };
      }
      return {
        status: 206,
        headers: {
          etag: '"stable-v1"',
          "content-range": `bytes 6-${modelBytes.length - 1}/${modelBytes.length}`,
          "content-length": String(modelBytes.length - 6),
        },
        body: (async function* () {
          yield modelBytes.subarray(6);
        })(),
      };
    },
  });

  try {
    await assert.rejects(
      () => installer.install({ assetId: "small", source: "official", operationId: "resume-first" }),
      (error) => error?.code === "DOWNLOAD_FAILED",
    );
    const result = await installer.install({ assetId: "small", source: "official", operationId: "resume-second" });
    assert.equal(result.installState, "ready");
    assert.deepEqual(requests[0].headers, {});
    assert.deepEqual(requests[1].headers, { Range: "bytes=6-", "If-Range": '"stable-v1"' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed ETag discards the old partial and restarts without byte concatenation", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-etag-change-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  const requests = [];
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          status: 200,
          headers: { etag: '"old"' },
          body: (async function* () {
            yield modelBytes.subarray(0, 6);
            const error = new Error("network interrupted");
            error.code = "DOWNLOAD_FAILED";
            throw error;
          })(),
        };
      }
      if (requests.length === 2) {
        return {
          status: 206,
          headers: { etag: '"changed"', "content-range": `bytes 6-${modelBytes.length - 1}/${modelBytes.length}` },
          body: (async function* () { yield modelBytes.subarray(6); })(),
        };
      }
      return { status: 200, headers: { etag: '"changed"' }, body: (async function* () { yield modelBytes; })() };
    },
  });
  try {
    await assert.rejects(
      () => installer.install({ assetId: "small", source: "official", operationId: "etag-first" }),
      (error) => error?.code === "DOWNLOAD_FAILED",
    );
    const result = await installer.install({ assetId: "small", source: "official", operationId: "etag-restart" });
    assert.equal(result.installState, "ready");
    assert.deepEqual(requests.map((request) => request.headers), [
      {},
      { Range: "bytes=6-", "If-Range": '"old"' },
      {},
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model install failure matrix never publishes ready or leaks local paths", async () => {
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const cases = [
    ["404", "DOWNLOAD_FAILED", async () => ({ status: 404, headers: {}, body: (async function* () {})() })],
    ["network", "DOWNLOAD_FAILED", async () => { throw new TypeError("network unavailable"); }],
    ["timeout", "DOWNLOAD_FAILED", async () => { const error = new Error("timeout"); error.code = "ETIMEDOUT"; throw error; }],
    ["short", "LENGTH_MISMATCH", async () => ({ status: 200, headers: {}, body: (async function* () { yield modelBytes.subarray(0, -1); })() })],
    ["long", "LENGTH_MISMATCH", async () => ({ status: 200, headers: {}, body: (async function* () { yield Buffer.concat([modelBytes, Buffer.from("x")]); })() })],
    ["hash", "HASH_MISMATCH", async () => ({ status: 200, headers: {}, body: (async function* () { yield Buffer.alloc(modelBytes.length, 1); })() })],
  ];
  for (const [name, expectedCode, openDownload] of cases) {
    const root = mkdtempSync(join(tmpdir(), `asr-model-failure-${name}-`));
    const appOwnedRoot = join(root, "managed");
    const trustedNoticeRoot = join(root, "trusted-notices");
    const manifest = manifestFor(modelBytes, noticeBytes);
    mkdirSync(trustedNoticeRoot, { recursive: true });
    writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
    const installer = createModelInstaller({ manifest, appOwnedRoot, trustedNoticeRoot, openDownload });
    try {
      await assert.rejects(
        () => installer.install({ assetId: "small", source: "official", operationId: `failure-${name}` }),
        (error) => error?.code === expectedCode && !String(error.message).includes(root),
      );
      const status = await createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" }).getCapabilityStatus();
      assert.equal(status.model.installState, "not_installed", name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("official mirror and manual model sources converge on the same trusted bytes", async () => {
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const hashes = [];
  for (const source of ["official", "mirror", "manual"]) {
    const root = mkdtempSync(join(tmpdir(), `asr-model-source-${source}-`));
    const appOwnedRoot = join(root, "managed");
    const trustedNoticeRoot = join(root, "trusted-notices");
    const selectedFile = join(root, "selected.bin");
    const manifest = manifestFor(modelBytes, noticeBytes);
    mkdirSync(trustedNoticeRoot, { recursive: true });
    writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
    writeFileSync(selectedFile, modelBytes);
    const installer = createModelInstaller({
      manifest,
      appOwnedRoot,
      trustedNoticeRoot,
      openDownload: async ({ url }) => {
        assert.equal(url, source === "mirror" ? manifest.model.mirrorUrl : manifest.model.sourceUrl);
        return { status: 200, headers: {}, body: (async function* () { yield modelBytes; })() };
      },
      selectImportFile: async () => ({ canceled: false, filePath: selectedFile }),
    });
    try {
      const result = source === "manual"
        ? await installer.importModel({ assetId: "small", operationId: `source-${source}` })
        : await installer.install({ assetId: "small", source, operationId: `source-${source}` });
      hashes.push(result.sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(hashes, [sha256(modelBytes), sha256(modelBytes), sha256(modelBytes)]);
});

test("cross-instance single-writer conflict cannot remove the active lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-lock-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  let releaseDownload;
  const gate = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  let firstOpened;
  const opened = new Promise((resolve) => {
    firstOpened = resolve;
  });
  const first = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async () => {
      firstOpened();
      await gate;
      return {
        status: 200,
        headers: {},
        body: (async function* () { yield modelBytes; })(),
      };
    },
  });
  const second = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async () => {
      throw new Error("second writer must not download");
    },
  });

  try {
    const active = first.install({ assetId: "small", source: "official", operationId: "writer-1" });
    await opened;
    await assert.rejects(
      () => second.install({ assetId: "small", source: "official", operationId: "writer-2" }),
      (error) => error?.code === "CONFLICT",
    );
    assert.equal(existsSync(join(appOwnedRoot, "locks", "small.lock")), true);
    releaseDownload();
    assert.equal((await active).installState, "ready");
  } finally {
    releaseDownload();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disk exhaustion is a stable retryable failure and never publishes ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-disk-full-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        const error = new Error("C:\\private\\disk full");
        error.code = "ENOSPC";
        throw error;
      })(),
    }),
  });

  try {
    await assert.rejects(
      () => installer.install({ assetId: "small", source: "official", operationId: "disk-full" }),
      (error) =>
        error?.code === "DISK_FULL" &&
        error?.retryable === true &&
        !String(error.message).includes("private"),
    );
    const registry = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
    assert.equal((await registry.getCapabilityStatus()).model.installState, "not_installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual import obtains its path from the trusted dialog boundary and publishes exact bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-manual-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const selectedFile = join(root, "user-selected-model.bin");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  writeFileSync(selectedFile, modelBytes);
  let dialogRequest = null;
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async () => {
      throw new Error("manual import must not use the network");
    },
    selectImportFile: async (request) => {
      dialogRequest = request;
      return { canceled: false, filePath: selectedFile };
    },
  });

  try {
    const result = await installer.importModel({ assetId: "small", operationId: "manual-1" });
    assert.equal(result.installState, "ready");
    assert.equal(result.source, "manual");
    assert.deepEqual(dialogRequest, { assetId: "small", extensions: ["bin"] });
    assert.equal(JSON.stringify(result).includes(selectedFile), false);
    const registry = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
    assert.equal((await registry.getCapabilityStatus()).model.installState, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation removes stale writer state and preserves a valid resumable partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-reconcile-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  const stagingRoot = join(appOwnedRoot, "staging", "models", "small");
  mkdirSync(trustedNoticeRoot, { recursive: true });
  mkdirSync(join(appOwnedRoot, "locks"), { recursive: true });
  mkdirSync(join(stagingRoot, "publish-abandoned"), { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  writeFileSync(join(appOwnedRoot, "locks", "small.lock"), JSON.stringify({ pid: 999999, operationId: "dead" }));
  writeFileSync(join(stagingRoot, "download.partial"), modelBytes.subarray(0, 5));
  writeFileSync(
    join(stagingRoot, "download.meta.json"),
    JSON.stringify({
      sourceUrl: manifest.model.sourceUrl,
      sizeBytes: modelBytes.length,
      sha256: sha256(modelBytes),
      etag: '"reconcile-v1"',
      receivedBytes: 5,
    }),
  );
  writeFileSync(join(stagingRoot, "download.meta.json.tmp"), "abandoned-metadata-write");
  let request = null;
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    isProcessAlive: () => false,
    openDownload: async (input) => {
      request = input;
      return {
        status: 206,
        headers: {
          etag: '"reconcile-v1"',
          "content-range": `bytes 5-${modelBytes.length - 1}/${modelBytes.length}`,
        },
        body: (async function* () { yield modelBytes.subarray(5); })(),
      };
    },
  });

  try {
    assert.deepEqual(await installer.reconcile(), {
      staleLocksRemoved: 1,
      abandonedPublishesRemoved: 1,
      resumablePartialsPreserved: 1,
    });
    assert.equal(existsSync(join(stagingRoot, "download.meta.json.tmp")), false);
    const result = await installer.install({ assetId: "small", source: "official", operationId: "after-restart" });
    assert.equal(result.installState, "ready");
    assert.deepEqual(request.headers, { Range: "bytes=5-", "If-Range": '"reconcile-v1"' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation never mutates staging owned by a live writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-live-reconcile-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  const stagingRoot = join(appOwnedRoot, "staging", "models", "small");
  const activePublish = join(stagingRoot, "publish-active", "keep.bin");
  mkdirSync(join(appOwnedRoot, "locks"), { recursive: true });
  mkdirSync(join(activePublish, ".."), { recursive: true });
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(appOwnedRoot, "locks", "small.lock"), JSON.stringify({ pid: 4242, processStartedAtMs: 1_000, operationId: "live" }));
  writeFileSync(activePublish, "keep");
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    isProcessAlive: (pid) => pid === 4242,
    getProcessStartTime: async (pid) => pid === 4242 ? 1_000 : null,
  });
  try {
    assert.deepEqual(await installer.reconcile(), {
      staleLocksRemoved: 0,
      abandonedPublishesRemoved: 0,
      resumablePartialsPreserved: 0,
    });
    assert.equal(existsSync(activePublish), true);
    assert.equal(existsSync(join(appOwnedRoot, "locks", "small.lock")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation removes a reused PID lock with the wrong process identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-pid-reuse-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const stagingRoot = join(appOwnedRoot, "staging", "models", "small");
  mkdirSync(join(appOwnedRoot, "locks"), { recursive: true });
  mkdirSync(join(stagingRoot, "publish-abandoned"), { recursive: true });
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(appOwnedRoot, "locks", "small.lock"), JSON.stringify({
    pid: 4242,
    processStartedAtMs: 1_000,
    operationId: "stale-owner",
  }));
  const installer = createModelInstaller({
    manifest: manifestFor(modelBytes, noticeBytes),
    appOwnedRoot,
    trustedNoticeRoot,
    isProcessAlive: (pid) => pid === 4242,
    getProcessStartTime: async (pid) => pid === 4242 ? 5_000 : null,
  });
  try {
    assert.deepEqual(await installer.reconcile(), {
      staleLocksRemoved: 1,
      abandonedPublishesRemoved: 1,
      resumablePartialsPreserved: 0,
    });
    assert.equal(existsSync(join(appOwnedRoot, "locks", "small.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall refuses an in-use model and never removes sibling assets or user projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-uninstall-"));
  const appOwnedRoot = join(root, "managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const selectedFile = join(root, "selected.bin");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  writeFileSync(selectedFile, modelBytes);
  let inUse = true;
  const installer = createModelInstaller({
    manifest,
    appOwnedRoot,
    trustedNoticeRoot,
    openDownload: async () => { throw new Error("not used"); },
    selectImportFile: async () => ({ canceled: false, filePath: selectedFile }),
    isAssetInUse: () => inUse,
  });

  try {
    await installer.importModel({ assetId: "small", operationId: "install-before-uninstall" });
    const sibling = join(appOwnedRoot, "models", "other-version", "keep.bin");
    const project = join(appOwnedRoot, "projects", "user-project", "keep.txt");
    mkdirSync(join(sibling, ".."), { recursive: true });
    mkdirSync(join(project, ".."), { recursive: true });
    writeFileSync(sibling, "keep");
    writeFileSync(project, "keep");

    await assert.rejects(
      () => installer.uninstall({ assetId: "small", operationId: "uninstall-blocked" }),
      (error) => error?.code === "CONFLICT" && /语音识别正在运行/.test(String(error.message)),
    );
    const registry = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
    assert.equal((await registry.getCapabilityStatus()).model.installState, "ready");

    inUse = false;
    assert.deepEqual(
      await installer.uninstall({ assetId: "small", operationId: "uninstall-ok" }),
      { assetId: "small", uninstalled: true },
    );
    assert.equal((await registry.getCapabilityStatus()).model.installState, "not_installed");
    assert.equal(existsSync(sibling), true);
    assert.equal(existsSync(project), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed-root and selected-file reparse points are rejected before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-model-reparse-"));
  const targetRoot = join(root, "real-managed");
  const appOwnedRoot = join(root, "linked-managed");
  const trustedNoticeRoot = join(root, "trusted-notices");
  const selectedDirectory = join(root, "selected-real");
  const selectedLinkDirectory = join(root, "selected-linked");
  const selectedTarget = join(selectedDirectory, "selected-target.bin");
  const selectedLink = join(selectedLinkDirectory, "selected-target.bin");
  const modelBytes = Buffer.from("exact-small-model-bytes");
  const noticeBytes = Buffer.from("OpenAI Whisper MIT notice");
  const manifest = manifestFor(modelBytes, noticeBytes);
  mkdirSync(targetRoot, { recursive: true });
  mkdirSync(selectedDirectory, { recursive: true });
  mkdirSync(trustedNoticeRoot, { recursive: true });
  writeFileSync(join(trustedNoticeRoot, "OPENAI-WHISPER-MIT.txt"), noticeBytes);
  writeFileSync(selectedTarget, modelBytes);
  symlinkSync(targetRoot, appOwnedRoot, "junction");
  symlinkSync(selectedDirectory, selectedLinkDirectory, "junction");

  try {
    for (const [managedRoot, selectedPath, operationId] of [
      [appOwnedRoot, selectedTarget, "linked-root"],
      [targetRoot, selectedLink, "linked-file"],
    ]) {
      const installer = createModelInstaller({
        manifest,
        appOwnedRoot: managedRoot,
        trustedNoticeRoot,
        openDownload: async () => { throw new Error("not used"); },
        selectImportFile: async () => ({ canceled: false, filePath: selectedPath }),
      });
      await assert.rejects(
        () => installer.importModel({ assetId: "small", operationId }),
        (error) => error?.code === "INVALID_ARTIFACT" && /reparse|managed|selection/i.test(String(error.message)),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
