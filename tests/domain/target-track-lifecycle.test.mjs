import test from "node:test";
import assert from "node:assert/strict";

import {
  approveTargetTrack,
  canExportTargetTrack,
  degradeTrackAfterSourceChange,
  refreshTrackQaIssues,
} from "../../shared/target-track-lifecycle.mjs";

function track(overrides = {}) {
  return {
    id: "tgt-zh",
    languageCode: "zh-CN",
    languageLabel: "简体中文",
    status: "in_review",
    isActive: true,
    qaIssues: [],
    snapshotIds: [],
    deliveryLabel: "review",
    lastHumanAction: "edit",
    ...overrides,
  };
}

function projectWith(segments) {
  return {
    id: "p1",
    activeSourceTrackId: "src",
    sourceTracks: [
      {
        id: "src",
        isActive: true,
        segments,
        targetTracks: [track()],
      },
    ],
  };
}

function cleanSegment() {
  return {
    id: "seg-1",
    start: "00:00:01,000",
    end: "00:00:03,000",
    sourceLanguage: "en",
    sourceText: { original: "Hello", normalized: "Hello" },
    targetTexts: {
      "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
    },
  };
}

test("approval requires explicit human actor", () => {
  const human = approveTargetTrack(track(), [], { actor: "user" });
  assert.equal(human.ok, true);
  assert.equal(human.track.status, "approved");

  const auto = approveTargetTrack(track(), [], { actor: "qa" });
  assert.equal(auto.ok, false);
  assert.equal(auto.reason, "approval_must_be_human");
  assert.equal(auto.track.status, "in_review");
});

test("hard QA errors block approval and export", () => {
  const hard = [{ id: "qa.empty_target:x:zh-CN", severity: "error", label: "空", detail: "x" }];
  const approval = approveTargetTrack(track(), hard, { actor: "user" });
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "hard_qa_errors");

  const exp = canExportTargetTrack(track({ status: "approved" }), hard);
  assert.equal(exp.ok, false);
  assert.equal(exp.reason, "hard_qa_errors");
});

test("warnings do not block approval", () => {
  const warnings = [{ id: "qa.stale:x:zh-CN", severity: "warning", label: "stale", detail: "x" }];
  const approval = approveTargetTrack(track(), warnings, { actor: "user" });
  assert.equal(approval.ok, true);
  assert.equal(approval.track.status, "approved");
});

test("source or timeline change degrades approved/exported to in_review", () => {
  const approved = degradeTrackAfterSourceChange(track({ status: "approved" }));
  assert.equal(approved.ok, true);
  assert.equal(approved.degraded, true);
  assert.equal(approved.track.status, "in_review");

  const exported = degradeTrackAfterSourceChange(track({ status: "exported" }));
  assert.equal(exported.track.status, "in_review");

  const draft = degradeTrackAfterSourceChange(track({ status: "draft" }));
  assert.equal(draft.degraded, false);
  assert.equal(draft.track.status, "draft");
});

test("refreshTrackQaIssues writes deterministic issues onto the track", () => {
  const dirty = projectWith([
    {
      ...cleanSegment(),
      targetTexts: { "zh-CN": { model: "", postProcessed: "", stale: true, qaFlags: [] } },
    },
  ]);
  const refreshed = refreshTrackQaIssues(dirty, track());
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.hasHardErrors, true);
  assert.ok(refreshed.track.qaIssues.some((issue) => issue.severity === "error"));
  const empty = refreshed.track.qaIssues.find((issue) => issue.id.includes("empty_target"));
  assert.equal(empty.ruleId, "qa.empty_target");
  assert.equal(empty.segmentId, "seg-1");
  assert.equal(empty.languageCode, "zh-CN");
});

test("draft export is allowed without hard errors and is marked non-approved", () => {
  const draft = canExportTargetTrack(track({ status: "in_review" }), []);
  assert.equal(draft.ok, true);
  assert.equal(draft.deliveryStatus, "draft");

  const allowed = canExportTargetTrack(track({ status: "approved" }), []);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.deliveryStatus, "approved");
});

test("clean project can refresh then approve", () => {
  const clean = projectWith([cleanSegment()]);
  const refreshed = refreshTrackQaIssues(clean, track({ status: "in_review" }));
  assert.equal(refreshed.hasHardErrors, false);
  const approved = approveTargetTrack(refreshed.track, refreshed.issues, { actor: "user" });
  assert.equal(approved.ok, true);
  assert.equal(approved.track.status, "approved");
});
