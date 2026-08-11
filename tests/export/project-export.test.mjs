import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  exportSubtitleMatrix,
  retryFailedExportRequests,
} from "../../backend/export/project-export.mjs";

function projectFixture() {
  return {
    id: "project-phase11",
    title: "演示 / Project",
    sourceFileName: "source.srt",
    activeSourceTrackId: "source-main",
    updatedAt: "2026-07-23T12:00:00.000Z",
    sourceTracks: [{
      id: "source-main",
      isActive: true,
      targetTracks: [
        { id: "target-zh", languageCode: "zh-CN", status: "approved", isActive: true, qaIssues: [] },
        { id: "target-ja", languageCode: "ja", status: "in_review", isActive: true, qaIssues: [] },
      ],
      segments: [
        {
          id: "segment-1",
          start: "00:00:00,000",
          end: "00:00:01,000",
          sourceText: { original: "Hello", normalized: "Hello", manual: "Hello!" },
          targetTexts: {
            "zh-CN": { model: "你好", postProcessed: "你好。", qaFlags: [] },
            ja: { model: "こんにちは", postProcessed: "こんにちは。", qaFlags: [] },
          },
        },
        {
          id: "segment-2",
          start: "00:00:01,000",
          end: "00:00:02,000",
          sourceText: { original: "World", normalized: "World" },
          targetTexts: {
            "zh-CN": { model: "世界", postProcessed: "世界。", manual: "世界！", qaFlags: [] },
            ja: { model: "世界", postProcessed: "世界。", qaFlags: [] },
          },
        },
      ],
    }],
  };
}

test("exports source, per-language target, and bilingual views without forking timelines", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "phase11-export-matrix-"));
  try {
    const summary = exportSubtitleMatrix({
      project: projectFixture(),
      containerDir,
      requests: [
        { id: "source", exportKind: "source", format: "srt" },
        { id: "target-zh", exportKind: "target", targetLanguageCode: "zh-CN", format: "srt" },
        { id: "bilingual-zh", exportKind: "bilingual", targetLanguageCode: "zh-CN", format: "srt" },
        { id: "target-ja", exportKind: "target", targetLanguageCode: "ja", format: "vtt" },
      ],
      now: () => new Date("2026-07-23T12:34:56.000Z"),
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.succeeded.length, 4);
    assert.equal(summary.failed.length, 0);
    assert.deepEqual(summary.succeeded.map((item) => item.exportRecord.exportKind), [
      "source",
      "target",
      "bilingual",
      "target",
    ]);

    const source = readFileSync(join(containerDir, summary.succeeded[0].exportRecord.path), "utf8");
    const target = readFileSync(join(containerDir, summary.succeeded[1].exportRecord.path), "utf8");
    const bilingual = readFileSync(join(containerDir, summary.succeeded[2].exportRecord.path), "utf8");
    assert.match(source, /Hello!/);
    assert.match(target, /世界！/);
    assert.match(bilingual, /Hello!\n你好。/);
    assert.equal((bilingual.match(/-->/g) ?? []).length, 2);
    assert.match(summary.succeeded[3].fileName, /draft/i);
    assert.equal(summary.succeeded[3].exportRecord.deliveryStatus, "draft");
    assert.equal(summary.succeeded[1].exportRecord.deliveryStatus, "approved");
    assert.equal(summary.succeeded[1].exportRecord.sourceTrackId, "source-main");
    assert.equal(summary.succeeded[1].exportRecord.targetTrackId, "target-zh");
  } finally {
    rmSync(containerDir, { recursive: true, force: true });
  }
});

test("an explicitly blank manual target omits that filler cue from target deliveries", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "phase11-export-omitted-cue-"));
  try {
    const project = projectFixture();
    project.sourceTracks[0].segments[0].targetTexts["zh-CN"].manual = "";
    const summary = exportSubtitleMatrix({
      project,
      containerDir,
      requests: [
        { id: "source", exportKind: "source", format: "srt" },
        { id: "target", exportKind: "target", targetLanguageCode: "zh-CN", format: "srt" },
        { id: "bilingual", exportKind: "bilingual", targetLanguageCode: "zh-CN", format: "srt" },
      ],
      now: () => new Date("2026-07-23T12:34:56.000Z"),
    });

    assert.equal(summary.ok, true);
    const source = readFileSync(join(containerDir, summary.succeeded[0].exportRecord.path), "utf8");
    const target = readFileSync(join(containerDir, summary.succeeded[1].exportRecord.path), "utf8");
    const bilingual = readFileSync(join(containerDir, summary.succeeded[2].exportRecord.path), "utf8");
    assert.equal((source.match(/-->/g) ?? []).length, 2);
    assert.equal((target.match(/-->/g) ?? []).length, 1);
    assert.equal((bilingual.match(/-->/g) ?? []).length, 1);
    assert.doesNotMatch(bilingual, /Hello!/);
  } finally {
    rmSync(containerDir, { recursive: true, force: true });
  }
});

test("never overwrites an earlier export and records external destinations", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "phase11-export-version-"));
  const destinationDir = mkdtempSync(join(tmpdir(), "phase11-export-external-"));
  try {
    const input = {
      project: projectFixture(),
      containerDir,
      destinationDir,
      requests: [{ id: "target", exportKind: "target", targetLanguageCode: "zh-CN", format: "ass" }],
      now: () => new Date("2026-07-23T12:34:56.000Z"),
    };
    const first = exportSubtitleMatrix(input);
    const second = exportSubtitleMatrix(input);

    assert.notEqual(first.succeeded[0].fileName, second.succeeded[0].fileName);
    assert.match(second.succeeded[0].fileName, /-2\.ass$/);
    assert.equal(first.succeeded[0].exportRecord.destinationKind, "external");
    assert.equal(first.succeeded[0].exportRecord.path, join(destinationDir, first.succeeded[0].fileName));
    assert.equal(existsSync(first.succeeded[0].exportRecord.path), true);
    assert.equal(existsSync(second.succeeded[0].exportRecord.path), true);
  } finally {
    rmSync(containerDir, { recursive: true, force: true });
    rmSync(destinationDir, { recursive: true, force: true });
  }
});

test("keeps successful files, summarizes failures, and retries failed requests only", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "phase11-export-partial-"));
  try {
    const summary = exportSubtitleMatrix({
      project: projectFixture(),
      containerDir,
      requests: [
        { id: "good", exportKind: "source", format: "srt" },
        { id: "bad", exportKind: "target", targetLanguageCode: "missing", format: "srt" },
      ],
      now: () => new Date("2026-07-23T12:34:56.000Z"),
    });

    assert.equal(summary.ok, false);
    assert.equal(summary.partial, true);
    assert.equal(summary.succeeded.length, 1);
    assert.equal(summary.failed.length, 1);
    assert.equal(existsSync(join(containerDir, summary.succeeded[0].exportRecord.path)), true);
    assert.deepEqual(retryFailedExportRequests(summary), [
      { id: "bad", exportKind: "target", targetLanguageCode: "missing", format: "srt" },
    ]);
  } finally {
    rmSync(containerDir, { recursive: true, force: true });
  }
});
