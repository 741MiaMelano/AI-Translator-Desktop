import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAsrRuntimePort, validateAsrManifest } from "../../backend/asr/runtime-registry.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureManifest() {
  const exe = Buffer.from("synthetic-whisper-cli");
  const dll = Buffer.from("synthetic-whisper-dll");
  const runtimeNotice = Buffer.from("whisper.cpp MIT notice");
  const model = Buffer.from("synthetic-small-model");
  const modelNotice = Buffer.from("OpenAI Whisper MIT notice");
  return {
    schemaVersion: 1,
    engine: {
      id: "whisper.cpp",
      version: "1.9.1",
      tagCommit: "f049fff95a089aa9969deb009cdd4892b3e74916",
    },
    runtime: {
      id: "whisper-cpp-cpu-x64",
      version: "1.9.1",
      platform: "win32",
      arch: "x64",
      executable: "whisper-cli.exe",
      archive: {
        fileName: "synthetic-cpu.zip",
        sizeBytes: 64,
        sha256: "1".repeat(64),
        sourceUrl: "https://example.invalid/synthetic-cpu.zip",
        entryPrefix: "Release/",
        ignoredEntries: [{ archivePath: "Release/bench.exe", sizeBytes: 12 }],
      },
      files: [
        { relativePath: "whisper-cli.exe", role: "executable", sizeBytes: exe.length, sha256: sha256(exe) },
        { relativePath: "whisper.dll", role: "library", sizeBytes: dll.length, sha256: sha256(dll) },
        { relativePath: "licenses/WHISPER-CPP-MIT.txt", role: "notice", sizeBytes: runtimeNotice.length, sha256: sha256(runtimeNotice) },
      ],
    },
    model: {
      id: "small",
      version: "5359861c739e955e79d9a303bcbc70fb988958b1",
      compatibleEngineVersion: "1.9.1",
      modelHash: sha256(model),
      files: [
        { relativePath: "ggml-small.bin", role: "model", sizeBytes: model.length, sha256: sha256(model) },
        { relativePath: "licenses/OPENAI-WHISPER-MIT.txt", role: "notice", sizeBytes: modelNotice.length, sha256: sha256(modelNotice) },
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

function multiModelManifest() {
  const manifest = fixtureManifest();
  const turbo = Buffer.from("synthetic-turbo-q5-model");
  const notice = Buffer.from("OpenAI Whisper MIT notice");
  const revision = manifest.model.version;
  const small = {
    ...manifest.model,
    ...catalogFields({ displayName: "Small", family: "small", variant: "full", quantization: "none" }),
    repository: "ggerganov/whisper.cpp",
    sourceUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${revision}/ggml-small.bin`,
    mirrorUrl: `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/${revision}/ggml-small.bin`,
  };
  const turboQ5 = {
    ...small,
    ...catalogFields({ displayName: "Large V3 Turbo Q5_0", family: "large-v3-turbo", variant: "q5_0", quantization: "q5_0" }),
    id: "large-v3-turbo-q5_0",
    modelHash: sha256(turbo),
    sourceUrl: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${revision}/ggml-large-v3-turbo-q5_0.bin`,
    mirrorUrl: `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/${revision}/ggml-large-v3-turbo-q5_0.bin`,
    files: [
      { relativePath: "ggml-large-v3-turbo-q5_0.bin", role: "model", sizeBytes: turbo.length, sha256: sha256(turbo) },
      { relativePath: "licenses/OPENAI-WHISPER-MIT.txt", role: "notice", sizeBytes: notice.length, sha256: sha256(notice) },
    ],
  };
  manifest.schemaVersion = 2;
  manifest.models = [small, turboQ5];
  delete manifest.model;
  return { manifest, turbo, notice };
}

function vadManifest() {
  const { manifest } = multiModelManifest();
  const tool = Buffer.from("synthetic-vad-segmenter");
  const model = Buffer.from("synthetic-silero-vad-model");
  const notice = Buffer.from("Silero VAD MIT notice");
  manifest.schemaVersion = 3;
  manifest.runtime.vadExecutable = "whisper-vad-speech-segments.exe";
  manifest.runtime.files.splice(1, 0, {
    relativePath: manifest.runtime.vadExecutable,
    role: "vad-executable",
    sizeBytes: tool.length,
    sha256: sha256(tool),
  });
  manifest.vadModel = {
    id: "silero-vad-v6.2.0",
    displayName: "Silero VAD v6.2.0",
    version: "6.2.0",
    sourceRevision: "9ffd54a1e1ee413ddf265af9913beaf518d1639b",
    compatibleEngineVersion: "1.9.1",
    modelHash: sha256(model),
    repository: "ggml-org/whisper-vad",
    sourceUrl: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
    license: "MIT",
    licenseUrl: "https://github.com/snakers4/silero-vad/blob/76e3dc408eb2a5c655c34e230d2d5459b4439daa/LICENSE",
    files: [
      { relativePath: "ggml-silero-v6.2.0.bin", role: "vad-model", sizeBytes: model.length, sha256: sha256(model) },
      { relativePath: "licenses/SILERO-VAD-MIT.txt", role: "notice", sizeBytes: notice.length, sha256: sha256(notice) },
    ],
  };
  return { manifest, tool, model, notice };
}

function writeFile(root, relativePath, bytes) {
  const absolute = join(root, ...relativePath.split("/"));
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, bytes);
}

function writeValidAssets(appOwnedRoot) {
  const runtimeRoot = join(appOwnedRoot, "runtimes", "whisper-cpp-cpu-x64");
  const modelRoot = join(appOwnedRoot, "models", "small");
  writeFile(runtimeRoot, "whisper-cli.exe", Buffer.from("synthetic-whisper-cli"));
  writeFile(runtimeRoot, "whisper.dll", Buffer.from("synthetic-whisper-dll"));
  writeFile(runtimeRoot, "licenses/WHISPER-CPP-MIT.txt", Buffer.from("whisper.cpp MIT notice"));
  writeFile(modelRoot, "ggml-small.bin", Buffer.from("synthetic-small-model"));
  writeFile(modelRoot, "licenses/OPENAI-WHISPER-MIT.txt", Buffer.from("OpenAI Whisper MIT notice"));
}

test("capability reports missing runtime and model without exposing managed paths", async () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-missing-"));
  try {
    const port = createAsrRuntimePort({
      manifest: fixtureManifest(),
      appOwnedRoot,
      platform: "win32",
      arch: "x64",
    });

    const status = await port.getCapabilityStatus();
    const { models, ...legacyStatus } = status;
    assert.deepEqual(legacyStatus, {
      engineId: "whisper.cpp",
      engineVersion: "1.9.1",
      runtime: {
        id: "whisper-cpp-cpu-x64",
        version: "1.9.1",
        installState: "not_installed",
        reason: "missing",
      },
      model: {
        id: "small",
        version: "5359861c739e955e79d9a303bcbc70fb988958b1",
        modelHash: fixtureManifest().model.modelHash,
        installState: "not_installed",
        reason: "missing",
      },
      optionalRuntimes: [],
      ready: false,
    });
    assert.deepEqual(models.map(({ id, installState }) => ({ id, installState })), [
      { id: "small", installState: "not_installed" },
    ]);
    assert.equal(JSON.stringify(status).includes(appOwnedRoot), false);
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("capability becomes ready only for the exact compatible runtime and model trees", async () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-ready-"));
  try {
    writeValidAssets(appOwnedRoot);
    const port = createAsrRuntimePort({
      manifest: fixtureManifest(),
      appOwnedRoot,
      platform: "win32",
      arch: "x64",
    });

    const status = await port.getCapabilityStatus();
    assert.equal(status.runtime.installState, "ready");
    assert.equal(status.model.installState, "ready");
    assert.equal(status.runtime.reason, undefined);
    assert.equal(status.model.reason, undefined);
    assert.equal(status.ready, true);
    const modelPath = join(appOwnedRoot, "models", "small", "ggml-small.bin");
    writeFileSync(modelPath, Buffer.from("corrupted-model-bytes"));
    utimesSync(modelPath, new Date(), new Date(Date.now() + 2_000));
    assert.equal((await port.getCapabilityStatus()).model.reason, "hash_mismatch");
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("VAD is a separately verified auxiliary resource and never appears in the ASR model catalog", async () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-vad-"));
  const { manifest, tool, model, notice } = vadManifest();
  try {
    writeValidAssets(appOwnedRoot);
    writeFile(join(appOwnedRoot, "runtimes", "whisper-cpp-cpu-x64"), "whisper-vad-speech-segments.exe", tool);
    const port = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
    let status = await port.getCapabilityStatus();
    assert.equal(status.ready, true, "the rc.4-compatible core remains usable with VAD off");
    assert.deepEqual(status.vadModel, {
      id: "silero-vad-v6.2.0",
      displayName: "Silero VAD v6.2.0",
      version: "6.2.0",
      modelHash: sha256(model),
      sizeBytes: model.length,
      license: "MIT",
      installState: "not_installed",
      reason: "missing",
    });
    assert.equal(status.models.some(({ id }) => id === "silero-vad-v6.2.0"), false);

    const vadRoot = join(appOwnedRoot, "auxiliary", "silero-vad-v6.2.0");
    writeFile(vadRoot, "ggml-silero-v6.2.0.bin", model);
    writeFile(vadRoot, "licenses/SILERO-VAD-MIT.txt", notice);
    status = await port.getCapabilityStatus();
    assert.equal(status.vadModel.installState, "ready");
    assert.equal(JSON.stringify(status).includes(appOwnedRoot), false);
    const runtime = await port.resolveReadyRuntime("cpu", "small");
    assert.equal(runtime.vadModelPath, join(vadRoot, "ggml-silero-v6.2.0.bin"));
    assert.equal(runtime.vadModelHash, sha256(model));
    const vadRuntime = await port.resolveReadyVadRuntime();
    assert.equal(vadRuntime.vadExecutablePath, join(appOwnedRoot, "runtimes", "whisper-cpp-cpu-x64", "whisper-vad-speech-segments.exe"));
    assert.equal(vadRuntime.vadModelPath, join(vadRoot, "ggml-silero-v6.2.0.bin"));

    writeFileSync(join(vadRoot, "ggml-silero-v6.2.0.bin"), "corrupt");
    status = await port.getCapabilityStatus();
    assert.equal(status.vadModel.installState, "corrupt");
    assert.equal(Object.hasOwn(await port.resolveReadyRuntime("cpu", "small"), "vadModelPath"), false);
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("packaged bundled CPU runtime is verified independently from the managed model root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "asr-registry-bundled-"));
  const appOwnedRoot = join(parent, "managed");
  const bundledRuntimeRoot = join(parent, "resources", "asr", "runtime", "whisper-cpp-cpu-x64");
  try {
    writeValidAssets(appOwnedRoot);
    rmSync(join(appOwnedRoot, "runtimes"), { recursive: true, force: true });
    writeFile(bundledRuntimeRoot, "whisper-cli.exe", Buffer.from("synthetic-whisper-cli"));
    writeFile(bundledRuntimeRoot, "whisper.dll", Buffer.from("synthetic-whisper-dll"));
    writeFile(bundledRuntimeRoot, "licenses/WHISPER-CPP-MIT.txt", Buffer.from("whisper.cpp MIT notice"));
    const port = createAsrRuntimePort({
      manifest: fixtureManifest(),
      appOwnedRoot,
      bundledRuntimeRoot,
      platform: "win32",
      arch: "x64",
    });
    assert.equal((await port.getCapabilityStatus()).ready, true);
    const resolved = await port.resolveReadyRuntime("cpu");
    assert.equal(resolved.cwd, bundledRuntimeRoot);
    assert.equal(resolved.executablePath, join(bundledRuntimeRoot, "whisper-cli.exe"));
    assert.equal(resolved.modelPath, join(appOwnedRoot, "models", "small", "ggml-small.bin"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runtime-only probe resolution does not require a downloaded model", async () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-probe-only-"));
  try {
    writeValidAssets(appOwnedRoot);
    rmSync(join(appOwnedRoot, "models", "small"), { recursive: true, force: true });
    const port = createAsrRuntimePort({
      manifest: fixtureManifest(),
      appOwnedRoot,
      platform: "win32",
      arch: "x64",
    });
    const probe = await port.resolveReadyRuntimeForProbe("cpu");
    assert.equal(probe.device, "cpu");
    assert.equal(probe.runtimeId, "whisper-cpp-cpu-x64");
    assert.equal(Object.hasOwn(probe, "modelPath"), false);
    await assert.rejects(
      () => port.resolveReadyRuntime("cpu"),
      (error) => error?.code === "NOT_AVAILABLE" && /model/i.test(String(error.message)),
    );
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("trusted manifest requires compliance notices for both runtime and model", () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-notices-"));
  try {
    const manifest = fixtureManifest();
    manifest.runtime.files = manifest.runtime.files.filter((entry) => entry.role !== "notice");
    assert.throws(
      () => createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" }),
      (error) => error?.code === "INVALID_ARTIFACT" && /notice/i.test(String(error.message)),
    );

    const second = fixtureManifest();
    second.model.files = second.model.files.filter((entry) => entry.role !== "notice");
    assert.throws(
      () => createAsrRuntimePort({ manifest: second, appOwnedRoot, platform: "win32", arch: "x64" }),
      (error) => error?.code === "INVALID_ARTIFACT" && /notice/i.test(String(error.message)),
    );
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("trusted manifest accepts only one executable and bounded file roles", () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-roles-"));
  try {
    const extraExecutable = fixtureManifest();
    extraExecutable.runtime.files.push({
      ...extraExecutable.runtime.files[0],
      relativePath: "second-tool.exe",
    });
    assert.throws(
      () => createAsrRuntimePort({ manifest: extraExecutable, appOwnedRoot, platform: "win32", arch: "x64" }),
      (error) => error?.code === "INVALID_ARTIFACT" && /executable|role/i.test(String(error.message)),
    );

    const arbitraryRole = fixtureManifest();
    arbitraryRole.runtime.files[1].role = "plugin";
    assert.throws(
      () => createAsrRuntimePort({ manifest: arbitraryRole, appOwnedRoot, platform: "win32", arch: "x64" }),
      (error) => error?.code === "INVALID_ARTIFACT" && /role/i.test(String(error.message)),
    );
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("registry refuses a second engine or model outside the accepted ADR", () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-engine-"));
  try {
    const otherEngine = fixtureManifest();
    otherEngine.engine.id = "faster-whisper";
    assert.throws(
      () => createAsrRuntimePort({ manifest: otherEngine, appOwnedRoot, platform: "win32", arch: "x64" }),
      (error) => error?.code === "INVALID_ARTIFACT" && /engine|whisper\.cpp/i.test(String(error.message)),
    );

    const otherModel = fixtureManifest();
    otherModel.model.id = "medium";
    assert.throws(
      () => createAsrRuntimePort({ manifest: otherModel, appOwnedRoot, platform: "win32", arch: "x64" }),
      (error) => error?.code === "INVALID_ARTIFACT" && /model|small/i.test(String(error.message)),
    );
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("internal runtime resolution re-verifies exact bytes and fails closed after tampering", async () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-resolve-"));
  try {
    writeValidAssets(appOwnedRoot);
    const port = createAsrRuntimePort({
      manifest: fixtureManifest(),
      appOwnedRoot,
      platform: "win32",
      arch: "x64",
    });

    const resolved = await port.resolveReadyRuntime();
    assert.equal(resolved.executablePath, join(appOwnedRoot, "runtimes", "whisper-cpp-cpu-x64", "whisper-cli.exe"));
    assert.equal(resolved.modelPath, join(appOwnedRoot, "models", "small", "ggml-small.bin"));
    assert.equal(resolved.cwd, join(appOwnedRoot, "runtimes", "whisper-cpp-cpu-x64"));
    assert.equal(resolved.engineId, "whisper.cpp");
    assert.equal(resolved.engineVersion, "1.9.1");

    writeFileSync(resolved.executablePath, Buffer.from("tampered-whisper-cli!"));
    await assert.rejects(
      () => port.resolveReadyRuntime(),
      (error) => error?.code === "INVALID_ARTIFACT" && /runtime.*hash_mismatch/i.test(String(error.message)),
    );
    const status = await port.getCapabilityStatus();
    assert.equal(status.runtime.installState, "corrupt");
    assert.equal(status.runtime.reason, "hash_mismatch");
    assert.equal(status.ready, false);
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("managed root reparse points never become ready", async () => {
  const parent = mkdtempSync(join(tmpdir(), "asr-registry-reparse-"));
  const targetRoot = join(parent, "target");
  const linkedRoot = join(parent, "managed");
  try {
    mkdirSync(targetRoot, { recursive: true });
    symlinkSync(targetRoot, linkedRoot, "junction");
    writeValidAssets(linkedRoot);
    const port = createAsrRuntimePort({
      manifest: fixtureManifest(),
      appOwnedRoot: linkedRoot,
      platform: "win32",
      arch: "x64",
    });

    const status = await port.getCapabilityStatus();
    assert.equal(status.runtime.installState, "corrupt");
    assert.equal(status.model.installState, "corrupt");
    assert.equal(status.runtime.reason, "reparse_root");
    assert.equal(status.model.reason, "reparse_root");
    assert.equal(status.ready, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("optional CUDA runtime has an independent verified state and does not block CPU readiness", async () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-cuda-"));
  try {
    const manifest = fixtureManifest();
    const cudaExe = Buffer.from("synthetic-cuda-whisper-cli");
    const cudaDll = Buffer.from("synthetic-cuda-library");
    const cudaNotice = Buffer.from("CUDA 12.4 redistribution notice");
    manifest.optionalRuntimes = [
      {
        id: "whisper-cpp-cuda-12.4-x64",
        version: "1.9.1",
        device: "cuda",
        platform: "win32",
        arch: "x64",
        executable: "whisper-cli.exe",
        archive: {
          fileName: "synthetic-cuda.zip",
          sizeBytes: 64,
          sha256: "0".repeat(64),
          sourceUrl: "https://example.invalid/synthetic-cuda.zip",
          entryPrefix: "Release/",
          ignoredEntries: [
            { archivePath: "Release/bench.exe", sizeBytes: 12 },
          ],
        },
        files: [
          { relativePath: "whisper-cli.exe", role: "executable", sizeBytes: cudaExe.length, sha256: sha256(cudaExe) },
          { relativePath: "ggml-cuda.dll", role: "library", sizeBytes: cudaDll.length, sha256: sha256(cudaDll) },
          { relativePath: "licenses/NVIDIA-CUDA-12.4-NOTICE.txt", role: "notice", sizeBytes: cudaNotice.length, sha256: sha256(cudaNotice) },
        ],
      },
    ];
    writeValidAssets(appOwnedRoot);
    const port = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });

    const normalized = validateAsrManifest(manifest);
    assert.deepEqual(normalized.optionalRuntimes[0].archive, manifest.optionalRuntimes[0].archive);

    let status = await port.getCapabilityStatus();
    assert.equal(status.ready, true);
    assert.deepEqual(status.optionalRuntimes, [
      {
        id: "whisper-cpp-cuda-12.4-x64",
        version: "1.9.1",
        device: "cuda",
        installState: "not_installed",
        reason: "missing",
      },
    ]);

    const cudaRoot = join(appOwnedRoot, "runtimes", "whisper-cpp-cuda-12.4-x64");
    writeFile(cudaRoot, "whisper-cli.exe", cudaExe);
    writeFile(cudaRoot, "ggml-cuda.dll", cudaDll);
    writeFile(cudaRoot, "licenses/NVIDIA-CUDA-12.4-NOTICE.txt", cudaNotice);
    status = await port.getCapabilityStatus();
    assert.equal(status.optionalRuntimes[0].installState, "ready");
    const resolved = await port.resolveReadyRuntime("cuda");
    assert.equal(resolved.device, "cuda");
    assert.equal(resolved.runtimeId, "whisper-cpp-cuda-12.4-x64");
    assert.equal(resolved.executablePath, join(cudaRoot, "whisper-cli.exe"));
    assert.equal(resolved.modelPath, join(appOwnedRoot, "models", "small", "ggml-small.bin"));
    await assert.rejects(
      () => port.resolveReadyRuntime("--gpu=0"),
      (error) => error?.code === "INVALID_INPUT",
    );
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("schema v2 registers independent model variants while preserving Small compatibility", async () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-models-"));
  const { manifest, turbo, notice } = multiModelManifest();
  try {
    writeValidAssets(appOwnedRoot);
    const normalized = validateAsrManifest(manifest);
    assert.deepEqual(normalized.models.map((model) => model.id), ["small", "large-v3-turbo-q5_0"]);
    assert.equal(normalized.model.id, "small");

    const port = createAsrRuntimePort({ manifest, appOwnedRoot, platform: "win32", arch: "x64" });
    let status = await port.getCapabilityStatus();
    assert.equal(status.model.id, "small");
    assert.equal(status.model.installState, "ready");
    assert.deepEqual(status.models.map(({ id, installState }) => ({ id, installState })), [
      { id: "small", installState: "ready" },
      { id: "large-v3-turbo-q5_0", installState: "not_installed" },
    ]);
    assert.equal(status.ready, true);
    await assert.rejects(
      () => port.resolveReadyRuntime("cpu", "large-v3-turbo-q5_0"),
      (error) => error?.code === "NOT_AVAILABLE" && /model/i.test(error.message),
    );

    const turboRoot = join(appOwnedRoot, "models", "large-v3-turbo-q5_0");
    writeFile(turboRoot, "ggml-large-v3-turbo-q5_0.bin", turbo);
    writeFile(turboRoot, "licenses/OPENAI-WHISPER-MIT.txt", notice);
    status = await port.getCapabilityStatus();
    assert.equal(status.models[1].installState, "ready");
    const resolved = await port.resolveReadyRuntime("cpu", "large-v3-turbo-q5_0");
    assert.equal(resolved.modelId, "large-v3-turbo-q5_0");
    assert.equal(resolved.modelPath, join(turboRoot, "ggml-large-v3-turbo-q5_0.bin"));
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});

test("schema v2 rejects duplicate model ids before they can share managed paths", () => {
  const { manifest } = multiModelManifest();
  manifest.models[1].id = "small";
  assert.throws(
    () => validateAsrManifest(manifest),
    (error) => error?.code === "INVALID_ARTIFACT" && /duplicate|unique/i.test(String(error.message)),
  );
});

test("release manifest is the accepted one-engine multi-model inventory", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../../docs/third-party/asr/manifest.json", import.meta.url), "utf8"),
  );
  const evidence = JSON.parse(
    readFileSync(
      new URL("../../docs/third-party/asr/runtime-files.json", import.meta.url),
      "utf8",
    ),
  ).selected;
  const manifest = validateAsrManifest(raw);
  assert.equal(manifest.engine.id, "whisper.cpp");
  assert.equal(manifest.engine.version, "1.9.1");
  assert.equal(manifest.runtime.files.length, 15);
  assert.equal(manifest.runtime.vadExecutable, "whisper-vad-speech-segments.exe");
  assert.equal(manifest.runtime.archive.entryPrefix, "Release/");
  assert.equal(manifest.runtime.archive.ignoredEntries.length, 23);
  assert.equal(manifest.optionalRuntimes.length, 1);
  assert.equal(manifest.optionalRuntimes[0].files.length, 22);
  assert.equal(manifest.optionalRuntimes[0].archive.entryPrefix, "Release/");
  assert.equal(manifest.optionalRuntimes[0].archive.ignoredEntries.length, 24);
  assert.deepEqual(manifest.models.map((model) => model.id), [
    "small",
    "large-v3-turbo-q5_0",
    "large-v3-turbo-q8_0",
    "large-v3-turbo",
    "large-v3-q5_0",
    "large-v3",
  ]);
  assert.equal(manifest.model.id, "small");
  assert.ok(manifest.models.every((model) => model.files.length === 2));
  assert.ok(manifest.models.every((model) => model.sourceUrl.includes(`/${model.version}/`)));
  assert.ok(manifest.models.every((model) => model.mirrorUrl.includes(`/${model.version}/`)));
  assert.ok(manifest.models.every((model) => model.modelHash === model.files.find((entry) => entry.role === "model").sha256));
  const project = (entries) =>
    entries
      .filter((entry) => entry.role !== "notice")
      .map((entry) => ({ path: entry.relativePath, size: entry.sizeBytes, sha256: entry.sha256 }));
  assert.deepEqual(project(manifest.runtime.files), evidence.cpuRuntime.selectedFiles);
  assert.deepEqual(project(manifest.optionalRuntimes[0].files), evidence.cudaRuntime.selectedFiles);
  assert.deepEqual(
    manifest.models.map((model) => ({ id: model.id, files: project(model.files) })),
    evidence.models.map((model) => ({ id: model.id, files: model.files })),
  );
  assert.deepEqual(project(manifest.vadModel.files), evidence.vadModel.files);
  assert.equal(manifest.vadModel.sourceRevision, evidence.vadModel.revision);
  assert.equal(manifest.vadModel.modelHash, evidence.vadModel.files[0].sha256);
});

test("missing extra and incompatible assets have distinct stable states", async () => {
  const appOwnedRoot = mkdtempSync(join(tmpdir(), "asr-registry-states-"));
  try {
    writeValidAssets(appOwnedRoot);
    const runtimeRoot = join(appOwnedRoot, "runtimes", "whisper-cpp-cpu-x64");
    rmSync(join(runtimeRoot, "whisper.dll"));
    let port = createAsrRuntimePort({ manifest: fixtureManifest(), appOwnedRoot, platform: "win32", arch: "x64" });
    let status = await port.getCapabilityStatus();
    assert.equal(status.runtime.installState, "corrupt");
    assert.equal(status.runtime.reason, "missing_file");

    writeFile(runtimeRoot, "whisper.dll", Buffer.from("synthetic-whisper-dll"));
    writeFile(runtimeRoot, "undeclared.exe", Buffer.from("unexpected"));
    status = await port.getCapabilityStatus();
    assert.equal(status.runtime.installState, "corrupt");
    assert.equal(status.runtime.reason, "undeclared_file");

    port = createAsrRuntimePort({ manifest: fixtureManifest(), appOwnedRoot, platform: "win32", arch: "arm64" });
    status = await port.getCapabilityStatus();
    assert.equal(status.runtime.installState, "incompatible");
    assert.equal(status.runtime.reason, "runtime_incompatible");

    const modelMismatch = fixtureManifest();
    modelMismatch.model.compatibleEngineVersion = "1.8.0";
    port = createAsrRuntimePort({ manifest: modelMismatch, appOwnedRoot, platform: "win32", arch: "x64" });
    status = await port.getCapabilityStatus();
    assert.equal(status.model.installState, "incompatible");
    assert.equal(status.model.reason, "model_incompatible");
  } finally {
    rmSync(appOwnedRoot, { recursive: true, force: true });
  }
});
