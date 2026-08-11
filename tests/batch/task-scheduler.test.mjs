import assert from "node:assert/strict";
import test from "node:test";

import { createTaskScheduler } from "../../backend/tasks/task-scheduler.mjs";

function gate() {
  let release;
  return {
    promise: new Promise((resolve) => { release = resolve; }),
    release,
  };
}

test("scheduler serializes local work and project writes while bounding API concurrency", async () => {
  const scheduler = createTaskScheduler({ localConcurrency: 1, apiConcurrency: 2 });
  const localGate = gate();
  let localActive = 0;
  let localMax = 0;
  const local = ["local-a", "local-b"].map((taskId, index) => scheduler.schedule({
    taskId,
    projectId: `project-${index}`,
    resource: "local",
    execute: async () => {
      localActive += 1;
      localMax = Math.max(localMax, localActive);
      if (index === 0) await localGate.promise;
      localActive -= 1;
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(localMax, 1);
  localGate.release();
  await Promise.all(local);
  assert.equal(localMax, 1);

  const apiGate = gate();
  let apiActive = 0;
  let apiMax = 0;
  const activeByProject = new Map();
  let sameProjectMax = 0;
  const api = ["api-a", "api-b", "api-same-project"].map((taskId, index) => scheduler.schedule({
    taskId,
    projectId: index < 2 ? "shared-project" : "other-project",
    resource: "api",
    execute: async () => {
      apiActive += 1;
      apiMax = Math.max(apiMax, apiActive);
      const projectId = index < 2 ? "shared-project" : "other-project";
      activeByProject.set(projectId, (activeByProject.get(projectId) ?? 0) + 1);
      sameProjectMax = Math.max(sameProjectMax, activeByProject.get(projectId));
      await apiGate.promise;
      activeByProject.set(projectId, activeByProject.get(projectId) - 1);
      apiActive -= 1;
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(apiMax, 2);
  apiGate.release();
  await Promise.all(api);
  assert.equal(apiMax, 2);
  assert.equal(sameProjectMax, 1);
});

test("scheduler rejects duplicate active task ids and prototype resource names", async () => {
  const scheduler = createTaskScheduler();
  const activeGate = gate();
  const active = scheduler.schedule({
    taskId: "task-1",
    projectId: "project-1",
    resource: "api",
    execute: () => activeGate.promise,
  });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    scheduler.schedule({
      taskId: "task-1",
      projectId: "project-2",
      resource: "api",
      execute: async () => {},
    }),
    (error) => error.code === "INVALID_SCHEDULED_TASK",
  );
  await assert.rejects(
    scheduler.schedule({
      taskId: "task-2",
      projectId: "project-2",
      resource: "toString",
      execute: async () => {},
    }),
    (error) => error.code === "INVALID_SCHEDULED_TASK",
  );

  activeGate.release();
  await active;
});
