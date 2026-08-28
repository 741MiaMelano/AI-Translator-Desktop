import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAsrCandidateService } from "../../backend/asr/asr-candidate-service.mjs";
import { ASR_SEGMENTATION_CONFIG_VERSION } from "../../backend/asr/segmentation.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";

function project() {
  return {
    id: "project-asr-candidate",
    title: "ASR candidate",
    sourceFileName: "source.wav",
    mediaKind: "audio",
    lifecycle: "draft",
    noSourceMedia: false,
    activeSourceTrackId: "source-human",
    sourceTracks: [{
      id: "source-human",
      label: "Human source",
      kind: "external_subtitle",
      languageState: "known",
      defaultLanguage: "en",
      isActive: true,
      summary: "human",
      segments: [{
        id: "human-segment",
        start: "00:00:00,000",
        end: "00:00:02,000",
        sourceLanguage: "en",
        sourceText: { original: "Human", normalized: "Human", manual: "Human manual" },
        targetTexts: { "zh-CN": { model: "模型", postProcessed: "模型", manual: "人工", locked: true, qaFlags: [] } },
      }],
      targetTracks: [{
        id: "human-target-zh",
        languageCode: "zh-CN",
        languageLabel: "zh-CN",
        status: "approved",
        isActive: true,
        qaIssues: [],
        snapshotIds: ["translation-old"],
        deliveryLabel: "approved",
        lastHumanAction: "manual",
      }],
    }],
    config: {
      sourceLanguage: "auto",
      targetLanguages: ["zh-CN", "ja"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "none",
      styleGuide: "none",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: true,
    },
    mediaSource: {
      assetId: "primary",
      displayName: "source.wav",
      availability: "available",
      identity: null,
      selectedAudioStreamId: "s:0",
      selectedSubtitleStreamId: null,
    },
    sourceProbeSummary: { media: {
      mediaKind: "audio",
      format: { formatName: "wav", durationMs: 2_000, sizeBytes: 64_000 },
      streams: [{ streamId: "s:0", index: 0, kind: "audio", codec: "pcm_s16le", language: "en", title: null, default: true, forced: false, extractable: false, width: null, height: null, channels: 1, sampleRate: 16_000 }],
      warnings: [],
      probeVersion: 1,
      artifact: { upstreamVersion: "7.1.1", ffprobeSha256: null },
    } },
    editorHistory: { undoStack: [{ kind: "source_manual", segmentId: "human-segment", beforeManual: null, afterManual: "Human manual" }], redoStack: [] },
    pendingConfirmations: [],
    notes: [],
    recentRunIds: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function result() {
  return {
    schemaVersion: 1,
    mediaDurationMs: 2_000,
    detectedLanguage: "en",
    languageProbability: null,
    warnings: ["language_probability_unavailable"],
    segments: [{
      startMs: 0,
      endMs: 2_000,
      text: " Hello world.",
      language: "en",
      languageProbability: null,
      words: [
        { startMs: 0, endMs: 800, text: " Hello", probability: 0.9 },
        { startMs: 800, endMs: 1_900, text: " world.", probability: 0.8 },
      ],
    }],
  };
}

function run() {
  return {
    id: "asr-run-candidate",
    operationId: "asr-op-candidate",
    projectId: "project-asr-candidate",
    audioStreamId: "s:0",
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtimeId: "whisper-cpp-cpu-x64",
    runtimeVersion: "1.9.1",
    modelId: "small",
    modelVersion: "model-revision",
    modelHash: "a".repeat(64),
    cacheFingerprint: "c".repeat(64),
    requestedDevice: "cpu",
    actualDevice: "cpu",
    fallbackReason: null,
    languageMode: "auto",
    languageHint: null,
    parameters: { threads: 6 },
    rawArtifactRelativePath: "artifacts/asr/asr-run-candidate.json",
    rawArtifactSha256: "b".repeat(64),
    rawArtifactSizeBytes: 512,
    processingDurationMs: 1_000,
    canonicalizerVersion: "whisper.cpp-1.9.1-v2",
    createdAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
  };
}

function qwenRun() {
  return {
    ...run(),
    id: "asr-run-qwen",
    operationId: "asr-op-qwen",
    engineId: "qwen3-asr",
    engineVersion: "0.0.6",
    runtimeId: "qwen3-asr-transformers-cu128-x64",
    runtimeVersion: "0.0.6+torch2.11.0-cu128",
    modelId: "qwen3-asr-0.6b",
    requestedDevice: "auto",
    actualDevice: "cuda",
    canonicalizerVersion: "qwen3-asr-0.0.6-v2",
    rawArtifactRelativePath: "artifacts/asr/asr-run-qwen.json",
  };
}

test("ASR candidate is inactive, blank-targeted, idempotent, and preserves active human state", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-candidate-"));
  let repository = openProjectRepository(root);
  try {
    repository.saveProject(project());
    repository.commitAsrRun({ run: run(), result: result() });
    const before = repository.loadProject();
    const rawBefore = repository.getAsrRun("asr-run-candidate");
    const service = createAsrCandidateService({
      getProjectRepository: () => repository,
      now: () => "2026-07-20T00:00:02.000Z",
    });
    const request = {
      projectId: "project-asr-candidate",
      asrRunId: "asr-run-candidate",
      configVersion: ASR_SEGMENTATION_CONFIG_VERSION,
      operationId: "renderer-field-is-ignored",
    };
    const completed = await service.segment(request);
    assert.equal(completed.deduplicated, false);
    const after = repository.loadProject();
    assert.equal(after.activeSourceTrackId, "source-human");
    assert.deepEqual(after.sourceTracks[0], before.sourceTracks[0]);
    assert.deepEqual(after.editorHistory, before.editorHistory);
    assert.deepEqual(repository.getAsrRun("asr-run-candidate"), rawBefore);
    const candidate = after.sourceTracks[1];
    assert.equal(candidate.id, completed.sourceTrackId);
    assert.equal(candidate.kind, "asr");
    assert.equal(candidate.isActive, false);
    assert.equal(candidate.asrRunId, "asr-run-candidate");
    assert.equal(candidate.segmentationConfigVersion, ASR_SEGMENTATION_CONFIG_VERSION);
    assert.equal(candidate.sourceStreamId, "s:0");
    assert.deepEqual(candidate.targetTracks.map((track) => [track.languageCode, track.isActive]), [["zh-CN", true], ["ja", true]]);
    for (const segment of candidate.segments) {
      assert.equal(Object.hasOwn(segment.sourceText, "manual"), false);
      assert.deepEqual(Object.values(segment.targetTexts), [
        { model: "", postProcessed: "", qaFlags: [] },
        { model: "", postProcessed: "", qaFlags: [] },
      ]);
    }

    const duplicate = await service.segment(request);
    assert.equal(duplicate.sourceTrackId, completed.sourceTrackId);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(repository.loadProject().sourceTracks.length, 2);

    const withoutCandidate = { ...repository.loadProject(), sourceTracks: [repository.loadProject().sourceTracks[0]] };
    assert.throws(
      () => repository.saveProject(withoutCandidate),
      (error) => error?.code === "CONFLICT",
    );
    assert.equal(repository.loadProject().sourceTracks.length, 2);

    repository.saveProject(repository.loadProject());
    repository.close();
    repository = openProjectRepository(root);
    assert.equal(repository.schemaVersion, 23);
    assert.equal(repository.loadProject().sourceTracks[1].asrRunId, "asr-run-candidate");
    assert.equal(repository.loadProject().sourceTracks[0].segments[0].sourceText.manual, "Human manual");
  } finally {
    repository?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncertain song intervals become non-blocking suspected-lyrics QA flags", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-candidate-song-"));
  const repository = openProjectRepository(root);
  try {
    repository.saveProject(project());
    repository.commitAsrRun({
      run: run(),
      result: {
        ...result(),
        songActivity: {
          detector: "ina-speech-music-noise-v1",
          mode: "filter",
          filteredIntervals: [],
          uncertainIntervals: [{ startMs: 500, endMs: 1_500 }],
        },
      },
    });
    assert.deepEqual(repository.getAsrRun("asr-run-candidate").result.songActivity?.uncertainIntervals, [
      { startMs: 500, endMs: 1_500 },
    ]);
    const service = createAsrCandidateService({ getProjectRepository: () => repository });
    await service.segment({
      projectId: "project-asr-candidate",
      asrRunId: "asr-run-candidate",
      configVersion: ASR_SEGMENTATION_CONFIG_VERSION,
      operationId: "song-segment",
    });
    const candidate = repository.loadProject().sourceTracks[1];
    for (const layer of Object.values(candidate.segments[0].targetTexts)) {
      assert.deepEqual(layer.qaFlags, ["suspected-lyrics"]);
    }
    assert.doesNotThrow(() => repository.saveProject(repository.loadProject()));
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fast speech candidates remain persistable when source timing cannot meet preferred CPS", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-candidate-fast-speech-"));
  const repository = openProjectRepository(root);
  try {
    const text = "x".repeat(46);
    repository.saveProject(project());
    repository.commitAsrRun({
      run: run(),
      result: {
        ...result(),
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
    const service = createAsrCandidateService({ getProjectRepository: () => repository });
    const completed = await service.segment({
      projectId: "project-asr-candidate",
      asrRunId: "asr-run-candidate",
      configVersion: ASR_SEGMENTATION_CONFIG_VERSION,
    });
    assert.equal(completed.segmentCount, 1);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("different config versions coexist while invalid or missing raw runs create nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-candidate-coexist-"));
  const repository = openProjectRepository(root);
  try {
    repository.saveProject(project());
    repository.commitAsrRun({ run: run(), result: result() });
    const service = createAsrCandidateService({ getProjectRepository: () => repository });
    await service.segment({ projectId: "project-asr-candidate", asrRunId: "asr-run-candidate", configVersion: ASR_SEGMENTATION_CONFIG_VERSION });
    const first = repository.loadProject().sourceTracks.at(-1);
    const second = {
      ...structuredClone(first),
      id: "asr-candidate-future",
      label: "ASR candidate future",
      segmentationConfigVersion: "asr-segmentation-v4",
      segments: first.segments.map((segment, index) => ({ ...segment, id: `asr-future-segment-${index}` })),
      targetTracks: first.targetTracks.map((track, index) => ({ ...track, id: `asr-future-target-${index}` })),
    };
    assert.equal(repository.commitAsrCandidate({
      asrRunId: "asr-run-candidate",
      configVersion: "asr-segmentation-v4",
      sourceTrack: second,
      updatedAt: "2026-07-20T00:00:03.000Z",
    }).deduplicated, false);
    assert.equal(repository.loadProject().sourceTracks.length, 3);
    assert.deepEqual(repository.loadProject().sourceTracks.slice(1).map((track) => track.segmentationConfigVersion), [ASR_SEGMENTATION_CONFIG_VERSION, "asr-segmentation-v4"]);

    await assert.rejects(
      service.segment({ projectId: "project-asr-candidate", asrRunId: "missing-run", configVersion: ASR_SEGMENTATION_CONFIG_VERSION }),
      (error) => error?.code === "NOT_FOUND",
    );
    assert.equal(repository.loadProject().sourceTracks.length, 3);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Qwen candidate keeps its detected language after persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-candidate-qwen-"));
  const repository = openProjectRepository(root);
  try {
    repository.saveProject(project());
    repository.commitAsrRun({ run: qwenRun(), result: result() });
    const service = createAsrCandidateService({ getProjectRepository: () => repository });
    await service.segment({
      projectId: "project-asr-candidate",
      asrRunId: "asr-run-qwen",
      configVersion: ASR_SEGMENTATION_CONFIG_VERSION,
    });
    const candidate = repository.loadProject().sourceTracks.at(-1);
    assert.equal(candidate.languageState, "known");
    assert.equal(candidate.defaultLanguage, "en");
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an in-flight resegmentation can be cancelled before candidate commit", async () => {
  const words = Array.from({ length: 1_000 }, (_, index) => ({
    startMs: index * 100,
    endMs: index * 100 + 80,
    text: ` w${index}`,
    probability: 0.9,
  }));
  const largeResult = {
    schemaVersion: 1,
    mediaDurationMs: 100_000,
    detectedLanguage: "en",
    languageProbability: 0.99,
    warnings: [],
    segments: [{ startMs: 0, endMs: 100_000, text: words.map((word) => word.text).join(""), language: "en", languageProbability: 0.99, words }],
  };
  let committed = false;
  const service = createAsrCandidateService({
    getProjectRepository: () => ({
      loadProject: () => project(),
      getAsrRun: () => ({ run: run(), result: largeResult }),
      commitAsrCandidate: () => { committed = true; return {}; },
    }),
  });
  const inFlight = service.segment({ projectId: "project-asr-candidate", asrRunId: "asr-run-candidate", configVersion: ASR_SEGMENTATION_CONFIG_VERSION, operationId: "segment-cancel" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await service.cancel({ operationId: "segment-cancel" }), { cancelled: true });
  await assert.rejects(inFlight, (error) => error?.code === "CANCELLED");
  assert.equal(committed, false);
});
