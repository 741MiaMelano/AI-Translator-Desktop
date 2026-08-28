import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVideoExportService } from "../../backend/export/video-export-service.mjs";

test("video post-processing resolves a recorded subtitle and appends a traceable export", async () => {
  const containerDir = mkdtempSync(join(tmpdir(), "phase11-video-service-"));
  const exportsDir = join(containerDir, "exports");
  const mediaPath = join(containerDir, "source.mkv");
  mkdirSync(exportsDir, { recursive: true });
  writeFileSync(join(exportsDir, "zh-CN.ass"), "[Script Info]\n", "utf8");
  writeFileSync(mediaPath, "media", "utf8");
  const appended = [];
  const processPayloads = [];
  const selectedOutputPath = join(containerDir, "selected", "translated-video.mkv");
  const revealed = [];
  mkdirSync(join(containerDir, "selected"), { recursive: true });
  const repository = {
    containerDir,
    loadProject: () => ({ id: "p1", title: "Demo" }),
    listExportRecords: () => [{
      id: "subtitle-record",
      exportKind: "target",
      targetLanguageCode: "zh-CN",
      path: "exports/zh-CN.ass",
      sourceTrackId: "source-1",
      targetTrackId: "target-zh",
      trackStatus: "in_review",
      deliveryStatus: "draft",
    }],
    appendExportRecord: (record) => appended.push(record),
  };
  const service = createVideoExportService({
    getProjectRepository: () => repository,
    resolveMediaPath: () => mediaPath,
    resolveFfmpegArtifacts: () => ({ ffmpegPath: "C:\\managed\\ffmpeg.exe" }),
    runProcess: async (payload) => {
      processPayloads.push(payload);
      writeFileSync(payload.argv.at(-1), "video", "utf8");
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    },
    selectOutputFile: async ({ suggestedName }) => {
      assert.match(suggestedName, /\.mkv$/);
      return { canceled: false, filePath: selectedOutputPath };
    },
    revealOutputFile: (path) => revealed.push(path),
    now: () => new Date("2026-07-23T12:00:00.000Z"),
  });
  try {
    const result = await service.exportVideo({
      projectId: "p1",
      subtitleExportRecordId: "subtitle-record",
      mode: "soft_subtitle",
      operationId: "operation-1",
    });
    assert.equal(result.ok, true);
    assert.equal(processPayloads[0].operationId, "operation-1");
    assert.equal(processPayloads[0].argv.at(-1), selectedOutputPath);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].exportKind, "soft_subtitle");
    assert.equal(appended[0].deliveryStatus, "draft");
    assert.equal(appended[0].path, selectedOutputPath);
    assert.equal(appended[0].destinationKind, "external");
    assert.equal(appended[0].targetTrackId, "target-zh");
    assert.deepEqual(revealed, [selectedOutputPath]);
  } finally {
    rmSync(containerDir, { recursive: true, force: true });
  }
});

test("cancelling the video save dialog creates no file or export record", async () => {
  const containerDir = mkdtempSync(join(tmpdir(), "phase11-video-cancel-"));
  const exportsDir = join(containerDir, "exports");
  const mediaPath = join(containerDir, "source.mkv");
  mkdirSync(exportsDir, { recursive: true });
  writeFileSync(join(exportsDir, "zh-CN.ass"), "[Script Info]\n", "utf8");
  writeFileSync(mediaPath, "media", "utf8");
  let processed = false;
  let appended = false;
  const service = createVideoExportService({
    getProjectRepository: () => ({
      containerDir,
      loadProject: () => ({ id: "p1", title: "Demo" }),
      listExportRecords: () => [{
        id: "subtitle-record",
        exportKind: "target",
        targetLanguageCode: "zh-CN",
        path: "exports/zh-CN.ass",
      }],
      appendExportRecord: () => { appended = true; },
    }),
    resolveMediaPath: () => mediaPath,
    resolveFfmpegArtifacts: () => ({ ffmpegPath: "C:\\managed\\ffmpeg.exe" }),
    runProcess: async () => { processed = true; },
    selectOutputFile: async () => ({ canceled: true }),
  });
  try {
    const result = await service.exportVideo({
      projectId: "p1",
      subtitleExportRecordId: "subtitle-record",
      mode: "soft_subtitle",
      operationId: "operation-cancel",
    });
    assert.deepEqual(result, { ok: true, canceled: true });
    assert.equal(processed, false);
    assert.equal(appended, false);
  } finally {
    rmSync(containerDir, { recursive: true, force: true });
  }
});

test("burn failure does not append an export record", async () => {
  const containerDir = mkdtempSync(join(tmpdir(), "phase11-video-failure-"));
  const exportsDir = join(containerDir, "exports");
  const mediaPath = join(containerDir, "source.mkv");
  mkdirSync(exportsDir, { recursive: true });
  writeFileSync(join(exportsDir, "zh-CN.ass"), "[Script Info]\n", "utf8");
  writeFileSync(mediaPath, "media", "utf8");
  let appended = false;
  const service = createVideoExportService({
    getProjectRepository: () => ({
      containerDir,
      loadProject: () => ({ id: "p1", title: "Demo" }),
      listExportRecords: () => [{
        id: "subtitle-record",
        exportKind: "target",
        targetLanguageCode: "zh-CN",
        path: "exports/zh-CN.ass",
        sourceTrackId: "source-1",
        targetTrackId: "target-zh",
        trackStatus: "approved",
        deliveryStatus: "approved",
      }],
      appendExportRecord: () => { appended = true; },
    }),
    resolveMediaPath: () => mediaPath,
    resolveFfmpegArtifacts: () => ({ ffmpegPath: "C:\\managed\\ffmpeg.exe" }),
    runProcess: async () => { throw Object.assign(new Error("burn failed"), { code: "PROCESS_FAILED" }); },
  });
  try {
    await assert.rejects(() => service.exportVideo({
      projectId: "p1",
      subtitleExportRecordId: "subtitle-record",
      mode: "burn_ass",
      operationId: "operation-2",
    }));
    assert.equal(appended, false);
  } finally {
    rmSync(containerDir, { recursive: true, force: true });
  }
});
