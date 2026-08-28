import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAudioSeparationService } from "../../backend/audio/separation-service.mjs";

function fixture({ available = true, fail = false } = {}) {
  const containerDir = mkdtempSync(join(tmpdir(), "phase11-separation-"));
  const mediaPath = join(containerDir, "source.wav");
  writeFileSync(mediaPath, "source audio", "utf8");
  const records = [{ id: "subtitle-1", exportKind: "target", path: "exports/subtitle.srt" }];
  const service = createAudioSeparationService({
    getProjectRepository: () => ({
      containerDir,
      loadProject: () => ({ id: "p1", activeSourceTrackId: "source-1" }),
      listExportRecords: () => [...records],
      appendExportRecord: (record) => records.push(record),
    }),
    resolveMediaPath: () => mediaPath,
    capabilityProvider: () => ({
      available,
      workerId: available ? "local-separator" : null,
      modelVersion: available ? "test-model-1" : null,
      reason: available ? null : "worker_not_installed",
    }),
    runWorker: async ({ outputDir }) => {
      if (fail) throw Object.assign(new Error("worker failed"), { code: "WORKER_FAILED" });
      for (const stem of ["vocals", "accompaniment", "background"]) {
        writeFileSync(join(outputDir, `${stem}.wav`), stem, "utf8");
      }
    },
    now: () => new Date("2026-07-23T14:00:00.000Z"),
  });
  return { containerDir, records, service };
}

test("separation worker commits three app-owned stems and a traceable manifest", async () => {
  const value = fixture();
  try {
    const result = await value.service.separate({ projectId: "p1", operationId: "separate-1" });
    assert.deepEqual(result.stems, ["vocals", "accompaniment", "background"]);
    assert.equal(value.records.length, 2);
    assert.equal(value.records[1].exportKind, "audio_separation");
    assert.equal(value.records[1].sourceTrackId, "source-1");
    assert.equal(value.records[1].targetTrackId, null);
    const manifestPath = join(value.containerDir, ...value.records[1].path.split("/"));
    assert.equal(existsSync(manifestPath), true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.workerId, "local-separator");
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.stem), result.stems);
  } finally {
    rmSync(value.containerDir, { recursive: true, force: true });
  }
});

test("unavailable or failed separation never removes existing subtitle delivery records", async () => {
  for (const options of [{ available: false }, { fail: true }]) {
    const value = fixture(options);
    try {
      await assert.rejects(
        () => value.service.separate({ projectId: "p1", operationId: `separate-${value.records.length}` }),
        (error) => options.available === false ? error.code === "NOT_AVAILABLE" : error.code === "WORKER_FAILED",
      );
      assert.deepEqual(value.records, [{ id: "subtitle-1", exportKind: "target", path: "exports/subtitle.srt" }]);
      assert.equal(existsSync(join(value.containerDir, "artifacts", "audio-separation")), true);
    } finally {
      rmSync(value.containerDir, { recursive: true, force: true });
    }
  }
});

test("capability status never exposes worker paths", async () => {
  const service = createAudioSeparationService({
    getProjectRepository: () => { throw new Error("not used"); },
    resolveMediaPath: () => null,
    capabilityProvider: () => ({
      available: false,
      workerId: "C:\\private\\separator.exe",
      modelVersion: "../model",
      reason: "missing at C:\\private",
    }),
    runWorker: async () => {},
  });
  assert.deepEqual(await service.getCapability(), {
    available: false,
    workerId: null,
    modelVersion: null,
    reason: null,
  });
});
