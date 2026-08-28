import test from "node:test";
import assert from "node:assert/strict";

import {
  applySelectedSegmentRerunResult,
  planSelectedSegmentRerun,
  withSelectedSegmentCoverage,
} from "../../shared/selected-segment-rerun.mjs";

function seg(id, text, target = {}) {
  return {
    id,
    start: "00:00:01,000",
    end: "00:00:02,000",
    sourceLanguage: "en",
    sourceText: { original: text, normalized: text },
    targetTexts: {
      "zh-CN": {
        model: `old-${id}`,
        postProcessed: `old-${id}`,
        qaFlags: [],
        ...target,
      },
    },
  };
}

test("plan request id set is exactly the selected unlocked segments", () => {
  const segments = [seg("a", "A"), seg("b", "B"), seg("c", "C"), seg("d", "D")];
  const plan = planSelectedSegmentRerun({
    segments,
    selectedSegmentIds: ["b", "c"],
    languageCode: "zh-CN",
    contextRadius: 1,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.requestSegmentIds, ["b", "c"]);
  assert.deepEqual(plan.coverage.segmentIds, ["b", "c"]);
  assert.ok(plan.contextSegmentIds.includes("a"));
  assert.ok(plan.contextSegmentIds.includes("d"));
  assert.equal(plan.contextSegments.every((entry) => entry.readOnly === true), true);
  assert.equal(
    plan.requestSegments.every((entry) => ["b", "c"].includes(entry.id)),
    true,
  );
});

test("locked selected segments are skipped from the paid request set", () => {
  const plan = planSelectedSegmentRerun({
    segments: [
      seg("a", "A", { locked: true, manual: "人工" }),
      seg("b", "B", { manual: "可重跑" }),
    ],
    selectedSegmentIds: ["a", "b"],
    languageCode: "zh-CN",
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.requestSegmentIds, ["b"]);
  assert.deepEqual(plan.skippedLockedSegmentIds, ["a"]);
});

test("apply updates only allowed selected segments and preserves previousManual", () => {
  const segments = [
    seg("a", "A", { manual: "人工A" }),
    seg("b", "B", { manual: "人工B" }),
    seg("c", "C"),
  ];

  const applied = applySelectedSegmentRerunResult({
    segments,
    languageCode: "zh-CN",
    allowedSegmentIds: ["b"],
    translations: { b: "新B" },
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.segments[0].targetTexts["zh-CN"].manual, "人工A");
  assert.equal(applied.segments[0].targetTexts["zh-CN"].model, "old-a");
  assert.equal(applied.segments[1].targetTexts["zh-CN"].manual, undefined);
  assert.equal(applied.segments[1].targetTexts["zh-CN"].previousManual, "人工B");
  assert.equal(applied.segments[1].targetTexts["zh-CN"].model, "新B");
  assert.equal(applied.segments[2].targetTexts["zh-CN"].model, "old-c");
});

test("unexpected translation ids fail closed without mutation", () => {
  const segments = [seg("a", "A"), seg("b", "B")];
  const before = structuredClone(segments);
  const applied = applySelectedSegmentRerunResult({
    segments,
    languageCode: "zh-CN",
    allowedSegmentIds: ["a"],
    translations: { a: "新A", b: "偷改B" },
  });
  assert.equal(applied.ok, false);
  assert.equal(applied.reason, "unexpected_segment_ids");
  assert.deepEqual(segments, before);
});

test("snapshot coverage records exact selected segment set", () => {
  const snapshot = withSelectedSegmentCoverage(
    {
      id: "run-1",
      parameters: { temperature: 0.2 },
    },
    { mode: "selected_segments", segmentIds: ["c", "a"] },
  );
  assert.deepEqual(snapshot.parameters.coverage, {
    mode: "selected_segments",
    segmentIds: ["a", "c"],
  });
  assert.equal(snapshot.parameters.temperature, 0.2);
});
