import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAsrRuntimeProcess } from "../../backend/asr/runtime-process.mjs";

test("runtime probe uses only the verified executable with fixed bounded process arguments", async () => {
  let observed = null;
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async (spec) => {
      observed = spec;
      return { exitCode: 0, stdout: Buffer.from("whisper.cpp version 1.9.1"), stderrSummary: "" };
    },
  });
  const result = await runtimeProcess.probe({
    operationId: "probe-1",
    runtime: {
      engineId: "whisper.cpp",
      engineVersion: "1.9.1",
      runtimeId: "whisper-cpp-cpu-x64",
      runtimeVersion: "1.9.1",
      device: "cpu",
      executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe",
      cwd: "C:\\managed-asr\\runtime",
      argv: ["--server", "bad"],
      url: "https://example.test/bad",
    },
  });

  assert.deepEqual(result, {
    available: true,
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtimeId: "whisper-cpp-cpu-x64",
    runtimeVersion: "1.9.1",
    device: "cpu",
  });
  assert.equal(observed.absoluteExe, "C:\\managed-asr\\runtime\\whisper-cli.exe");
  assert.equal(observed.cwd, "C:\\managed-asr\\runtime");
  assert.deepEqual(observed.argv, ["--version"]);
  assert.equal(observed.timeoutMs, 15_000);
  assert.equal(observed.stdoutMaxBytes, 64 * 1024);
  assert.equal(observed.stderrMaxBytes, 16 * 1024);
  assert.equal(Object.hasOwn(observed, "url"), false);
});

test("runtime reports external child ownership for the full process lifetime", async () => {
  const events = [];
  const runtimeProcess = createAsrRuntimeProcess({
    reportChildProcess: (event) => events.push(event),
    runProcess: async (spec) => {
      spec.onSpawn?.(4242);
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  await runtimeProcess.probe({
    operationId: "probe-owned-child",
    runtime: {
      engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeId: "whisper-cpp-cpu-x64",
      runtimeVersion: "1.9.1", device: "cpu",
      executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe",
      cwd: "C:\\managed-asr\\runtime",
    },
  });
  assert.deepEqual(events, [
    { operationId: "probe-owned-child", pid: 4242, active: true },
    { operationId: "probe-owned-child", pid: 4242, active: false },
  ]);
});

test("runtime cancellation aborts the active managed process and settles the probe", async () => {
  let observedSignal = null;
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: ({ signal }) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("cancelled");
            error.code = "CANCELLED";
            reject(error);
          },
          { once: true },
        );
      });
    },
  });
  const pending = runtimeProcess.probe({
    operationId: "probe-cancel",
    runtime: {
      engineId: "whisper.cpp",
      engineVersion: "1.9.1",
      runtimeId: "whisper-cpp-cpu-x64",
      runtimeVersion: "1.9.1",
      device: "cpu",
      executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe",
      cwd: "C:\\managed-asr\\runtime",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runtimeProcess.cancel("probe-cancel"), { cancelled: true });
  await assert.rejects(() => pending, (error) => error?.code === "CANCELLED");
  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(runtimeProcess.cancel("probe-cancel"), { cancelled: false });
});

test("runtime shutdown aborts every active managed process", async () => {
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("shutdown");
            error.code = "CANCELLED";
            reject(error);
          },
          { once: true },
        );
      }),
  });
  const runtime = {
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtimeId: "whisper-cpp-cpu-x64",
    runtimeVersion: "1.9.1",
    device: "cpu",
    executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe",
    cwd: "C:\\managed-asr\\runtime",
  };
  const first = runtimeProcess.probe({ operationId: "shutdown-a", runtime });
  const second = runtimeProcess.probe({ operationId: "shutdown-b", runtime });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runtimeProcess.close(), { cancelled: 2 });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.every((result) => result.status === "rejected" && result.reason.code === "CANCELLED"), true);
  assert.deepEqual(runtimeProcess.close(), { cancelled: 0 });
});

test("runtime probe rejects temp and repository executable roots before spawning", async () => {
  let spawnCalls = 0;
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async () => {
      spawnCalls += 1;
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  for (const cwd of [tmpdir(), process.cwd()]) {
    await assert.rejects(
      () =>
        runtimeProcess.probe({
          operationId: `forbidden-${spawnCalls}`,
          runtime: {
            engineId: "whisper.cpp",
            engineVersion: "1.9.1",
            runtimeId: "whisper-cpp-cpu-x64",
            runtimeVersion: "1.9.1",
            device: "cpu",
            executablePath: join(cwd, "whisper-cli.exe"),
            cwd,
          },
        }),
      (error) => error?.code === "INVALID_ARTIFACT" && /managed|forbidden|root/i.test(String(error.message)),
    );
  }
  assert.equal(spawnCalls, 0);
});

test("runtime probe rejects free-form device and mismatched runtime identity before spawning", async () => {
  let spawnCalls = 0;
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async () => {
      spawnCalls += 1;
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  for (const runtime of [
    { ...{
      engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeVersion: "1.9.1",
      executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe", cwd: "C:\\managed-asr\\runtime",
    }, runtimeId: "whisper-cpp-cpu-x64", device: "--gpu=0" },
    { ...{
      engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeVersion: "1.9.1",
      executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe", cwd: "C:\\managed-asr\\runtime",
    }, runtimeId: "whisper-cpp-cpu-x64", device: "cuda" },
  ]) {
    await assert.rejects(
      () => runtimeProcess.probe({ operationId: `invalid-device-${spawnCalls}`, runtime }),
      (error) => error?.code === "INVALID_ARTIFACT" && /device|runtime/i.test(String(error.message)),
    );
  }
  assert.equal(spawnCalls, 0);
});
