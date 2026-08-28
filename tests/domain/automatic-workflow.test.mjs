import assert from "node:assert/strict";
import test from "node:test";

import { planAutomaticWorkflow } from "../../src/domain/automatic-workflow.ts";

function sourceTrack(overrides = {}) {
  return {
    id: "source-1",
    label: "Source",
    kind: "external_subtitle",
    languageState: "known",
    defaultLanguage: "en",
    isActive: true,
    summary: "ready",
    segments: [{
      id: "segment-1",
      start: "00:00:00,000",
      end: "00:00:01,000",
      sourceLanguage: "en",
      sourceText: { original: "Hello", normalized: "Hello" },
      targetTexts: {},
    }],
    targetTracks: [],
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: "project-1",
    title: "Fixture",
    sourceFileName: "fixture.mp4",
    mediaKind: "video",
    noSourceMedia: false,
    lifecycle: "draft",
    createdAt: "2026-07-29 10:00",
    updatedAt: "2026-07-29 10:00",
    activeSourceTrackId: null,
    pendingConfirmations: [],
    notes: [],
    config: {
      sourceLanguage: "自动检测",
      targetLanguages: ["简体中文"],
      provider: "DeepSeek",
      model: "deepseek-v4-flash",
      glossary: "默认",
      styleGuide: "影视字幕",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [],
    recentRunIds: [],
    mediaSource: {
      assetId: "primary",
      displayName: "fixture.mp4",
      availability: "available",
      identity: null,
      selectedAudioStreamId: "1",
      selectedSubtitleStreamId: null,
      confirmedAudioStreamId: null,
      confirmedSubtitleStreamId: null,
    },
    sourceProbeSummary: { media: { streams: [] } },
    ...overrides,
  };
}

const ready = {
  providerConfigured: true,
  hasLiveTask: false,
  asrChecked: true,
  asrReady: true,
  latestAsrRunId: null,
};

test("automatic workflow translates an existing source without exposing media steps", () => {
  const source = sourceTrack();
  assert.deepEqual(
    planAutomaticWorkflow(project({ activeSourceTrackId: source.id, sourceTracks: [source] }), ready),
    { kind: "translate" },
  );
});

test("damaged source timing needs an explicit keep-original choice before translation", () => {
  const damaged = sourceTrack({
    segments: Array.from({ length: 5 }, (_, index) => ({
      ...sourceTrack().segments[0],
      id: `segment-${index + 1}`,
      start: `00:0${index}:00,000`,
      end: `00:0${index + 1}:30,000`,
      sourceText: { original: `Line ${index + 1}`, normalized: `Line ${index + 1}` },
    })),
  });
  const input = project({ activeSourceTrackId: damaged.id, sourceTracks: [damaged] });

  assert.equal(planAutomaticWorkflow(input, ready).reason, "inspect_source");
  assert.deepEqual(
    planAutomaticWorkflow(input, { ...ready, allowUnsafeSource: true }),
    { kind: "translate" },
  );
});

test("automatic workflow prefers one unambiguous embedded subtitle", () => {
  const input = project({
    mediaSource: { ...project().mediaSource, selectedSubtitleStreamId: "2" },
    sourceProbeSummary: { media: { streams: [
      { streamId: "1", kind: "audio", default: true },
      { streamId: "2", kind: "subtitle", extractable: true, default: true },
    ] } },
  });
  assert.deepEqual(planAutomaticWorkflow(input, ready), { kind: "extract_subtitle", streamId: "2" });
  const candidate = sourceTrack({ id: "embedded-1", kind: "embedded_subtitle", isActive: false });
  assert.deepEqual(
    planAutomaticWorkflow(project({ sourceTracks: [candidate] }), ready),
    { kind: "activate_source", sourceTrackId: candidate.id },
  );
});

test("automatic workflow pauses instead of guessing between equal subtitle or audio tracks", () => {
  const subtitleChoice = project({
    sourceProbeSummary: { media: { streams: [
      { streamId: "2", kind: "subtitle", extractable: true },
      { streamId: "3", kind: "subtitle", extractable: true },
    ] } },
  });
  const subtitleBlock = planAutomaticWorkflow(subtitleChoice, ready);
  assert.equal(subtitleBlock.reason, "choose_subtitle");
  assert.equal(subtitleBlock.resolution.kind, "stream");
  assert.deepEqual(subtitleBlock.resolution.choices.map((choice) => choice.value), ["2", "3"]);

  const audioChoice = project({
    sourceProbeSummary: { media: { streams: [
      { streamId: "1", kind: "audio" },
      { streamId: "2", kind: "audio" },
    ] } },
  });
  const audioBlock = planAutomaticWorkflow(audioChoice, ready);
  assert.equal(audioBlock.reason, "choose_audio");
  assert.equal(audioBlock.resolution.prompt, "这段内容来自哪条音轨？");
  assert.deepEqual(
    planAutomaticWorkflow(project({
      ...audioChoice,
      mediaSource: { ...audioChoice.mediaSource, confirmedAudioStreamId: "2" },
    }), ready),
    { kind: "run_asr", audioStreamId: "2" },
  );
});

test("automatic workflow starts ASR for one audio track and resumes a saved run at segmentation", () => {
  const input = project({
    sourceProbeSummary: { media: { streams: [{ streamId: "1", kind: "audio", default: true }] } },
  });
  assert.deepEqual(planAutomaticWorkflow(input, ready), { kind: "run_asr", audioStreamId: "1" });
  assert.deepEqual(
    planAutomaticWorkflow(input, { ...ready, latestAsrRunId: "run-1" }),
    { kind: "segment_asr", asrRunId: "run-1" },
  );
});

test("automatic workflow detects uncertain candidate language, then pauses only for low confidence", () => {
  const und = sourceTrack({
    id: "candidate-1",
    kind: "asr",
    asrRunId: "run-1",
    isActive: false,
    segments: [{ ...sourceTrack().segments[0], sourceLanguage: "und" }],
  });
  const input = project({ sourceTracks: [und] });
  const matchingRun = { ...ready, latestAsrRunId: "run-1" };
  assert.deepEqual(planAutomaticWorkflow(input, matchingRun), { kind: "detect_languages", sourceTrackId: und.id });

  const uncertain = {
    ...und,
    segments: [{
      ...und.segments[0],
      detectedLanguage: "en",
      languageConfidence: 0.55,
      languageDetectionMethod: "whisper-region",
      languageDetectionVersion: "v1",
      languageOverlapStatus: "none",
    }],
  };
  const blocked = planAutomaticWorkflow(project({ sourceTracks: [uncertain] }), matchingRun);
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.reason, "confirm_languages");
  assert.equal(blocked.resolution.kind, "language");
  assert.deepEqual(blocked.resolution.segmentIds, ["segment-1"]);
  assert.equal(blocked.resolution.choices.find((choice) => choice.recommended)?.value, "en");
});

test("automatic workflow activates a ready ASR candidate and blocks missing prerequisites early", () => {
  const candidate = sourceTrack({ id: "candidate-1", kind: "asr", isActive: false, asrRunId: "run-1" });
  assert.deepEqual(
    planAutomaticWorkflow(project({ sourceTracks: [candidate] }), { ...ready, latestAsrRunId: "run-1" }),
    { kind: "activate_source", sourceTrackId: candidate.id },
  );
  assert.equal(planAutomaticWorkflow(project(), { ...ready, providerConfigured: false }).reason, "connect_provider");
  const oneAudio = project({
    sourceProbeSummary: { media: { streams: [{ streamId: "1", kind: "audio", default: true }] } },
  });
  assert.equal(planAutomaticWorkflow(oneAudio, { ...ready, asrReady: false }).reason, "install_asr");
  assert.equal(planAutomaticWorkflow(project(), { ...ready, hasLiveTask: true }).reason, "task_running");
});

test("switching ASR models does not resume a run or candidate from the previous model", () => {
  const oldCandidate = sourceTrack({
    id: "candidate-old",
    kind: "asr",
    isActive: false,
    asrRunId: "run-old-model",
  });
  const input = project({
    sourceTracks: [oldCandidate],
    sourceProbeSummary: { media: { streams: [{ streamId: "1", kind: "audio", default: true }] } },
  });

  assert.deepEqual(planAutomaticWorkflow(input, ready), { kind: "run_asr", audioStreamId: "1" });
  assert.deepEqual(
    planAutomaticWorkflow(input, { ...ready, latestAsrRunId: "run-new-model" }),
    { kind: "segment_asr", asrRunId: "run-new-model" },
  );
});
