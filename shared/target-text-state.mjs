function cloneLayer(layer) {
  if (!layer || typeof layer !== "object") {
    return {
      model: "",
      postProcessed: "",
      qaFlags: [],
      stale: false,
    };
  }

  const next = {
    model: typeof layer.model === "string" ? layer.model : "",
    postProcessed: typeof layer.postProcessed === "string" ? layer.postProcessed : "",
    qaFlags: Array.isArray(layer.qaFlags) ? [...layer.qaFlags] : [],
    stale: layer.stale === true,
  };

  if (typeof layer.manual === "string") next.manual = layer.manual;
  if (typeof layer.previousManual === "string") next.previousManual = layer.previousManual;
  if (layer.locked === true) next.locked = true;

  return next;
}

function fail(layer, reason) {
  return {
    ok: false,
    skipped: true,
    reason,
    layer: cloneLayer(layer),
  };
}

function ok(layer) {
  return {
    ok: true,
    skipped: false,
    layer: cloneLayer(layer),
  };
}

export function createEmptyTargetTextLayers() {
  return {
    model: "",
    postProcessed: "",
    qaFlags: [],
    stale: false,
  };
}

export function getEffectiveTargetText(layer) {
  if (typeof layer?.manual === "string") return layer.manual;
  if (typeof layer?.postProcessed === "string" && layer.postProcessed.length > 0) {
    return layer.postProcessed;
  }
  return typeof layer?.model === "string" ? layer.model : "";
}

export function isLockedTargetLayer(layer) {
  return layer?.locked === true;
}

export function hasManualTargetText(layer) {
  return typeof layer?.manual === "string";
}

export function hasPreviousManualTargetText(layer) {
  return typeof layer?.previousManual === "string";
}

/** Ordinary automatic paths must not touch these layers. */
export function isAutoProtectedTargetLayer(layer) {
  if (!layer || typeof layer !== "object") return false;
  return (
    isLockedTargetLayer(layer) ||
    hasManualTargetText(layer) ||
    hasPreviousManualTargetText(layer)
  );
}

/** Backward-compatible alias used by translation/cache paths. */
export function isProtectedTargetLayer(layer) {
  return isAutoProtectedTargetLayer(layer);
}

export function isStaleTargetLayer(layer) {
  return layer?.stale === true;
}

/**
 * Ordinary rerun / cache fill. Never overwrites manual, previousManual, or locked.
 */
export function applyAutomaticModelText(layer, text) {
  if (typeof text !== "string") {
    throw new Error("translation text must be a string");
  }
  if (isAutoProtectedTargetLayer(layer)) {
    return fail(layer, "protected");
  }

  const next = cloneLayer(layer);
  next.model = text;
  next.postProcessed = text;
  next.stale = false;
  return ok(next);
}

/**
 * Bulk plain-text replace used by automatic batch paths.
 * Locked and manual layers are skipped; previousManual-only remains protected via auto path.
 */
export function applyBatchReplace(layer, findText, replaceText) {
  if (typeof findText !== "string" || typeof replaceText !== "string") {
    throw new Error("findText and replaceText must be strings");
  }
  if (isLockedTargetLayer(layer)) {
    return fail(layer, "locked");
  }
  if (hasManualTargetText(layer)) {
    return fail(layer, "manual");
  }
  if (hasPreviousManualTargetText(layer)) {
    return fail(layer, "protected");
  }

  const next = cloneLayer(layer);
  next.model = next.model.split(findText).join(replaceText);
  next.postProcessed = next.postProcessed.split(findText).join(replaceText);
  return ok(next);
}

/**
 * Candidate-track adopt into the active layer.
 * Locked is absolute. Manual is skipped unless force=true (explicit user override).
 */
export function applyCandidateAdopt(layer, candidateText, { force = false } = {}) {
  if (typeof candidateText !== "string") {
    throw new Error("candidateText must be a string");
  }
  if (isLockedTargetLayer(layer)) {
    return fail(layer, "locked");
  }
  if (!force && hasManualTargetText(layer)) {
    return fail(layer, "manual");
  }

  const next = cloneLayer(layer);
  if (force && typeof next.manual === "string") {
    next.previousManual = next.manual;
    delete next.manual;
  }
  next.model = candidateText;
  next.postProcessed = candidateText;
  next.stale = false;
  return ok(next);
}

/**
 * Explicit user-triggered segment rerun.
 * Saves current manual into previousManual, then writes model/postProcessed.
 * Locked is absolute protection.
 */
export function applyExplicitRerunResult(layer, text) {
  if (typeof text !== "string") {
    throw new Error("translation text must be a string");
  }
  if (isLockedTargetLayer(layer)) {
    return fail(layer, "locked");
  }

  const next = cloneLayer(layer);
  if (typeof next.manual === "string") {
    next.previousManual = next.manual;
    delete next.manual;
  }
  next.model = text;
  next.postProcessed = text;
  next.stale = false;
  return ok(next);
}

export function revertToPreviousManual(layer) {
  if (isLockedTargetLayer(layer)) {
    return fail(layer, "locked");
  }
  if (typeof layer?.previousManual !== "string") {
    return fail(layer, "no_previous_manual");
  }

  const next = cloneLayer(layer);
  next.manual = next.previousManual;
  return ok(next);
}

export function setManualTargetText(layer, manualText, { preserveEmpty = false } = {}) {
  if (typeof manualText !== "string") {
    throw new Error("manualText must be a string");
  }
  if (isLockedTargetLayer(layer)) {
    return fail(layer, "locked");
  }

  const next = cloneLayer(layer);
  if (manualText.trim().length === 0) {
    if (preserveEmpty) {
      if (typeof next.manual === "string" && next.manual !== manualText) {
        next.previousManual = next.manual;
      }
      next.manual = manualText;
      next.stale = false;
      return ok(next);
    }
    if (typeof next.manual === "string") {
      next.previousManual = next.manual;
    }
    delete next.manual;
    return ok(next);
  }

  if (typeof next.manual === "string" && next.manual !== manualText) {
    next.previousManual = next.manual;
  }
  next.manual = manualText;
  next.stale = false;
  return ok(next);
}

export function setLockedTargetText(layer, locked) {
  if (typeof locked !== "boolean") {
    throw new Error("locked must be a boolean");
  }
  const next = cloneLayer(layer);
  if (locked) {
    next.locked = true;
  } else {
    delete next.locked;
  }
  return ok(next);
}

export function markStaleTargetText(layer) {
  const next = cloneLayer(layer);
  next.stale = true;
  return ok(next);
}

export function clearStaleTargetText(layer) {
  const next = cloneLayer(layer);
  next.stale = false;
  return ok(next);
}
