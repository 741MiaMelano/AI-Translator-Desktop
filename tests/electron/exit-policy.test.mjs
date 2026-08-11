import assert from "node:assert/strict";
import test from "node:test";
import { decideExitBehavior, resolveAutomatedExitResponse } from "../../electron/exit-policy.ts";

test("automated exit choices are available only to the fake-provider E2E boundary", () => {
  assert.equal(resolveAutomatedExitResponse({ fakeProvider: true, choice: "background" }), 0);
  assert.equal(resolveAutomatedExitResponse({ fakeProvider: true, choice: "stop" }), 1);
  assert.equal(resolveAutomatedExitResponse({ fakeProvider: true, choice: "cancel" }), 2);
  assert.equal(resolveAutomatedExitResponse({ fakeProvider: false, choice: "stop" }), null);
  assert.equal(resolveAutomatedExitResponse({ fakeProvider: true, choice: "invalid" }), null);
});

test("exit policy exits immediately when no task is active", async () => {
  let prompts = 0;
  assert.equal(await decideExitBehavior({
    hasActiveTasks: false,
    prompt: async () => { prompts += 1; return 2; },
  }), "exit");
  assert.equal(prompts, 0);
});

test("exit policy maps the three active-task choices without a hidden default", async () => {
  for (const [response, expected] of [[0, "background"], [1, "stop"], [2, "cancel"]]) {
    assert.equal(await decideExitBehavior({
      hasActiveTasks: true,
      prompt: async () => response,
    }), expected);
  }
});
