import assert from "node:assert/strict";
import test from "node:test";
import { createAsrProjectService } from "../../backend/asr/asr-project-service.mjs";

function project() {
  return {
    id: "project-workflow",
    sourceTracks: [],
    activeSourceTrackId: null,
  };
}

function run() {
  return {
    id: "asr-run-1",
    operationId: "secret-operation",
    projectId: "project-workflow",
    audioStreamId: "s:1",
    modelId: "small",
    modelHash: "a".repeat(64),
    actualDevice: "cpu",
    fallbackReason: null,
    mediaDurationMs: 2_000,
    processingDurationMs: 1_000,
    rawSegmentCount: 1,
    wordCount: 2,
    detectedLanguage: "en",
    rawArtifactRelativePath: "artifacts/asr/private.json",
    completedAt: "2026-07-20T10:00:00.000Z",
  };
}

test("ASR project status is restart-safe and strips operation, artifact, hash, and process fields", async () => {
  const value = project();
  const repo = { loadProject: () => value, listAsrRuns: () => [run()] };
  const service = createAsrProjectService({
    getProjectRepository: () => repo,
    getCapabilityStatus: async () => ({ ready: true }),
    getDeviceStatus: async () => ({ requestedDevice: "cpu" }),
    asrService: { run: async () => ({}), cancel: async () => ({ cancelled: false }) },
    candidateService: { segment: async () => ({}), cancel: async () => ({ cancelled: false }) },
    languageService: { detect: async () => ({}), updateManual: () => ({}) },
    languageRegionDetector: { finish: async () => {}, cancel: async () => ({ cancelled: false }) },
  });
  const status = await service.getStatus({ projectId: "project-workflow" });
  assert.equal(status.project, value);
  assert.equal(status.runs[0].id, "asr-run-1");
  const serialized = JSON.stringify(status.runs);
  assert.equal(/operation|artifact|hash|path|argv|cwd/i.test(serialized), false);
});

test("mutations reload and index the persisted project while cancellation is project-owned", async () => {
  let value = project();
  let release;
  const persisted = [];
  const cancellations = [];
  const repo = { loadProject: () => value, listAsrRuns: () => [] };
  const service = createAsrProjectService({
    getProjectRepository: () => repo,
    getCapabilityStatus: async () => ({ ready: true }),
    getDeviceStatus: async () => ({ requestedDevice: "cpu" }),
    asrService: {
      run: async () => new Promise((resolve) => { release = resolve; }),
      cancel: async ({ operationId }) => { cancellations.push(["asr", operationId]); release?.({ runId: "cancelled" }); return { cancelled: true }; },
    },
    candidateService: {
      segment: async () => { value = { ...value, sourceTracks: [{ id: "candidate-1" }] }; return { sourceTrackId: "candidate-1" }; },
      cancel: async ({ operationId }) => { cancellations.push(["segment", operationId]); return { cancelled: true }; },
    },
    languageService: {
      detect: async () => ({ sourceTrackId: "candidate-1", pendingSegmentIds: ["segment-1"] }),
      updateManual: () => ({ sourceTrackId: "candidate-1", affectedSegmentIds: ["segment-1"] }),
    },
    languageRegionDetector: {
      finish: async () => {},
      cancel: async ({ operationId }) => { cancellations.push(["language", operationId]); return { cancelled: true }; },
    },
    persistProject: (next) => persisted.push(next),
  });

  assert.equal(service.isBusy(), false);
  const segmented = await service.segment({ projectId: "project-workflow", asrRunId: "asr-run-1", configVersion: "asr-segmentation-v2", operationId: "segment-op" });
  assert.equal(segmented.project.sourceTracks[0].id, "candidate-1");
  assert.equal(persisted.at(-1), value);

  const inFlight = service.transcribe({ projectId: "project-workflow", operationId: "owned-op" });
  assert.equal(service.isBusy(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await service.cancel({ projectId: "other-project", operationId: "owned-op" }), { cancelled: false });
  assert.deepEqual(await service.cancel({ projectId: "project-workflow", operationId: "owned-op" }), { cancelled: true });
  await inFlight;
  assert.equal(service.isBusy(), false);
  assert.deepEqual(cancellations, [["asr", "owned-op"], ["segment", "owned-op"], ["language", "owned-op"]]);
});
