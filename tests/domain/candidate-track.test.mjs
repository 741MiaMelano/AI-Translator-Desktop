import test from "node:test";
import assert from "node:assert/strict";

import {
  adoptCandidateSegment,
  assertCandidateDoesNotReplaceActive,
  createCandidateTargetTrack,
  diffActiveAgainstCandidate,
  fillCandidateTexts,
} from "../../shared/candidate-track.mjs";

function segmentsFixture() {
  return [
    {
      id: "s1",
      start: "00:00:01,000",
      end: "00:00:02,000",
      sourceLanguage: "en",
      sourceText: { original: "Hello", normalized: "Hello" },
      targetTexts: {
        "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
      },
    },
    {
      id: "s2",
      start: "00:00:03,000",
      end: "00:00:04,000",
      sourceLanguage: "en",
      sourceText: { original: "World", normalized: "World" },
      targetTexts: {
        "zh-CN": {
          model: "世界",
          postProcessed: "世界",
          manual: "人工世界",
          qaFlags: [],
        },
      },
    },
  ];
}

test("full-track candidate does not replace active track", () => {
  const sourceTrack = {
    id: "src",
    targetTracks: [
      {
        id: "active-zh",
        languageCode: "zh-CN",
        languageLabel: "简体中文",
        status: "in_review",
        isActive: true,
        qaIssues: [],
        snapshotIds: ["run-1"],
        deliveryLabel: "active",
        lastHumanAction: "translated",
      },
    ],
  };

  const created = createCandidateTargetTrack({
    sourceTrack,
    languageCode: "zh-CN",
    idFactory: () => "candidate-zh-1",
  });

  assert.equal(created.ok, true);
  assert.equal(created.candidateTrack.isActive, false);
  assert.equal(created.candidateTrack.role, "candidate");
  assert.equal(created.candidateTrack.baseTrackId, "active-zh");
  assert.equal(created.activeTrackId, "active-zh");
  assert.equal(
    assertCandidateDoesNotReplaceActive({
      activeTrack: sourceTrack.targetTracks[0],
      candidateTrack: created.candidateTrack,
    }).ok,
    true,
  );
  // original active track object remains active
  assert.equal(sourceTrack.targetTracks[0].isActive, true);
});

test("candidate texts fill without touching active segment layers", () => {
  const segments = segmentsFixture();
  const before = structuredClone(segments);
  const filled = fillCandidateTexts({}, { s1: "候选你好", s2: "候选世界" });
  assert.equal(filled.candidateTexts.s1.postProcessed, "候选你好");
  assert.deepEqual(segments, before);
});

test("diff reports changed rows and protected active manual", () => {
  const diff = diffActiveAgainstCandidate({
    segments: segmentsFixture(),
    languageCode: "zh-CN",
    candidateTexts: {
      s1: { model: "候选你好", postProcessed: "候选你好", qaFlags: [] },
      s2: { model: "候选世界", postProcessed: "候选世界", qaFlags: [] },
    },
  });
  assert.equal(diff.changedCount, 2);
  assert.equal(diff.rows[0].changed, true);
  assert.equal(diff.rows[1].activeProtected, true);
  assert.equal(diff.rows[1].activeText, "人工世界");
});

test("adopt updates one active segment and skips manual by default", () => {
  const candidateTexts = {
    s1: { model: "候选你好", postProcessed: "候选你好", qaFlags: [], origin: "candidate_full_track" },
    s2: { model: "候选世界", postProcessed: "候选世界", qaFlags: [], origin: "candidate_full_track" },
  };

  const adopted = adoptCandidateSegment({
    segments: segmentsFixture(),
    languageCode: "zh-CN",
    segmentId: "s1",
    candidateTexts,
  });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.segments[0].targetTexts["zh-CN"].postProcessed, "候选你好");
  assert.equal(adopted.segments[1].targetTexts["zh-CN"].manual, "人工世界");
  assert.equal(adopted.provenance.kind, "candidate_adopt");

  const skipped = adoptCandidateSegment({
    segments: segmentsFixture(),
    languageCode: "zh-CN",
    segmentId: "s2",
    candidateTexts,
  });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, "manual");
  assert.equal(skipped.segments[1].targetTexts["zh-CN"].manual, "人工世界");
});

test("forced adopt can override manual after explicit confirmation path", () => {
  const result = adoptCandidateSegment({
    segments: segmentsFixture(),
    languageCode: "zh-CN",
    segmentId: "s2",
    candidateTexts: {
      s2: { model: "候选世界", postProcessed: "候选世界", qaFlags: [] },
    },
    force: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.segments[1].targetTexts["zh-CN"].manual, undefined);
  assert.equal(result.segments[1].targetTexts["zh-CN"].previousManual, "人工世界");
  assert.equal(result.segments[1].targetTexts["zh-CN"].postProcessed, "候选世界");
});
