import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  VOCAL_SEPARATION_IDENTITY,
  buildVocalSeparationArgv,
  createVocalSeparationProcess,
} from "../../backend/audio/vocal-separation-process.mjs";

async function fixture(t, device = "cpu") {
  const root = await mkdtemp(join(tmpdir(), "vocal-separation-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = join(root, "runtime");
  const ffmpegDir = join(root, "ffmpeg");
  const modelDir = join(root, "model");
  const workDir = join(root, "work");
  const outputDir = join(root, "output");
  await Promise.all([
    mkdir(runtimeDir),
    mkdir(ffmpegDir),
    mkdir(modelDir),
    mkdir(workDir),
    mkdir(outputDir),
  ]);
  const executablePath = join(runtimeDir, "audio-separator.exe");
  const ffmpegPath = join(ffmpegDir, "ffmpeg.exe");
  const modelPath = join(modelDir, VOCAL_SEPARATION_IDENTITY.modelFileName);
  const configPath = join(modelDir, VOCAL_SEPARATION_IDENTITY.configFileName);
  const inputPath = join(workDir, "input.wav");
  await Promise.all([
    writeFile(executablePath, Buffer.from("exe")),
    writeFile(ffmpegPath, Buffer.from("exe")),
    writeFile(modelPath, Buffer.alloc(0)),
    writeFile(configPath, Buffer.alloc(VOCAL_SEPARATION_IDENTITY.configSizeBytes)),
    writeFile(inputPath, Buffer.alloc(128)),
  ]);
  await truncate(modelPath, VOCAL_SEPARATION_IDENTITY.modelSizeBytes);
  return {
    root,
    inputPath,
    outputDir,
    runtime: {
      engineId: VOCAL_SEPARATION_IDENTITY.engineId,
      engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
      executablePath,
      cwd: runtimeDir,
      ffmpegPath,
      modelId: VOCAL_SEPARATION_IDENTITY.modelId,
      modelRevision: VOCAL_SEPARATION_IDENTITY.modelRevision,
      modelHash: VOCAL_SEPARATION_IDENTITY.modelSha256,
      modelSizeBytes: VOCAL_SEPARATION_IDENTITY.modelSizeBytes,
      modelDir,
      modelPath,
      configHash: VOCAL_SEPARATION_IDENTITY.configSha256,
      configSizeBytes: VOCAL_SEPARATION_IDENTITY.configSizeBytes,
      configPath,
      device,
    },
  };
}

function codedError(code, message = "failed") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createFixtureProcess(options = {}) {
  return createVocalSeparationProcess({ verifyArtifact: async () => {}, ...options });
}

test("fixed argv requests one 44.1 kHz vocals stem and enables autocast only on CUDA", () => {
  const common = {
    inputPath: "C:\\tasks\\input.wav",
    outputDir: "C:\\tasks\\output",
    modelDir: "C:\\managed\\models",
    chunkDurationSeconds: 900,
  };
  const cpu = buildVocalSeparationArgv({ ...common, device: "cpu" });
  assert.deepEqual(cpu, [
    common.inputPath,
    "--model_filename", VOCAL_SEPARATION_IDENTITY.modelFileName,
    "--model_file_dir", common.modelDir,
    "--output_dir", common.outputDir,
    "--output_format", "WAV",
    "--single_stem", "Vocals",
    "--sample_rate", "44100",
    "--use_soundfile",
    "--chunk_duration", "900",
    "--custom_output_names", "{\"vocals\":\"vocals\"}",
    "--log_level", "info",
  ]);
  assert.equal(cpu.includes("--use_autocast"), false);
  assert.deepEqual(buildVocalSeparationArgv({ ...common, device: "cuda" }), [...cpu, "--use_autocast"]);
  const unchunked = buildVocalSeparationArgv({
    inputPath: common.inputPath,
    outputDir: common.outputDir,
    modelDir: common.modelDir,
    device: "cpu",
    chunkDurationSeconds: null,
  });
  assert.equal(unchunked.includes("--chunk_duration"), false);
});

test("probe and separation use the fixed local runtime without a download path", async (t) => {
  const { runtime, inputPath, outputDir } = await fixture(t);
  const calls = [];
  const artifactChecks = [];
  let clock = 1_000;
  const process = createFixtureProcess({
    now: () => (clock += 25),
    verifyArtifact: async (spec) => { artifactChecks.push(spec); },
    runProcess: async (spec) => {
      calls.push(spec);
      if (spec.argv[0] === "--version") {
        return { exitCode: 0, stdoutBase64: Buffer.from("audio-separator.exe 0.44.5\n").toString("base64"), stderrSummary: "" };
      }
      await writeFile(join(outputDir, "vocals.wav"), Buffer.alloc(256));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  assert.deepEqual(await process.probe({ operationId: "probe", runtime }), {
    available: true,
    engineId: VOCAL_SEPARATION_IDENTITY.engineId,
    engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
    modelId: VOCAL_SEPARATION_IDENTITY.modelId,
    modelRevision: VOCAL_SEPARATION_IDENTITY.modelRevision,
    device: "cpu",
  });
  const result = await process.separate({
    operationId: "separate",
    runtime,
    inputPath,
    outputDir,
    chunkDurationSeconds: 720,
    timeoutMs: 2 * 60_000,
  });
  assert.equal(result.vocalsPath, await realpath(join(outputDir, "vocals.wav")));
  assert.equal(result.processingDurationMs, 25);
  assert.equal(result.chunkDurationSeconds, 720);
  assert.equal(calls.length, 2);
  assert.equal(artifactChecks.length, 2, "model and config hashes should be verified once per unchanged process lifetime");
  assert.deepEqual(artifactChecks.map(({ expectedSha256, expectedSizeBytes }) => ({ expectedSha256, expectedSizeBytes })), [
    { expectedSha256: VOCAL_SEPARATION_IDENTITY.configSha256, expectedSizeBytes: VOCAL_SEPARATION_IDENTITY.configSizeBytes },
    { expectedSha256: VOCAL_SEPARATION_IDENTITY.modelSha256, expectedSizeBytes: VOCAL_SEPARATION_IDENTITY.modelSizeBytes },
  ]);
  const separation = calls[1];
  assert.equal(separation.absoluteExe, runtime.executablePath);
  assert.equal(separation.cwd, runtime.cwd);
  assert.equal(separation.shell, false);
  assert.equal(separation.timeoutMs, 120_000);
  assert.equal(separation.envOverrides.PATH, dirname(runtime.ffmpegPath));
  assert.equal(separation.envOverrides.CUDA_VISIBLE_DEVICES, "-1");
  assert.equal(separation.envOverrides.HF_HUB_OFFLINE, "1");
  assert.equal(separation.envOverrides.HTTPS_PROXY, "http://127.0.0.1:9");
  assert.equal(separation.argv.includes("--use_autocast"), false);
  assert.equal(separation.signal instanceof AbortSignal, true);
  const catalog = JSON.parse(await readFile(join(runtime.modelDir, "download_checks.json"), "utf8"));
  assert.deepEqual(catalog, {
    demucs_download_list: {},
    vr_download_list: {},
    mdx_download_list: {},
    mdx_download_vip_list: {},
    mdx23c_download_list: {},
    mdx23c_download_vip_list: {},
    roformer_download_list: {},
  });
});

test("runtime identity and artifact sizes are rejected before spawning", async (t) => {
  const { runtime, inputPath, outputDir } = await fixture(t);
  let calls = 0;
  const process = createFixtureProcess({ runProcess: async () => { calls += 1; } });
  await assert.rejects(
    () => process.separate({
      operationId: "bad-revision",
      runtime: { ...runtime, modelRevision: "unverified" },
      inputPath,
      outputDir,
    }),
    (error) => error?.code === "INVALID_ARTIFACT",
  );
  await writeFile(runtime.configPath, Buffer.alloc(943));
  await assert.rejects(
    () => process.separate({ operationId: "bad-size", runtime, inputPath, outputDir }),
    (error) => error?.code === "INVALID_ARTIFACT",
  );
  assert.equal(calls, 0);
});

test("a model or config hash mismatch is rejected before spawning", async (t) => {
  const { runtime } = await fixture(t);
  let calls = 0;
  const process = createFixtureProcess({
    verifyArtifact: async () => { throw codedError("INVALID_ARTIFACT", "hash mismatch"); },
    runProcess: async () => { calls += 1; },
  });
  await assert.rejects(
    () => process.probe({ operationId: "bad-hash", runtime }),
    (error) => error?.code === "INVALID_ARTIFACT" && !String(error.message).includes(runtime.modelPath),
  );
  assert.equal(calls, 0);
});

test("pre-existing or missing vocals output is rejected and only the expected output is cleaned", async (t) => {
  const first = await fixture(t);
  await writeFile(join(first.outputDir, "vocals.wav"), Buffer.alloc(128));
  let calls = 0;
  const process = createFixtureProcess({ runProcess: async () => { calls += 1; } });
  await assert.rejects(
    () => process.separate({ operationId: "conflict", runtime: first.runtime, inputPath: first.inputPath, outputDir: first.outputDir }),
    (error) => error?.code === "CONFLICT",
  );
  assert.equal(calls, 0);

  const second = await fixture(t);
  await writeFile(join(second.outputDir, "keep.txt"), "keep");
  const noOutput = createFixtureProcess({ runProcess: async () => ({ stdout: Buffer.alloc(0) }) });
  await assert.rejects(
    () => noOutput.separate({ operationId: "missing-output", runtime: second.runtime,
      inputPath: second.inputPath, outputDir: second.outputDir }),
    (error) => error?.code === "INVALID_ARTIFACT",
  );
  assert.equal(await readFile(join(second.outputDir, "keep.txt"), "utf8"), "keep");
});

test("local cancellation aborts the short-lived process and duplicate operation ids conflict", async (t) => {
  const { runtime, inputPath, outputDir } = await fixture(t);
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const process = createFixtureProcess({
    runProcess: ({ signal }) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(codedError("CANCELLED")), { once: true });
    }),
  });
  const pending = process.separate({ operationId: "cancel-local", runtime, inputPath, outputDir });
  await running;
  await assert.rejects(
    () => process.probe({ operationId: "cancel-local", runtime }),
    (error) => error?.code === "CONFLICT",
  );
  assert.deepEqual(process.cancel("cancel-local"), { cancelled: true });
  await assert.rejects(() => pending, (error) => error?.code === "CANCELLED");
  assert.deepEqual(process.cancel("cancel-local"), { cancelled: false });
});

test("cancellation during model verification never starts the separator", async (t) => {
  const { runtime } = await fixture(t);
  let started;
  const verifying = new Promise((resolve) => { started = resolve; });
  let processCalls = 0;
  const process = createFixtureProcess({
    verifyArtifact: ({ signal }) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(codedError("CANCELLED")), { once: true });
    }),
    runProcess: async () => { processCalls += 1; },
  });
  const pending = process.probe({ operationId: "cancel-hash", runtime });
  await verifying;
  assert.deepEqual(process.cancel("cancel-hash"), { cancelled: true });
  await assert.rejects(() => pending, (error) => error?.code === "CANCELLED");
  assert.equal(processCalls, 0);
});

test("external supervisor cancellation is used without serializing AbortSignal", async (t) => {
  const { runtime, inputPath, outputDir } = await fixture(t);
  let observed;
  let rejectProcess;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const cancellations = [];
  const process = createFixtureProcess({
    runProcess: (spec) => {
      observed = spec;
      started();
      return new Promise((_resolve, reject) => { rejectProcess = reject; });
    },
    cancelProcess: ({ operationId }) => {
      cancellations.push(operationId);
      rejectProcess(codedError("PROCESS_FAILED", "remote cancellation"));
      return { cancelled: true };
    },
  });
  const pending = process.separate({ operationId: "cancel-external", runtime, inputPath, outputDir });
  await running;
  assert.equal(Object.hasOwn(observed, "signal"), false);
  assert.deepEqual(process.cancel("cancel-external"), { cancelled: true });
  await assert.rejects(() => pending, (error) => error?.code === "CANCELLED");
  assert.deepEqual(cancellations, ["cancel-external"]);
});

test("timeouts and process failures have stable path-free mappings", async (t) => {
  const { runtime, inputPath, outputDir } = await fixture(t);
  const cases = [
    { operationId: "timeout", device: "cpu", source: codedError("TIMEOUT", `${inputPath} timed out`), expected: "TIMEOUT" },
    { operationId: "cuda", device: "cuda", source: codedError("PROCESS_FAILED", `${inputPath} cuda failed`), expected: "CUDA_INITIALIZATION_FAILED" },
    { operationId: "unknown", device: "cpu", source: new Error(`${inputPath} exploded`), expected: "PROCESS_FAILED" },
  ];
  for (const item of cases) {
    const process = createFixtureProcess({ runProcess: async () => { throw item.source; } });
    await assert.rejects(
      () => process.separate({ operationId: item.operationId, runtime: { ...runtime, device: item.device }, inputPath, outputDir }),
      (error) => {
        assert.equal(error?.code, item.expected);
        assert.equal(String(error?.message).includes(inputPath), false);
        return true;
      },
    );
  }
});

test("probe rejects an unexpected audio-separator version", async (t) => {
  const { runtime } = await fixture(t);
  const process = createFixtureProcess({
    runProcess: async () => ({ stdout: Buffer.from("audio-separator.exe 0.45.0") }),
  });
  await assert.rejects(
    () => process.probe({ operationId: "wrong-version", runtime }),
    (error) => error?.code === "INVALID_ARTIFACT",
  );
});
