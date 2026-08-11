const PARAMETER_FIELDS = Object.freeze([
  "threshold",
  "minSpeechDurationMs",
  "minSilenceDurationMs",
  "maxSpeechDurationSeconds",
  "speechPadMs",
  "samplesOverlapSeconds",
]);

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  return error;
}

function requireExactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(`${label} must be a plain object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw invalid(`${label} shape is invalid`);
  }
}

function boundedNumber(value, min, max, field, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw invalid(`${field} is outside the supported range`);
  }
  return value;
}

export const ASR_VAD_RECOMMENDED_PARAMETERS = Object.freeze({
  threshold: 0.5,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 100,
  // whisper.cpp 1.9.1 treats zero as unlimited; keeping zero makes the setting serializable.
  maxSpeechDurationSeconds: 0,
  speechPadMs: 30,
  samplesOverlapSeconds: 0.1,
});

export const ASR_VAD_PRESET_PARAMETERS = Object.freeze({
  gentle: Object.freeze({
    threshold: 0.35,
    minSpeechDurationMs: 150,
    minSilenceDurationMs: 120,
    maxSpeechDurationSeconds: 0,
    speechPadMs: 60,
    samplesOverlapSeconds: 0.1,
  }),
  balanced: ASR_VAD_RECOMMENDED_PARAMETERS,
  strong: Object.freeze({
    threshold: 0.65,
    minSpeechDurationMs: 300,
    minSilenceDurationMs: 100,
    maxSpeechDurationSeconds: 0,
    speechPadMs: 30,
    samplesOverlapSeconds: 0.05,
  }),
});

export const DEFAULT_ASR_VAD_SETTINGS = Object.freeze({
  mode: "auto",
  customParameters: ASR_VAD_RECOMMENDED_PARAMETERS,
});

export function normalizeAsrVadParameters(value) {
  requireExactObject(value, PARAMETER_FIELDS, "VAD parameters");
  const threshold = boundedNumber(value.threshold, 0, 1, "VAD threshold");
  return {
    threshold: threshold === 1 ? ASR_VAD_RECOMMENDED_PARAMETERS.threshold : threshold,
    minSpeechDurationMs: boundedNumber(value.minSpeechDurationMs, 0, 60_000, "VAD minimum speech duration", true),
    minSilenceDurationMs: boundedNumber(value.minSilenceDurationMs, 0, 60_000, "VAD minimum silence duration", true),
    maxSpeechDurationSeconds: boundedNumber(value.maxSpeechDurationSeconds, 0, 86_400, "VAD maximum speech duration"),
    speechPadMs: boundedNumber(value.speechPadMs, 0, 60_000, "VAD speech padding", true),
    samplesOverlapSeconds: boundedNumber(value.samplesOverlapSeconds, 0, 60, "VAD samples overlap"),
  };
}

export function normalizeAsrVadSettings(value) {
  requireExactObject(value, ["mode", "customParameters"], "VAD settings");
  if (!new Set(["auto", "off", "custom"]).has(value.mode)) throw invalid("VAD mode is invalid");
  return { mode: value.mode, customParameters: normalizeAsrVadParameters(value.customParameters) };
}

export function effectiveAsrVadParameters(settings) {
  const value = normalizeAsrVadSettings(settings);
  if (value.mode === "off") return null;
  return value.mode === "auto"
    ? { ...ASR_VAD_RECOMMENDED_PARAMETERS }
    : { ...value.customParameters };
}
