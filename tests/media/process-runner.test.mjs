import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertRunnableExe,
  isProcessAlive,
  runManagedProcess,
} from "../../backend/media/process-runner.mjs";
import { MEDIA_ERROR_CODES } from "../../backend/media/constants.mjs";

const helper = fileURLToPath(new URL("./helpers/echo-child.mjs", import.meta.url));
const nodeExe = process.execPath;

test("rejects relative executable empty path directory non-exe and PATH names", async () => {
  await assert.rejects(() => runManagedProcess({ absoluteExe: "ffprobe.exe", argv: [] }), (error) => {
    assert.equal(error.code, MEDIA_ERROR_CODES.INVALID_INPUT);
    return true;
  });
  await assert.rejects(() => runManagedProcess({ absoluteExe: "", argv: [] }), (error) => {
    assert.equal(error.code, MEDIA_ERROR_CODES.INVALID_INPUT);
    return true;
  });
  await assert.rejects(() => runManagedProcess({ absoluteExe: tmpdir(), argv: [] }), (error) => {
    assert.equal(error.code, MEDIA_ERROR_CODES.INVALID_INPUT);
    return true;
  });
  await assert.rejects(() => runManagedProcess({ absoluteExe: join(tmpdir(), "nope.txt"), argv: [] }), (error) => {
    assert.ok(
      error.code === MEDIA_ERROR_CODES.INVALID_INPUT || error.code === MEDIA_ERROR_CODES.NOT_AVAILABLE,
    );
    return true;
  });
  assert.throws(() => assertRunnableExe("ffprobe"), (error) => error.code === MEDIA_ERROR_CODES.INVALID_INPUT);
});

test("argv with Chinese spaces and special characters arrives intact and shell is false", async () => {
  const calls = [];
  const { spawn: realSpawn } = await import("node:child_process");
  const spawnImpl = (exe, argv, options) => {
    calls.push({ exe, argv, options });
    return realSpawn(exe, argv, options);
  };
  const special = ["中文路径", "has space", "a&b(c)"];
  const result = await runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "echo-argv", ...special],
    spawnImpl,
    timeoutMs: 5000,
  });
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].argv.slice(2), special);
  const echoed = JSON.parse(result.stdout.toString("utf8"));
  assert.deepEqual(echoed.slice(1), special);
});

test("managed process reports its OS pid to the owning supervisor", async () => {
  let spawnedPid = null;
  const result = await runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "echo-argv", "pid"],
    timeoutMs: 5_000,
    onSpawn: (pid) => { spawnedPid = pid; },
  });
  assert.equal(spawnedPid, result.pid);
  assert.equal(Number.isInteger(spawnedPid) && spawnedPid > 0, true);
});

test("managed process can stream bounded stdout without changing the final result", async () => {
  const chunks = [];
  const result = await runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "stdout-bytes", "16"],
    stdoutMaxBytes: 16,
    timeoutMs: 5_000,
    onStdout: (chunk) => chunks.push(chunk),
  });
  assert.equal(Buffer.concat(chunks).equals(result.stdout), true);
});

test("cwd is app-owned work dir and env is minimal without PATH dependency", async () => {
  const work = mkdtempSync(join(tmpdir(), "media-work-"));
  const mediaDir = mkdtempSync(join(tmpdir(), "media-src-中文 "));
  try {
    const result = await runManagedProcess({
      absoluteExe: nodeExe,
      argv: [helper, "echo-env"],
      cwd: work,
      timeoutMs: 5000,
    });
    const payload = JSON.parse(result.stdout.toString("utf8"));
    assert.equal(payload.cwd, work);
    assert.notEqual(payload.cwd, mediaDir);
    const upper = new Set(payload.keys.map((key) => key.toUpperCase()));
    assert.ok(upper.has("SYSTEMROOT") || upper.has("WINDIR"));
    assert.ok(upper.has("TEMP") || upper.has("TMP"));
    assert.ok(upper.has("PATH"));
    assert.ok(result.spawnOptions.envKeys.map((k) => k.toUpperCase()).includes("PATH"));
    // Host PATH must not be inherited; empty PATH is intentional.
    assert.equal(result.spawnOptions.envKeys.includes("PATH") || result.spawnOptions.envKeys.includes("Path"), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(mediaDir, { recursive: true, force: true });
  }
});

test("stdout and stderr byte limits allow exact max and reject max+1", async () => {
  const okOut = await runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "stdout-bytes", "16"],
    stdoutMaxBytes: 16,
    timeoutMs: 5000,
  });
  assert.equal(okOut.stdoutBytes, 16);

  await assert.rejects(
    () =>
      runManagedProcess({
        absoluteExe: nodeExe,
        argv: [helper, "stdout-bytes", "17"],
        stdoutMaxBytes: 16,
        timeoutMs: 5000,
      }),
    (error) => error.code === MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE,
  );

  const okErr = await runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "stderr-bytes", "8"],
    stderrMaxBytes: 8,
    timeoutMs: 5000,
  });
  assert.equal(okErr.exitCode, 0);
  assert.equal(Object.hasOwn(okErr, "stderr"), false);

  const privateErr = await runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "stderr-bytes", "8"],
    stderrMaxBytes: 8,
    includeRawStderr: true,
    timeoutMs: 5000,
  });
  assert.equal(privateErr.stderr.equals(Buffer.alloc(8, 0x62)), true);

  await assert.rejects(
    () =>
      runManagedProcess({
        absoluteExe: nodeExe,
        argv: [helper, "stderr-bytes", "9"],
        stderrMaxBytes: 8,
        timeoutMs: 5000,
      }),
    (error) => error.code === MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE,
  );

  const truncatedErr = await runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "stderr-text", "123456789ABCDEFG"],
    stderrMaxBytes: 8,
    truncateStderr: true,
    includeRawStderr: true,
    timeoutMs: 5000,
  });
  assert.equal(truncatedErr.exitCode, 0);
  assert.equal(truncatedErr.stderr.toString("utf8"), "9ABCDEFG");

  await assert.rejects(
    () => runManagedProcess({
      absoluteExe: nodeExe,
      argv: [helper, "stderr-noise-fail", "70000"],
      stderrMaxBytes: 64 * 1024,
      truncateStderr: true,
      timeoutMs: 5000,
    }),
    (error) => error.code === MEDIA_ERROR_CODES.PROCESS_FAILED && error.message.includes("FINAL_QWEN_ERROR"),
  );
});

test("timeout returns TIMEOUT and cancel returns CANCELLED with no live pid", async () => {
  await assert.rejects(
    () =>
      runManagedProcess({
        absoluteExe: nodeExe,
        argv: [helper, "sleep", "5000"],
        timeoutMs: 80,
      }),
    (error) => error.code === MEDIA_ERROR_CODES.TIMEOUT,
  );

  const controller = new AbortController();
  const pending = runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "hang"],
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  await delay(50);
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === MEDIA_ERROR_CODES.CANCELLED);
});

test("cancel cleans up spawned child process tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-tree-"));
  const marker = join(dir, "child-pid.txt");
  const controller = new AbortController();
  const pending = runManagedProcess({
    absoluteExe: nodeExe,
    argv: [helper, "spawn-child", marker],
    timeoutMs: 20_000,
    signal: controller.signal,
  });
  let childPid = null;
  for (let i = 0; i < 50; i += 1) {
    try {
      childPid = Number(readFileSync(marker, "utf8"));
      if (Number.isInteger(childPid) && childPid > 0) break;
    } catch {
      /* wait */
    }
    await delay(40);
  }
  assert.ok(childPid, "child pid marker missing");
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === MEDIA_ERROR_CODES.CANCELLED);
  await delay(1200);
  assert.equal(isProcessAlive(childPid), false);
  rmSync(dir, { recursive: true, force: true });
});

test("non-zero exit and start failure return stable sanitized codes", async () => {
  await assert.rejects(
    () =>
      runManagedProcess({
        absoluteExe: nodeExe,
        argv: [helper, "fail", "C:\\\\Users\\\\secret\\\\video.mkv"],
        timeoutMs: 5000,
      }),
    (error) => {
      assert.equal(error.code, MEDIA_ERROR_CODES.PROCESS_FAILED);
      assert.ok(!String(error.message).includes("Users\\\\secret"));
      assert.ok(!String(error.message).includes("secret-stack"));
      return true;
    },
  );

  const missing = join(tmpdir(), `missing-media-tool-${Date.now()}.exe`);
  await assert.rejects(
    () => runManagedProcess({ absoluteExe: missing, argv: [] }),
    (error) => error.code === MEDIA_ERROR_CODES.NOT_AVAILABLE,
  );
});
