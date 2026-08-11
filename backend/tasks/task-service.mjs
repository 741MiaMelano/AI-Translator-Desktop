import { randomUUID } from "node:crypto";
import { createTaskScheduler } from "./task-scheduler.mjs";

function taskError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function persistedInput(input) {
  return JSON.parse(JSON.stringify(input));
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : "TASK_FAILED";
}

function safeErrorMessage(error) {
  return String(error?.message || "Task failed")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .slice(0, 240);
}

export function createTaskService({
  coordinator,
  publish = () => {},
  idFactory = (operation) => `task-${operation.replaceAll(".", "-")}-${randomUUID()}`,
  scheduler = createTaskScheduler(),
}) {
  const descriptors = new Map();
  const active = new Map();
  const scheduled = new Map();
  const statusWaiters = new Set();

  function descriptorFor(operation) {
    const descriptor = descriptors.get(operation);
    if (!descriptor) throw taskError("TASK_EXECUTOR_UNAVAILABLE", "Task executor is unavailable");
    return descriptor;
  }

  function emit(task) {
    publish({
      type: "status",
      taskId: task.id,
      projectId: task.projectId,
      stage: task.stage,
      sequence: task.sequence,
      timestamp: task.updatedAt,
      status: task.status,
      progress: task.progress,
      ...(task.checkpointStage ? { checkpointStage: task.checkpointStage } : {}),
      ...(task.lastErrorCode ? { errorCode: task.lastErrorCode } : {}),
    });
    for (const waiter of statusWaiters) {
      if (waiter.taskId === task.id && waiter.status === task.status) {
        statusWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(task);
      }
    }
    return task;
  }

  function emitProgress(task) {
    publish({
      type: "progress",
      taskId: task.id,
      projectId: task.projectId,
      stage: task.stage,
      sequence: task.sequence,
      timestamp: task.updatedAt,
      progress: task.progress,
      message: task.detail,
    });
    return task;
  }

  function createPauseGate(record) {
    if (record.pauseGate) return record.pauseGate.promise;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    record.pauseGate = { promise, resolve };
    return promise;
  }

  function launch(task, descriptor) {
    if (active.has(task.id)) throw taskError("TASK_ALREADY_RUNNING", "Task is already running");
    const controller = new AbortController();
    const record = {
      controller,
      descriptor,
      input: task.request.input,
      pauseGate: null,
      promise: null,
      cancelPromise: null,
    };
    const context = {
      taskId: task.id,
      projectId: task.projectId,
      signal: controller.signal,
      get task() { return coordinator.get(task.id); },
      reportProgress(value, detail) {
        return emitProgress(coordinator.updateProgress(task.id, value, detail));
      },
      async checkpoint(completedStage, patch = {}) {
        const checkpointed = emit(coordinator.checkpoint(task.id, completedStage, patch));
        if (checkpointed.status !== "pausing") return checkpointed;
        createPauseGate(record);
        emit(coordinator.transition(task.id, "paused", {
          detail: "Paused at a safe checkpoint",
        }));
        await record.pauseGate.promise;
        return coordinator.get(task.id);
      },
    };
    const promise = (async () => {
      try {
        const result = await descriptor.execute(record.input, context);
        const current = coordinator.get(task.id);
        if (current.status === "cancelling") {
          emit(coordinator.finishCancellation(task.id));
          throw taskError("CANCELLED", "Task was cancelled");
        }
        if (current.status === "recoverable") {
          throw taskError("WORKER_CRASHED", "Task was interrupted");
        }
        emit(coordinator.transition(task.id, "completed", {
          progress: 100,
          detail: "Completed",
          lastErrorCode: null,
          retryable: false,
        }));
        return result;
      } catch (error) {
        const current = coordinator.get(task.id);
        if (current?.status === "cancelling") {
          emit(coordinator.finishCancellation(task.id));
          if (error?.code === "CANCELLED") throw error;
          throw taskError("CANCELLED", "Task was cancelled");
        }
        if (current?.status === "recoverable" || current?.status === "cancelled") throw error;
        if (["running", "pausing"].includes(current?.status)) {
          emit(coordinator.transition(task.id, "failed", {
            detail: safeErrorMessage(error),
            lastErrorCode: safeErrorCode(error),
            retryable: Boolean(error?.retryable),
          }));
        }
        throw error;
      } finally {
        active.delete(task.id);
      }
    })();
    record.promise = promise;
    active.set(task.id, record);
    return promise;
  }

  function schedule(task, descriptor) {
    const promise = scheduler.schedule({
      taskId: task.id,
      projectId: task.projectId,
      resource: descriptor.resource ?? (task.kind === "translate" ? "api" : "local"),
      priority: task.priority ?? 0,
      execute: () => {
        const current = coordinator.get(task.id);
        if (current.status === "pending") {
          return launch(emit(coordinator.transition(task.id, "running", { detail: "Running" })), descriptor);
        }
        if (current.status === "running") return launch(current, descriptor);
        throw taskError("CANCELLED", "Task left the runnable queue");
      },
    });
    scheduled.set(task.id, promise);
    promise.then(
      () => scheduled.delete(task.id),
      () => scheduled.delete(task.id),
    );
    return promise;
  }

  function register(operation, descriptor) {
    if (typeof operation !== "string" || !operation || descriptors.has(operation)) {
      throw taskError("INVALID_TASK_EXECUTOR", "Task operation must be unique");
    }
    if (typeof descriptor?.execute !== "function" || typeof descriptor?.label !== "function") {
      throw taskError("INVALID_TASK_EXECUTOR", "Task executor is invalid");
    }
    descriptors.set(operation, Object.freeze({ ...descriptor }));
  }

  function queue(operation, input) {
    const descriptor = descriptorFor(operation);
    const requestInput = persistedInput(input);
    const task = emit(coordinator.create({
      id: idFactory(operation, requestInput),
      projectId: requestInput.projectId,
      kind: descriptor.kind,
      label: descriptor.label(requestInput),
      detail: descriptor.detail?.(requestInput) ?? "Queued",
      stage: descriptor.stage,
      request: {
        operation,
        input: requestInput,
        stages: descriptor.stages ?? [descriptor.stage],
      },
      pauseCapability: descriptor.pauseCapability,
      targetLanguageCode: descriptor.targetLanguageCode?.(requestInput) ?? null,
    }));
    return { task, promise: schedule(task, descriptor) };
  }

  async function run(operation, input) {
    return queue(operation, input).promise;
  }

  function enqueue(operation, input) {
    const queued = queue(operation, input);
    queued.promise.catch(() => {});
    return queued.task;
  }

  function control(command) {
    const before = coordinator.get(command.taskId);
    const operation = before?.request?.operation;
    const descriptor = operation ? descriptorFor(operation) : null;
    const next = emit(coordinator.control(command.taskId, command));
    const record = active.get(command.taskId);
    if (command.action === "prioritize") {
      if (!scheduler.prioritize(command.taskId, next.priority ?? 0)) {
        throw taskError("INVALID_TASK_TRANSITION", "Only queued tasks can be moved next");
      }
      return next;
    }
    if (command.action === "pause") {
      if (next.status === "paused") scheduler.cancel(command.taskId);
      return next;
    }
    if (command.action === "cancel") {
      scheduler.cancel(command.taskId);
      record?.controller.abort();
      if (record && typeof descriptor.cancel === "function") {
        record.cancelPromise = Promise.resolve(
          descriptor.cancel(record.input, { taskId: command.taskId }),
        ).catch(() => {});
      }
      if (record?.pauseGate) record.pauseGate.resolve();
      if (!record) return emit(coordinator.finishCancellation(command.taskId));
      return next;
    }
    if (command.action === "resume" && record?.pauseGate) {
      const gate = record.pauseGate;
      record.pauseGate = null;
      gate.resolve();
      return next;
    }
    if (["resume", "retry"].includes(command.action) && !record) {
      const promise = schedule(next, descriptor);
      promise.catch(() => {});
    }
    return next;
  }

  function waitForStatus(taskId, status, timeoutMs = 2_000) {
    const current = coordinator.get(taskId);
    if (current?.status === status) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const waiter = { taskId, status, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        statusWaiters.delete(waiter);
        reject(taskError("TIMEOUT", `Task did not reach ${status}`));
      }, timeoutMs);
      waiter.timer.unref?.();
      statusWaiters.add(waiter);
    });
  }

  return {
    register,
    run,
    enqueue,
    control,
    waitForStatus,
    waitForIdle(taskId) {
      return scheduled.get(taskId) ?? active.get(taskId)?.promise ?? Promise.resolve();
    },
    hasActiveTasks: () => active.size > 0 || scheduled.size > 0,
    async stopAll() {
      const promises = [...scheduled.values()];
      const taskIds = new Set([...scheduled.keys(), ...active.keys()]);
      for (const taskId of taskIds) {
        const record = active.get(taskId);
        const task = coordinator.get(taskId);
        if (task?.status === "cancelling" && record) {
          record.controller.abort();
          record.pauseGate?.resolve();
          if (typeof record.descriptor.cancel === "function") {
            record.cancelPromise = Promise.resolve(
              record.descriptor.cancel(record.input, { taskId }),
            ).catch(() => {});
          }
        } else if (["pending", "running", "pausing", "paused", "recoverable"].includes(task?.status)) {
          control({ taskId, projectId: task.projectId, action: "cancel" });
        }
      }
      await Promise.allSettled([
        ...promises,
        ...[...active.values()].flatMap((record) =>
          record.cancelPromise ? [record.promise, record.cancelPromise] : [record.promise]),
      ]);
    },
  };
}
