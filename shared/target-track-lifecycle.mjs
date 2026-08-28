import { hasHardQaErrors, runSubtitleQa } from "./qa-engine.mjs";

const APPROVED_LIKE = new Set(["approved", "exported"]);

/**
 * Explicit human approval only. QA never auto-approves.
 * Hard errors block approval.
 */
export function approveTargetTrack(track, qaIssues, { actor = "user" } = {}) {
  if (!track || typeof track !== "object") {
    return { ok: false, reason: "track_required", track: null };
  }
  if (actor !== "user") {
    return { ok: false, reason: "approval_must_be_human", track: cloneTrack(track) };
  }
  if (hasHardQaErrors(qaIssues)) {
    return { ok: false, reason: "hard_qa_errors", track: cloneTrack(track) };
  }

  return {
    ok: true,
    track: {
      ...cloneTrack(track),
      status: "approved",
      lastHumanAction: "explicitly approved",
    },
  };
}

/**
 * Source text or timeline drift: approved/exported tracks fall back to in_review.
 * Draft/in_review stay as-is (in_review if already reviewing).
 */
export function degradeTrackAfterSourceChange(track, { reason = "source_or_timeline_changed" } = {}) {
  if (!track || typeof track !== "object") {
    return { ok: false, reason: "track_required", track: null };
  }
  const next = cloneTrack(track);
  if (APPROVED_LIKE.has(next.status)) {
    next.status = "in_review";
    next.lastHumanAction = `degraded after ${reason}`;
  }
  return { ok: true, track: next, degraded: APPROVED_LIKE.has(track.status) };
}

/**
 * Recompute track.qaIssues from the QA engine. Does not change approval status by itself.
 */
export function refreshTrackQaIssues(project, track, options = {}) {
  const languageCode = track?.languageCode ?? options.languageCode;
  const result = runSubtitleQa(project, { ...options, languageCode });
  const next = cloneTrack(track);
  next.qaIssues = result.issues.map((entry) => ({
    id: entry.id,
    ruleId: entry.ruleId,
    label: entry.label,
    severity: entry.severity === "error" ? "error" : "warning",
    detail: entry.detail,
    segmentId: entry.segmentId,
    languageCode: entry.languageCode,
  }));
  return {
    ok: true,
    track: next,
    issues: result.issues,
    hasHardErrors: hasHardQaErrors(result.issues),
  };
}

/**
 * Phase 11 export gate: hard errors block; draft/review exports are marked draft.
 */
export function canExportTargetTrack(track, qaIssues) {
  if (!track || typeof track !== "object") {
    return { ok: false, reason: "track_required" };
  }
  if (hasHardQaErrors(qaIssues ?? track.qaIssues)) {
    return { ok: false, reason: "hard_qa_errors" };
  }
  return {
    ok: true,
    deliveryStatus: APPROVED_LIKE.has(track.status) ? "approved" : "draft",
  };
}

function cloneTrack(track) {
  return {
    ...track,
    snapshotIds: Array.isArray(track.snapshotIds) ? [...track.snapshotIds] : [],
    qaIssues: Array.isArray(track.qaIssues)
      ? track.qaIssues.map((issue) => ({ ...issue }))
      : [],
  };
}
