import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTaskSupervisorClient } from "../../electron/task-supervisor-client.ts";

function fakeSupervisor(onPostMessage = () => {}) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.postMessage = onPostMessage;
  child.kill = () => true;
  return child;
}

test("task supervisor waits for ready and resolves a correlated request", async () => {
  let sent;
  const child = fakeSupervisor((message) => {
    sent = message;
    queueMicrotask(() => child.emit("message", {
      type: "supervisor.result",
      correlationId: message.correlationId,
      ok: true,
      data: { available: true },
    }));
  });
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
  });

  const pending = client.request("asr.runtimeProbe", { operationId: "probe-1" });
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));

  assert.deepEqual(await pending, { available: true });
  assert.equal(sent.type, "asr.runtimeProbe");
  assert.equal(sent.operationId, "probe-1");
  assert.equal(typeof sent.correlationId, "string");
});

test("translation cancellation is routed through the single supervisor", async () => {
  let sent;
  const child = fakeSupervisor((message) => {
    sent = message;
    queueMicrotask(() => child.emit("message", {
      type: "supervisor.result",
      correlationId: message.correlationId,
      ok: true,
      data: { cancelled: true },
    }));
  });
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
  });
  const pending = client.cancelTranslation({ operationId: "task-translate-1" });
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(sent.type, "translate.cancel");
  assert.equal(sent.operationId, "task-translate-1");
});

test("translation batch callbacks stay in main and are acknowledged across the worker boundary", async () => {
  const sent = [];
  const seen = [];
  let runCorrelationId;
  const child = fakeSupervisor((message) => {
    structuredClone(message);
    sent.push(message);
    if (message.type === "translate.run") {
      runCorrelationId = message.correlationId;
      queueMicrotask(() => child.emit("message", {
        type: "supervisor.translationBatch",
        correlationId: runCorrelationId,
        batchId: "batch-0",
        event: { batchIndex: 0, batchCount: 2 },
      }));
    } else if (message.type === "translate.batchAck") {
      queueMicrotask(() => child.emit("message", {
        type: "supervisor.result",
        correlationId: runCorrelationId,
        ok: true,
        data: { status: "completed" },
      }));
    }
  });
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
  });
  const pending = client.translateLanguage({
    projectId: "project-1",
    operationId: "task-1",
    signal: new AbortController().signal,
    onBatch: async (event) => { seen.push(event); },
  });
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));

  assert.deepEqual(await pending, { status: "completed" });
  assert.deepEqual(seen, [{ batchIndex: 0, batchCount: 2 }]);
  const runMessage = sent.find((message) => message.type === "translate.run");
  assert.equal(Object.hasOwn(runMessage, "onBatch"), false);
  assert.equal(Object.hasOwn(runMessage, "signal"), false);
  assert.equal(sent.some((message) => message.type === "translate.batchAck" && message.ok === true), true);
});

test("ASR progress callbacks stay in main while checkpoint identity crosses the worker boundary", async () => {
  const seen = [];
  let sent;
  const child = fakeSupervisor((message) => {
    structuredClone(message);
    sent = message;
    queueMicrotask(() => {
      child.emit("message", {
        type: "supervisor.asrProgress",
        correlationId: message.correlationId,
        event: { progress: 25, completedChunks: 2, totalChunks: 8, path: "hidden" },
      });
      child.emit("message", {
        type: "supervisor.result",
        correlationId: message.correlationId,
        ok: true,
        data: { canonicalResultPath: "result.json" },
      });
    });
  });
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
  });
  const pending = client.transcribeAsr({
    operationId: "asr-1",
    runtime: {
      vadModelPath: "C:\\models\\vad.bin",
      vadModelId: "silero-vad-v6.2.0",
      vadModelVersion: "6.2.0",
      vadModelHash: "b".repeat(64),
      vadExecutablePath: "C:\\runtime\\whisper-vad-speech-segments.exe",
    },
    vad: {
      mode: "auto",
      model: { id: "silero-vad-v6.2.0", version: "6.2.0", hash: "b".repeat(64) },
      parameters: { threshold: 0.5 },
    },
    workRoot: "C:\\work",
    audioPath: "C:\\work\\audio.wav",
    outputName: "result",
    mediaDurationMs: 60_000,
    languageMode: "auto",
    languageHint: null,
    checkpointPath: "C:\\project\\checkpoint.json",
    checkpointFingerprint: "a".repeat(64),
    onProgress: (event) => seen.push(event),
  });
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));

  await pending;
  assert.equal(Object.hasOwn(sent, "onProgress"), false);
  assert.equal(sent.checkpointFingerprint, "a".repeat(64));
  assert.equal(sent.runtime.vadModelPath, "C:\\models\\vad.bin");
  assert.equal(sent.runtime.vadModelId, "silero-vad-v6.2.0");
  assert.equal(sent.runtime.vadModelVersion, "6.2.0");
  assert.equal(sent.runtime.vadModelHash, "b".repeat(64));
  assert.equal(sent.runtime.vadExecutablePath, "C:\\runtime\\whisper-vad-speech-segments.exe");
  assert.equal(sent.vad.parameters.threshold, 0.5);
  assert.deepEqual(seen, [{ progress: 25, completedChunks: 2, totalChunks: 8 }]);
});

test("ASR chunk failure details cross the supervisor as a bounded allowlist", async () => {
  const child = fakeSupervisor((message) => queueMicrotask(() => child.emit("message", {
    type: "supervisor.result",
    correlationId: message.correlationId,
    ok: false,
    error: {
      code: "INVALID_ASR_RESULT",
      message: "invalid chunk",
      safeDetails: { chunkIndex: 2, startMs: 500, endMs: 3_500, text: "hidden" },
    },
  })));
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
  });
  const pending = client.transcribeAsr({ operationId: "asr-failure", runtime: {} });
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));

  await assert.rejects(pending, (error) => {
    assert.deepEqual(error.safeDetails, { chunkIndex: 2, startMs: 500, endMs: 3_500 });
    assert.equal(Object.hasOwn(error.safeDetails, "text"), false);
    return error.code === "INVALID_ASR_RESULT";
  });
});

test("worker events are forwarded separately from correlated results", async () => {
  const events = [];
  let sent;
  const child = fakeSupervisor((message) => { sent = message; });
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
    onEvent: (event) => events.push(event),
  });
  const request = client.request("media.run", {});
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("message", {
    type: "supervisor.event",
    event: { type: "progress", taskId: "task-1", sequence: 2, progress: 50 },
  });
  child.emit("message", {
    type: "supervisor.result",
    correlationId: sent.correlationId,
    ok: true,
    data: {},
  });
  await request;
  assert.deepEqual(events, [{ type: "progress", taskId: "task-1", sequence: 2, progress: 50 }]);
});

test("unexpected supervisor exit rejects every pending request and reports a crash", async () => {
  const crashes = [];
  const child = fakeSupervisor();
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
    onCrash: (event) => crashes.push(event),
  });
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));

  const first = client.request("media.run", {});
  const second = client.request("asr.transcribe", {});
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 7);

  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.deepEqual(results.map((result) => result.reason.code), ["WORKER_CRASHED", "WORKER_CRASHED"]);
  assert.deepEqual(crashes, [{ code: 7, pid: 1234, reason: "exit" }]);
});

test("missing supervisor heartbeat kills the process and settles pending work", async () => {
  let killed = false;
  const crashes = [];
  const child = fakeSupervisor();
  child.kill = () => {
    killed = true;
    return true;
  };
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
    heartbeatTimeoutMs: 10,
    onCrash: (event) => crashes.push(event),
  });
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));

  const pending = client.request("media.run", {});
  const result = await Promise.race([
    pending.then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", code: error.code }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 100)),
  ]);

  assert.deepEqual(result, { status: "rejected", code: "WORKER_CRASHED" });
  assert.equal(killed, true);
  assert.deepEqual(crashes, [{ code: null, pid: 1234, reason: "heartbeat_timeout" }]);
});

test("graceful close cancels pending work, waits for exit, and rejects new requests", async () => {
  const sent = [];
  const crashes = [];
  const child = fakeSupervisor((message) => sent.push(message));
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    forkWorker: () => child,
    onCrash: (event) => crashes.push(event),
  });
  queueMicrotask(() => child.emit("message", { type: "supervisor.ready" }));
  const pending = client.request("asr.transcribe", {});
  await new Promise((resolve) => setImmediate(resolve));

  const closing = client.close();
  await assert.rejects(() => pending, (error) => error.code === "CANCELLED");
  await assert.rejects(
    () => client.request("media.run", {}),
    (error) => error.code === "CANCELLED",
  );
  assert.equal(sent.some((message) => message.type === "supervisor.shutdown"), true);
  assert.equal(await Promise.race([
    closing.then(() => "closed"),
    new Promise((resolve) => setImmediate(() => resolve("waiting"))),
  ]), "waiting");

  child.emit("exit", 0);
  await closing;
  assert.deepEqual(crashes, []);
});

test("readiness timeout discards the stale supervisor and allows one clean retry", async () => {
  let forks = 0;
  let firstKilled = false;
  const first = fakeSupervisor();
  first.kill = () => {
    firstKilled = true;
    return true;
  };
  const second = fakeSupervisor((message) => queueMicrotask(() => second.emit("message", {
    type: "supervisor.result",
    correlationId: message.correlationId,
    ok: true,
    data: { available: true },
  })));
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    readyTimeoutMs: 5,
    forkWorker: () => {
      forks += 1;
      if (forks === 1) return first;
      queueMicrotask(() => second.emit("message", { type: "supervisor.ready" }));
      return second;
    },
  });

  await assert.rejects(
    () => client.request("asr.runtimeProbe", {}),
    (error) => error.code === "WORKER_CRASHED",
  );
  assert.equal(firstKilled, true);
  assert.deepEqual(await client.request("asr.runtimeProbe", {}), { available: true });
  assert.equal(forks, 2);
});

test("closing before readiness immediately rejects the waiting request as cancelled", async () => {
  const child = fakeSupervisor();
  const client = createTaskSupervisorClient({
    entryPath: "task-supervisor-entry.mjs",
    readyTimeoutMs: 1_000,
    forkWorker: () => child,
  });
  const pending = client.request("asr.runtimeProbe", {});
  await new Promise((resolve) => setImmediate(resolve));

  const closing = client.close();
  const result = await Promise.race([
    pending.then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", code: error.code }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 50)),
  ]);

  assert.deepEqual(result, { status: "rejected", code: "CANCELLED" });
  child.emit("exit", 0);
  await closing;
});
