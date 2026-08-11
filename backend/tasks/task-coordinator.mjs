import {
  WORKER_TASK_STAGES,
  isLegalTransition,
  isWorkerEventSequenceAccepted,
} from "../../shared/worker-task.mjs";

const TASK_KINDS = new Set(["media", "asr", "translate", "qa", "export"]);
const PAUSE_CAPABILITIES = new Set(["never", "checkpoint"]);
const FORBIDDEN_REQUEST_KEY = /api.?key|secret|password|(?:^|_)token$|accessToken|refreshToken|absolutePath|audioPath|workRoot|executablePath|modelPath|cwd|argv|stack/i;
const HOST_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const MAX_REQUEST_BYTES = 32 * 1024;

function taskError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw taskError("INVALID_TASK", `${field} is required`);
  return value;
}

function progress(value) {
  if (!Number.isFinite(value)) throw taskError("INVALID_TASK", "progress must be finite");
  return Math.min(100, Math.max(0, value));
}

function safeTaskRequest(value) {
  const seen = new Set();
  function visit(current, key = "") {
    if (FORBIDDEN_REQUEST_KEY.test(key)) {
      throw taskError("INVALID_TASK_REQUEST", `Task request field ${key} cannot be persisted`);
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw taskError("INVALID_TASK_REQUEST", "Task request number must be finite");
      return;
    }
    if (typeof current === "string") {
      if (HOST_ABSOLUTE_PATH.test(current)) {
        throw taskError("INVALID_TASK_REQUEST", "Task request cannot persist a host absolute path");
      }
      return;
    }
    if (typeof current !== "object" || ArrayBuffer.isView(current)) {
      throw taskError("INVALID_TASK_REQUEST", "Task request contains a non-serializable value");
    }
    if (seen.has(current)) throw taskError("INVALID_TASK_REQUEST", "Task request cannot be cyclic");
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item));
    } else {
      for (const [childKey, childValue] of Object.entries(current)) visit(childValue, childKey);
    }
    seen.delete(current);
  }
  visit(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_REQUEST_BYTES) {
    throw taskError("INVALID_TASK_REQUEST", "Task request snapshot is too large");
  }
  return structuredClone(value);
}

export function createTaskCoordinator({
  queueRepository,
  appendHistory = () => {},
  now = () => new Date().toISOString(),
}) {
  function create(input) {
    const kind = requireString(input.kind, "kind");
    const stage = requireString(input.stage, "stage");
    if (!TASK_KINDS.has(kind) || !WORKER_TASK_STAGES.includes(stage)) {
      throw taskError("INVALID_TASK", "Task kind or stage is invalid");
    }
    const pauseCapability = input.pauseCapability ?? "never";
    if (!PAUSE_CAPABILITIES.has(pauseCapability)) {
      throw taskError("INVALID_TASK", "Task pause capability is invalid");
    }
    if (!input.request || typeof input.request !== "object" || Array.isArray(input.request)) {
      throw taskError("INVALID_TASK", "Task request snapshot must be an object");
    }
    const timestamp = now();
    const task = {
      id: requireString(input.id, "id"),
      projectId: requireString(input.projectId, "projectId"),
      kind,
      label: requireString(input.label, "label"),
      detail: requireString(input.detail, "detail"),
      stage,
      status: "pending",
      progress: 0,
      targetLanguageCode: input.targetLanguageCode ?? null,
      checkpointStage: null,
      lastErrorCode: null,
      retryable: false,
      runSnapshotId: null,
      priority: 0,
      sequence: 0,
      attempt: 0,
      request: safeTaskRequest(input.request),
      pauseCapability,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    queueRepository.insertTask(task);
    appendHistory(task);
    return task;
  }

  function transition(taskId, nextStatus, patch = {}) {
    const current = queueRepository.getTask(taskId);
    if (!current) throw taskError("TASK_NOT_FOUND", "Task not found");
    if (!isLegalTransition(current.status, nextStatus)) {
      throw taskError(
        "INVALID_TASK_TRANSITION",
        `Cannot transition task from ${current.status} to ${nextStatus}`,
      );
    }
    const nextProgress = patch.progress === undefined ? current.progress : progress(patch.progress);
    const retryReset = current.status === "failed" && nextStatus === "recoverable";
    if (nextProgress < current.progress && !retryReset) {
      throw taskError("INVALID_TASK_PROGRESS", "Task progress cannot move backwards");
    }
    const next = {
      ...current,
      ...patch,
      status: nextStatus,
      progress: nextProgress,
      sequence: current.sequence + 1,
      updatedAt: now(),
    };
    queueRepository.updateTask(next, { expectedSequence: current.sequence });
    appendHistory(next);
    return next;
  }

  function plannedStages(task) {
    const stages = task.request?.stages ?? [task.stage];
    if (
      !Array.isArray(stages) || stages.length === 0 ||
      stages.some((stage) => !WORKER_TASK_STAGES.includes(stage)) ||
      new Set(stages).size !== stages.length
    ) {
      throw taskError("INVALID_TASK", "Task stage plan is invalid");
    }
    return stages;
  }

  function persistSameStatus(current, patch) {
    const next = {
      ...current,
      ...patch,
      status: current.status,
      sequence: current.sequence + 1,
      updatedAt: now(),
    };
    queueRepository.updateTask(next, { expectedSequence: current.sequence });
    appendHistory(next);
    return next;
  }

  function updateProgress(taskId, value, detail) {
    const current = queueRepository.getTask(taskId);
    if (!current) throw taskError("TASK_NOT_FOUND", "Task not found");
    if (!["running", "pausing"].includes(current.status)) {
      throw taskError("INVALID_TASK_TRANSITION", "Only active tasks can report progress");
    }
    const nextProgress = progress(value);
    if (nextProgress < current.progress) {
      throw taskError("INVALID_TASK_PROGRESS", "Task progress cannot move backwards");
    }
    const next = {
      ...current,
      progress: nextProgress,
      ...(detail ? { detail } : {}),
      sequence: current.sequence + 1,
      updatedAt: now(),
    };
    queueRepository.updateTask(next, { expectedSequence: current.sequence });
    return next;
  }

  function checkpoint(taskId, completedStage, patch = {}) {
    const current = queueRepository.getTask(taskId);
    if (!current) throw taskError("TASK_NOT_FOUND", "Task not found");
    if (!["running", "pausing"].includes(current.status) || current.stage !== completedStage) {
      throw taskError("INVALID_TASK_CHECKPOINT", "Only the current running stage can be checkpointed");
    }
    const stages = plannedStages(current);
    const index = stages.indexOf(completedStage);
    if (index < 0) throw taskError("INVALID_TASK_CHECKPOINT", "Checkpoint is outside the task plan");
    const nextProgress = patch.progress === undefined ? current.progress : progress(patch.progress);
    if (nextProgress < current.progress) {
      throw taskError("INVALID_TASK_PROGRESS", "Task progress cannot move backwards");
    }
    return persistSameStatus(current, {
      checkpointStage: completedStage,
      stage: stages[index + 1] ?? completedStage,
      progress: nextProgress,
      ...(patch.detail ? { detail: patch.detail } : {}),
      ...(patch.runSnapshotId ? { runSnapshotId: patch.runSnapshotId } : {}),
    });
  }

  function recoveryPlan(taskId) {
    const task = queueRepository.getTask(taskId);
    if (!task) throw taskError("TASK_NOT_FOUND", "Task not found");
    if (task.status !== "recoverable") {
      throw taskError("INVALID_TASK_TRANSITION", "Only recoverable tasks have a recovery plan");
    }
    const stages = plannedStages(task);
    const checkpointIndex = task.checkpointStage === null
      ? -1
      : stages.indexOf(task.checkpointStage);
    if (task.checkpointStage !== null && checkpointIndex < 0) {
      throw taskError("INVALID_TASK_CHECKPOINT", "Stored checkpoint is outside the task plan");
    }
    const resumeFromStage = stages[checkpointIndex + 1];
    if (!resumeFromStage) throw taskError("INVALID_TASK_CHECKPOINT", "Task has no unfinished stage");
    return {
      taskId: task.id,
      projectId: task.projectId,
      resumeFromStage,
      requiresUserConfirmation: true,
    };
  }

  function resume(taskId, { userConfirmed }) {
    if (userConfirmed !== true) {
      throw taskError("USER_CONFIRMATION_REQUIRED", "Task recovery requires explicit confirmation");
    }
    const plan = recoveryPlan(taskId);
    const current = queueRepository.getTask(taskId);
    return transition(taskId, "running", {
      stage: plan.resumeFromStage,
      attempt: current.attempt + 1,
      lastErrorCode: null,
      retryable: false,
      detail: "Resumed after user confirmation",
    });
  }

  function control(taskId, { action, projectId, userConfirmed = false }) {
    const current = queueRepository.getTask(taskId);
    if (!current || current.projectId !== projectId) throw taskError("TASK_NOT_FOUND", "Task not found");
    if (action === "pause") {
      if (current.status === "pending") {
        return transition(taskId, "paused", { detail: "Paused before start" });
      }
      if (current.pauseCapability !== "checkpoint") {
        throw taskError("TASK_NOT_PAUSABLE", "This task can only stop or cancel at its current stage");
      }
      return transition(taskId, "pausing", { detail: "Pausing at the next safe checkpoint" });
    }
    if (action === "prioritize") {
      if (current.status !== "pending") {
        throw taskError("INVALID_TASK_TRANSITION", "Only pending tasks can be moved next");
      }
      const highestPriority = queueRepository.listTasks().reduce(
        (highest, task) => task.status === "pending" ? Math.max(highest, task.priority ?? 0) : highest,
        0,
      );
      return persistSameStatus(current, {
        priority: highestPriority + 1,
        detail: "Queued next",
      });
    }
    if (action === "resume") {
      if (current.status === "recoverable") return resume(taskId, { userConfirmed });
      if (current.status !== "paused") {
        throw taskError("INVALID_TASK_TRANSITION", "Only paused or recoverable tasks can resume");
      }
      return transition(taskId, "running", { detail: "Resumed" });
    }
    if (action === "cancel") {
      return transition(taskId, "cancelling", { detail: "Cancellation requested" });
    }
    if (action === "retry") {
      if (userConfirmed !== true) {
        throw taskError("USER_CONFIRMATION_REQUIRED", "Task retry requires explicit confirmation");
      }
      if (current.status !== "failed") {
        throw taskError("INVALID_TASK_TRANSITION", "Only failed tasks can retry");
      }
      transition(taskId, "recoverable", {
        progress: 0,
        checkpointStage: null,
        detail: "Retry confirmed",
      });
      return resume(taskId, { userConfirmed: true });
    }
    throw taskError("INVALID_TASK_CONTROL", "Task control action is invalid");
  }

  function finishCancellation(taskId) {
    return transition(taskId, "cancelled", { detail: "Cancelled" });
  }

  function reconcileInterrupted() {
    return queueRepository.listTasks()
      .filter((task) => ["pending", "running", "pausing", "cancelling"].includes(task.status))
      .map((task) => task.status === "cancelling"
        ? transition(task.id, "cancelled", {
            detail: "Cancelled during application shutdown",
          })
        : transition(task.id, "recoverable", {
            detail: task.status === "pending"
              ? "Queued before restart; waiting for user confirmation"
              : "Interrupted; waiting for user confirmation",
            lastErrorCode: "WORKER_INTERRUPTED",
            retryable: true,
          }));
  }

  function acceptEvent(event) {
    const current = queueRepository.getTask(event?.taskId);
    if (!current) return { accepted: false, reason: "task_not_found" };
    if (event.projectId !== current.projectId || event.stage !== current.stage) {
      return { accepted: false, reason: "identity_mismatch" };
    }
    if (!isWorkerEventSequenceAccepted(current.sequence, event.sequence)) {
      return { accepted: false, reason: "stale_sequence" };
    }
    if (event.type === "progress") {
      if (!Number.isFinite(event.progress) || event.progress < current.progress) {
        return { accepted: false, reason: "progress_backwards" };
      }
      const next = {
        ...current,
        progress: progress(event.progress),
        sequence: event.sequence,
        updatedAt: now(),
      };
      queueRepository.updateTask(next, { expectedSequence: current.sequence });
      return { accepted: true, task: next };
    }
    if (event.type === "status") {
      if (!isLegalTransition(current.status, event.status)) {
        return { accepted: false, reason: "invalid_transition" };
      }
      const next = {
        ...current,
        status: event.status,
        progress: event.progress === undefined ? current.progress : progress(event.progress),
        checkpointStage: event.checkpointStage ?? current.checkpointStage,
        lastErrorCode: event.errorCode ?? current.lastErrorCode,
        sequence: event.sequence,
        updatedAt: now(),
      };
      if (next.progress < current.progress) return { accepted: false, reason: "progress_backwards" };
      queueRepository.updateTask(next, { expectedSequence: current.sequence });
      appendHistory(next);
      return { accepted: true, task: next };
    }
    if (event.type === "log") {
      const next = { ...current, sequence: event.sequence, updatedAt: now() };
      queueRepository.updateTask(next, { expectedSequence: current.sequence });
      return { accepted: true, task: next };
    }
    return { accepted: false, reason: "invalid_event" };
  }

  return {
    create,
    transition,
    checkpoint,
    updateProgress,
    recoveryPlan,
    resume,
    control,
    finishCancellation,
    reconcileInterrupted,
    acceptEvent,
    get: (taskId) => queueRepository.getTask(taskId),
    list: () => queueRepository.listTasks(),
  };
}
