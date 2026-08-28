import assert from "node:assert/strict";
import test from "node:test";
import { approveProjectDelivery, inspectProjectDelivery } from "../../src/domain/project-delivery.ts";

function project() {
  return {
    id: "delivery-project",
    title: "Delivery project",
    sourceFileName: "source.srt",
    mediaKind: "subtitle",
    noSourceMedia: true,
    lifecycle: "needs_review",
    createdAt: "2026-07-29 10:00",
    updatedAt: "2026-07-29 10:00",
    activeSourceTrackId: "source-1",
    pendingConfirmations: [],
    notes: [],
    config: {
      sourceLanguage: "en",
      targetLanguages: ["简体中文", "日语"],
      provider: "DeepSeek",
      model: "deepseek-chat",
      glossary: "",
      styleGuide: "",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [{
      id: "source-1",
      label: "Main",
      kind: "external_subtitle",
      languageState: "known",
      defaultLanguage: "en",
      isActive: true,
      summary: "main",
      segments: [{
        id: "seg-1",
        start: "00:00:01,000",
        end: "00:00:03,000",
        sourceLanguage: "en",
        sourceText: { original: "Hello", normalized: "Hello" },
        targetTexts: {
          "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
          "ja-JP": { model: "こんにちは", postProcessed: "こんにちは", qaFlags: [] },
        },
      }],
      targetTracks: [
        {
          id: "target-zh",
          languageCode: "zh-CN",
          languageLabel: "简体中文",
          status: "in_review",
          isActive: true,
          qaIssues: [],
          snapshotIds: [],
          deliveryLabel: "待校对",
          lastHumanAction: "none",
        },
        {
          id: "target-ja",
          languageCode: "ja-JP",
          languageLabel: "日语",
          status: "in_review",
          isActive: true,
          qaIssues: [],
          snapshotIds: [],
          deliveryLabel: "待校对",
          lastHumanAction: "none",
        },
      ],
    }],
    recentRunIds: ["run-1"],
  };
}

test("delivery inspection groups blocking issues and keeps the first location", () => {
  const blocked = project();
  blocked.sourceTracks[0].targetTracks[0].qaIssues = [
    { id: "one", ruleId: "qa.empty_target", label: "目标为空", severity: "error", detail: "one", segmentId: "seg-1" },
    { id: "two", ruleId: "qa.empty_target", label: "目标为空", severity: "error", detail: "two", segmentId: "seg-2" },
    { id: "warn", ruleId: "qa.max_cps", label: "CPS 过高", severity: "warning", detail: "warn", segmentId: "seg-1" },
  ];

  const inspection = inspectProjectDelivery(blocked);
  assert.equal(inspection.state, "blocked");
  assert.equal(inspection.errorCount, 2);
  assert.equal(inspection.warningCount, 1);
  assert.equal(inspection.errorGroups[0].count, 2);
  assert.equal(inspection.errorGroups[0].firstSegmentId, "seg-1");
});

test("untranslated draft targets are not deliverable", () => {
  const untranslated = project();
  untranslated.sourceTracks[0].targetTracks.forEach((track) => { track.status = "draft"; });
  untranslated.sourceTracks[0].segments[0].targetTexts = {
    "zh-CN": { model: "", postProcessed: "", qaFlags: [] },
    "ja-JP": { model: "", postProcessed: "", qaFlags: [] },
  };

  assert.equal(inspectProjectDelivery(untranslated).state, "empty");
});

test("one explicit delivery action approves every clean active language and blocks any empty target", () => {
  const approved = approveProjectDelivery(project());
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.approvedLanguageCodes, ["zh-CN", "ja-JP"]);
  assert.ok(approved.project.sourceTracks[0].targetTracks.every((track) => track.status === "approved"));

  const blocked = project();
  blocked.sourceTracks[0].segments[0].targetTexts["ja-JP"] = { model: "", postProcessed: "", qaFlags: [] };
  const rejected = approveProjectDelivery(blocked);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "hard_qa_errors");
  assert.equal(rejected.inspection.errorGroups[0].firstSegmentId, "seg-1");
  assert.ok(rejected.project.sourceTracks[0].targetTracks.every((track) => track.status === "in_review"));
});
