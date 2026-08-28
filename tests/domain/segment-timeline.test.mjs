import test from "node:test";
import assert from "node:assert/strict";

import {
  findSegmentAtTime,
  timelinePointerMs,
  mergeSegments,
  nudgeSegmentBoundary,
  shiftSegment,
  splitSegment,
} from "../../src/domain/segment-timeline.ts";

test("waveform pointer maps to the full timeline and clamps outside the track", () => {
  assert.equal(timelinePointerMs(150, { left: 100, width: 200 }, 10_000), 2_500);
  assert.equal(timelinePointerMs(50, { left: 100, width: 200 }, 10_000), 0);
  assert.equal(timelinePointerMs(350, { left: 100, width: 200 }, 10_000), 10_000);
});

function target(overrides = {}) {
  return {
    model: "译文",
    postProcessed: "译文",
    qaFlags: [],
    ...overrides,
  };
}

function segment(overrides = {}) {
  return {
    id: overrides.id ?? "seg-1",
    start: overrides.start ?? "00:00:01,000",
    end: overrides.end ?? "00:00:05,000",
    sourceLanguage: overrides.sourceLanguage ?? "en",
    sourceText: overrides.sourceText ?? {
      original: "Hello world",
      normalized: "Hello world",
    },
    targetTexts: overrides.targetTexts ?? {
      "zh-CN": target({ manual: "人工", locked: true }),
    },
  };
}

function ids(segments) {
  return segments.map((entry) => entry.id);
}

test("playback time resolves the active half-open subtitle interval", () => {
  const segments = [
    segment({ id: "a", start: "00:00:01,000", end: "00:00:02,000" }),
    segment({ id: "b", start: "00:00:02,500", end: "00:00:04,000" }),
  ];
  assert.equal(findSegmentAtTime(segments, 999), null);
  assert.equal(findSegmentAtTime(segments, 1_000)?.id, "a");
  assert.equal(findSegmentAtTime(segments, 2_000), null);
  assert.equal(findSegmentAtTime(segments, 2_500)?.id, "b");
  assert.equal(findSegmentAtTime(segments, 4_000), null);
});

test("split creates two new segment ids and does not auto-split target text", () => {
  const segments = [
    segment({ id: "seg-a", start: "00:00:01,000", end: "00:00:05,000" }),
    segment({
      id: "seg-b",
      start: "00:00:06,000",
      end: "00:00:08,000",
      sourceText: { original: "Next", normalized: "Next" },
      targetTexts: { "zh-CN": target({ model: "下一段", postProcessed: "下一段" }) },
    }),
  ];

  const result = splitSegment(segments, "seg-a", "00:00:03,000", {
    idFactory: (() => {
      let n = 0;
      return () => `new-${++n}`;
    })(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(ids(result.segments), ["new-1", "new-2", "seg-b"]);
  assert.equal(result.segments[0].start, "00:00:01,000");
  assert.equal(result.segments[0].end, "00:00:03,000");
  assert.equal(result.segments[1].start, "00:00:03,000");
  assert.equal(result.segments[1].end, "00:00:05,000");

  // old segment id is gone
  assert.equal(result.segments.some((entry) => entry.id === "seg-a"), false);

  // first keeps full old source/target as history; second does not invent a split mapping
  assert.equal(result.segments[0].sourceText.normalized, "Hello world");
  assert.equal(result.segments[0].targetTexts["zh-CN"].manual, "人工");
  assert.equal(result.segments[0].targetTexts["zh-CN"].locked, true);
  assert.equal(result.segments[0].targetTexts["zh-CN"].stale, true);

  assert.equal(result.segments[1].sourceText.normalized, "");
  assert.equal(result.segments[1].sourceText.original, "");
  assert.equal(result.segments[1].targetTexts["zh-CN"].model, "");
  assert.equal(result.segments[1].targetTexts["zh-CN"].postProcessed, "");
  assert.equal(result.segments[1].targetTexts["zh-CN"].stale, true);
  assert.equal(result.segments[1].targetTexts["zh-CN"].manual, undefined);
});

test("split rejects at-point outside open interval and leaves input unchanged", () => {
  const segments = [segment({ id: "seg-a" })];
  const before = structuredClone(segments);

  for (const at of ["00:00:01,000", "00:00:05,000", "00:00:00,500", "00:00:06,000", "bad"]) {
    const result = splitSegment(segments, "seg-a", at, { idFactory: () => "x" });
    assert.equal(result.ok, false);
    assert.deepEqual(segments, before);
    assert.equal(result.segments, undefined);
  }
});

test("merge creates one new id, joins source, does not join target text", () => {
  const segments = [
    segment({
      id: "seg-1",
      start: "00:00:01,000",
      end: "00:00:03,000",
      sourceText: { original: "Hello", normalized: "Hello" },
      targetTexts: { "zh-CN": target({ model: "你好", postProcessed: "你好", manual: "人工A" }) },
    }),
    segment({
      id: "seg-2",
      start: "00:00:03,000",
      end: "00:00:05,000",
      sourceText: { original: "world", normalized: "world" },
      targetTexts: { "zh-CN": target({ model: "世界", postProcessed: "世界", manual: "人工B" }) },
    }),
    segment({
      id: "seg-3",
      start: "00:00:06,000",
      end: "00:00:07,000",
      sourceText: { original: "tail", normalized: "tail" },
      targetTexts: { "zh-CN": target({ model: "尾", postProcessed: "尾" }) },
    }),
  ];

  const result = mergeSegments(segments, "seg-1", "seg-2", {
    idFactory: () => "merged-1",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(ids(result.segments), ["merged-1", "seg-3"]);
  assert.equal(result.segments[0].start, "00:00:01,000");
  assert.equal(result.segments[0].end, "00:00:05,000");
  assert.equal(result.segments[0].sourceText.normalized, "Hello\nworld");
  assert.equal(result.segments[0].sourceText.original, "Hello\nworld");

  // target text is historical evidence from the first segment only; not auto-joined
  assert.equal(result.segments[0].targetTexts["zh-CN"].manual, "人工A");
  assert.equal(result.segments[0].targetTexts["zh-CN"].model, "你好");
  assert.notEqual(result.segments[0].targetTexts["zh-CN"].postProcessed, "你好\n世界");
  assert.equal(result.segments[0].targetTexts["zh-CN"].stale, true);
});

test("merge rejects non-adjacent or missing segments without mutating input", () => {
  const segments = [
    segment({ id: "a", start: "00:00:01,000", end: "00:00:02,000" }),
    segment({ id: "b", start: "00:00:03,000", end: "00:00:04,000" }),
    segment({ id: "c", start: "00:00:05,000", end: "00:00:06,000" }),
  ];
  const before = structuredClone(segments);

  assert.equal(mergeSegments(segments, "a", "c", { idFactory: () => "x" }).ok, false);
  assert.equal(mergeSegments(segments, "a", "missing", { idFactory: () => "x" }).ok, false);
  assert.deepEqual(segments, before);
});

test("nudge start/end keeps id and marks targets stale", () => {
  const segments = [
    segment({
      id: "seg-1",
      start: "00:00:01,000",
      end: "00:00:03,000",
      targetTexts: { "zh-CN": target({ model: "A", postProcessed: "A" }) },
    }),
  ];

  const startNudge = nudgeSegmentBoundary(segments, "seg-1", "start", 200);
  assert.equal(startNudge.ok, true);
  assert.equal(startNudge.segments[0].id, "seg-1");
  assert.equal(startNudge.segments[0].start, "00:00:01,200");
  assert.equal(startNudge.segments[0].end, "00:00:03,000");
  assert.equal(startNudge.segments[0].targetTexts["zh-CN"].stale, true);
  assert.equal(startNudge.segments[0].targetTexts["zh-CN"].model, "A");

  const endNudge = nudgeSegmentBoundary(segments, "seg-1", "end", -500);
  assert.equal(endNudge.ok, true);
  assert.equal(endNudge.segments[0].end, "00:00:02,500");
});

test("shift moves both boundaries and marks targets stale", () => {
  const segments = [
    segment({
      id: "seg-1",
      start: "00:00:01,000",
      end: "00:00:02,000",
      targetTexts: {
        "zh-CN": target({ manual: "人工" }),
        "en-US": target({ model: "EN", postProcessed: "EN" }),
      },
    }),
  ];

  const result = shiftSegment(segments, "seg-1", 1500);
  assert.equal(result.ok, true);
  assert.equal(result.segments[0].id, "seg-1");
  assert.equal(result.segments[0].start, "00:00:02,500");
  assert.equal(result.segments[0].end, "00:00:03,500");
  assert.equal(result.segments[0].targetTexts["zh-CN"].stale, true);
  assert.equal(result.segments[0].targetTexts["zh-CN"].manual, "人工");
  assert.equal(result.segments[0].targetTexts["en-US"].stale, true);
});

test("illegal timeline edits fail closed without partial mutation", () => {
  const segments = [
    segment({ id: "seg-1", start: "00:00:01,000", end: "00:00:02,000" }),
  ];
  const before = structuredClone(segments);

  assert.equal(nudgeSegmentBoundary(segments, "seg-1", "start", 2000).ok, false); // start >= end
  assert.equal(nudgeSegmentBoundary(segments, "seg-1", "end", -2000).ok, false);
  assert.equal(nudgeSegmentBoundary(segments, "seg-1", "start", -2000).ok, false); // negative
  assert.equal(shiftSegment(segments, "seg-1", -2000).ok, false);
  assert.equal(nudgeSegmentBoundary(segments, "missing", "start", 10).ok, false);

  assert.deepEqual(segments, before);
});

test("nudge and shift do not create new ids; split/merge always do", () => {
  const base = [
    segment({ id: "a", start: "00:00:01,000", end: "00:00:03,000" }),
    segment({
      id: "b",
      start: "00:00:03,000",
      end: "00:00:05,000",
      sourceText: { original: "B", normalized: "B" },
      targetTexts: { "zh-CN": target({ model: "B", postProcessed: "B" }) },
    }),
  ];

  assert.equal(nudgeSegmentBoundary(base, "a", "end", -10).segments[0].id, "a");
  assert.equal(shiftSegment(base, "b", 10).segments[1].id, "b");

  const split = splitSegment(base, "a", "00:00:02,000", {
    idFactory: (() => {
      let n = 0;
      return () => `s${++n}`;
    })(),
  });
  assert.ok(!ids(split.segments).includes("a"));
  assert.ok(ids(split.segments).includes("s1"));
  assert.ok(ids(split.segments).includes("s2"));

  const merged = mergeSegments(base, "a", "b", { idFactory: () => "m1" });
  assert.deepEqual(ids(merged.segments), ["m1"]);
});
