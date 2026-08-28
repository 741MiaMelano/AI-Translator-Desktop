import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openAppRepository } from "../backend/persistence/app-repository.mjs";
import { createTaskCoordinator } from "../backend/tasks/task-coordinator.mjs";
import { createTaskService } from "../backend/tasks/task-service.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function withService(run) {
  const root = mkdtempSync(join(tmpdir(), "phase8-task-service-"));
  const repository = openAppRepository(root);
  const coordinator = createTaskCoordinator({ queueRepository: repository });
  const events = [];
  const service = createTaskService({
    coordinator,
    publish: (event) => events.push(event),
    idFactory: (operation) => `task-${operation.replaceAll(".", "-")}`,
  });
  return Promise.resolve(run({ service, coordinator, events })).finally(() => {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  });
}

test("task service persists and publishes a successful execution lifecycle", () => withService(async ({ service, coordinator, events }) => {
  service.register("export.source", {
    kind: "export",
    stage: "export",
    label: () => "Export source subtitles",
    pauseCapability: "never",
    execute: async (request) => ({ fileName: `${request.projectId}.srt` }),
  });

  const result = await service.run("export.source", { projectId: "project-1" });

  assert.deepEqual(result, { fileName: "project-1.srt" });
  assert.equal(coordinator.get("task-export-source").status, "completed");
  assert.equal(coordinator.get("task-export-source").progress, 100);
  assert.deepEqual(events.map((event) => event.status), ["pending", "running", "completed"]);
  assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2]);
}));

test("task service keeps local executors queued behind the shared scheduler", () => withService(async ({ service, coordinator }) => {
  const firstGate = deferred();
  let starts = 0;
  for (const operation of ["media.first", "media.second"]) {
    service.register(operation, {
      kind: "media",
      stage: "detect",
      resource: "local",
      label: () => operation,
      pauseCapability: "never",
      execute: async () => {
        starts += 1;
        if (operation === "media.first") await firstGate.promise;
      },
    });
  }

  const first = service.run("media.first", { projectId: "project-1" });
  const second = service.run("media.second", { projectId: "project-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(coordinator.get("task-media-second").status, "pending");
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.equal(starts, 2);
}));

test("setting a pending task next persists priority and changes the real scheduler order", () => withService(async ({ service, coordinator }) => {
  const firstGate = deferred();
  const starts = [];
  for (const operation of ["media.first", "media.second", "media.third"]) {
    service.register(operation, {
      kind: "media",
      stage: "detect",
      resource: "local",
      label: () => operation,
      pauseCapability: "never",
      execute: async () => {
        starts.push(operation);
        if (operation === "media.first") await firstGate.promise;
      },
    });
  }
  const first = service.enqueue("media.first", { projectId: "project-1" });
  const second = service.enqueue("media.second", { projectId: "project-2" });
  const third = service.enqueue("media.third", { projectId: "project-3" });
  await new Promise((resolve) => setImmediate(resolve));

  const prioritized = service.control({ taskId: third.id, projectId: third.projectId, action: "prioritize" });
  assert.ok(prioritized.priority > coordinator.get(second.id).priority);
  firstGate.resolve();
  await Promise.all([first, second, third].map((task) => service.waitForIdle(task.id)));

  assert.deepEqual(starts, ["media.first", "media.third", "media.second"]);
}));

test("queued work can pause before spending and resumes only after confirmation", () => withService(async ({ service, coordinator }) => {
  const firstGate = deferred();
  let secondStarts = 0;
  service.register("translation.first", {
    kind: "translate",
    stage: "translate",
    label: () => "First",
    pauseCapability: "never",
    execute: () => firstGate.promise,
  });
  service.register("translation.second", {
    kind: "translate",
    stage: "translate",
    label: () => "Second",
    pauseCapability: "never",
    execute: async () => { secondStarts += 1; },
  });

  const first = service.enqueue("translation.first", { projectId: "project-1" });
  const second = service.enqueue("translation.second", { projectId: "project-1" });
  await new Promise((resolve) => setImmediate(resolve));
  const paused = service.control({ taskId: second.id, projectId: second.projectId, action: "pause" });
  assert.equal(paused.status, "paused");
  firstGate.resolve();
  await service.waitForIdle(first.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarts, 0);
  assert.equal(coordinator.get(second.id).status, "paused");

  const resumed = service.control({ taskId: second.id, projectId: second.projectId, action: "resume" });
  assert.equal(resumed.status, "running");
  await service.waitForIdle(second.id);
  assert.equal(secondStarts, 1);
  assert.equal(coordinator.get(second.id).status, "completed");
}));

test("queued project failure does not stop an independent project", () => withService(async ({ service, coordinator }) => {
  service.register("translation.fail", {
    kind: "translate",
    stage: "translate",
    label: () => "Fail",
    pauseCapability: "never",
    execute: async () => { throw Object.assign(new Error("provider failed"), { code: "PROVIDER_SERVER" }); },
  });
  service.register("translation.pass", {
    kind: "translate",
    stage: "translate",
    label: () => "Pass",
    pauseCapability: "never",
    execute: async () => ({ translated: true }),
  });

  const failed = service.enqueue("translation.fail", { projectId: "project-failed" });
  const passed = service.enqueue("translation.pass", { projectId: "project-passed" });
  await Promise.allSettled([service.waitForIdle(failed.id), service.waitForIdle(passed.id)]);
  assert.equal(coordinator.get(failed.id).status, "failed");
  assert.equal(coordinator.get(passed.id).status, "completed");
}));

test("task progress is monotonic, persisted, and emitted with one new sequence", () => withService(async ({ service, coordinator, events }) => {
  service.register("media.progress", {
    kind: "media",
    stage: "extract",
    label: () => "Extract",
    pauseCapability: "never",
    execute: async (_request, context) => {
      context.reportProgress(35, "Audio extracted");
      return {};
    },
  });
  await service.run("media.progress", { projectId: "project-1" });
  assert.deepEqual(events.map((event) => [event.type, event.sequence]), [
    ["status", 0],
    ["status", 1],
    ["progress", 2],
    ["status", 3],
  ]);
  assert.equal(coordinator.get("task-media-progress").progress, 100);
  assert.throws(
    () => coordinator.updateProgress("task-media-progress", 20),
    (error) => error.code === "INVALID_TASK_TRANSITION",
  );
}));

test("failed work never auto-retries and explicit retry starts a new attempt", () => withService(async ({ service, coordinator }) => {
  let calls = 0;
  service.register("translation.start", {
    kind: "translate",
    stage: "translate",
    label: () => "Translate",
    pauseCapability: "never",
    execute: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { code: "PROVIDER_429", retryable: true });
      return { translated: true };
    },
  });

  await assert.rejects(service.run("translation.start", { projectId: "project-1", userConfirmed: true }));
  assert.equal(calls, 1);
  assert.equal(coordinator.get("task-translation-start").status, "failed");
  assert.throws(
    () => service.control({ taskId: "task-translation-start", projectId: "project-1", action: "retry", userConfirmed: false }),
    (error) => error.code === "USER_CONFIRMATION_REQUIRED",
  );

  const retry = service.control({
    taskId: "task-translation-start",
    projectId: "project-1",
    action: "retry",
    userConfirmed: true,
  });
  assert.equal(retry.status, "running");
  await service.waitForIdle("task-translation-start");
  assert.equal(calls, 2);
  assert.equal(coordinator.get("task-translation-start").status, "completed");
  assert.equal(coordinator.get("task-translation-start").attempt, 1);
}));

test("checkpoint-capable work pauses only at a safe boundary and then resumes", () => withService(async ({ service, coordinator }) => {
  const firstStage = deferred();
  const started = deferred();
  service.register("asr.pipeline", {
    kind: "asr",
    stage: "extract",
    stages: ["extract", "asr"],
    label: () => "Extract and transcribe",
    pauseCapability: "checkpoint",
    execute: async (_request, context) => {
      started.resolve();
      await firstStage.promise;
      await context.checkpoint("extract", { progress: 40 });
      return { runId: "run-1" };
    },
  });

  const running = service.run("asr.pipeline", { projectId: "project-1" });
  await started.promise;
  assert.equal(service.control({ taskId: "task-asr-pipeline", projectId: "project-1", action: "pause" }).status, "pausing");
  firstStage.resolve();
  await service.waitForStatus("task-asr-pipeline", "paused");
  assert.equal(coordinator.get("task-asr-pipeline").checkpointStage, "extract");
  assert.equal(coordinator.get("task-asr-pipeline").stage, "asr");
  assert.equal(service.control({ taskId: "task-asr-pipeline", projectId: "project-1", action: "resume" }).status, "running");
  assert.deepEqual(await running, { runId: "run-1" });
  assert.equal(coordinator.get("task-asr-pipeline").status, "completed");
}));

test("cancellation invokes resource cleanup and does not report completion", () => withService(async ({ service, coordinator }) => {
  const started = deferred();
  let cancelCalls = 0;
  service.register("media.probe", {
    kind: "media",
    stage: "detect",
    label: () => "Probe media",
    pauseCapability: "never",
    execute: (_request, { signal }) => new Promise((_resolve, reject) => {
      started.resolve();
      signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" })), { once: true });
    }),
    cancel: async () => { cancelCalls += 1; },
  });

  const running = service.run("media.probe", { projectId: "project-1", operationId: "probe-1" });
  await started.promise;
  assert.equal(service.control({ taskId: "task-media-probe", projectId: "project-1", action: "cancel" }).status, "cancelling");
  await assert.rejects(running, (error) => error.code === "CANCELLED");
  assert.equal(cancelCalls, 1);
  assert.equal(coordinator.get("task-media-probe").status, "cancelled");
}));

test("stopAll cancels every active executor before shutdown returns", () => withService(async ({ service, coordinator }) => {
  let cleanupCalls = 0;
  service.register("asr.long", {
    kind: "asr",
    stage: "asr",
    label: () => "Long ASR",
    pauseCapability: "never",
    execute: (_request, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" })), { once: true });
    }),
    cancel: async () => { cleanupCalls += 1; },
  });
  const running = service.run("asr.long", { projectId: "project-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.hasActiveTasks(), true);
  await service.stopAll();
  await assert.rejects(running, (error) => error.code === "CANCELLED");
  assert.equal(cleanupCalls, 1);
  assert.equal(service.hasActiveTasks(), false);
  assert.equal(coordinator.get("task-asr-long").status, "cancelled");
}));
