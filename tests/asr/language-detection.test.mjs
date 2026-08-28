import assert from "node:assert/strict";
import test from "node:test";
import {
  ASR_LANGUAGE_DETECTION_CONFIG,
  classifySegmentLanguages,
  normalizeAsrLanguageCode,
} from "../../backend/asr/language-detection.mjs";

function segments() {
  return [
    { id: "segment-1", sourceLanguage: "und", sourceText: { original: "Hello", normalized: "Hello" }, targetTexts: {} },
    { id: "segment-2", sourceLanguage: "und", sourceText: { original: "你好", normalized: "你好" }, targetTexts: {} },
  ];
}

function evidence(first = ["en", 0.95], second = ["en", 0.9]) {
  return [first, second].map(([detectedLanguage, confidence], index) => ({
    segmentId: `segment-${index + 1}`,
    detectedLanguage,
    confidence,
    detectionMethod: "whisper.cpp-region-auto",
    detectionVersion: "whisper.cpp-1.9.1-small-v1",
    overlapStatus: "none",
  }));
}

test("language codes normalize and confident single or serial mixed evidence classifies the track", () => {
  assert.equal(normalizeAsrLanguageCode("ENG"), "en");
  assert.equal(normalizeAsrLanguageCode("cmn"), "zh");
  assert.equal(normalizeAsrLanguageCode("pt_BR"), "pt-br");
  assert.equal(normalizeAsrLanguageCode("not a code"), "und");

  const single = classifySegmentLanguages({ segments: segments(), evidence: evidence() });
  assert.equal(single.languageState, "known");
  assert.equal(single.defaultLanguage, "en");
  assert.deepEqual(single.segments.map((segment) => segment.sourceLanguage), ["en", "en"]);

  const mixed = classifySegmentLanguages({ segments: segments(), evidence: evidence(["eng", 0.99], ["zho", 0.98]) });
  assert.equal(mixed.languageState, "multilingual");
  assert.equal(mixed.defaultLanguage, "auto");
  assert.deepEqual(mixed.segments.map((segment) => segment.sourceLanguage), ["en", "zh"]);
});

test("unknown, low-confidence, null-confidence, and overlap stay und pending", () => {
  for (const item of [
    evidence(["und", 0.99], ["en", 0.99]),
    evidence(["en", ASR_LANGUAGE_DETECTION_CONFIG.confidenceThreshold - 0.01], ["en", 0.99]),
    evidence(["en", null], ["en", 0.99]),
    [{ ...evidence()[0], overlapStatus: "overlap_unsupported" }, evidence()[1]],
  ]) {
    const value = classifySegmentLanguages({ segments: segments(), evidence: item });
    assert.equal(value.languageState, "pending");
    assert.equal(value.segments[0].sourceLanguage, "und");
    assert.deepEqual(value.pendingSegmentIds, ["segment-1"]);
  }
});

test("manual language wins without deleting evidence and multilingual only converges explicitly", () => {
  const current = classifySegmentLanguages({
    segments: segments(),
    evidence: evidence(["en", 0.99], ["zh", 0.99]),
  });
  current.segments[1].manualLanguage = "EN";
  const sticky = classifySegmentLanguages({
    segments: current.segments,
    evidence: evidence(["en", 0.99], ["zh", 0.99]),
    previousLanguageState: "multilingual",
  });
  assert.equal(sticky.segments[1].detectedLanguage, "zh");
  assert.equal(sticky.segments[1].manualLanguage, "en");
  assert.equal(sticky.segments[1].sourceLanguage, "en");
  assert.equal(sticky.languageState, "multilingual");

  const converged = classifySegmentLanguages({
    segments: sticky.segments,
    evidence: evidence(["en", 0.99], ["zh", 0.99]),
    previousLanguageState: "multilingual",
    confirmTrackConvergence: true,
  });
  assert.equal(converged.languageState, "known");
  assert.equal(converged.defaultLanguage, "en");
});

test("invalid evidence, duplicate IDs, and partial coverage fail closed", () => {
  for (const value of [
    evidence(["en", Number.NaN], ["en", 0.9]),
    evidence(["en", 1.1], ["en", 0.9]),
    [evidence()[0]],
    [evidence()[0], { ...evidence()[1], segmentId: "segment-1" }],
    [{ ...evidence()[0], detectionMethod: "renderer-model" }, evidence()[1]],
  ]) {
    assert.throws(
      () => classifySegmentLanguages({ segments: segments(), evidence: value }),
      (error) => error?.code === "INVALID_INPUT",
    );
  }
});
