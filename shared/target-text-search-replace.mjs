import {
  applyBatchReplace,
  getEffectiveTargetText,
  isLockedTargetLayer,
  setManualTargetText,
} from "./target-text-state.mjs";

/**
 * Plain-text search/replace over target layers.
 * - No regex
 * - Locked segments are skipped and reported
 * - Manual text is editable (user path); model/postProcessed when no manual
 */
export function searchReplaceTargetTexts({
  segments,
  languageCode,
  findText,
  replaceText,
  scopeSegmentIds = null,
  matchField = "target",
} = {}) {
  if (!Array.isArray(segments)) {
    throw new Error("segments must be an array");
  }
  if (typeof languageCode !== "string" || languageCode.length === 0) {
    throw new Error("languageCode is required");
  }
  if (typeof findText !== "string" || findText.length === 0) {
    throw new Error("findText must be a non-empty string");
  }
  if (typeof replaceText !== "string") {
    throw new Error("replaceText must be a string");
  }
  if (matchField !== "target" && matchField !== "source") {
    throw new Error("matchField must be target or source");
  }

  const scope =
    scopeSegmentIds == null
      ? null
      : new Set(Array.isArray(scopeSegmentIds) ? scopeSegmentIds : []);

  let replacedCount = 0;
  let skippedLockedCount = 0;
  const skippedLockedSegmentIds = [];
  const changedSegmentIds = [];

  const nextSegments = segments.map((segment) => {
    if (scope && !scope.has(segment.id)) {
      return cloneSegment(segment);
    }

    const layer = segment.targetTexts?.[languageCode];
    if (!layer) {
      return cloneSegment(segment);
    }

    const sourceText = segment.sourceText?.manual ?? segment.sourceText?.normalized ?? segment.sourceText?.original ?? "";
    const matchedText = matchField === "source" ? sourceText : getEffectiveTargetText(layer);
    if (!matchedText.includes(findText)) {
      return cloneSegment(segment);
    }

    if (isLockedTargetLayer(layer)) {
      skippedLockedCount += 1;
      skippedLockedSegmentIds.push(segment.id);
      return cloneSegment(segment);
    }

    if (matchField === "source") {
      if (getEffectiveTargetText(layer) === replaceText) {
        return cloneSegment(segment);
      }
      const transition = setManualTargetText(layer, replaceText, { preserveEmpty: true });
      if (!transition.ok) return cloneSegment(segment);
      replacedCount += 1;
      changedSegmentIds.push(segment.id);
      return {
        ...cloneSegment(segment),
        targetTexts: {
          ...cloneSegment(segment).targetTexts,
          [languageCode]: transition.layer,
        },
      };
    }

    if (typeof layer.manual === "string") {
      const replacedManual = layer.manual.split(findText).join(replaceText);
      const transition = setManualTargetText(layer, replacedManual, { preserveEmpty: true });
      if (!transition.ok) {
        return cloneSegment(segment);
      }
      replacedCount += 1;
      changedSegmentIds.push(segment.id);
      return {
        ...cloneSegment(segment),
        targetTexts: {
          ...cloneSegment(segment).targetTexts,
          [languageCode]: transition.layer,
        },
      };
    }

    const batch = applyBatchReplace(layer, findText, replaceText);
    if (!batch.ok) {
      if (batch.reason === "locked") {
        skippedLockedCount += 1;
        skippedLockedSegmentIds.push(segment.id);
      }
      return cloneSegment(segment);
    }

    const before = getEffectiveTargetText(layer);
    const after = getEffectiveTargetText(batch.layer);
    if (before === after) {
      return cloneSegment(segment);
    }

    replacedCount += 1;
    changedSegmentIds.push(segment.id);
    return {
      ...cloneSegment(segment),
      targetTexts: {
        ...cloneSegment(segment).targetTexts,
        [languageCode]: batch.layer,
      },
    };
  });

  return {
    ok: true,
    segments: nextSegments,
    replacedCount,
    skippedLockedCount,
    skippedLockedSegmentIds,
    changedSegmentIds,
  };
}

/**
 * Minimal undo/redo stack for serializable editor patches.
 * Intended for persistence-friendly plain objects.
 */
export function createUndoRedoStack({ limit = 100 } = {}) {
  const undoStack = [];
  const redoStack = [];

  return {
    push(entry) {
      if (!entry || typeof entry !== "object") {
        throw new Error("undo entry must be an object");
      }
      undoStack.push(entry);
      if (undoStack.length > limit) {
        undoStack.shift();
      }
      redoStack.length = 0;
    },
    undo() {
      if (undoStack.length === 0) return null;
      const entry = undoStack.pop();
      redoStack.push(entry);
      return entry;
    },
    redo() {
      if (redoStack.length === 0) return null;
      const entry = redoStack.pop();
      undoStack.push(entry);
      return entry;
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    serialize() {
      return {
        undoStack: undoStack.map((entry) => structuredClone(entry)),
        redoStack: redoStack.map((entry) => structuredClone(entry)),
      };
    },
    restore(snapshot) {
      undoStack.length = 0;
      redoStack.length = 0;
      for (const entry of snapshot?.undoStack ?? []) {
        undoStack.push(structuredClone(entry));
      }
      for (const entry of snapshot?.redoStack ?? []) {
        redoStack.push(structuredClone(entry));
      }
    },
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
