import { ASR_RESULT_LIMITS, validateAsrResult } from "./asr-contract.mjs";

const WARNING_ORDER = [
  "language_probability_unavailable",
  "leading_timestamp_clamped",
  "terminal_timestamp_clamped",
  "zero_duration_tokens_partitioned",
];
const MAX_TERMINAL_OVERSHOOT_MS = 500;
const MAX_LEADING_UNDERSHOOT_MS = 1_000;
const MAX_SUPERSEDED_PREFIX_DURATION_MS = 100;
const WHISPER_CPP_TIMESTAMP_TICK_MS = 20;

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_ASR_RESULT";
  return error;
}

function integer(value, field, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw invalid(`${field} is invalid`);
  return value;
}

function tokenProbability(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw invalid(`${field} is invalid`);
  return value;
}

function isSpecialToken(text) {
  return /^\[_[A-Z0-9_]+\]$/.test(text);
}

function quantizedMediaEnd(mediaDurationMs) {
  return Math.ceil(mediaDurationMs / WHISPER_CPP_TIMESTAMP_TICK_MS) * WHISPER_CPP_TIMESTAMP_TICK_MS;
}

function isSupersededShortPrefix(raw, startMs, endMs, next) {
  return endMs > startMs && endMs - startMs <= MAX_SUPERSEDED_PREFIX_DURATION_MS &&
    typeof raw.text === "string" && raw.text.trim() &&
    typeof next?.text === "string" && next.text.trim() &&
    Number.isSafeInteger(next?.offsets?.from) && Number.isSafeInteger(next?.offsets?.to) &&
    next.offsets.from === startMs && next.offsets.to >= endMs;
}

function rawWords(tokens, field, mediaDurationMs) {
  if (tokens === undefined) return [];
  if (!Array.isArray(tokens)) throw invalid(`${field} tokens are invalid`);
  const words = [];
  let pendingWhitespace = null;
  let previousTokenEnd = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || typeof token !== "object" || Array.isArray(token) || typeof token.text !== "string") {
      throw invalid(`${field}.tokens[${index}] is invalid`);
    }
    if (isSpecialToken(token.text)) continue;
    if (!token.text || !token.offsets || typeof token.offsets !== "object") {
      throw invalid(`${field}.tokens[${index}] offsets are invalid`);
    }
    const maximumRawEnd = quantizedMediaEnd(mediaDurationMs) + MAX_TERMINAL_OVERSHOOT_MS;
    const startMs = integer(token.offsets.from, `${field}.tokens[${index}].from`, maximumRawEnd);
    const endMs = integer(token.offsets.to, `${field}.tokens[${index}].to`, maximumRawEnd);
    const startsWord = !words.length || pendingWhitespace || /^\s/u.test(token.text) || /\p{Script=Han}/u.test(token.text);
    if (startMs < previousTokenEnd || (endMs < startMs && !startsWord)) {
      throw invalid(`${field}.tokens[${index}] timing overlaps or is out of order`);
    }
    previousTokenEnd = Math.max(startMs, endMs);
    const probability = tokenProbability(token.p, `${field}.tokens[${index}].p`);
    if (/^\s+$/u.test(token.text)) {
      pendingWhitespace = pendingWhitespace
        ? { ...pendingWhitespace, rawEndMs: endMs, text: pendingWhitespace.text + token.text,
            probability: pendingWhitespace.probability === null || probability === null
              ? pendingWhitespace.probability ?? probability
              : Math.min(pendingWhitespace.probability, probability) }
        : { rawStartMs: startMs, rawEndMs: endMs, text: token.text, probability };
      continue;
    }
    if (startsWord) {
      words.push({
        rawStartMs: pendingWhitespace?.rawStartMs ?? startMs,
        rawEndMs: endMs,
        text: (pendingWhitespace?.text ?? "") + token.text,
        probability: pendingWhitespace?.probability === null || probability === null
          ? pendingWhitespace?.probability ?? probability
          : Math.min(pendingWhitespace?.probability ?? 1, probability),
      });
      pendingWhitespace = null;
    } else {
      const current = words.at(-1);
      current.text += token.text;
      current.rawEndMs = endMs;
      current.probability = current.probability === null || probability === null
        ? current.probability ?? probability
        : Math.min(current.probability, probability);
    }
  }
  if (pendingWhitespace && words.length) {
    const current = words.at(-1);
    current.text += pendingWhitespace.text;
    current.rawEndMs = pendingWhitespace.rawEndMs;
  }
  return words;
}

function repairedWord(raw, startMs, endMs, code) {
  const value = { startMs, endMs, text: raw.text, probability: raw.probability };
  const repairCodes = [...new Set([...(raw.repairCodes ?? []), ...(code ? [code] : [])])];
  if (repairCodes.length) {
    value.rawStartMs = raw.sourceRawStartMs ?? raw.rawStartMs;
    value.rawEndMs = raw.sourceRawEndMs ?? raw.rawEndMs;
    value.repairCodes = repairCodes;
  }
  return value;
}

function normalizeLeadingWords(raw, segment, priorSegmentEndMs, warnings) {
  const first = raw[0];
  const last = raw.at(-1);
  const shift = first ? segment.startMs - first.rawStartMs : 0;
  if (
    shift > 0 &&
    raw.every((word) => word.rawEndMs >= word.rawStartMs) &&
    last.rawEndMs + shift <= segment.endMs + MAX_TERMINAL_OVERSHOOT_MS
  ) {
    const rawSpan = last.rawEndMs - first.rawStartMs;
    const scale = rawSpan > segment.endMs - segment.startMs
      ? (segment.endMs - segment.startMs) / rawSpan
      : 1;
    warnings.add("leading_timestamp_clamped");
    return raw.map((word) => ({
      ...word,
      rawStartMs: segment.startMs + Math.round((word.rawStartMs - first.rawStartMs) * scale),
      rawEndMs: segment.startMs + Math.round((word.rawEndMs - first.rawStartMs) * scale),
      sourceRawStartMs: word.rawStartMs,
      sourceRawEndMs: word.rawEndMs,
      repairCodes: ["leading_timestamp_clamped"],
    }));
  }
  let leading = true;
  return raw.map((word) => {
    let startMs = word.rawStartMs;
    let endMs = word.rawEndMs;
    if (
      leading &&
      startMs < segment.startMs &&
      endMs > segment.startMs &&
      segment.startMs - startMs <= MAX_LEADING_UNDERSHOOT_MS
    ) {
      startMs = segment.startMs;
    } else if (
      leading &&
      startMs === segment.startMs &&
      endMs < startMs &&
      endMs >= priorSegmentEndMs &&
      startMs - endMs <= MAX_LEADING_UNDERSHOOT_MS
    ) {
      endMs = startMs;
    } else {
      leading = false;
      return word;
    }
    warnings.add("leading_timestamp_clamped");
    return {
      ...word,
      rawStartMs: startMs,
      rawEndMs: endMs,
      sourceRawStartMs: word.rawStartMs,
      sourceRawEndMs: word.rawEndMs,
      repairCodes: ["leading_timestamp_clamped"],
    };
  });
}

function repairWords(raw, segment, { terminal, mediaDurationMs, priorSegmentEndMs }, warnings) {
  const normalized = normalizeLeadingWords(raw, segment, priorSegmentEndMs, warnings);
  const words = [];
  for (let index = 0; index < normalized.length;) {
    const current = normalized[index];
    if (current.rawStartMs < segment.startMs || current.rawStartMs > segment.endMs || current.rawEndMs < current.rawStartMs) {
      throw invalid("word timing is outside its segment or reversed");
    }
    if (current.rawEndMs > segment.endMs) {
      const terminalWord = terminal && index === raw.length - 1 && segment.endMs === mediaDurationMs;
      if (!terminalWord || current.rawEndMs - quantizedMediaEnd(mediaDurationMs) > MAX_TERMINAL_OVERSHOOT_MS) {
        throw invalid("non-terminal word timing exceeds its segment");
      }
      const previousEnd = words.at(-1)?.endMs ?? segment.startMs;
      if (current.rawStartMs < previousEnd || current.rawStartMs >= mediaDurationMs) {
        throw invalid("terminal word timing overlaps or is out of order");
      }
      warnings.add("terminal_timestamp_clamped");
      words.push(repairedWord(current, current.rawStartMs, mediaDurationMs, "terminal_timestamp_clamped"));
      index += 1;
      continue;
    }
    if (current.rawEndMs > current.rawStartMs) {
      const previousEnd = words.at(-1)?.endMs ?? segment.startMs;
      if (current.rawStartMs < previousEnd) throw invalid("positive-duration word timing overlaps or is out of order");
      words.push(repairedWord(current, current.rawStartMs, current.rawEndMs));
      index += 1;
      continue;
    }

    let runEnd = index;
    while (runEnd + 1 < normalized.length && normalized[runEnd + 1].rawStartMs === normalized[runEnd + 1].rawEndMs) runEnd += 1;
    let lower = words.at(-1)?.endMs ?? segment.startMs;
    let upper = runEnd + 1 < normalized.length ? normalized[runEnd + 1].rawStartMs : segment.endMs;
    const count = runEnd - index + 1;
    for (let cursor = index; cursor <= runEnd; cursor += 1) {
      const zero = normalized[cursor];
      if (zero.rawStartMs < lower || zero.rawStartMs > upper) throw invalid("zero-duration word timing is out of order");
    }
    let borrowedNext = null;
    if (upper - lower < count) {
      const next = normalized[runEnd + 1];
      const previous = normalized[index - 1];
      const previousWord = words.at(-1);
      if (next && next.rawStartMs === upper && next.rawEndMs <= segment.endMs && next.rawEndMs - lower > count) {
        upper = lower + count;
        borrowedNext = next;
      } else if (
        !next && previous && previousWord && previous.rawEndMs > previous.rawStartMs &&
        previousWord.endMs === lower && previousWord.endMs - previousWord.startMs > count
      ) {
        upper = lower;
        lower -= count;
        words[words.length - 1] = repairedWord(
          previous,
          previousWord.startMs,
          lower,
          "zero_duration_tokens_partitioned",
        );
      } else {
        throw invalid("zero-duration word run has insufficient timeline space");
      }
    }
    let startMs = lower;
    for (let offset = 0; offset < count; offset += 1) {
      const remaining = count - offset;
      startMs = Math.max(startMs, Math.min(normalized[index + offset].rawStartMs, upper - remaining));
      const endMs = startMs + 1;
      words.push(repairedWord(normalized[index + offset], startMs, endMs, "zero_duration_tokens_partitioned"));
      startMs = endMs;
    }
    warnings.add("zero_duration_tokens_partitioned");
    if (borrowedNext) {
      words.push(repairedWord(borrowedNext, upper, borrowedNext.rawEndMs, "zero_duration_tokens_partitioned"));
      index = runEnd + 2;
    } else {
      index = runEnd + 1;
    }
  }
  return words;
}

export function canonicalizeWhisperCppResult(source, { mediaDurationMs }) {
  integer(mediaDurationMs, "mediaDurationMs", ASR_RESULT_LIMITS.MAX_MEDIA_DURATION_MS);
  if (!source || typeof source !== "object" || Array.isArray(source)) throw invalid("whisper.cpp result is invalid");
  if (!Array.isArray(source.transcription) || source.transcription.length > ASR_RESULT_LIMITS.MAX_SEGMENTS + 1) {
    throw invalid("whisper.cpp transcription is invalid or too large");
  }
  const detectedLanguage = source.result?.language;
  if (typeof detectedLanguage !== "string") throw invalid("whisper.cpp detected language is invalid");
  const warnings = new Set(["language_probability_unavailable"]);
  const segments = [];
  let previousSegmentEnd = 0;
  let terminalContentIndex = -1;
  for (let index = source.transcription.length - 1; index >= 0; index -= 1) {
    if (typeof source.transcription[index]?.text === "string" && source.transcription[index].text.trim()) {
      terminalContentIndex = index;
      break;
    }
  }
  for (let index = 0; index < source.transcription.length; index += 1) {
    const raw = source.transcription[index];
    const field = `transcription[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.text !== "string") {
      throw invalid(`${field} is invalid`);
    }
    if (!raw.text.trim()) {
      const tokens = rawWords(raw.tokens, field, mediaDurationMs);
      if (tokens.length) throw invalid(`${field} silently drops non-special token text`);
      continue;
    }
    if (!raw.offsets || typeof raw.offsets !== "object") throw invalid(`${field} offsets are invalid`);
    const startMs = integer(raw.offsets.from, `${field}.startMs`, mediaDurationMs);
    const rawEndMs = integer(
      raw.offsets.to,
      `${field}.endMs`,
      quantizedMediaEnd(mediaDurationMs) + MAX_TERMINAL_OVERSHOOT_MS,
    );
    const terminal = index === terminalContentIndex;
    if (rawEndMs > mediaDurationMs &&
      (!terminal || rawEndMs - quantizedMediaEnd(mediaDurationMs) > MAX_TERMINAL_OVERSHOOT_MS)) {
      throw invalid(`${field} has a non-terminal or excessive overshoot`);
    }
    const endMs = Math.min(rawEndMs, mediaDurationMs);
    if (rawEndMs !== endMs) warnings.add("terminal_timestamp_clamped");
    const rawTokenWords = rawWords(raw.tokens, field, mediaDurationMs);
    if (!rawTokenWords.length || rawTokenWords.map((word) => word.text).join("") !== raw.text) {
      throw invalid(`${field} token text does not match the segment`);
    }
    if (isSupersededShortPrefix(raw, startMs, endMs, source.transcription[index + 1])) continue;
    const priorSegmentEndMs = previousSegmentEnd;
    if (endMs <= startMs || startMs < priorSegmentEndMs) throw invalid(`${field} timing is invalid`);
    previousSegmentEnd = endMs;
    const words = repairWords(rawTokenWords, { startMs, endMs }, { terminal, mediaDurationMs, priorSegmentEndMs }, warnings);
    segments.push({
      startMs,
      endMs,
      text: raw.text,
      language: detectedLanguage,
      languageProbability: null,
      words,
    });
  }
  if (!segments.length) throw invalid("whisper.cpp transcription contains no text segments");
  return validateAsrResult({
    schemaVersion: 1,
    mediaDurationMs,
    detectedLanguage,
    languageProbability: null,
    warnings: WARNING_ORDER.filter((code) => warnings.has(code)),
    segments,
  });
}
