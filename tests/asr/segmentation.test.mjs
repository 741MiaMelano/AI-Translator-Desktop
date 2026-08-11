import assert from "node:assert/strict";
import test from "node:test";
import {
  ASR_SEGMENTATION_CONFIG,
  ASR_SEGMENTATION_CONFIG_VERSION,
  segmentAsrResult,
  segmentAsrResultAsync,
} from "../../backend/asr/segmentation.mjs";

function result() {
  return {
    schemaVersion: 1,
    mediaDurationMs: 10_000,
    detectedLanguage: "en",
    languageProbability: null,
    warnings: ["language_probability_unavailable"],
    segments: [
      {
        startMs: 0,
        endMs: 1_200,
        text: " Hello world.",
        language: "en",
        languageProbability: null,
        words: [
          { startMs: 0, endMs: 400, text: " Hello", probability: 0.9 },
          { startMs: 400, endMs: 1_200, text: " world.", probability: 0.9 },
        ],
      },
      {
        startMs: 2_200,
        endMs: 4_200,
        text: " This is a deterministic test.",
        language: "en",
        languageProbability: null,
        words: [
          { startMs: 2_200, endMs: 2_500, text: " This", probability: 0.9 },
          { startMs: 2_500, endMs: 2_700, text: " is", probability: 0.9 },
          { startMs: 2_700, endMs: 2_800, text: " a", probability: 0.9 },
          { startMs: 2_800, endMs: 3_500, text: " deterministic", probability: 0.9 },
          { startMs: 3_500, endMs: 4_200, text: " test.", probability: 0.9 },
        ],
      },
      {
        startMs: 8_000,
        endMs: 8_500,
        text: " 尾声。",
        language: "zh",
        languageProbability: null,
        words: [{ startMs: 8_000, endMs: 8_500, text: " 尾声。", probability: 0.8 }],
      },
    ],
  };
}

function semanticText(value) {
  return value.normalize("NFC").replace(/\s/gu, "");
}

test("same raw words and version produce byte-identical deterministic segments", () => {
  const first = segmentAsrResult({ runId: "asr-run-deterministic", result: result() });
  const second = segmentAsrResult({ runId: "asr-run-deterministic", result: structuredClone(result()) });
  assert.deepEqual(first, second);
  assert.equal(first.configVersion, ASR_SEGMENTATION_CONFIG_VERSION);
  assert.equal(first.segments[0].sourceText.original, " Hello world.");
  assert.equal(first.segments[0].endMs, 1_200, "sentence punctuation and the natural pause win");
  assert.deepEqual(first.segments.map((segment) => segment.id), second.segments.map((segment) => segment.id));
});

test("segmentation is word-lossless and every output obeys timeline and readability limits", () => {
  const raw = result();
  const segmented = segmentAsrResult({ runId: "asr-run-invariants", result: raw });
  const inputWords = raw.segments.flatMap((segment) => segment.words);
  const outputOriginal = segmented.segments.map((segment) => segment.sourceText.original).join("");
  assert.equal(semanticText(outputOriginal), semanticText(inputWords.map((word) => word.text).join("")));
  assert.deepEqual(
    segmented.segments.flatMap((segment) =>
      Array.from({ length: segment.wordEndIndex - segment.wordStartIndex + 1 }, (_, index) => segment.wordStartIndex + index)),
    inputWords.map((_, index) => index),
  );
  segmented.segments.forEach((segment, index) => {
    const durationMs = segment.endMs - segment.startMs;
    const lines = segment.sourceText.normalized.split("\n");
    const chars = [...segment.sourceText.normalized.replaceAll("\n", "")].length;
    assert.ok(durationMs >= ASR_SEGMENTATION_CONFIG.minDurationMs);
    assert.ok(durationMs <= ASR_SEGMENTATION_CONFIG.maxDurationMs);
    assert.ok(chars / (durationMs / 1_000) <= ASR_SEGMENTATION_CONFIG.maxCps);
    assert.ok(lines.length <= ASR_SEGMENTATION_CONFIG.maxLines);
    assert.ok(lines.every((line) => [...line].length <= ASR_SEGMENTATION_CONFIG.maxCharsPerLine));
    assert.ok(segment.startMs >= 0 && segment.endMs <= raw.mediaDurationMs && segment.startMs < segment.endMs);
    if (index > 0) {
      assert.ok(segment.startMs - segmented.segments[index - 1].endMs >= ASR_SEGMENTATION_CONFIG.minGapMs);
    }
  });
});

test("long unpunctuated speech splits deterministically and one long token wraps without rewriting", () => {
  const words = Array.from({ length: 30 }, (_, index) => ({
    startMs: index * 400,
    endMs: index * 400 + 300,
    text: ` w${index}`,
    probability: null,
  }));
  const raw = {
    ...result(),
    mediaDurationMs: 12_500,
    segments: [{
      startMs: 0,
      endMs: 11_900,
      text: words.map((word) => word.text).join(""),
      language: "en",
      languageProbability: null,
      words,
    }],
  };
  const segmented = segmentAsrResult({ runId: "asr-run-no-punctuation", result: raw });
  assert.ok(segmented.segments.length > 1);
  assert.equal(semanticText(segmented.segments.map((segment) => segment.sourceText.original).join("")), semanticText(raw.segments[0].text));

  const token = "x".repeat(80);
  const single = segmentAsrResult({
    runId: "asr-run-long-token",
    result: {
      ...result(),
      mediaDurationMs: 5_000,
      segments: [{
        startMs: 0,
        endMs: 5_000,
        text: token,
        language: "en",
        languageProbability: null,
        words: [{ startMs: 0, endMs: 5_000, text: token, probability: null }],
      }],
    },
  });
  assert.equal(single.segments[0].sourceText.normalized.replaceAll("\n", ""), token);
  assert.equal(single.segments[0].sourceText.normalized.split("\n").length, 2);
});

test("multi-word Latin subtitles split into cues instead of wrapping inside a word", () => {
  const first = ` ${"a".repeat(40)}`;
  const second = ` ${"b".repeat(43)}`;
  const segmented = segmentAsrResult({
    runId: "asr-run-word-safe-wrap",
    result: {
      ...result(),
      mediaDurationMs: 5_000,
      segments: [{
        startMs: 0,
        endMs: 5_000,
        text: first + second,
        language: "en",
        languageProbability: null,
        words: [
          { startMs: 0, endMs: 2_400, text: first, probability: null },
          { startMs: 2_500, endMs: 5_000, text: second, probability: null },
        ],
      }],
    },
  });

  assert.equal(segmented.segments.length, 2);
  assert.equal(segmented.segments[0].sourceText.normalized, first.trim());
  assert.equal(segmented.segments[1].sourceText.normalized.replaceAll("\n", ""), second.trim());
});

test("fast speech remains word-lossless when the source timing cannot meet the preferred CPS", () => {
  const text = "x".repeat(46);
  const segmented = segmentAsrResult({
    runId: "asr-run-fast-speech",
    result: {
      ...result(),
      mediaDurationMs: 1_770,
      segments: [{
        startMs: 0,
        endMs: 1_770,
        text,
        language: "en",
        languageProbability: null,
        words: [{ startMs: 0, endMs: 1_770, text, probability: 0.9 }],
      }],
    },
  });
  assert.equal(segmented.segments[0].sourceText.normalized.replaceAll("\n", ""), text);
  assert.ok(text.length / (segmented.segments[0].endMs / 1_000) > ASR_SEGMENTATION_CONFIG.maxCps);
});

test("contiguous engine word boundaries reserve the frozen subtitle gap without losing words", () => {
  const raw = {
    ...result(),
    mediaDurationMs: 4_000,
    segments: [{
      startMs: 0,
      endMs: 2_000,
      text: " Uncertain phrase.",
      language: "en",
      languageProbability: null,
      words: [
        { startMs: 0, endMs: 900, text: " Uncertain", probability: 0.5 },
        { startMs: 900, endMs: 2_000, text: " phrase.", probability: 0.5 },
      ],
    }, {
      startMs: 2_000,
      endMs: 4_000,
      text: " Clear phrase.",
      language: "en",
      languageProbability: null,
      words: [
        { startMs: 2_000, endMs: 2_900, text: " Clear", probability: 0.9 },
        { startMs: 2_900, endMs: 4_000, text: " phrase.", probability: 0.9 },
      ],
    }],
  };
  const segmented = segmentAsrResult({ runId: "asr-run-contiguous", result: raw });
  assert.equal(segmented.segments.length, 2);
  assert.equal(segmented.segments[0].endMs, 1_980);
  assert.equal(segmented.segments[1].startMs, 2_000);
  assert.equal(semanticText(segmented.segments.map((segment) => segment.sourceText.original).join("")),
    semanticText(raw.segments.map((segment) => segment.text).join("")));
});

test("legacy zero-duration repair cannot make a long video unsegmentable", () => {
  const raw = {
    ...result(),
    mediaDurationMs: 10_000,
    segments: [{
      startMs: 0,
      endMs: 9_000,
      text: "Yes. Oh, come.",
      language: "en",
      languageProbability: null,
      words: [
        { startMs: 0, endMs: 160, text: "Yes.", probability: null },
        {
          startMs: 160,
          endMs: 8_160,
          text: " Oh,",
          probability: null,
          rawStartMs: 7_120,
          rawEndMs: 7_120,
          repairCodes: ["zero_duration_tokens_partitioned"],
        },
        { startMs: 8_160, endMs: 9_000, text: " come.", probability: null },
      ],
    }],
  };
  const segmented = segmentAsrResult({ runId: "asr-run-legacy-zero", result: raw });

  assert.equal(semanticText(segmented.segments.map((segment) => segment.sourceText.original).join("")), semanticText(raw.segments[0].text));
  segmented.segments.forEach((segment, index) => {
    assert.ok(segment.endMs - segment.startMs >= ASR_SEGMENTATION_CONFIG.minDurationMs);
    assert.ok(segment.endMs - segment.startMs <= ASR_SEGMENTATION_CONFIG.maxDurationMs);
    if (index) assert.ok(segment.startMs - segmented.segments[index - 1].endMs >= ASR_SEGMENTATION_CONFIG.minGapMs);
  });
});

test("an ASR word longer than the subtitle maximum keeps its text in a capped cue", () => {
  const raw = {
    ...result(),
    mediaDurationMs: 12_000,
    segments: [{
      startMs: 1_000,
      endMs: 11_000,
      text: "Okay, now.",
      language: "en",
      languageProbability: null,
      words: [
        { startMs: 1_000, endMs: 10_200, text: "Okay,", probability: null },
        { startMs: 10_400, endMs: 11_000, text: " now.", probability: null },
      ],
    }],
  };
  const segmented = segmentAsrResult({ runId: "asr-run-long-word", result: raw });

  assert.equal(segmented.segments[0].endMs - segmented.segments[0].startMs, ASR_SEGMENTATION_CONFIG.maxDurationMs);
  assert.equal(
    semanticText(segmented.segments.map((segment) => segment.sourceText.original).join("")),
    semanticText(raw.segments[0].text),
  );
});

test("collapsed dense word timing uses a local soft timeline and stays deterministic", async () => {
  const words = Array.from({ length: 30 }, (_, index) => ({
    startMs: 8_900 + index,
    endMs: 8_901 + index,
    text: ` word${index}`,
    probability: null,
  }));
  const raw = {
    ...result(),
    mediaDurationMs: 10_000,
    segments: [{
      startMs: 0,
      endMs: 10_000,
      text: words.map((word) => word.text).join(""),
      language: "en",
      languageProbability: null,
      words,
    }],
  };
  const sync = segmentAsrResult({ runId: "asr-run-dense-timing", result: raw });
  const asyncResult = await segmentAsrResultAsync({
    runId: "asr-run-dense-timing",
    result: raw,
    yieldControl: () => Promise.resolve(),
  });

  assert.deepEqual(asyncResult, sync);
  assert.ok(sync.segments.length > 1);
  assert.equal(
    semanticText(sync.segments.map((segment) => segment.sourceText.original).join("")),
    semanticText(raw.segments[0].text),
  );
  sync.segments.forEach((segment, index) => {
    assert.ok(segment.endMs - segment.startMs >= ASR_SEGMENTATION_CONFIG.minDurationMs);
    assert.ok(segment.endMs - segment.startMs <= ASR_SEGMENTATION_CONFIG.maxDurationMs);
    if (index) assert.ok(segment.startMs - sync.segments[index - 1].endMs >= ASR_SEGMENTATION_CONFIG.minGapMs);
  });
});

test("impossible hard limits and invalid raw timing fail explicitly", () => {
  const impossible = result();
  const token = "x".repeat(85);
  impossible.segments = [{
    startMs: 0,
    endMs: 7_000,
    text: token,
    language: "en",
    languageProbability: null,
    words: [{ startMs: 0, endMs: 7_000, text: token, probability: null }],
  }];
  assert.throws(
    () => segmentAsrResult({ runId: "asr-run-impossible", result: impossible }),
    (error) => error?.code === "UNSEGMENTABLE_INPUT",
  );
  const invalid = result();
  invalid.segments[0].words[0].endMs = 0;
  assert.throws(
    () => segmentAsrResult({ runId: "asr-run-invalid", result: invalid }),
    (error) => error?.code === "INVALID_ASR_RESULT",
  );
  assert.throws(
    () => segmentAsrResult({ runId: "asr-run-invalid-version", result: result(), configVersion: "future" }),
    (error) => error?.code === "INVALID_INPUT",
  );
});
