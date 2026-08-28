import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SONG_CLASSIFIER_IDENTITY,
  createSongClassifierProcess,
} from "../../backend/audio/song-classifier-process.mjs";
import { createSongClassifierInstaller } from "../../backend/audio/song-classifier-installer.mjs";

async function processFixture(t, device = "cpu") {
  const root = await mkdtemp(join(tmpdir(), "song-classifier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime");
  const componentRoot = join(root, "component");
  const outputDir = join(root, "output");
  await Promise.all([mkdir(runtimeRoot), mkdir(componentRoot), mkdir(outputDir)]);
  const pythonPath = join(runtimeRoot, "python.exe");
  const sidecarPath = join(runtimeRoot, "song-classifier-sidecar.py");
  const sitePackagesPath = join(componentRoot, "site-packages");
  const modelPath = join(componentRoot, SONG_CLASSIFIER_IDENTITY.modelFileName);
  const inputPath = join(root, "input.wav");
  await mkdir(sitePackagesPath);
  await Promise.all([
    writeFile(pythonPath, "python"),
    writeFile(sidecarPath, "sidecar"),
    writeFile(modelPath, ""),
    writeFile(inputPath, Buffer.alloc(128)),
  ]);
  await truncate(modelPath, SONG_CLASSIFIER_IDENTITY.modelSizeBytes);
  return {
    root,
    inputPath,
    outputDir,
    runtime: {
      detectorId: SONG_CLASSIFIER_IDENTITY.detectorId,
      modelHash: SONG_CLASSIFIER_IDENTITY.modelSha256,
      pythonPath,
      sidecarPath,
      sitePackagesPath,
      modelPath,
      cwd: componentRoot,
      device,
    },
  };
}

test("song classifier uses one fixed offline sidecar and validates bounded output", async (t) => {
  const fixture = await processFixture(t, "cuda");
  const calls = [];
  const process = createSongClassifierProcess({
    verifyArtifact: async () => SONG_CLASSIFIER_IDENTITY.modelSha256,
    runProcess: async (spec) => {
      calls.push(spec);
      if (spec.argv.includes("--self-check")) {
        return { stdout: Buffer.from(JSON.stringify({
          ok: true,
          detector: SONG_CLASSIFIER_IDENTITY.detectorId,
          h5py: SONG_CLASSIFIER_IDENTITY.h5pyVersion,
        })) };
      }
      await writeFile(join(fixture.outputDir, "filtered.wav"), Buffer.alloc(320));
      await writeFile(join(fixture.outputDir, "classification.json"), JSON.stringify({
        schemaVersion: 1,
        detector: SONG_CLASSIFIER_IDENTITY.detectorId,
        modelHash: SONG_CLASSIFIER_IDENTITY.modelSha256,
        device: "cuda",
        durationMs: 9_990,
        filteredIntervals: [{ startMs: 1_000, endMs: 3_000 }],
        uncertainIntervals: [{ startMs: 5_000, endMs: 6_000 }],
      }));
      return { stdout: Buffer.from('{"type":"progress","progress":50}\n') };
    },
  });
  assert.equal((await process.probe({ operationId: "probe", runtime: fixture.runtime })).available, true);
  const progress = [];
  const result = await process.classify({
    operationId: "classify",
    runtime: fixture.runtime,
    inputPath: fixture.inputPath,
    outputDir: fixture.outputDir,
    mediaDurationMs: 10_000,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result.filteredIntervals, [{ startMs: 1_000, endMs: 3_000 }]);
  assert.deepEqual(result.uncertainIntervals, [{ startMs: 5_000, endMs: 6_000 }]);
  assert.deepEqual(progress, [50]);
  const call = calls[1];
  assert.equal(call.absoluteExe, fixture.runtime.pythonPath);
  assert.equal(call.shell, false);
  assert.equal(call.truncateStderr, true);
  assert.equal(call.envOverrides.HF_HUB_OFFLINE, "1");
  assert.equal(call.argv.includes("--chunk-seconds"), true);
  assert.equal(call.argv.includes("600"), true);
});

test("song classifier rejects identity changes and maps CUDA failures without leaking paths", async (t) => {
  const fixture = await processFixture(t, "cuda");
  let calls = 0;
  const invalid = createSongClassifierProcess({
    verifyArtifact: async () => "0".repeat(64),
    runProcess: async () => { calls += 1; },
  });
  await assert.rejects(
    () => invalid.probe({ operationId: "invalid", runtime: fixture.runtime }),
    (error) => error?.code === "INVALID_ARTIFACT",
  );
  assert.equal(calls, 0);

  const failed = createSongClassifierProcess({
    verifyArtifact: async () => SONG_CLASSIFIER_IDENTITY.modelSha256,
    runProcess: async () => { const error = new Error(fixture.inputPath); error.code = "PROCESS_FAILED"; throw error; },
  });
  await assert.rejects(
    () => failed.probe({ operationId: "cuda-failed", runtime: fixture.runtime }),
    (error) => error?.code === "CUDA_INITIALIZATION_FAILED" && !error.message.includes(fixture.inputPath),
  );
});

test("optional classifier installer downloads a pinned model into an isolated component", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "song-classifier-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeId = "qwen3-asr-transformers-cu128-x64";
  const scripts = join(root, "runtimes", runtimeId, "venv", "Scripts");
  const tools = join(root, "runtimes", runtimeId, "tools");
  await Promise.all([mkdir(scripts, { recursive: true }), mkdir(tools, { recursive: true })]);
  const pythonPath = join(scripts, "python.exe");
  const uvPath = join(tools, "uv.exe");
  const sidecarPath = join(root, "sidecar.py");
  await Promise.all([writeFile(pythonPath, "python"), writeFile(uvPath, "uv"), writeFile(sidecarPath, "sidecar")]);
  const calls = [];
  const installer = createSongClassifierInstaller({
    appOwnedRoot: root,
    qwenRuntimeId: runtimeId,
    sidecarPath,
    openDownload: async () => ({
      status: 200,
      body: (async function* () { yield Buffer.alloc(SONG_CLASSIFIER_IDENTITY.modelSizeBytes); })(),
    }),
    runProcess: async (spec) => { calls.push(spec); return { stdout: Buffer.alloc(0) }; },
    verifyArtifact: async () => SONG_CLASSIFIER_IDENTITY.modelSha256,
  });
  assert.equal((await installer.getStatus()).installState, "not_installed");
  const installed = await installer.install({
    assetId: SONG_CLASSIFIER_IDENTITY.modelId,
    source: "official",
    operationId: "install",
  });
  assert.equal(installed.installState, "ready");
  assert.equal((await installer.getStatus()).installState, "ready");
  assert.equal(calls[0].absoluteExe, uvPath);
  assert.deepEqual(calls[0].argv.slice(0, 5), ["pip", "install", "--python", pythonPath, "--target"]);
  assert.equal(calls[1].absoluteExe, pythonPath);
  assert.match(await readFile(join(root, "auxiliary", SONG_CLASSIFIER_IDENTITY.modelId, ".ready.json"), "utf8"), /ina-speech-music-noise-v1/);
  assert.equal((await installer.uninstall({ assetId: SONG_CLASSIFIER_IDENTITY.modelId, operationId: "uninstall" })).uninstalled, true);
});
