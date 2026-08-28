import { applyCandidateAdopt, getEffectiveTargetText } from "./target-text-state.mjs";

/**
 * Create a candidate target track for full-track retranslation.
 * Never replaces the active track; candidate starts inactive.
 */
export function createCandidateTargetTrack({
  sourceTrack,
  languageCode,
  languageLabel,
  idFactory,
  deliveryLabel = "候选整轨重译",
  lastHumanAction = "created candidate track",
} = {}) {
  if (!sourceTrack || typeof sourceTrack !== "object") {
    throw new Error("sourceTrack is required");
  }
  if (typeof languageCode !== "string" || languageCode.length === 0) {
    throw new Error("languageCode is required");
  }
  if (typeof idFactory !== "function") {
    throw new Error("idFactory is required");
  }

  const active =
    sourceTrack.targetTracks?.find((track) => track.languageCode === languageCode && track.isActive) ??
    sourceTrack.targetTracks?.find((track) => track.languageCode === languageCode) ??
    null;

  const candidateId = idFactory();
  if (active && candidateId === active.id) {
    throw new Error("candidate track id must differ from active track id");
  }

  const candidateTrack = {
    id: candidateId,
    languageCode,
    languageLabel: languageLabel ?? active?.languageLabel ?? languageCode,
    status: "draft",
    isActive: false,
    qaIssues: [],
    snapshotIds: [],
    deliveryLabel,
    lastHumanAction,
    role: "candidate",
    baseTrackId: active?.id ?? null,
  };

  return {
    ok: true,
    activeTrackId: active?.id ?? null,
    candidateTrack,
    // Candidate text store is separate from segment.targetTexts active layers.
    candidateTexts: {},
  };
}

/**
 * Write full-track machine translations into a candidate text map only.
 */
export function fillCandidateTexts(candidateTexts, translations) {
  if (!candidateTexts || typeof candidateTexts !== "object") {
    throw new Error("candidateTexts map is required");
  }
  if (!translations || typeof translations !== "object") {
    throw new Error("translations map is required");
  }
  const next = { ...candidateTexts };
  for (const [segmentId, text] of Object.entries(translations)) {
    if (typeof text !== "string") {
      throw new Error(`candidate text for ${segmentId} must be a string`);
    }
    next[segmentId] = {
      model: text,
      postProcessed: text,
      qaFlags: [],
      origin: "candidate_full_track",
    };
  }
  return { ok: true, candidateTexts: next };
}

/**
 * Diff active segment target layers against candidate texts.
 */
export function diffActiveAgainstCandidate({
  segments,
  languageCode,
  candidateTexts,
  segmentIds = null,
} = {}) {
  const scope = segmentIds ? new Set(segmentIds) : null;
  const rows = [];

  for (const segment of segments ?? []) {
    if (scope && !scope.has(segment.id)) continue;
    const activeLayer = segment.targetTexts?.[languageCode];
    const activeText = activeLayer ? getEffectiveTargetText(activeLayer) : "";
    const candidate = candidateTexts?.[segment.id];
    const candidateText = candidate
      ? getEffectiveTargetText(candidate)
      : "";
    rows.push({
      segmentId: segment.id,
      activeText,
      candidateText,
      changed: activeText !== candidateText,
      activeProtected:
        activeLayer?.locked === true || typeof activeLayer?.manual === "string",
    });
  }

  return {
    ok: true,
    rows,
    changedCount: rows.filter((row) => row.changed).length,
  };
}

/**
 * Adopt one candidate segment into the active target layer.
 * Manual/locked are protected unless force=true.
 */
export function adoptCandidateSegment({
  segments,
  languageCode,
  segmentId,
  candidateTexts,
  force = false,
} = {}) {
  const index = (segments ?? []).findIndex((segment) => segment.id === segmentId);
  if (index < 0) {
    return { ok: false, reason: "segment_not_found", segments };
  }
  const candidate = candidateTexts?.[segmentId];
  if (!candidate) {
    return { ok: false, reason: "candidate_missing", segments };
  }

  const segment = segments[index];
  const currentLayer = segment.targetTexts?.[languageCode] ?? {
    model: "",
    postProcessed: "",
    qaFlags: [],
  };
  const candidateText = getEffectiveTargetText(candidate);
  const transition = applyCandidateAdopt(currentLayer, candidateText, { force });
  if (!transition.ok) {
    return {
      ok: false,
      reason: transition.reason,
      segments,
      skipped: true,
    };
  }

  const nextSegments = segments.map((entry, entryIndex) => {
    if (entryIndex !== index) {
      return cloneSegment(entry);
    }
    return {
      ...cloneSegment(entry),
      targetTexts: {
        ...cloneSegment(entry).targetTexts,
        [languageCode]: {
          ...transition.layer,
          // Keep provenance for audit without inventing a parallel timeline.
          qaFlags: [...(transition.layer.qaFlags ?? [])],
        },
      },
    };
  });

  return {
    ok: true,
    segments: nextSegments,
    adoptedSegmentId: segmentId,
    provenance: {
      kind: "candidate_adopt",
      segmentId,
      languageCode,
      candidateOrigin: candidate.origin ?? "candidate_full_track",
    },
  };
}

/**
 * Ensure candidate track remains non-active and active track is unchanged by candidate creation.
 */
export function assertCandidateDoesNotReplaceActive({ activeTrack, candidateTrack }) {
  if (!candidateTrack) return { ok: false, reason: "candidate_required" };
  if (candidateTrack.isActive) return { ok: false, reason: "candidate_must_be_inactive" };
  if (activeTrack && candidateTrack.id === activeTrack.id) {
    return { ok: false, reason: "candidate_id_collision" };
  }
  if (activeTrack?.isActive !== true && activeTrack != null) {
    // Active flag is owned by caller; candidate path must not flip it off here.
  }
  return { ok: true };
}

function cloneSegment(segment) {
  return {
    ...segment,
    sourceText: { ...segment.sourceText },
    targetTexts: Object.fromEntries(
      Object.entries(segment.targetTexts ?? {}).map(([languageCode, layer]) => [
        languageCode,
        {
          ...layer,
          qaFlags: Array.isArray(layer.qaFlags) ? [...layer.qaFlags] : [],
        },
      ]),
    ),
  };
}
