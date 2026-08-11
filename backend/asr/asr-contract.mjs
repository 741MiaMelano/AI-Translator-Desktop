const LIMITS = Object.freeze({
  MAX_MEDIA_DURATION_MS: 12 * 60 * 60 * 1_000,
  MAX_SEGMENTS: 20_000,
  MAX_WORDS: 500_000,
  MAX_SEGMENT_TEXT_BYTES: 16 * 1024,
  MAX_WORD_TEXT_BYTES: 1_024,
  MAX_TOTAL_TEXT_BYTES: 32 * 1024 * 1024,
  MAX_WARNING_CODES: 128,
  MAX_REPAIR_CODES_PER_WORD: 8,
  MAX_ACTIVITY_INTERVALS: 100_000,
  MAX_ARTIFACT_BYTES: 64 * 1024 * 1024,
});

const WARNING_CODES = new Set([
  "leading_timestamp_clamped",
  "terminal_timestamp_clamped",
  "zero_duration_tokens_partitioned",
  "language_probability_unavailable",
  "audio_silence_boundary_aligned",
]);
const REPAIR_CODES = new Set([
  "leading_timestamp_clamped",
  "terminal_timestamp_clamped",
  "zero_duration_tokens_partitioned",
  "audio_silence_boundary_aligned",
]);

function contractError(message, code = "INVALID_ASR_RESULT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(`${field} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, field) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) throw contractError(`${field} contains unsupported raw engine fields`);
}

function finiteInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw contractError(`${field} time or duration is invalid`);
  }
  return value;
}

function probability(value, field) {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw contractError(`${field} probability is invalid`);
  }
  return value;
}

function language(value, field) {
  if (typeof value !== "string" || !/^(?:und|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(value)) {
    throw contractError(`${field} language is invalid`);
  }
  return value.toLowerCase();
}

function boundedText(value, field, maxBytes) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw contractError(`${field} text is invalid`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) throw contractError(`${field} text exceeds the limit`, "OUTPUT_TOO_LARGE");
  return { value, bytes };
}

function boundedCodes(value, field, allowed, max) {
  if (!Array.isArray(value) || value.length > max) {
    throw contractError(`${field} exceeds the limit`, "OUTPUT_TOO_LARGE");
  }
  if (new Set(value).size !== value.length || value.some((code) => !allowed.has(code))) {
    throw contractError(`${field} contains an invalid code`);
  }
  return [...value];
}

function activityIntervals(value, field, mediaDurationMs) {
  if (!Array.isArray(value) || value.length > LIMITS.MAX_ACTIVITY_INTERVALS) {
    throw contractError(`${field} exceeds the limit`, "OUTPUT_TOO_LARGE");
  }
  let previousEnd = 0;
  return value.map((raw, index) => {
    const interval = plainObject(raw, `${field}[${index}]`);
    exactKeys(interval, new Set(["startMs", "endMs"]), `${field}[${index}]`);
    const startMs = finiteInteger(interval.startMs, `${field}[${index}].startMs`, { max: mediaDurationMs });
    const endMs = finiteInteger(interval.endMs, `${field}[${index}].endMs`, { max: mediaDurationMs });
    if (endMs <= startMs || startMs < previousEnd) {
      throw contractError(`${field} contains an invalid or overlapping interval`);
    }
    previousEnd = endMs;
    return { startMs, endMs };
  });
}

function validateActivity(raw, mediaDurationMs) {
  const activity = plainObject(raw, "activity");
  exactKeys(activity, new Set(["detector", "mode", "speechIntervals", "excludedIntervals"]), "activity");
  if (activity.detector !== "silero-vad-v6.2.0" || !new Set(["auto", "custom"]).has(activity.mode)) {
    throw contractError("activity detector or mode is invalid");
  }
  const speechIntervals = activityIntervals(activity.speechIntervals, "activity.speechIntervals", mediaDurationMs);
  if (speechIntervals.length === 0) throw contractError("activity must contain detected speech");
  const excludedIntervals = activityIntervals(activity.excludedIntervals, "activity.excludedIntervals", mediaDurationMs);
  const expectedExcluded = [];
  let cursor = 0;
  for (const interval of speechIntervals) {
    if (interval.startMs > cursor) expectedExcluded.push({ startMs: cursor, endMs: interval.startMs });
    cursor = interval.endMs;
  }
  if (cursor < mediaDurationMs) expectedExcluded.push({ startMs: cursor, endMs: mediaDurationMs });
  if (JSON.stringify(excludedIntervals) !== JSON.stringify(expectedExcluded)) {
    throw contractError("activity excluded intervals do not complement detected speech");
  }
  return { detector: activity.detector, mode: activity.mode, speechIntervals, excludedIntervals };
}

function validateSongActivity(raw, mediaDurationMs) {
  const activity = plainObject(raw, "songActivity");
  exactKeys(activity, new Set(["detector", "mode", "filteredIntervals", "uncertainIntervals"]), "songActivity");
  if (activity.detector !== "ina-speech-music-noise-v1" || activity.mode !== "filter") {
    throw contractError("song activity detector or mode is invalid");
  }
  const filteredIntervals = activityIntervals(activity.filteredIntervals, "songActivity.filteredIntervals", mediaDurationMs);
  const uncertainIntervals = activityIntervals(activity.uncertainIntervals, "songActivity.uncertainIntervals", mediaDurationMs);
  const combined = [...filteredIntervals, ...uncertainIntervals].sort((left, right) => left.startMs - right.startMs);
  if (combined.some((interval, index) => index > 0 && interval.startMs < combined[index - 1].endMs)) {
    throw contractError("song activity intervals overlap");
  }
  return { detector: activity.detector, mode: activity.mode, filteredIntervals, uncertainIntervals };
}

function validateWord(raw, segment, index) {
  const field = `segments.words[${index}]`;
  const word = plainObject(raw, field);
  exactKeys(word, new Set([
    "startMs", "endMs", "text", "probability", "rawStartMs", "rawEndMs", "repairCodes",
  ]), field);
  const startMs = finiteInteger(word.startMs, `${field}.startMs`, { max: segment.endMs });
  const endMs = finiteInteger(word.endMs, `${field}.endMs`, { max: segment.endMs });
  if (startMs < segment.startMs || endMs <= startMs) {
    throw contractError(`${field} word time is outside its segment`);
  }
  const text = boundedText(word.text, `${field}.text`, LIMITS.MAX_WORD_TEXT_BYTES);
  const hasRawStart = word.rawStartMs !== undefined;
  const hasRawEnd = word.rawEndMs !== undefined;
  if (hasRawStart !== hasRawEnd) throw contractError(`${field} raw word time must be paired`);
  const repairCodes = word.repairCodes === undefined
    ? []
    : boundedCodes(word.repairCodes, `${field}.repairCodes`, REPAIR_CODES, LIMITS.MAX_REPAIR_CODES_PER_WORD);
  const result = {
    startMs,
    endMs,
    text: text.value,
    probability: probability(word.probability, `${field}.probability`),
  };
  if (hasRawStart) {
    const rawMax = segment.mediaDurationMs + 10_000;
    result.rawStartMs = finiteInteger(word.rawStartMs, `${field}.rawStartMs`, { max: rawMax });
    result.rawEndMs = finiteInteger(word.rawEndMs, `${field}.rawEndMs`, { max: rawMax });
    if ((result.rawStartMs !== startMs || result.rawEndMs !== endMs) && repairCodes.length === 0) {
      throw contractError(`${field} changed raw word time requires repair evidence`);
    }
  }
  if (repairCodes.length) result.repairCodes = repairCodes;
  return { word: result, textBytes: text.bytes };
}

export function validateAsrResult(raw) {
  const value = plainObject(raw, "result");
  exactKeys(value, new Set([
    "schemaVersion", "mediaDurationMs", "detectedLanguage", "languageProbability", "warnings", "segments", "activity", "songActivity",
  ]), "result");
  if (value.schemaVersion !== 1) throw contractError("result schemaVersion is invalid");
  const mediaDurationMs = finiteInteger(value.mediaDurationMs, "mediaDurationMs", {
    min: 1,
    max: LIMITS.MAX_MEDIA_DURATION_MS,
  });
  const warnings = boundedCodes(value.warnings, "warnings", WARNING_CODES, LIMITS.MAX_WARNING_CODES);
  if (!Array.isArray(value.segments)) throw contractError("segments must be an array");
  if (value.segments.length === 0) throw contractError("segments must not be empty");
  if (value.segments.length > LIMITS.MAX_SEGMENTS) {
    throw contractError("segment count exceeds the limit", "OUTPUT_TOO_LARGE");
  }
  let previousSegmentEnd = 0;
  let totalWords = 0;
  let totalTextBytes = 0;
  const segments = value.segments.map((rawSegment, segmentIndex) => {
    const field = `segments[${segmentIndex}]`;
    const segment = plainObject(rawSegment, field);
    exactKeys(segment, new Set([
      "startMs", "endMs", "text", "language", "languageProbability", "words",
    ]), field);
    const startMs = finiteInteger(segment.startMs, `${field}.startMs`, { max: mediaDurationMs });
    const endMs = finiteInteger(segment.endMs, `${field}.endMs`, { max: mediaDurationMs });
    if (endMs <= startMs || startMs < previousSegmentEnd) {
      throw contractError(`${field} segment time is invalid or non-monotonic`);
    }
    previousSegmentEnd = endMs;
    const text = boundedText(segment.text, `${field}.text`, LIMITS.MAX_SEGMENT_TEXT_BYTES);
    totalTextBytes += text.bytes;
    if (!Array.isArray(segment.words)) throw contractError(`${field}.words must be an array`);
    totalWords += segment.words.length;
    if (totalWords > LIMITS.MAX_WORDS) throw contractError("word count exceeds the limit", "OUTPUT_TOO_LARGE");
    let previousWordEnd = startMs;
    const words = segment.words.map((rawWord, wordIndex) => {
      const normalized = validateWord(rawWord, { startMs, endMs, mediaDurationMs }, wordIndex);
      if (normalized.word.startMs < previousWordEnd) {
        throw contractError(`${field}.words word time is non-monotonic`);
      }
      previousWordEnd = normalized.word.endMs;
      totalTextBytes += normalized.textBytes;
      if (totalTextBytes > LIMITS.MAX_TOTAL_TEXT_BYTES) {
        throw contractError("ASR text exceeds the total byte limit", "OUTPUT_TOO_LARGE");
      }
      return normalized.word;
    });
    return {
      startMs,
      endMs,
      text: text.value,
      language: language(segment.language, `${field}.language`),
      languageProbability: probability(segment.languageProbability, `${field}.languageProbability`),
      words,
    };
  });
  const result = {
    schemaVersion: 1,
    mediaDurationMs,
    detectedLanguage: language(value.detectedLanguage, "detectedLanguage"),
    languageProbability: probability(value.languageProbability, "languageProbability"),
    warnings,
    segments,
  };
  if (value.activity !== undefined) result.activity = validateActivity(value.activity, mediaDurationMs);
  if (value.songActivity !== undefined) result.songActivity = validateSongActivity(value.songActivity, mediaDurationMs);
  return result;
}

export { LIMITS as ASR_RESULT_LIMITS };
