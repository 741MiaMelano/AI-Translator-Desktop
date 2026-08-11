import { applyExplicitRerunResult, isLockedTargetLayer } from "./target-text-state.mjs";

/**
 * Build a selected-segment rerun plan.
 * Paid/request set is exactly the selected unlocked ids.
 * Neighbor segments are returned as read-only context and must not be updated.
 */
export function planSelectedSegmentRerun({
  segments,
  selectedSegmentIds,
  languageCode,
  contextRadius = 1,
} = {}) {
  if (!Array.isArray(segments)) {
    throw new Error("segments must be an array");
  }
  if (!Array.isArray(selectedSegmentIds) || selectedSegmentIds.length === 0) {
    throw new Error("selectedSegmentIds must be a non-empty array");
  }
  if (typeof languageCode !== "string" || languageCode.length === 0) {
    throw new Error("languageCode is required");
  }

  const selectedSet = new Set(selectedSegmentIds);
  const indexById = new Map(segments.map((segment, index) => [segment.id, index]));

  const missing = selectedSegmentIds.filter((id) => !indexById.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "segment_not_found",
      missingSegmentIds: missing,
    };
  }

  const requestSegmentIds = [];
  const skippedLockedSegmentIds = [];
  const existingTargetLayers = {};

  for (const segmentId of selectedSegmentIds) {
    const segment = segments[indexById.get(segmentId)];
    const layer = segment.targetTexts?.[languageCode];
    if (isLockedTargetLayer(layer)) {
      skippedLockedSegmentIds.push(segmentId);
      continue;
    }
    requestSegmentIds.push(segmentId);
    existingTargetLayers[segmentId] = layer
      ? { ...layer, qaFlags: [...(layer.qaFlags ?? [])] }
      : { model: "", postProcessed: "", qaFlags: [] };
  }

  if (requestSegmentIds.length === 0) {
    return {
      ok: false,
      reason: "all_selected_locked",
      skippedLockedSegmentIds,
    };
  }

  const contextIds = new Set();
  for (const segmentId of requestSegmentIds) {
    const index = indexById.get(segmentId);
    for (let offset = -contextRadius; offset <= contextRadius; offset += 1) {
      if (offset === 0) continue;
      const neighbor = segments[index + offset];
      if (!neighbor) continue;
      if (selectedSet.has(neighbor.id)) continue;
      contextIds.add(neighbor.id);
    }
  }

  const requestSegments = requestSegmentIds.map((segmentId) => {
    const segment = segments[indexById.get(segmentId)];
    return {
      id: segment.id,
      sourceText: { ...segment.sourceText },
      start: segment.start,
      end: segment.end,
    };
  });

  const contextSegments = [...contextIds].map((segmentId) => {
    const segment = segments[indexById.get(segmentId)];
    return {
      id: segment.id,
      sourceText: { ...segment.sourceText },
      start: segment.start,
      end: segment.end,
      readOnly: true,
    };
  });

  return {
    ok: true,
    languageCode,
    requestSegmentIds: [...requestSegmentIds],
    contextSegmentIds: [...contextIds],
    skippedLockedSegmentIds,
    requestSegments,
    contextSegments,
    existingTargetLayers,
    coverage: {
      mode: "selected_segments",
      segmentIds: [...requestSegmentIds],
    },
  };
}

/**
 * Apply selected-segment rerun translations onto active track layers.
 * Only requestSegmentIds may change. Failures return the original segments.
 */
export function applySelectedSegmentRerunResult({
  segments,
  languageCode,
  translations,
  allowedSegmentIds,
} = {}) {
  if (!Array.isArray(segments)) {
    throw new Error("segments must be an array");
  }
  if (typeof languageCode !== "string") {
    throw new Error("languageCode is required");
  }
  if (!translations || typeof translations !== "object") {
    throw new Error("translations map is required");
  }

  const allowed = new Set(allowedSegmentIds ?? Object.keys(translations));
  const unexpected = Object.keys(translations).filter((segmentId) => !allowed.has(segmentId));
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason: "unexpected_segment_ids",
      unexpectedSegmentIds: unexpected,
      segments,
    };
  }

  let changedCount = 0;
  const nextSegments = segments.map((segment) => {
    if (!Object.prototype.hasOwnProperty.call(translations, segment.id)) {
      return cloneSegment(segment);
    }
    if (!allowed.has(segment.id)) {
      return cloneSegment(segment);
    }

    const currentLayer = segment.targetTexts?.[languageCode] ?? {
      model: "",
      postProcessed: "",
      qaFlags: [],
    };
    const transition = applyExplicitRerunResult(currentLayer, translations[segment.id]);
    if (!transition.ok) {
      return cloneSegment(segment);
    }
    changedCount += 1;
    return {
      ...cloneSegment(segment),
      targetTexts: {
        ...cloneSegment(segment).targetTexts,
        [languageCode]: transition.layer,
      },
    };
  });

  return {
    ok: true,
    segments: nextSegments,
    changedCount,
    appliedSegmentIds: Object.keys(translations).filter((id) => allowed.has(id)),
  };
}

/**
 * Attach selected-segment coverage onto run snapshot parameters without mutating history ids.
 */
export function withSelectedSegmentCoverage(snapshot, coverage) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("snapshot is required");
  }
  const parameters = {
    ...(snapshot.parameters ?? {}),
    coverage: {
      mode: coverage?.mode ?? "selected_segments",
      segmentIds: [...(coverage?.segmentIds ?? [])].sort(),
    },
  };
  return {
    ...snapshot,
    parameters,
  };
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
