import { ASR_LANGUAGE_DETECTION_CONFIG } from "../../shared/asr-language-config.mjs";

const ALIASES = Object.freeze({
  eng: "en",
  zho: "zh",
  chi: "zh",
  cmn: "zh",
  jpn: "ja",
  kor: "ko",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  spa: "es",
  por: "pt",
});

function fail(message) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  return error;
}

export function normalizeAsrLanguageCode(value) {
  if (typeof value !== "string") return "und";
  const normalized = value.normalize("NFC").trim().toLowerCase().replaceAll("_", "-");
  const aliased = ALIASES[normalized] ?? normalized;
  return /^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/.test(aliased) ? aliased : "und";
}

function validateEvidence(raw, segmentId) {
  if (
    !raw || raw.segmentId !== segmentId ||
    raw.detectionMethod !== ASR_LANGUAGE_DETECTION_CONFIG.method ||
    raw.detectionVersion !== ASR_LANGUAGE_DETECTION_CONFIG.version ||
    !new Set(["none", "overlap_unsupported"]).has(raw.overlapStatus) ||
    (raw.confidence !== null && (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1))
  ) {
    throw fail("Segment language evidence is invalid");
  }
  return {
    detectedLanguage: normalizeAsrLanguageCode(raw.detectedLanguage),
    confidence: raw.confidence,
    detectionMethod: raw.detectionMethod,
    detectionVersion: raw.detectionVersion,
    overlapStatus: raw.overlapStatus,
  };
}

export function classifySegmentLanguages({
  segments,
  evidence,
  previousLanguageState = "pending",
  confirmTrackConvergence = false,
}) {
  if (!Array.isArray(segments) || !segments.length || !Array.isArray(evidence) || evidence.length !== segments.length) {
    throw fail("Language evidence must cover every segment");
  }
  const evidenceById = new Map();
  for (const item of evidence) {
    if (typeof item?.segmentId !== "string" || evidenceById.has(item.segmentId)) throw fail("Language evidence IDs are invalid");
    evidenceById.set(item.segmentId, item);
  }
  const classified = segments.map((segment) => {
    const item = validateEvidence(evidenceById.get(segment.id), segment.id);
    let manualLanguage;
    if (segment.manualLanguage !== undefined && segment.manualLanguage !== null) {
      manualLanguage = normalizeAsrLanguageCode(segment.manualLanguage);
      if (manualLanguage === "und") throw fail("Manual language is invalid");
    }
    const confident = item.overlapStatus === "none" && item.detectedLanguage !== "und" &&
      item.confidence !== null && item.confidence >= ASR_LANGUAGE_DETECTION_CONFIG.confidenceThreshold;
    const value = {
      ...segment,
      detectedLanguage: item.detectedLanguage,
      languageConfidence: item.confidence,
      languageDetectionMethod: item.detectionMethod,
      languageDetectionVersion: item.detectionVersion,
      languageOverlapStatus: item.overlapStatus,
      sourceLanguage: manualLanguage ?? (confident ? item.detectedLanguage : "und"),
    };
    if (manualLanguage) value.manualLanguage = manualLanguage;
    else delete value.manualLanguage;
    return value;
  });
  const pendingSegmentIds = classified.filter((segment) => segment.sourceLanguage === "und").map((segment) => segment.id);
  const languages = new Set(classified.map((segment) => segment.sourceLanguage).filter((language) => language !== "und"));
  let languageState = pendingSegmentIds.length ? "pending" : languages.size > 1 ? "multilingual" : "known";
  if (previousLanguageState === "multilingual" && languageState === "known" && !confirmTrackConvergence) {
    languageState = "multilingual";
  }
  return {
    segments: classified,
    languageState,
    defaultLanguage: languageState === "known" ? languages.values().next().value : "auto",
    pendingSegmentIds,
  };
}

export { ASR_LANGUAGE_DETECTION_CONFIG };
