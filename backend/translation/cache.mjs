import { createHash } from "node:crypto";
import { isProtectedTargetLayer as isProtectedTargetLayerShared } from "../../shared/target-text-state.mjs";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function buildTranslationCacheFingerprint({
  sourceText,
  targetLanguage,
  providerId,
  model,
  baseUrl = "",
  transportMode = "",
  promptTemplateVersion,
  parameters,
  resourceSnapshot,
  segmentVersion,
}) {
  const payload = {
    sourceText,
    targetLanguage,
    providerId,
    model,
    baseUrl,
    transportMode,
    promptTemplateVersion,
    parameters: parameters ?? {},
    resourceSnapshot: resourceSnapshot ?? { glossary: "empty", styleGuide: "empty" },
    segmentVersion,
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function createMemoryTranslationCache() {
  const map = new Map();
  return {
    get(fingerprint) {
      return map.has(fingerprint) ? map.get(fingerprint) : null;
    },
    set(fingerprint, value) {
      map.set(fingerprint, value);
    },
    has(fingerprint) {
      return map.has(fingerprint);
    },
    size() {
      return map.size;
    },
  };
}

export function isProtectedTargetLayer(layer) {
  return isProtectedTargetLayerShared(layer);
}
