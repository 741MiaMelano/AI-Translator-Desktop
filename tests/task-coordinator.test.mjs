import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openAppRepository } from "../backend/persistence/app-repository.mjs";
import { openProjectRepository } from "../backend/persistence/project-repository.mjs";
import { createTaskCoordinator } from "../backend/tasks/task-coordinator.mjs";

function withCoordinator(run) {
  const appDir = mkdtempSync(join(tmpdir(), "phase8-task-coordinator-"));
  const repository = openAppRepository(appDir);
  const coordinator = createTaskCoordinator({
    queueRepository: repository,
    now: () => "2026-07-22T12:00:00.000Z",
  });
  try {
    return run({ coordinator, repository });
  } finally {
    repository.close();
    rmSync(appDir, { recursive: true, force: true });
  }
}

function createTranslationTask(coordinator) {
  return coordinator.create({
    id: "task-1",
    projectId: "project-1",
    kind: "translate",
    label: "Translate zh-CN",
    detail: "Queued",
    stage: "translate",
    targetLanguageCode: "zh-CN",
    request: { targetLanguages: ["zh-CN"], credentialId: "openai-default" },
    pauseCapability: "checkpoint",
  });
}

test("task coordinator persists only legal state transitions", () => withCoordinator(({ coordinator }) => {
  assert.equal(createTranslationTask(coordinator).status, "pending");
  assert.throws(
    () => coordinator.transition("task-1", "completed"),
    (error) => error.code === "INVALID_TASK_TRANSITION",
  );
  assert.equal(coordinator.get("task-1").status, "pending");
  const running = coordinator.transition("task-1", "running", { progress: 10, detail: "Running" });
  assert.equal(running.status, "running");
  assert.equal(running.sequence, 1);
  assert.equal(running.progress, 10);
}));

test("only pending tasks can be persisted as the next queue item", () => withCoordinator(({ coordinator }) => {
  const first = createTranslationTask(coordinator);
  const prioritized = coordinator.control(first.id, {
    action: "prioritize",
    projectId: first.projectId,
  });
  assert.equal(prioritized.priority, 1);
  assert.equal(coordinator.get(first.id).priority, 1);
  coordinator.transition(first.id, "running");
  assert.throws(
    () => coordinator.control(first.id, { action: "prioritize", projectId: first.projectId }),
    (error) => error.code === "INVALID_TASK_TRANSITION",
  );
}));

test("each accepted transition appends one sequenced project history record", () => {
  const root = mkdtempSync(join(tmpdir(), "phase8-task-history-"));
  const appRepository = openAppRepository(join(root, "app"));
  const projectRepository = openProjectRepository(join(root, "project"));
  const appendHistory = (task) => projectRepository.appendTaskHistory({
    ...task,
    id: `${task.id}:${task.sequence}`,
    queueTaskId: task.id,
    recordedAt: task.updatedAt,
  });
  const coordinator = createTaskCoordinator({
    queueRepository: appRepository,
    appendHistory,
    now: () => "2026-07-22T12:00:00.000Z",
  });
  try {
    createTranslationTask(coordinator);
    coordinator.transition("task-1", "running", { progress: 10 });
    const history = projectRepository.listTaskHistory();
    assert.deepEqual(history.map((event) => event.sequence), [1, 0]);
    assert.deepEqual(history.map((event) => event.queueTaskId), ["task-1", "task-1"]);
  } finally {
    projectRepository.close();
    appRepository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery requires confirmation and resumes after the last successful checkpoint", () => withCoordinator(({ coordinator }) => {
  coordinator.create({
    id: "task-pipeline",
    projectId: "project-1",
    kind: "asr",
    label: "Transcribe and segment",
    detail: "Queued",
    stage: "extract",
    request: { stages: ["extract", "asr", "segment"] },
    pauseCapability: "checkpoint",
  });
  coordinator.transition("task-pipeline", "running");
  coordinator.checkpoint("task-pipeline", "extract", { progress: 25 });
  coordinator.transition("task-pipeline", "recoverable", { lastErrorCode: "WORKER_CRASHED" });

  assert.deepEqual(coordinator.recoveryPlan("task-pipeline"), {
    taskId: "task-pipeline",
    projectId: "project-1",
    resumeFromStage: "asr",
    requiresUserConfirmation: true,
  });
  assert.throws(
    () => coordinator.resume("task-pipeline", { userConfirmed: false }),
    (error) => error.code === "USER_CONFIRMATION_REQUIRED",
  );
  const resumed = coordinator.resume("task-pipeline", { userConfirmed: true });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.stage, "asr");
  assert.equal(resumed.checkpointStage, "extract");
  assert.equal(resumed.attempt, 1);
}));

test("durable task requests reject secrets and host absolute paths", () => withCoordinator(({ coordinator }) => {
  const base = {
    id: "task-sensitive",
    projectId: "project-1",
    kind: "translate",
    label: "Translate",
    detail: "Queued",
    stage: "translate",
    pauseCapability: "checkpoint",
  };
  assert.throws(
    () => coordinator.create({ ...base, request: { apiKey: "sk-must-not-persist" } }),
    (error) => error.code === "INVALID_TASK_REQUEST",
  );
  assert.throws(
    () => coordinator.create({ ...base, request: { audioPath: "C:\\private\\audio.wav" } }),
    (error) => error.code === "INVALID_TASK_REQUEST",
  );
  assert.doesNotThrow(() => coordinator.create({
    ...base,
    id: "task-safe",
    request: { credentialId: "openai-default", artifactId: "primary", stages: ["translate"] },
  }));
}));

test("startup reconciliation never auto-runs interrupted work", () => withCoordinator(({ coordinator }) => {
  for (const id of ["running", "pausing", "cancelling"]) {
    coordinator.create({
      id,
      projectId: "project-1",
      kind: "asr",
      label: id,
      detail: "Queued",
      stage: "asr",
      request: { stages: ["asr"] },
      pauseCapability: "checkpoint",
    });
    coordinator.transition(id, "running");
  }
  coordinator.transition("pausing", "pausing");
  coordinator.transition("cancelling", "cancelling");
  coordinator.create({
    id: "pending",
    projectId: "project-1",
    kind: "translate",
    label: "pending",
    detail: "Queued",
    stage: "translate",
    request: { stages: ["translate"] },
    pauseCapability: "never",
  });

  const reconciled = coordinator.reconcileInterrupted();

  assert.deepEqual(reconciled.map((task) => [task.id, task.status]), [
    ["cancelling", "cancelled"],
    ["pausing", "recoverable"],
    ["pending", "recoverable"],
    ["running", "recoverable"],
  ]);
  assert.equal(coordinator.list().some((task) => task.status === "running"), false);
}));

test("worker events reject duplicate, out-of-order, and backwards progress", () => withCoordinator(({ coordinator }) => {
  createTranslationTask(coordinator);
  coordinator.transition("task-1", "running");
  const event = {
    type: "progress",
    taskId: "task-1",
    projectId: "project-1",
    stage: "translate",
    sequence: 2,
    timestamp: "2026-07-22T12:00:01.000Z",
    progress: 50,
    message: "Half complete",
  };

  assert.equal(coordinator.acceptEvent(event).accepted, true);
  assert.deepEqual(coordinator.acceptEvent(event), { accepted: false, reason: "stale_sequence" });
  assert.deepEqual(coordinator.acceptEvent({ ...event, sequence: 1 }), { accepted: false, reason: "stale_sequence" });
  assert.deepEqual(coordinator.acceptEvent({ ...event, sequence: 3, progress: 40 }), {
    accepted: false,
    reason: "progress_backwards",
  });
  assert.equal(coordinator.get("task-1").progress, 50);
  assert.equal(coordinator.get("task-1").sequence, 2);
}));

test("task controls enforce pause capability, cancellation, and explicit paid retry", () => withCoordinator(({ coordinator }) => {
  createTranslationTask(coordinator);
  coordinator.transition("task-1", "running");
  assert.equal(coordinator.control("task-1", { action: "pause", projectId: "project-1" }).status, "pausing");
  coordinator.transition("task-1", "paused", { checkpointStage: "translate" });
  assert.equal(coordinator.control("task-1", { action: "resume", projectId: "project-1" }).status, "running");
  assert.equal(coordinator.control("task-1", { action: "cancel", projectId: "project-1" }).status, "cancelling");
  assert.equal(coordinator.finishCancellation("task-1").status, "cancelled");

  coordinator.create({
    id: "task-never-pause",
    projectId: "project-1",
    kind: "media",
    label: "Probe",
    detail: "Queued",
    stage: "detect",
    request: { operation: "media.probe", input: { projectId: "project-1" } },
    pauseCapability: "never",
  });
  coordinator.transition("task-never-pause", "running");
  assert.throws(
    () => coordinator.control("task-never-pause", { action: "pause", projectId: "project-1" }),
    (error) => error.code === "TASK_NOT_PAUSABLE",
  );
  coordinator.transition("task-never-pause", "failed", { lastErrorCode: "PROCESS_FAILED" });
  assert.throws(
    () => coordinator.control("task-never-pause", { action: "retry", projectId: "project-1", userConfirmed: false }),
    (error) => error.code === "USER_CONFIRMATION_REQUIRED",
  );
  const retried = coordinator.control("task-never-pause", {
    action: "retry",
    projectId: "project-1",
    userConfirmed: true,
  });
  assert.equal(retried.status, "running");
  assert.equal(retried.attempt, 1);
  assert.equal(retried.progress, 0);
}));
