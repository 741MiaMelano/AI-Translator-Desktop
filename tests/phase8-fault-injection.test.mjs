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
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function withRuntime(run) {
  const root = mkdtempSync(join(tmpdir(), "phase8-fault-"));
  const repository = openAppRepository(root);
  const coordinator = createTaskCoordinator({ queueRepository: repository });
  const service = createTaskService({
    coordinator,
    idFactory: (operation) => `task-${operation}`,
  });
  try {
    await run({ root, repository, coordinator, service });
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const fault of [
  { name: "network disconnect", code: "NETWORK_UNAVAILABLE", retryable: true },
  { name: "Provider 429", code: "PROVIDER_429", retryable: true },
  { name: "disk full", code: "DISK_FULL", retryable: true },
  { name: "FFmpeg failure", code: "PROCESS_FAILED", retryable: false },
]) {
  test(`${fault.name} has a deterministic failed state and never auto-retries`, () => withRuntime(async ({ coordinator, service }) => {
    let calls = 0;
    service.register(fault.code.toLowerCase(), {
      kind: fault.code === "PROCESS_FAILED" ? "media" : "translate",
      stage: fault.code === "PROCESS_FAILED" ? "extract" : "translate",
      label: () => fault.name,
      pauseCapability: "never",
      execute: async () => {
        calls += 1;
        throw Object.assign(new Error(fault.name), {
          code: fault.code,
          retryable: fault.retryable,
        });
      },
    });
    await assert.rejects(service.run(fault.code.toLowerCase(), { projectId: "project-1" }));
    const task = coordinator.get(`task-${fault.code.toLowerCase()}`);
    assert.equal(task.status, "failed");
    assert.equal(task.lastErrorCode, fault.code);
    assert.equal(task.retryable, fault.retryable);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  }));
}

test("worker crash preserves recoverable state until an explicitly confirmed resume", () => withRuntime(async ({ coordinator, service }) => {
  const crashed = deferred();
  let calls = 0;
  service.register("worker-crash", {
    kind: "asr",
    stage: "asr",
    label: () => "ASR",
    pauseCapability: "never",
    execute: async () => {
      calls += 1;
      if (calls === 1) return crashed.promise;
      return { resumed: true };
    },
  });
  const first = service.run("worker-crash", { projectId: "project-1" });
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.reconcileInterrupted();
  crashed.reject(Object.assign(new Error("worker crashed"), { code: "WORKER_CRASHED", retryable: true }));
  await assert.rejects(first);
  assert.equal(coordinator.get("task-worker-crash").status, "recoverable");
  assert.equal(calls, 1);
  assert.throws(
    () => service.control({
      taskId: "task-worker-crash",
      projectId: "project-1",
      action: "resume",
      userConfirmed: false,
    }),
    (error) => error.code === "USER_CONFIRMATION_REQUIRED",
  );
  service.control({
    taskId: "task-worker-crash",
    projectId: "project-1",
    action: "resume",
    userConfirmed: true,
  });
  await service.waitForIdle("task-worker-crash");
  assert.equal(calls, 2);
  assert.equal(coordinator.get("task-worker-crash").status, "completed");
}));

test("application hard kill leaves work visible but restart reconciliation does not execute it", () => {
  const root = mkdtempSync(join(tmpdir(), "phase8-hard-kill-"));
  let repository = openAppRepository(root);
  try {
    const before = createTaskCoordinator({ queueRepository: repository });
    before.create({
      id: "task-hard-kill",
      projectId: "project-1",
      kind: "translate",
      label: "Translate",
      detail: "Queued",
      stage: "translate",
      request: { operation: "translation.start", input: { projectId: "project-1" } },
      pauseCapability: "never",
    });
    before.transition("task-hard-kill", "running");
    repository.close();

    repository = openAppRepository(root);
    const after = createTaskCoordinator({ queueRepository: repository });
    assert.equal(after.get("task-hard-kill").status, "running");
    assert.deepEqual(after.reconcileInterrupted().map((task) => task.status), ["recoverable"]);
    assert.equal(after.get("task-hard-kill").lastErrorCode, "WORKER_INTERRUPTED");
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});
