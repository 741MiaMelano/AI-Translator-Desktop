import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSourceQuality } from "../../src/domain/source-quality.ts";

function segment(id, text, start, end) {
  return {
    id,
    start,
    end,
    sourceText: { original: text, normalized: text },
  };
}

function timestamp(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds % 1_000).padStart(3, "0")}`;
}

test("severe repeated text plus an abnormal timeline is blocked before paid translation", () => {
  const segments = [
    ...Array.from({ length: 30 }, (_, index) => segment(`repeat-${index}`, "I'll call them", `00:00:${String(index).padStart(2, "0")},000`, `00:00:${String(index).padStart(2, "0")},900`)),
    ...Array.from({ length: 30 }, (_, index) => segment(`other-${index}`, `line ${index}`, "00:01:00,000", "00:01:01,000")),
    segment("broken-tail", "These are nice ones.", "01:28:42,830", "01:37:34,010"),
  ];

  assert.deepEqual(analyzeSourceQuality(segments), {
    repeatedText: "I'll call them",
    repeatedCount: 30,
    segmentCount: 61,
    longestSegmentId: "broken-tail",
    longestDurationMs: 531180,
    invalidRangeCount: 0,
    extremeDurationCount: 1,
    severeOverlapCount: 0,
    reasons: ["repetition_with_abnormal_timeline"],
  });
});

test("ordinary repeated dialogue or one long caption alone does not manufacture a corruption warning", () => {
  const repeatedOnly = Array.from({ length: 24 }, (_, index) =>
    segment(`line-${index}`, index < 8 ? "yeah" : `line ${index}`, "00:00:01,000", "00:00:03,000"),
  );
  assert.equal(analyzeSourceQuality(repeatedOnly), null);
  assert.equal(analyzeSourceQuality([
    segment("long", "Music", "00:00:00,000", "00:02:00,000"),
    segment("normal", "Hello", "00:02:00,000", "00:02:02,000"),
  ]), null);
});

test("many extreme cue durations are blocked even when the text is not repeated", () => {
  const segments = [
    ...Array.from({ length: 80 }, (_, index) =>
      segment(`normal-${index}`, `normal line ${index}`, timestamp(index * 3_000), timestamp(index * 3_000 + 2_000)),
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      segment(`extreme-${index}`, `broken line ${index}`, timestamp(7_200_000 + index * 180_000), timestamp(7_320_000 + index * 180_000)),
    ),
  ];

  const problem = analyzeSourceQuality(segments);
  assert.equal(problem?.extremeDurationCount, 8);
  assert.equal(problem?.longestSegmentId, "extreme-0");
  assert.equal(problem?.reasons.includes("extreme_durations"), true);
});

test("a few intentional overlaps do not trigger the severe-overlap gate", () => {
  const segments = Array.from({ length: 100 }, (_, index) =>
    segment(
      `line-${index}`,
      `line ${index}`,
      `00:${String(Math.floor(index / 10)).padStart(2, "0")}:${String((index % 10) * 5).padStart(2, "0")},000`,
      `00:${String(Math.floor(index / 10)).padStart(2, "0")}:${String((index % 10) * 5 + (index < 4 ? 10 : 4)).padStart(2, "0")},000`,
    ),
  );

  assert.equal(analyzeSourceQuality(segments), null);
});
