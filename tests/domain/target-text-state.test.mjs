import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAutomaticModelText,
  applyBatchReplace,
  applyCandidateAdopt,
  applyExplicitRerunResult,
  getEffectiveTargetText,
  isAutoProtectedTargetLayer,
  isLockedTargetLayer,
  isStaleTargetLayer,
  markStaleTargetText,
  revertToPreviousManual,
  setLockedTargetText,
  setManualTargetText,
} from "../../shared/target-text-state.mjs";

function layer(overrides = {}) {
  return {
    model: "model-text",
    postProcessed: "post-text",
    qaFlags: [],
    stale: false,
    ...overrides,
  };
}

test("effective text prefers manual over postProcessed over model", () => {
  assert.equal(getEffectiveTargetText(layer({ manual: "人工" })), "人工");
  assert.equal(getEffectiveTargetText(layer({ postProcessed: "后处理" })), "后处理");
  assert.equal(getEffectiveTargetText(layer({ postProcessed: "", model: "模型" })), "模型");
});

test("manual, previousManual and locked are auto-protected", () => {
  assert.equal(isAutoProtectedTargetLayer(layer({ manual: "人工" })), true);
  assert.equal(isAutoProtectedTargetLayer(layer({ previousManual: "旧人工" })), true);
  assert.equal(isAutoProtectedTargetLayer(layer({ locked: true })), true);
  assert.equal(isAutoProtectedTargetLayer(layer()), false);
});

test("ordinary automatic model write skips manual", () => {
  const current = layer({ manual: "人工", model: "old", postProcessed: "old" });
  const result = applyAutomaticModelText(current, "NEW");
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "protected");
  assert.equal(result.layer.manual, "人工");
  assert.equal(result.layer.model, "old");
  assert.equal(result.layer.postProcessed, "old");
});

test("ordinary automatic model write skips locked", () => {
  const current = layer({ locked: true, model: "old", postProcessed: "old" });
  const result = applyAutomaticModelText(current, "NEW");
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "protected");
  assert.equal(result.layer.locked, true);
  assert.equal(result.layer.model, "old");
});

test("ordinary automatic model write skips previousManual-only layers", () => {
  const current = layer({ previousManual: "旧人工", model: "old", postProcessed: "old" });
  const result = applyAutomaticModelText(current, "NEW");
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.layer.previousManual, "旧人工");
  assert.equal(result.layer.model, "old");
});

test("cache-style automatic write updates unprotected layers and clears stale", () => {
  const current = layer({ model: "old", postProcessed: "old", stale: true });
  const result = applyAutomaticModelText(current, "cached");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.layer.model, "cached");
  assert.equal(result.layer.postProcessed, "cached");
  assert.equal(result.layer.stale, false);
});

test("batch replace skips locked and manual", () => {
  const locked = applyBatchReplace(layer({ locked: true, postProcessed: "hello world" }), "hello", "hi");
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "locked");
  assert.equal(locked.layer.postProcessed, "hello world");

  const manual = applyBatchReplace(layer({ manual: "hello world" }), "hello", "hi");
  assert.equal(manual.ok, false);
  assert.equal(manual.reason, "manual");
  assert.equal(manual.layer.manual, "hello world");
});

test("batch replace rewrites unprotected postProcessed and model", () => {
  const result = applyBatchReplace(
    layer({ model: "hello world", postProcessed: "hello world" }),
    "hello",
    "hi",
  );
  assert.equal(result.ok, true);
  assert.equal(result.layer.model, "hi world");
  assert.equal(result.layer.postProcessed, "hi world");
});

test("candidate adopt skips locked and default-skips manual", () => {
  const locked = applyCandidateAdopt(layer({ locked: true, model: "old" }), "candidate");
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "locked");
  assert.equal(locked.layer.model, "old");

  const manual = applyCandidateAdopt(layer({ manual: "人工", model: "old" }), "candidate");
  assert.equal(manual.ok, false);
  assert.equal(manual.reason, "manual");
  assert.equal(manual.layer.manual, "人工");
  assert.equal(manual.layer.model, "old");
});

test("candidate adopt updates unprotected active text", () => {
  const result = applyCandidateAdopt(layer({ model: "old", postProcessed: "old", stale: true }), "candidate");
  assert.equal(result.ok, true);
  assert.equal(result.layer.model, "candidate");
  assert.equal(result.layer.postProcessed, "candidate");
  assert.equal(result.layer.stale, false);
});

test("explicit rerun saves previousManual, clears manual, writes model", () => {
  const current = layer({
    manual: "人工稿",
    previousManual: "更早",
    model: "old-model",
    postProcessed: "old-post",
    stale: true,
  });
  const result = applyExplicitRerunResult(current, "new-model");
  assert.equal(result.ok, true);
  assert.equal(result.layer.manual, undefined);
  assert.equal(result.layer.previousManual, "人工稿");
  assert.equal(result.layer.model, "new-model");
  assert.equal(result.layer.postProcessed, "new-model");
  assert.equal(result.layer.stale, false);
});

test("explicit rerun is blocked by locked absolute protection", () => {
  const result = applyExplicitRerunResult(
    layer({ locked: true, manual: "人工", model: "old" }),
    "new-model",
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "locked");
  assert.equal(result.layer.manual, "人工");
  assert.equal(result.layer.model, "old");
  assert.equal(isLockedTargetLayer(result.layer), true);
});

test("revert restores previousManual into manual", () => {
  const result = revertToPreviousManual(
    layer({
      model: "new-model",
      postProcessed: "new-model",
      previousManual: "人工稿",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.layer.manual, "人工稿");
  assert.equal(result.layer.previousManual, "人工稿");
  assert.equal(getEffectiveTargetText(result.layer), "人工稿");
});

test("revert fails without previousManual and when locked", () => {
  assert.equal(revertToPreviousManual(layer()).ok, false);
  assert.equal(revertToPreviousManual(layer({ previousManual: "x", locked: true })).reason, "locked");
});

test("setManual and lock transitions preserve protection invariants", () => {
  const edited = setManualTargetText(layer({ model: "m", postProcessed: "p" }), " 人工 ");
  assert.equal(edited.ok, true);
  assert.equal(edited.layer.manual, " 人工 ");
  assert.equal(isAutoProtectedTargetLayer(edited.layer), true);

  const locked = setLockedTargetText(edited.layer, true);
  assert.equal(locked.layer.locked, true);
  assert.equal(setManualTargetText(locked.layer, "改不动").ok, false);

  const unlocked = setLockedTargetText(locked.layer, false);
  assert.equal(unlocked.layer.locked, undefined);
});

test("stale is an explicit target-text state flag", () => {
  const stale = markStaleTargetText(layer({ manual: "人工" }));
  assert.equal(stale.ok, true);
  assert.equal(stale.layer.stale, true);
  assert.equal(isStaleTargetLayer(stale.layer), true);
  assert.equal(stale.layer.manual, "人工");
});
