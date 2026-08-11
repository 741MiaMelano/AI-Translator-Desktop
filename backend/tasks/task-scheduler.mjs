function schedulerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createTaskScheduler({ localConcurrency = 1, apiConcurrency = 4 } = {}) {
  const limits = { local: localConcurrency, api: apiConcurrency };
  if (Object.values(limits).some((value) => !Number.isInteger(value) || value < 1 || value > 32)) {
    throw schedulerError("INVALID_SCHEDULER_LIMIT", "Scheduler limits must be integers from 1 to 32");
  }
  const queue = [];
  const active = { local: 0, api: 0 };
  const activeProjects = new Set();
  const activeTaskIds = new Set();
  let order = 0;

  function sortQueue() {
    queue.sort((left, right) => right.priority - left.priority || left.order - right.order);
  }

  function drain() {
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      if (active[entry.resource] >= limits[entry.resource] || activeProjects.has(entry.projectId)) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      active[entry.resource] += 1;
      activeProjects.add(entry.projectId);
      activeTaskIds.add(entry.taskId);
      Promise.resolve()
        .then(entry.execute)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active[entry.resource] -= 1;
          activeProjects.delete(entry.projectId);
          activeTaskIds.delete(entry.taskId);
          drain();
        });
    }
  }

  function schedule({ taskId, projectId, resource, priority = 0, execute }) {
    if (
      typeof taskId !== "string" || !taskId
      || typeof projectId !== "string" || !projectId
      || !Object.hasOwn(limits, resource)
      || typeof execute !== "function"
      || !Number.isSafeInteger(priority) || priority < 0
      || activeTaskIds.has(taskId)
      || queue.some((entry) => entry.taskId === taskId)
    ) {
      return Promise.reject(schedulerError("INVALID_SCHEDULED_TASK", "Scheduled task is invalid"));
    }
    const promise = new Promise((resolve, reject) => {
      order += 1;
      queue.push({ taskId, projectId, resource, priority, order, execute, resolve, reject });
      sortQueue();
    });
    drain();
    return promise;
  }

  return {
    schedule,
    prioritize(taskId, priority) {
      const entry = queue.find((item) => item.taskId === taskId);
      if (!entry || !Number.isSafeInteger(priority) || priority < 0) return false;
      entry.priority = priority;
      sortQueue();
      return true;
    },
    cancel(taskId) {
      const index = queue.findIndex((entry) => entry.taskId === taskId);
      if (index < 0) return false;
      const [entry] = queue.splice(index, 1);
      entry.reject(schedulerError("CANCELLED", "Scheduled task was cancelled"));
      return true;
    },
    hasPending: () => queue.length > 0,
    stats: () => ({ pending: queue.length, active: { ...active }, limits: { ...limits } }),
  };
}
