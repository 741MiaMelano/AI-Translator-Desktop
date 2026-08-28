import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAsrCandidateService } from "../../backend/asr/asr-candidate-service.mjs";
import { createAsrLanguageService } from "../../backend/asr/asr-language-service.mjs";
import { ASR_SEGMENTATION_CONFIG_VERSION } from "../../backend/asr/segmentation.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";

function project() {
  return {
    id: "project-language",
    title: "Language evidence",
    sourceFileName: "source.wav",
    mediaKind: "audio",
    lifecycle: "draft",
    noSourceMedia: false,
    activeSourceTrackId: null,
    sourceTracks: [],
    config: { sourceLanguage: "auto", targetLanguages: ["zh-CN"], provider: "OpenAI", model: "GPT-4.1", glossary: "none", styleGuide: "none", outputFormat: "SRT", burnVideo: false, copyMediaIntoProject: true },
    mediaSource: { assetId: "primary", displayName: "source.wav", availability: "available", identity: null, selectedAudioStreamId: "s:0", selectedSubtitleStreamId: null },
    sourceProbeSummary: { media: { mediaKind: "audio", format: { formatName: "wav", durationMs: 5_000, sizeBytes: 160_000 }, streams: [{ streamId: "s:0", index: 0, kind: "audio", codec: "pcm_s16le", language: null, title: null, default: true, forced: false, extractable: false, width: null, height: null, channels: 1, sampleRate: 16_000 }], warnings: [], probeVersion: 1, artifact: { upstreamVersion: "7.1.1", ffprobeSha256: null } } },
    pendingConfirmations: [], notes: [], recentRunIds: [],
    createdAt: "2026-07-20T01:00:00.000Z", updatedAt: "2026-07-20T01:00:00.000Z",
  };
}

function rawResult() {
  return {
    schemaVersion: 1,
    mediaDurationMs: 5_000,
    detectedLanguage: "en",
    languageProbability: null,
    warnings: ["language_probability_unavailable"],
    segments: [
      { startMs: 0, endMs: 1_500, text: " Hello.", language: "en", languageProbability: null, words: [{ startMs: 0, endMs: 1_500, text: " Hello.", probability: 0.9 }] },
      { startMs: 3_000, endMs: 4_500, text: " 你好。", language: "en", languageProbability: null, words: [{ startMs: 3_000, endMs: 4_500, text: " 你好。", probability: 0.9 }] },
    ],
  };
}

function run() {
  return {
    id: "asr-run-language", operationId: "asr-op-language", projectId: "project-language", audioStreamId: "s:0",
    engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeId: "whisper-cpp-cpu-x64", runtimeVersion: "1.9.1",
    modelId: "small", modelVersion: "model-revision", modelHash: "a".repeat(64), requestedDevice: "cpu", actualDevice: "cpu", fallbackReason: null,
    cacheFingerprint: "c".repeat(64),
    languageMode: "auto", languageHint: null, parameters: { threads: 6 }, rawArtifactRelativePath: "artifacts/asr/asr-run-language.json",
    rawArtifactSha256: "b".repeat(64), rawArtifactSizeBytes: 512, processingDurationMs: 1_000,
    canonicalizerVersion: "whisper.cpp-1.9.1-v2", createdAt: "2026-07-20T01:00:00.000Z", completedAt: "2026-07-20T01:00:01.000Z",
  };
}

test("segment evidence, manual override, sticky multilingual state, stale targets, and restart round-trip", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-language-"));
  let repository = openProjectRepository(root);
  let detectionRound = 0;
  const detectedBySegment = new Map();
  try {
    repository.saveProject(project());
    repository.commitAsrRun({ run: run(), result: rawResult() });
    const candidate = createAsrCandidateService({ getProjectRepository: () => repository, now: () => "2026-07-20T01:00:02.000Z" });
    const created = await candidate.segment({ projectId: "project-language", asrRunId: "asr-run-language", configVersion: ASR_SEGMENTATION_CONFIG_VERSION });
    const language = createAsrLanguageService({
      getProjectRepository: () => repository,
      detectRegion: async ({ segmentId, startMs, endMs }) => {
        detectedBySegment.set(segmentId, [startMs, endMs]);
        const second = [...detectedBySegment.keys()].indexOf(segmentId) === 1;
        return {
          segmentId,
          detectedLanguage: detectionRound > 0 ? "zh" : second ? "zh" : "en",
          confidence: 0.99,
          detectionMethod: "whisper.cpp-region-auto",
          detectionVersion: "whisper.cpp-1.9.1-small-v1",
          overlapStatus: "none",
        };
      },
      now: (() => { let tick = 3; return () => `2026-07-20T01:00:0${tick++}.000Z`; })(),
    });
    const detected = await language.detect({ projectId: "project-language", sourceTrackId: created.sourceTrackId, extraProvider: "must be ignored" });
    assert.equal(detected.languageState, "multilingual");
    assert.equal(detectedBySegment.size, 2);
    let loaded = repository.loadProject();
    let track = loaded.sourceTracks[0];
    assert.deepEqual(track.segments.map((segment) => [segment.detectedLanguage, segment.languageConfidence, segment.sourceLanguage]), [["en", 0.99, "en"], ["zh", 0.99, "zh"]]);
    assert.deepEqual(track.segments.map((segment) => [segment.languageDetectionMethod, segment.languageDetectionVersion, segment.languageOverlapStatus]), [
      ["whisper.cpp-region-auto", "whisper.cpp-1.9.1-small-v1", "none"],
      ["whisper.cpp-region-auto", "whisper.cpp-1.9.1-small-v1", "none"],
    ]);

    track.segments[1].targetTexts["zh-CN"].model = "已有译文";
    track.segments[1].targetTexts["zh-CN"].postProcessed = "已有译文";
    repository.saveProject(loaded);
    const changed = language.updateManual({
      projectId: "project-language",
      sourceTrackId: created.sourceTrackId,
      changes: [{ segmentId: track.segments[1].id, manualLanguage: "EN" }],
      confirmTrackConvergence: false,
    });
    assert.deepEqual(changed.affectedSegmentIds, [track.segments[1].id]);
    assert.equal(changed.languageState, "multilingual");
    loaded = repository.loadProject();
    track = loaded.sourceTracks[0];
    assert.equal(track.segments[1].detectedLanguage, "zh");
    assert.equal(track.segments[1].manualLanguage, "en");
    assert.equal(track.segments[1].sourceLanguage, "en");
    assert.equal(track.segments[1].targetTexts["zh-CN"].stale, true);
    assert.equal(track.segments[0].targetTexts["zh-CN"].stale, undefined);

    detectionRound += 1;
    await language.detect({ projectId: "project-language", sourceTrackId: created.sourceTrackId });
    loaded = repository.loadProject();
    assert.equal(loaded.sourceTracks[0].segments[1].manualLanguage, "en", "detection rerun preserves manual evidence");
    assert.equal(loaded.sourceTracks[0].segments[1].detectedLanguage, "zh");

    const convergence = language.updateManual({
      projectId: "project-language",
      sourceTrackId: created.sourceTrackId,
      changes: [{ segmentId: loaded.sourceTracks[0].segments[0].id, manualLanguage: "en" }],
      confirmTrackConvergence: true,
    });
    assert.equal(convergence.languageState, "known");
    assert.equal(convergence.defaultLanguage, "en");

    repository.close();
    repository = openProjectRepository(root);
    assert.equal(repository.schemaVersion, 23);
    const restarted = repository.loadProject().sourceTracks[0];
    assert.equal(restarted.languageState, "known");
    assert.equal(restarted.segments[0].manualLanguage, "en");
    assert.equal(restarted.segments[0].detectedLanguage, "zh");
    assert.equal(restarted.segments[1].targetTexts["zh-CN"].model, "已有译文");
  } finally {
    repository?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid manual scope changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "asr-language-invalid-"));
  const repository = openProjectRepository(root);
  try {
    repository.saveProject(project());
    repository.commitAsrRun({ run: run(), result: rawResult() });
    const candidate = createAsrCandidateService({ getProjectRepository: () => repository });
    const created = await candidate.segment({ projectId: "project-language", asrRunId: "asr-run-language", configVersion: ASR_SEGMENTATION_CONFIG_VERSION });
    const before = repository.loadProject();
    const language = createAsrLanguageService({ getProjectRepository: () => repository, detectRegion: async () => { throw new Error("not called"); } });
    assert.throws(
      () => language.updateManual({ projectId: "project-language", sourceTrackId: created.sourceTrackId, changes: [{ segmentId: "missing", manualLanguage: "en" }] }),
      (error) => error?.code === "INVALID_INPUT",
    );
    assert.deepEqual(repository.loadProject(), before);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("language service preserves actionable region failure codes", async () => {
  const repo = {
    loadProject: () => ({
      id: "project-language",
      sourceTracks: [{
        id: "candidate-language",
        kind: "asr",
        asrRunId: "run-language",
        segments: [{ id: "segment-language", start: "00:00:00,000", end: "00:00:01,000" }],
      }],
    }),
    commitAsrLanguageState: () => { throw new Error("must not commit"); },
  };
  for (const code of ["NOT_AVAILABLE", "INVALID_ARTIFACT", "PROCESS_FAILED", "OUTPUT_TOO_LARGE", "CUDA_UNAVAILABLE"]) {
    const service = createAsrLanguageService({
      getProjectRepository: () => repo,
      detectRegion: async () => {
        const error = new Error("C:\\private detail");
        error.code = code;
        throw error;
      },
    });
    await assert.rejects(
      () => service.detect({ projectId: "project-language", sourceTrackId: "candidate-language" }),
      (error) => error?.code === code && !error.message.includes("private"),
    );
  }
});
