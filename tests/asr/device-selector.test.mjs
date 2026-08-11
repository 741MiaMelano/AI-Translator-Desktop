import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAsrDeviceSelector } from "../../backend/asr/device-selector.mjs";
import { createAsrRuntimeProcess } from "../../backend/asr/runtime-process.mjs";

const CPU_ID = "whisper-cpp-cpu-x64";
const CUDA_ID = "whisper-cpp-cuda-12.4-x64";

function capabilities({ cuda = "not_installed" } = {}) {
  return {
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtime: { id: CPU_ID, version: "1.9.1", device: "cpu", installState: "ready" },
    model: { id: "small", version: "model-rev", modelHash: "a".repeat(64), installState: "ready" },
    optionalRuntimes: [{
      id: CUDA_ID,
      version: "1.9.1",
      device: "cuda",
      installState: cuda,
      ...(cuda === "ready" ? {} : { reason: "missing" }),
    }],
    ready: true,
  };
}

function runtime(device, modelId = "small") {
  return {
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtimeId: device === "cpu" ? CPU_ID : CUDA_ID,
    runtimeVersion: "1.9.1",
    device,
    executablePath: `C:\\managed-asr\\${device}\\whisper-cli.exe`,
    modelPath: `C:\\managed-asr\\models\\${modelId}\\${modelId}.bin`,
    modelId,
    modelVersion: `${modelId}-rev`,
    modelHash: (modelId === "small" ? "a" : "b").repeat(64),
    cwd: `C:\\managed-asr\\${device}`,
  };
}

test("CUDA fallback keeps the selected model on every device attempt", async () => {
  const resolved = [];
  const selector = createAsrDeviceSelector({
    getCapabilityStatus: async () => capabilities({ cuda: "ready" }),
    resolveRuntime: async (device, modelId) => {
      resolved.push({ device, modelId });
      return runtime(device, modelId);
    },
    probeRuntime: async () => ({ available: true }),
  });
  const initializationError = new Error("CUDA initialization failed");
  initializationError.code = "CUDA_INITIALIZATION_FAILED";
  const selected = await selector.run({
    operationId: "model-stable-fallback",
    modelId: "large-v3-turbo-q5_0",
    requestedDevice: "auto",
    allowCudaFallback: false,
    executeStagedAttempt: async ({ device, runtime: selectedRuntime }) => {
      assert.equal(selectedRuntime.modelId, "large-v3-turbo-q5_0");
      if (device === "cuda") throw initializationError;
      return { transcript: "cpu" };
    },
  });
  assert.equal(selected.actualDevice, "cpu");
  assert.deepEqual(resolved, [
    { device: "cuda", modelId: "large-v3-turbo-q5_0" },
    { device: "cpu", modelId: "large-v3-turbo-q5_0" },
  ]);
});

function harness({ cuda = "not_installed", initialState = null } = {}) {
  let saved = initialState;
  const attempts = [];
  let active = 0;
  let maxActive = 0;
  const selector = createAsrDeviceSelector({
    getCapabilityStatus: async () => capabilities({ cuda }),
    resolveRuntime: async (device) => runtime(device),
    probeRuntime: async () => ({ available: true }),
    loadState: () => saved,
    saveState: (state) => { saved = structuredClone(state); },
    now: () => "2026-07-19T20:00:00.000Z",
  });
  return {
    selector,
    attempts,
    get saved() { return saved; },
    get maxActive() { return maxActive; },
    execute(resultByDevice) {
      return async ({ device, runtime: selectedRuntime }) => {
        attempts.push({ device, runtimeId: selectedRuntime.runtimeId });
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          const value = resultByDevice[device];
          if (value instanceof Error) throw value;
          return value;
        } finally {
          active -= 1;
        }
      };
    },
  };
}

test("auto without CUDA and explicit cpu always select the verified CPU runtime", async () => {
  for (const requestedDevice of ["auto", "cpu"]) {
    const value = harness();
    const result = await value.selector.run({
      operationId: `select-${requestedDevice}`,
      requestedDevice,
      allowCudaFallback: false,
      executeStagedAttempt: value.execute({ cpu: { transcript: "staged" } }),
    });
    assert.equal(result.requestedDevice, requestedDevice);
    assert.equal(result.actualDevice, "cpu");
    assert.equal(result.runtimeId, CPU_ID);
    assert.equal(result.runtimeVersion, "1.9.1");
    assert.equal(result.fallbackReason, requestedDevice === "auto" ? "cuda_not_ready" : null);
    assert.deepEqual(value.attempts, [{ device: "cpu", runtimeId: CPU_ID }]);
  }
});

test("auto CUDA initialization failure settles before one CPU restart and persists provenance", async () => {
  const value = harness({
    cuda: "ready",
    initialState: {
      requestedDevice: "auto",
      allowCudaFallback: false,
      actualDevice: null,
      fallbackReason: null,
      detection: {
        cpu: { status: "available", runtimeId: CPU_ID, runtimeVersion: "1.9.1" },
        cuda: { status: "available", runtimeId: CUDA_ID, runtimeVersion: "1.9.1" },
      },
      updatedAt: "2026-07-19T19:00:00.000Z",
    },
  });
  const initializationError = new Error("raw driver detail must not escape");
  initializationError.code = "CUDA_INITIALIZATION_FAILED";
  const result = await value.selector.run({
    operationId: "auto-fallback",
    requestedDevice: "auto",
    allowCudaFallback: false,
    executeStagedAttempt: value.execute({ cuda: initializationError, cpu: { transcript: "cpu-staged" } }),
  });

  assert.equal(value.maxActive, 1);
  assert.deepEqual(value.attempts, [
    { device: "cuda", runtimeId: CUDA_ID },
    { device: "cpu", runtimeId: CPU_ID },
  ]);
  assert.equal(result.actualDevice, "cpu");
  assert.equal(result.fallbackReason, "cuda_initialization_failed");
  assert.deepEqual(result.result, { transcript: "cpu-staged" });
  assert.equal(value.saved.detection.cuda.status, "unavailable");
  assert.equal(value.saved.detection.cuda.reason, "initialization_failed");

  const restarted = createAsrDeviceSelector({
    getCapabilityStatus: async () => capabilities({ cuda: "ready" }),
    resolveRuntime: async (device) => runtime(device),
    probeRuntime: async () => ({ available: true }),
    loadState: () => value.saved,
    saveState: () => {},
    now: () => "2026-07-19T21:00:00.000Z",
  });
  const status = await restarted.getStatus();
  assert.equal(status.actualDevice, "cpu");
  assert.equal(status.fallbackReason, "cuda_initialization_failed");
  assert.equal(status.actualRuntimeVersion, "1.9.1");
  const restartAttempts = [];
  const restartedRun = await restarted.run({
    operationId: "auto-after-restart",
    requestedDevice: "auto",
    allowCudaFallback: false,
    executeStagedAttempt: async ({ device }) => {
      restartAttempts.push(device);
      return { transcript: "cpu-after-restart" };
    },
  });
  assert.deepEqual(restartAttempts, ["cpu"]);
  assert.equal(restartedRun.fallbackReason, "cuda_initialization_failed");
});

test("real CUDA process failure reaches the selector as one clean CPU fallback", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "asr-device-runtime-fallback-"));
  const audioPath = join(workRoot, "input.wav");
  writeFileSync(audioPath, "synthetic wav placeholder");
  const executables = [];
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async (spec) => {
      executables.push(spec.absoluteExe);
      if (spec.absoluteExe.includes("\\cuda\\")) {
        const error = new Error("driver initialization failed");
        error.code = "PROCESS_FAILED";
        throw error;
      }
      const prefix = spec.argv[spec.argv.indexOf("-of") + 1];
      writeFileSync(join(spec.cwd, `${prefix}.json`), JSON.stringify({
        result: { language: "en" },
        transcription: [{
          offsets: { from: 0, to: 1_000 },
          text: " Hello",
          tokens: [{ text: " Hello", offsets: { from: 0, to: 1_000 }, p: 0.9 }],
        }],
      }));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  const selector = createAsrDeviceSelector({
    getCapabilityStatus: async () => capabilities({ cuda: "ready" }),
    resolveRuntime: async (device) => runtime(device),
    probeRuntime: async () => ({ available: true }),
  });
  try {
    const selected = await selector.run({
      operationId: "runtime-fallback",
      requestedDevice: "auto",
      allowCudaFallback: false,
      executeStagedAttempt: ({ runtime: selectedRuntime }) => runtimeProcess.transcribe({
        operationId: "runtime-fallback",
        runtime: selectedRuntime,
        workRoot,
        audioPath,
        outputName: "runtime-fallback",
        mediaDurationMs: 1_000,
        languageMode: "auto",
        languageHint: null,
      }),
    });
    assert.equal(selected.actualDevice, "cpu");
    assert.equal(selected.runtimeId, CPU_ID);
    assert.equal(selected.fallbackReason, "cuda_initialization_failed");
    assert.deepEqual(executables, [runtime("cuda").executablePath, runtime("cpu").executablePath]);
  } finally {
    runtimeProcess.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("real CUDA language detection failure follows the configured CPU fallback policy", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "asr-language-runtime-fallback-"));
  const audioPath = join(workRoot, "input.wav");
  writeFileSync(audioPath, "synthetic wav placeholder");
  const executables = [];
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async (spec) => {
      executables.push(spec.absoluteExe);
      if (spec.absoluteExe.includes("\\cuda\\")) {
        const error = new Error("driver initialization failed");
        error.code = "PROCESS_FAILED";
        throw error;
      }
      const prefix = spec.argv[spec.argv.indexOf("-of") + 1];
      writeFileSync(join(spec.cwd, `${prefix}.json`), JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return {
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderrSummary: "",
        stderr: Buffer.from("auto-detected language: en (p = 0.9)"),
      };
    },
  });
  const selector = createAsrDeviceSelector({
    getCapabilityStatus: async () => capabilities({ cuda: "ready" }),
    resolveRuntime: async (device) => runtime(device),
    probeRuntime: async () => ({ available: true }),
  });
  const detect = (operationId, outputName) => ({ runtime: selectedRuntime }) =>
    runtimeProcess.detectLanguageRegion({
      operationId,
      runtime: selectedRuntime,
      workRoot,
      audioPath,
      outputName,
      mediaDurationMs: 1_000,
      segmentId: "segment-1",
      startMs: 0,
      endMs: 1_000,
    });
  try {
    const selected = await selector.run({
      operationId: "language-runtime-fallback",
      requestedDevice: "auto",
      allowCudaFallback: false,
      executeStagedAttempt: detect("language-runtime-fallback", "language-runtime-fallback"),
    });
    assert.equal(selected.actualDevice, "cpu");
    assert.equal(selected.fallbackReason, "cuda_initialization_failed");
    assert.equal(selected.result.detectedLanguage, "en");
    assert.deepEqual(executables, [runtime("cuda").executablePath, runtime("cpu").executablePath]);

    executables.length = 0;
    const allowedFallback = await selector.run({
      operationId: "language-runtime-allowed-fallback",
      requestedDevice: "cuda",
      allowCudaFallback: true,
      executeStagedAttempt: detect("language-runtime-allowed-fallback", "language-runtime-allowed-fallback"),
    });
    assert.equal(allowedFallback.actualDevice, "cpu");
    assert.equal(allowedFallback.runtimeId, CPU_ID);
    assert.equal(allowedFallback.fallbackReason, "cuda_initialization_failed");
    assert.deepEqual(executables, [runtime("cuda").executablePath, runtime("cpu").executablePath]);

    executables.length = 0;
    await assert.rejects(
      () => selector.run({
        operationId: "language-runtime-no-fallback",
        requestedDevice: "cuda",
        allowCudaFallback: false,
        executeStagedAttempt: detect("language-runtime-no-fallback", "language-runtime-no-fallback"),
      }),
      (error) => error?.code === "CUDA_UNAVAILABLE" && !String(error.message).includes("driver initialization"),
    );
    assert.deepEqual(executables, [runtime("cuda").executablePath]);
  } finally {
    runtimeProcess.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("device detection probes verified runtimes sequentially and persists bounded availability", async () => {
  let saved = null;
  let active = 0;
  let maxActive = 0;
  const probes = [];
  const selector = createAsrDeviceSelector({
    getCapabilityStatus: async () => capabilities({ cuda: "ready" }),
    resolveRuntime: async (device) => runtime(device),
    probeRuntime: async ({ operationId, device, runtime: selectedRuntime }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      probes.push({ operationId, device, runtimeId: selectedRuntime.runtimeId });
      try {
        if (device === "cuda") {
          const error = new Error("C:\\private\\driver detail");
          error.code = "CUDA_INITIALIZATION_FAILED";
          throw error;
        }
        return { available: true };
      } finally {
        active -= 1;
      }
    },
    loadState: () => saved,
    saveState: (state) => { saved = structuredClone(state); },
    now: () => "2026-07-19T20:00:00.000Z",
  });

  const status = await selector.detect({ operationId: "device-detect" });
  assert.equal(maxActive, 1);
  assert.deepEqual(probes, [
    { operationId: "device-detect", device: "cpu", runtimeId: CPU_ID },
    { operationId: "device-detect", device: "cuda", runtimeId: CUDA_ID },
  ]);
  assert.deepEqual(status.detection.cpu, { status: "available", runtimeId: CPU_ID, runtimeVersion: "1.9.1" });
  assert.deepEqual(status.detection.cuda, {
    status: "unavailable",
    runtimeId: CUDA_ID,
    runtimeVersion: "1.9.1",
    reason: "initialization_failed",
  });
  assert.equal(/path|argv|cwd|private/i.test(JSON.stringify(status)), false);
  assert.deepEqual(saved.detection, status.detection);
});

test("device detection cancellation settles the active probe and writes no partial summary", async () => {
  let rejectProbe;
  let saved = null;
  const selector = createAsrDeviceSelector({
    getCapabilityStatus: async () => capabilities(),
    resolveRuntime: async (device) => runtime(device),
    probeRuntime: () => new Promise((_resolve, reject) => { rejectProbe = reject; }),
    cancelProbe: ({ operationId }) => {
      assert.equal(operationId, "cancel-detect");
      const error = new Error("cancelled");
      error.code = "CANCELLED";
      rejectProbe(error);
      return { cancelled: true };
    },
    loadState: () => saved,
    saveState: (state) => { saved = structuredClone(state); },
  });
  const pending = selector.detect({ operationId: "cancel-detect" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await selector.cancel({ operationId: "cancel-detect" }), { cancelled: true });
  await assert.rejects(() => pending, (error) => error?.code === "CANCELLED");
  assert.equal(saved, null);
  assert.deepEqual(await selector.cancel({ operationId: "cancel-detect" }), { cancelled: false });
});

test("explicit CUDA never silently reports CPU unless fallback was explicitly allowed", async () => {
  for (const allowCudaFallback of [false, true]) {
    const value = harness({ cuda: "ready" });
    const initializationError = new Error("driver init failed");
    initializationError.code = "CUDA_INITIALIZATION_FAILED";
    const pending = value.selector.run({
      operationId: `explicit-cuda-${allowCudaFallback}`,
      requestedDevice: "cuda",
      allowCudaFallback,
      executeStagedAttempt: value.execute({ cuda: initializationError, cpu: { transcript: "cpu-staged" } }),
    });
    if (allowCudaFallback) {
      const result = await pending;
      assert.equal(result.actualDevice, "cpu");
      assert.equal(result.fallbackReason, "cuda_initialization_failed");
      assert.equal(value.attempts.length, 2);
    } else {
      await assert.rejects(
        () => pending,
        (error) => error?.code === "CUDA_UNAVAILABLE" && !String(error.message).includes("driver init"),
      );
      assert.deepEqual(value.attempts, [{ device: "cuda", runtimeId: CUDA_ID }]);
      assert.notEqual(value.saved.actualDevice, "cpu");
    }
  }
});

test("device preference and operation inputs are exact bounded enums", async () => {
  const value = harness({ cuda: "ready" });
  for (const request of [
    { requestedDevice: "--gpu=0", allowCudaFallback: false },
    { requestedDevice: "cuda", allowCudaFallback: "yes" },
    { requestedDevice: "cpu", allowCudaFallback: false, argv: ["--prompt", "bad"] },
  ]) {
    await assert.rejects(
      () => value.selector.setPreference(request),
      (error) => error?.code === "INVALID_INPUT",
    );
  }
  await assert.rejects(
    () => value.selector.run({
      operationId: "../escape",
      requestedDevice: "auto",
      allowCudaFallback: false,
      executeStagedAttempt: async () => ({}),
    }),
    (error) => error?.code === "INVALID_INPUT",
  );
  assert.deepEqual(value.attempts, []);
  const status = await value.selector.setPreference({ requestedDevice: "cuda", allowCudaFallback: true });
  assert.equal(status.requestedDevice, "cuda");
  assert.equal(status.allowCudaFallback, true);
  assert.equal(status.detection.cpu.status, "not_detected");
  assert.equal(status.detection.cuda.status, "not_detected");
});
