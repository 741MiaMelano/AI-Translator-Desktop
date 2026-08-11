import assert from "node:assert/strict";
import test from "node:test";
import { createTaskEventPublisher } from "../../electron/task-event-publisher.ts";

function event(sequence, patch = {}) {
  return {
    type: "progress",
    taskId: "task-1",
    projectId: "project-1",
    stage: "translate",
    sequence,
    timestamp: `2026-07-22T12:00:0${sequence}.000Z`,
    progress: sequence * 10,
    ...patch,
  };
}

test("task event publisher drops stale events and coalesces progress without reordering", async () => {
  const sent = [];
  const publisher = createTaskEventPublisher({ send: (value) => sent.push(value), throttleMs: 10 });
  publisher.publish(event(1));
  publisher.publish(event(2));
  publisher.publish(event(2, { progress: 99 }));
  publisher.publish(event(3));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(sent.map((value) => value.sequence), [1, 3]);
  assert.deepEqual(sent.map((value) => value.progress), [10, 30]);
  publisher.close();
});

test("status is immediate and supersedes an older throttled progress event", async () => {
  const sent = [];
  const publisher = createTaskEventPublisher({ send: (value) => sent.push(value), throttleMs: 20 });
  publisher.publish(event(1));
  publisher.publish(event(2));
  publisher.publish(event(3, { type: "status", status: "completed", progress: 100 }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(sent.map((value) => [value.sequence, value.type]), [[1, "progress"], [3, "status"]]);
  publisher.close();
});

test("duplicate logs are suppressed and messages are bounded and sanitized", async () => {
  const sent = [];
  const publisher = createTaskEventPublisher({ send: (value) => sent.push(value), throttleMs: 5 });
  publisher.publish(event(1, {
    type: "log",
    level: "warn",
    message: "failed C:\\Users\\Le\\private.txt apiKey=secret-value",
  }));
  publisher.publish(event(2, {
    type: "log",
    level: "warn",
    message: "failed C:\\Users\\Le\\private.txt apiKey=secret-value",
  }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.includes("private.txt"), false);
  assert.equal(sent[0].message.includes("secret-value"), false);
  publisher.close();
});
