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
