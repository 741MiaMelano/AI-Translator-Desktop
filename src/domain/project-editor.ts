import {
  applySelectedSegmentRerunResult,
  planSelectedSegmentRerun,
} from "../../shared/selected-segment-rerun.mjs";
import {
  markStaleTargetText,
  setLockedTargetText,
  setManualTargetText,
} from "../../shared/target-text-state.mjs";
import {
  adoptCandidateSegment,
  createCandidateTargetTrack,
  fillCandidateTexts,
} from "../../shared/candidate-track.mjs";
import {
  createUndoRedoStack,
  searchReplaceTargetTexts,
} from "../../shared/target-text-search-replace.mjs";
import {
  approveTargetTrack,
  degradeTrackAfterSourceChange,
  refreshTrackQaIssues,
} from "../../shared/target-track-lifecycle.mjs";
import type {
  EditorHistoryEntry,
  Project,
  SourceTrack,
  TargetReplaceHistoryEntry,
  TargetTrack,
} from "./workspace";
import {
  mergeSegments,
  nudgeSegmentBoundary,
  shiftSegment,
  splitSegment,
  splitSegmentText,
} from "./segment-timeline.ts";

export type TimelineEditCommand =
  | { kind: "split"; segmentId: string; atTimestamp: string; idFactory?: () => string }
  | { kind: "split_text"; segmentId: string; atTimestamp: string; languageCode: string; targetText: string; targetOffset: number; idFactory?: () => string }
  | { kind: "merge"; leftSegmentId: string; rightSegmentId: string; idFactory?: () => string }
  | { kind: "nudge"; segmentId: string; edge: "start" | "end"; deltaMs: number }
  | { kind: "shift"; segmentId: string; deltaMs: number };

function activeSource(project: Project): SourceTrack | null {
  return project.sourceTracks.find((track) => track.id === project.activeSourceTrackId) ?? null;
}

function targetTrack(sourceTrack: SourceTrack, languageCode: string): TargetTrack | null {
  return sourceTrack.targetTracks.find(
    (track) => track.languageCode === languageCode && track.isActive,
  ) ?? null;
}

function replaceTargetTrack(project: Project, replacement: TargetTrack): Project {
  return {
    ...project,
    sourceTracks: project.sourceTracks.map((sourceTrack) =>
      sourceTrack.id !== project.activeSourceTrackId
        ? sourceTrack
        : {
            ...sourceTrack,
            targetTracks: sourceTrack.targetTracks.map((track) =>
              track.id === replacement.id ? replacement : track,
            ),
          },
    ),
  };
}

function replaceActiveSource(project: Project, replacement: SourceTrack): Project {
  return {
    ...project,
    sourceTracks: project.sourceTracks.map((sourceTrack) =>
      sourceTrack.id === replacement.id ? replacement : sourceTrack,
    ),
  };
}

function historyWith(project: Project, update: (stack: ReturnType<typeof createUndoRedoStack>) => void) {
  const stack = createUndoRedoStack();
  stack.restore(project.editorHistory);
  update(stack);
  return stack.serialize();
}

function applyHistoryEntry(project: Project, entry: EditorHistoryEntry, useAfter: boolean): Project {
  const source = activeSource(project);
  if (!source) return project;
  if (entry.kind === "source_manual") {
    const manual = useAfter ? entry.afterManual : entry.beforeManual;
    const segments = source.segments.map((segment) => {
      if (segment.id !== entry.segmentId) return segment;
      const sourceText = { ...segment.sourceText };
      if (manual === null) delete sourceText.manual;
      else sourceText.manual = manual;
      return { ...segment, sourceText };
    });
    return replaceActiveSource(project, { ...source, segments });
  }
  if (entry.kind === "timeline") {
    const removeCount = (useAfter ? entry.beforeSegments : entry.afterSegments).length;
    const replacement = structuredClone(useAfter ? entry.afterSegments : entry.beforeSegments);
    return replaceActiveSource(project, {
      ...source,
      segments: [
        ...source.segments.slice(0, entry.index),
        ...replacement,
        ...source.segments.slice(entry.index + removeCount),
      ],
    });
  }
  const changes = new Map(entry.changes.map((change) => [change.segmentId, change]));
  const segments = source.segments.map((segment) => {
    const change = changes.get(segment.id);
    if (!change) return segment;
    return {
      ...segment,
      targetTexts: {
        ...segment.targetTexts,
        [entry.languageCode]: structuredClone(useAfter ? change.after : change.before),
      },
    };
  });
  return replaceActiveSource(project, { ...source, segments });
}

export function approveProjectTargetTrack(project: Project, languageCode: string) {
  const source = activeSource(project);
  const track = source ? targetTrack(source, languageCode) : null;
  if (!track) return { ok: false as const, reason: "track_required", project };

  const refreshed = refreshTrackQaIssues(project, track, { languageCode });
  const withQa = replaceTargetTrack(project, refreshed.track);
  const approval = approveTargetTrack(refreshed.track, refreshed.issues, { actor: "user" });
  if (!approval.ok) {
    return { ok: false as const, reason: approval.reason, project: withQa };
  }
  return {
    ok: true as const,
    project: { ...replaceTargetTrack(withQa, approval.track), lifecycle: "completed" as const },
  };
}

export function planProjectSelectedRerun(
  project: Project,
  languageCode: string,
  selectedSegmentIds: string[],
) {
  const source = activeSource(project);
  if (!source) return { ok: false as const, reason: "source_track_required" };
  return planSelectedSegmentRerun({
    segments: source.segments,
    selectedSegmentIds,
    languageCode,
  });
}

export function refreshProjectTargetQa(project: Project, languageCode: string) {
  const source = activeSource(project);
  const track = source ? targetTrack(source, languageCode) : null;
  if (!track) return { ok: false as const, reason: "track_required", project };
  const refreshed = refreshTrackQaIssues(project, track, { languageCode });
  return {
    ok: true as const,
    hasHardErrors: refreshed.hasHardErrors,
    project: replaceTargetTrack(project, refreshed.track),
  };
}

export function applyProjectSelectedRerunResult(
  project: Project,
  languageCode: string,
  selectedSegmentIds: string[],
  translations: Record<string, string>,
) {
  const source = activeSource(project);
  if (!source) return { ok: false as const, reason: "source_track_required", project };
  const applied = applySelectedSegmentRerunResult({
    segments: source.segments,
    languageCode,
    translations,
    allowedSegmentIds: selectedSegmentIds,
  });
  if (!applied.ok) return { ...applied, project };
  const targetTracks = source.targetTracks.map((track) =>
    track.languageCode === languageCode
      ? {
          ...track,
          status: "in_review" as const,
          lastHumanAction: `reran ${applied.appliedSegmentIds.join(",")}`,
        }
      : track,
  );
  return {
    ok: true as const,
    project: {
      ...replaceActiveSource(project, { ...source, segments: applied.segments, targetTracks }),
      lifecycle: "needs_review" as const,
    },
  };
}

export function editProjectTimeline(project: Project, command: TimelineEditCommand) {
  const source = activeSource(project);
  if (!source) return { ok: false as const, reason: "source_track_required", project };

  const result = command.kind === "split"
    ? splitSegment(source.segments, command.segmentId, command.atTimestamp, {
        idFactory: command.idFactory,
      })
    : command.kind === "split_text"
      ? splitSegmentText(
          source.segments,
          command.segmentId,
          command.atTimestamp,
          command.languageCode,
          command.targetText,
          command.targetOffset,
          { idFactory: command.idFactory },
        )
    : command.kind === "merge"
      ? mergeSegments(source.segments, command.leftSegmentId, command.rightSegmentId, {
          idFactory: command.idFactory,
        })
      : command.kind === "nudge"
        ? nudgeSegmentBoundary(source.segments, command.segmentId, command.edge, command.deltaMs)
        : shiftSegment(source.segments, command.segmentId, command.deltaMs);
  if (!result.ok) return { ...result, project };

  const targetTracks = source.targetTracks.map(
    (track) => degradeTrackAfterSourceChange(track).track,
  );
  const nextSource = { ...source, segments: result.segments, targetTracks };
  const index = command.kind === "merge"
    ? source.segments.findIndex((segment) => segment.id === command.leftSegmentId)
    : source.segments.findIndex((segment) => segment.id === command.segmentId);
  const beforeCount = command.kind === "merge" ? 2 : 1;
  const afterCount = command.kind === "split" || command.kind === "split_text" ? 2 : 1;
  const historyEntry = {
    kind: "timeline" as const,
    index,
    beforeSegments: structuredClone(source.segments.slice(index, index + beforeCount)),
    afterSegments: structuredClone(result.segments.slice(index, index + afterCount)),
  };
  return {
    ok: true as const,
    affectedSegmentIds: result.affectedSegmentIds,
    project: {
      ...replaceActiveSource(project, nextSource),
      lifecycle: "needs_review" as const,
      editorHistory: historyWith(project, (stack) => stack.push(historyEntry)),
    },
  };
}

export function replaceProjectTargetTexts(
  project: Project,
  languageCode: string,
  findText: string,
  replaceText: string,
  scopeSegmentIds: string[] | null = null,
  matchField: "target" | "source" = "target",
) {
  const source = activeSource(project);
  if (!source) return { ok: false as const, reason: "source_track_required", project };
  const result = searchReplaceTargetTexts({
    segments: source.segments,
    languageCode,
    findText,
    replaceText,
    scopeSegmentIds,
    matchField,
  });
  if (result.changedSegmentIds.length === 0) return { ...result, project };

  const before = new Map(source.segments.map((segment) => [segment.id, segment]));
  const after = new Map(result.segments.map((segment) => [segment.id, segment]));
  const entry: TargetReplaceHistoryEntry = {
    kind: "target_replace",
    languageCode,
    changes: result.changedSegmentIds.map((segmentId) => ({
      segmentId,
      before: structuredClone(before.get(segmentId)!.targetTexts[languageCode]),
      after: structuredClone(after.get(segmentId)!.targetTexts[languageCode]),
    })),
  };
  const targetTracks = source.targetTracks.map((track) =>
    track.languageCode === languageCode && (track.status === "approved" || track.status === "exported")
      ? { ...track, status: "in_review" as const, lastHumanAction: "target text replaced" }
      : track,
  );
  const next = replaceActiveSource(project, {
    ...source,
    segments: result.segments,
    targetTracks,
  });
  return {
    ...result,
    project: {
      ...next,
      lifecycle: "needs_review" as const,
      editorHistory: historyWith(project, (stack) => stack.push(entry)),
    },
  };
}

function moveProjectHistory(project: Project, direction: "undo" | "redo") {
  const stack = createUndoRedoStack();
  stack.restore(project.editorHistory);
  const entry = direction === "undo" ? stack.undo() : stack.redo();
  if (!entry) return { ok: false as const, reason: `${direction}_empty`, project };
  const changed = applyHistoryEntry(project, entry as EditorHistoryEntry, direction === "redo");
  return {
    ok: true as const,
    project: {
      ...changed,
      lifecycle: project.recentRunIds.length > 0 ? "needs_review" as const : project.lifecycle,
      editorHistory: stack.serialize(),
    },
  };
}

export function undoProjectEdit(project: Project) {
  return moveProjectHistory(project, "undo");
}

export function redoProjectEdit(project: Project) {
  return moveProjectHistory(project, "redo");
}

export function createProjectCandidateTrack(
  project: Project,
  languageCode: string,
  idFactory: () => string,
) {
  const source = activeSource(project);
  if (!source) return { ok: false as const, reason: "source_track_required", project };
  const created = createCandidateTargetTrack({ sourceTrack: source, languageCode, idFactory });
  const nextSource = {
    ...source,
    targetTracks: [...source.targetTracks, created.candidateTrack as TargetTrack],
  };
  return {
    ok: true as const,
    candidateTrackId: created.candidateTrack.id,
    project: replaceActiveSource(project, nextSource),
  };
}

export function fillProjectCandidateTexts(
  project: Project,
  candidateTrackId: string,
  translations: Record<string, string>,
  snapshotId?: string,
) {
  const source = activeSource(project);
  const candidate = source?.targetTracks.find(
    (track) => track.id === candidateTrackId && track.role === "candidate",
  );
  if (!source || !candidate) return { ok: false as const, reason: "candidate_required", project };
  const filled = fillCandidateTexts(candidate.candidateTexts ?? {}, translations);
  const replacement: TargetTrack = {
    ...candidate,
    status: "in_review",
    candidateTexts: filled.candidateTexts,
    snapshotIds: snapshotId
      ? [snapshotId, ...candidate.snapshotIds.filter((id) => id !== snapshotId)]
      : candidate.snapshotIds,
    deliveryLabel: "候选待比较",
  };
  return { ok: true as const, project: replaceTargetTrack(project, replacement) };
}

export function adoptProjectCandidateSegment(
  project: Project,
  candidateTrackId: string,
  segmentId: string,
  force = false,
) {
  const source = activeSource(project);
  const candidate = source?.targetTracks.find(
    (track) => track.id === candidateTrackId && track.role === "candidate",
  );
  if (!source || !candidate) return { ok: false as const, reason: "candidate_required", project };
  const adopted = adoptCandidateSegment({
    segments: source.segments,
    languageCode: candidate.languageCode,
    segmentId,
    candidateTexts: candidate.candidateTexts ?? {},
    force,
  });
  if (!adopted.ok) return { ...adopted, project };
  const targetTracks = source.targetTracks.map((track) =>
    track.languageCode === candidate.languageCode && track.isActive
      ? {
          ...track,
          status: "in_review" as const,
          lastHumanAction: `adopted ${segmentId} from ${candidateTrackId}`,
        }
      : track,
  );
  return {
    ok: true as const,
    provenance: adopted.provenance,
    project: {
      ...replaceActiveSource(project, {
        ...source,
        segments: adopted.segments,
        targetTracks,
      }),
      lifecycle: "needs_review" as const,
    },
  };
}

export function setProjectSourceManual(
  project: Project,
  segmentId: string,
  manualText: string | null,
) {
  const source = activeSource(project);
  const segment = source?.segments.find((entry) => entry.id === segmentId);
  if (!source || !segment) return { ok: false as const, reason: "segment_not_found", project };
  const beforeManual = segment.sourceText.manual ?? null;
  const afterManual = manualText && manualText.length > 0 ? manualText : null;
  if (beforeManual === afterManual) return { ok: true as const, changed: false, project };
  const entry = { kind: "source_manual" as const, segmentId, beforeManual, afterManual };
  const changed = applyHistoryEntry(project, entry, true);
  const changedSource = activeSource(changed)!;
  const segments = changedSource.segments.map((item) =>
    item.id !== segmentId
      ? item
      : {
          ...item,
          targetTexts: Object.fromEntries(
            Object.entries(item.targetTexts).map(([languageCode, layer]) => [
              languageCode,
              markStaleTargetText(layer).layer,
            ]),
          ),
        },
  );
  const targetTracks = changedSource.targetTracks.map(
    (track) => degradeTrackAfterSourceChange(track).track,
  );
  return {
    ok: true as const,
    changed: true,
    project: {
      ...replaceActiveSource(changed, { ...changedSource, segments, targetTracks }),
      lifecycle: project.recentRunIds.length > 0 ? "needs_review" as const : project.lifecycle,
      editorHistory: historyWith(project, (stack) => stack.push(entry)),
    },
  };
}

function replaceTargetLayer(
  project: Project,
  languageCode: string,
  segmentId: string,
  layer: Project["sourceTracks"][number]["segments"][number]["targetTexts"][string],
) {
  const source = activeSource(project)!;
  const segments = source.segments.map((segment) =>
    segment.id === segmentId
      ? {
          ...segment,
          targetTexts: { ...segment.targetTexts, [languageCode]: layer },
        }
      : segment,
  );
  const targetTracks = source.targetTracks.map((track) =>
    track.languageCode === languageCode && (track.status === "approved" || track.status === "exported")
      ? { ...track, status: "in_review" as const, lastHumanAction: `edited ${segmentId}` }
      : track,
  );
  return {
    ...replaceActiveSource(project, { ...source, segments, targetTracks }),
    lifecycle: "needs_review" as const,
  };
}

export function setProjectTargetManual(
  project: Project,
  languageCode: string,
  segmentId: string,
  manualText: string,
) {
  const source = activeSource(project);
  const current = source?.segments.find((segment) => segment.id === segmentId)?.targetTexts[languageCode];
  if (!current) return { ok: false as const, reason: "segment_not_found", project };
  const transition = setManualTargetText(current, manualText);
  if (!transition.ok) return { ok: false as const, reason: transition.reason, project };
  const entry: TargetReplaceHistoryEntry = {
    kind: "target_replace",
    languageCode,
    changes: [{
      segmentId,
      before: structuredClone(current),
      after: structuredClone(transition.layer),
    }],
  };
  const changed = replaceTargetLayer(project, languageCode, segmentId, transition.layer);
  return {
    ok: true as const,
    project: {
      ...changed,
      editorHistory: historyWith(project, (stack) => stack.push(entry)),
    },
  };
}

export function setProjectTargetLocked(
  project: Project,
  languageCode: string,
  segmentId: string,
  locked: boolean,
) {
  const source = activeSource(project);
  const current = source?.segments.find((segment) => segment.id === segmentId)?.targetTexts[languageCode];
  if (!current) return { ok: false as const, reason: "segment_not_found", project };
  const transition = setLockedTargetText(current, locked);
  if (!transition.ok) return { ok: false as const, reason: transition.reason, project };
  return {
    ok: true as const,
    project: replaceTargetLayer(project, languageCode, segmentId, transition.layer),
  };
}
