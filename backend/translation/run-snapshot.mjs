import { createHash } from "node:crypto";
import { PROMPT_TEMPLATE_VERSION } from "./prompt-contract.mjs";

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

export function buildEmptyResourceSnapshot({ glossaryId = "", styleGuideId = "" } = {}) {
  return {
    glossary: glossaryId ? { id: glossaryId, empty: false } : { id: "", empty: true },
    styleGuide: styleGuideId ? { id: styleGuideId, empty: false } : { id: "", empty: true },
  };
}

export function fingerprintResourceSnapshot(resourceSnapshot) {
  return createHash("sha256").update(canonicalJson(resourceSnapshot ?? {})).digest("hex");
}

export function createRunSnapshotRecord({
  id,
  projectId,
  sourceTrackId,
  targetLanguageCode,
  providerId,
  model,
  baseUrlDisplay,
  transportMode,
  parameters = {},
  resourceSnapshot,
  segmentVersion,
  cacheHits = 0,
  inputTokens = 0,
  outputTokens = 0,
  createdAt = new Date().toISOString(),
}) {
  const resources = resourceSnapshot ?? buildEmptyResourceSnapshot();
  return Object.freeze({
    id,
    projectId,
    sourceTrackId,
    targetLanguageCode,
    providerId,
    model,
    baseUrlDisplay: baseUrlDisplay ?? null,
    transportMode: transportMode ?? null,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    parameters: Object.freeze({ ...parameters }),
    resourceSnapshot: Object.freeze(structuredClone(resources)),
    resourceFingerprint: fingerprintResourceSnapshot(resources),
    segmentVersion,
    createdAt,
    cacheHits,
    inputTokens,
    outputTokens,
  });
}
