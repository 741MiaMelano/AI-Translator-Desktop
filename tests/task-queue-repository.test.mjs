import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openAppRepository } from "../backend/persistence/app-repository.mjs";

function task(overrides = {}) {
  return {
    id: "task-1",
    projectId: "project-1",
    kind: "translate",
    label: "Translate zh-CN",
    detail: "Queued",
    stage: "translate",
    status: "pending",
    progress: 0,
    targetLanguageCode: "zh-CN",
    checkpointStage: null,
    lastErrorCode: null,
    retryable: false,
    runSnapshotId: null,
    priority: 0,
    sequence: 0,
    attempt: 0,
    request: { targetLanguages: ["zh-CN"], credentialId: "openai-default" },
    pauseCapability: "checkpoint",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

test("task queue survives reopen and rejects a stale sequence update", () => {
  const appDir = mkdtempSync(join(tmpdir(), "phase8-task-queue-"));
  let repository;
  try {
    repository = openAppRepository(appDir);
    repository.insertTask(task());
    repository.updateTask(task({
      status: "running",
      detail: "Running",
      progress: 10,
      sequence: 1,
      updatedAt: "2026-07-22T12:01:00.000Z",
    }), { expectedSequence: 0 });
    assert.throws(
      () => repository.updateTask(task({ sequence: 2 }), { expectedSequence: 0 }),
      (error) => error.code === "TASK_CONFLICT",
    );
    repository.close();
    repository = null;

    repository = openAppRepository(appDir);
    assert.deepEqual(repository.listTasks(), [task({
      status: "running",
      detail: "Running",
      progress: 10,
      sequence: 1,
      updatedAt: "2026-07-22T12:01:00.000Z",
    })]);
    repository.close();
    repository = null;
  } finally {
    repository?.close();
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("task queue priority survives repository reopen", () => {
  const appDir = mkdtempSync(join(tmpdir(), "p2-task-priority-"));
  let repository;
  try {
    repository = openAppRepository(appDir);
    repository.insertTask(task({ priority: 7 }));
    repository.close();
    repository = openAppRepository(appDir);
    assert.equal(repository.getTask("task-1").priority, 7);
  } finally {
    repository?.close();
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("purging finished tasks never removes a live or recoverable one", () => {
  const appDir = mkdtempSync(join(tmpdir(), "translator-task-purge-"));
  let repository;
  try {
    repository = openAppRepository(appDir);
    // 三条终态 + 四条必须保留的。recoverable 尤其重要：删掉它等于悄悄
    // 拿走用户的恢复能力。
    const rows = [
      ["done-1", "completed"], ["fail-1", "failed"], ["cancel-1", "cancelled"],
      ["live-1", "running"], ["live-2", "pending"], ["live-3", "paused"], ["live-4", "recoverable"],
    ];
    for (const [id, status] of rows) repository.insertTask(task({ id, status }));

    const purged = repository.purgeTerminalTasks();
    assert.equal(purged.deletedCount, 3);
    assert.equal(purged.keptCount, 4);
    assert.deepEqual(
      repository.listTasks().map((entry) => entry.id).sort(),
      ["live-1", "live-2", "live-3", "live-4"],
    );

    // 幂等：再清一次不该报错，也不该再删掉任何东西。
    assert.equal(repository.purgeTerminalTasks().deletedCount, 0);
  } finally {
    repository?.close();
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("purging finished tasks can be scoped to one project", () => {
  const appDir = mkdtempSync(join(tmpdir(), "translator-task-purge-scope-"));
  let repository;
  try {
    repository = openAppRepository(appDir);
    repository.insertTask(task({ id: "a-done", projectId: "project-a", status: "completed" }));
    repository.insertTask(task({ id: "b-done", projectId: "project-b", status: "completed" }));
    repository.insertTask(task({ id: "b-live", projectId: "project-b", status: "running" }));

    const purged = repository.purgeTerminalTasks({ projectId: "project-b" });
    assert.equal(purged.deletedCount, 1);
    // keptCount 只数本次范围内活着的那条，不能把别的项目的终态任务算进来。
    assert.equal(purged.keptCount, 1);
    assert.deepEqual(repository.listTasks().map((entry) => entry.id).sort(), ["a-done", "b-live"]);
  } finally {
    repository?.close();
    rmSync(appDir, { recursive: true, force: true });
  }
});
