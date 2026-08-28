import assert from "node:assert/strict";
import test from "node:test";
import { ASR_RESULT_LIMITS, validateAsrResult } from "../../backend/asr/asr-contract.mjs";

function validResult() {
  return {
    schemaVersion: 1,
    mediaDurationMs: 4_000,
    detectedLanguage: "en",
    languageProbability: 0.97,
    warnings: ["terminal_timestamp_clamped"],
    segments: [
      {
        startMs: 0,
        endMs: 2_000,
        text: " Hello world.",
        language: "en",
        languageProbability: 0.96,
        words: [
          { startMs: 0, endMs: 700, text: " Hello", probability: 0.9 },
          {
            startMs: 700,
            endMs: 1_900,
            text: " world.",
            probability: 0.8,
            rawStartMs: 700,
            rawEndMs: 2_210,
            repairCodes: ["terminal_timestamp_clamped"],
          },
        ],
      },
      {
        startMs: 2_000,
        endMs: 4_000,
        text: " Next line.",
        language: "en",
        languageProbability: null,
        words: [{ startMs: 2_000, endMs: 3_900, text: " Next line.", probability: null }],
      },
    ],
  };
}

test("bounded ASR result accepts canonical segments words and raw timing repair evidence", () => {
  const result = validateAsrResult(validResult());
  assert.deepEqual(result, validResult());
  assert.notEqual(result, validResult());
  assert.equal(Object.hasOwn(result, "systemInfo"), false);
});

test("song activity accepts bounded disjoint intervals and rejects overlap", () => {
  const value = {
    ...validResult(),
    songActivity: {
      detector: "ina-speech-music-noise-v1",
      mode: "filter",
      filteredIntervals: [{ startMs: 100, endMs: 500 }],
      uncertainIntervals: [{ startMs: 1_000, endMs: 1_500 }],
    },
  };
  assert.deepEqual(validateAsrResult(value).songActivity, value.songActivity);
  value.songActivity.uncertainIntervals = [{ startMs: 400, endMs: 800 }];
  assert.throws(() => validateAsrResult(value), (error) => error?.code === "INVALID_ASR_RESULT");
});

test("ASR result rejects invalid segment and word timing before persistence", () => {
  const mutations = [
    (value) => { value.mediaDurationMs = Number.POSITIVE_INFINITY; },
    (value) => { value.segments[0].startMs = -1; },
    (value) => { value.segments[0].endMs = 0; },
    (value) => { value.segments[1].startMs = 1_900; },
    (value) => { value.segments[1].endMs = 4_001; },
    (value) => { value.segments[0].words[0].startMs = -1; },
    (value) => { value.segments[0].words[0].endMs = 2_001; },
    (value) => { value.segments[0].words[1].startMs = 600; },
    (value) => { value.segments[0].words[0].endMs = 0; },
  ];
  for (const mutate of mutations) {
    const value = validResult();
    mutate(value);
    assert.throws(
      () => validateAsrResult(value),
      (error) => error?.code === "INVALID_ASR_RESULT" && /time|duration|segment|word/i.test(String(error.message)),
    );
  }
});

test("ASR result rejects unbounded counts text warnings and raw engine fields", () => {
  const tooManySegments = validResult();
  tooManySegments.segments = new Array(ASR_RESULT_LIMITS.MAX_SEGMENTS + 1).fill(tooManySegments.segments[0]);
  assert.throws(() => validateAsrResult(tooManySegments), (error) => error?.code === "OUTPUT_TOO_LARGE");

  const tooManyWords = validResult();
  tooManyWords.segments[0].words = new Array(ASR_RESULT_LIMITS.MAX_WORDS + 1).fill(tooManyWords.segments[0].words[0]);
  assert.throws(() => validateAsrResult(tooManyWords), (error) => error?.code === "OUTPUT_TOO_LARGE");

  for (const mutate of [
    (value) => { value.segments[0].text = "x".repeat(ASR_RESULT_LIMITS.MAX_SEGMENT_TEXT_BYTES + 1); },
    (value) => { value.segments[0].words[0].text = "x".repeat(ASR_RESULT_LIMITS.MAX_WORD_TEXT_BYTES + 1); },
    (value) => { value.warnings = new Array(ASR_RESULT_LIMITS.MAX_WARNING_CODES + 1).fill("warning"); },
    (value) => { value.rawStdout = "engine output"; },
    (value) => { value.segments[0].tokens = [{ id: 1 }]; },
    (value) => { value.segments[0].words[0].rawToken = { id: 1 }; },
  ]) {
    const value = validResult();
    mutate(value);
    assert.throws(
      () => validateAsrResult(value),
      (error) => ["INVALID_ASR_RESULT", "OUTPUT_TOO_LARGE"].includes(error?.code),
    );
  }
});

test("ASR language probability and repair codes are finite bounded enums", () => {
  for (const mutate of [
    (value) => { value.detectedLanguage = "../../escape"; },
    (value) => { value.languageProbability = 2; },
    (value) => { value.segments[0].languageProbability = Number.NaN; },
    (value) => { value.segments[0].words[0].probability = -0.1; },
    (value) => { value.segments[0].words[1].repairCodes = ["free form reason!"]; },
  ]) {
    const value = validResult();
    mutate(value);
    assert.throws(() => validateAsrResult(value), (error) => error?.code === "INVALID_ASR_RESULT");
  }
});
