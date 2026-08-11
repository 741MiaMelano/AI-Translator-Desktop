import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAsrLanguageRegionDetector } from "../../backend/asr/asr-language-region-detector.mjs";

function project() {
  return {
    id: "project-region",
    noSourceMedia: false,
    mediaSource: { availability: "available" },
    sourceProbeSummary: { media: {
      format: { durationMs: 2_000 },
      streams: [{ streamId: "s:1", index: 1, kind: "audio" }],
    } },
    sourceTracks: [{ id: "candidate-1", kind: "asr", asrRunId: "run-1", sourceStreamId: "s:1" }],
  };
}

function harness({ holdMedia = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "asr-region-"));
  const sourcePath = join(root, "source.wav");
  const ffmpegPath = join(root, "ffmpeg.exe");
  writeFileSync(sourcePath, "source");
  writeFileSync(ffmpegPath, "ffmpeg");
  let releaseMedia;
  const cancellations = [];
  const detections = [];
  const mediaCalls = [];
  const selectedModelIds = [];
  const detector = createAsrLanguageRegionDetector({
    getProjectRepository: () => ({
      containerDir: root,
      loadProject: project,
      getAsrRun: () => ({ run: { modelId: "large-v3-turbo-q5_0" } }),
    }),
    resolveMediaPath: () => sourcePath,
    resolveFfmpegArtifacts: async () => ({ ffmpegPath }),
    runMediaProcess: async (payload) => {
      mediaCalls.push(payload);
      if (holdMedia) await new Promise((resolve) => { releaseMedia = resolve; });
      if (!holdMedia) writeFileSync(payload.argv.at(-1), Buffer.alloc(64_044));
    },
    cancelMediaProcess: async (operationId) => { cancellations.push(["media", operationId]); releaseMedia?.(); return { cancelled: true }; },
    deviceSelector: {
      run: async ({ modelId, executeStagedAttempt }) => {
        selectedModelIds.push(modelId);
        return { result: await executeStagedAttempt({ runtime: { modelId } }) };
      },
    },
    detectLanguageRegion: async (payload) => {
      detections.push(payload);
      return { segmentId: payload.segmentId, detectedLanguage: "en", confidence: 0.99, detectionMethod: "whisper.cpp-region-auto", detectionVersion: "whisper.cpp-1.9.1-small-v1", overlapStatus: "none" };
    },
    cancelDetection: async (operationId) => { cancellations.push(["asr", operationId]); return { cancelled: true }; },
  });
  return { root, detector, detections, cancellations, mediaCalls, selectedModelIds, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const request = {
  projectId: "project-region",
  asrRunId: "run-1",
  sourceTrackId: "candidate-1",
  segmentId: "segment-1",
  operationId: "language-op",
  requestedDevice: "cpu",
  allowCudaFallback: false,
  startMs: 0,
  endMs: 1_000,
};

test("region detector prepares one main-owned PCM and a physically bounded region before detection", async () => {
  const h = harness();
  try {
    const evidence = await h.detector.detectRegion(request);
    assert.equal(evidence.segmentId, "segment-1");
    assert.equal(h.detections.length, 1);
    assert.equal(h.mediaCalls.length, 2);
    assert.equal(h.mediaCalls[0].argv.at(-1).endsWith("audio.wav"), true);
    assert.equal(h.mediaCalls[1].argv.includes("-ss"), true);
    assert.equal(h.mediaCalls[1].argv.includes("-t"), true);
    assert.equal(h.detections[0].audioPath.endsWith("segment-1.wav"), true);
    assert.equal(h.detections[0].mediaDurationMs, 1_000);
    assert.equal(h.detections[0].startMs, 0);
    assert.equal(h.detections[0].endMs, 1_000);
    assert.deepEqual(h.selectedModelIds, ["large-v3-turbo-q5_0"]);
    assert.equal(h.detections[0].runtime.modelId, "large-v3-turbo-q5_0");
    assert.equal("argv" in evidence || "path" in evidence, false);
    await h.detector.finish("language-op");
    assert.equal(existsSync(join(h.root, "cache", "asr-language", "language-op")), false);
  } finally {
    h.cleanup();
  }
});

test("region detector cancellation settles both workers and leaves no PCM cache", async () => {
  const h = harness({ holdMedia: true });
  try {
    const inFlight = h.detector.detectRegion(request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await h.detector.cancel({ operationId: "language-op" }), { cancelled: true });
    await assert.rejects(inFlight, (error) => error?.code === "CANCELLED");
    await h.detector.finish("language-op");
    assert.deepEqual(h.cancellations, [["media", "language-op"], ["asr", "language-op"]]);
    assert.equal(existsSync(join(h.root, "cache", "asr-language", "language-op")), false);
  } finally {
    h.cleanup();
  }
});
