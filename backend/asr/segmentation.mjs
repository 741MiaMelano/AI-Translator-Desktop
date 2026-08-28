import { createHash } from "node:crypto";
import { validateAsrResult } from "./asr-contract.mjs";
import {
  ASR_SEGMENTATION_CONFIG,
  ASR_SEGMENTATION_CONFIG_VERSION,
} from "../../shared/asr-segmentation-config.mjs";

const SENTENCE_END = /[.!?。！？…]["'”’）)]?$/u;
const CLAUSE_END = /[,;:，；：]["'”’）)]?$/u;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeRunId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw fail("INVALID_INPUT", "ASR run id is invalid");
  }
  return value;
}

function semanticText(value) {
  return value.normalize("NFC").replace(/\s/gu, "");
}

function normalizeText(value) {
  return value
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\s+([,.!?;:，。！？；：])/gu, "$1");
}

function wrappedText(original, config) {
  const text = normalizeText(original);
  const chars = [...text];
  if (chars.length <= config.maxCharsPerLine) return text;
  if (chars.length > config.maxLines * config.maxCharsPerLine) return null;
  const lower = chars.length - config.maxCharsPerLine;
  const upper = config.maxCharsPerLine;
  const midpoint = chars.length / 2;
  let best = null;
  for (let index = lower; index <= upper; index += 1) {
    let left = chars.slice(0, index).join("").trimEnd();
    let right = chars.slice(index).join("").trimStart();
    if (!left || !right) continue;
    const boundaryPriority = /\s/u.test(chars[index - 1] ?? "") || /\s/u.test(chars[index] ?? "")
      ? 0
      : SENTENCE_END.test(left) ? 1 : CLAUSE_END.test(left) ? 2 : 3;
    const score = boundaryPriority * 1_000 + Math.abs(index - midpoint);
    if (!best || score < best.score) best = { score, boundaryPriority, value: `${left}\n${right}` };
  }
  if (best?.boundaryPriority === 3 && /\s/u.test(text)) return null;
  return best?.value ?? null;
}

function boundaryRank(words, index, mediaDurationMs, config) {
  if (index === words.length - 1) return 0;
  const word = words[index];
  const gap = words[index + 1].startMs - word.endMs;
  if (SENTENCE_END.test(word.text)) return 0;
  if (gap >= config.preferredPauseMs) return 5;
  if (CLAUSE_END.test(word.text)) return 10;
  if (gap >= config.secondaryPauseMs) return 20;
  return mediaDurationMs === word.endMs ? 0 : 50;
}

function isPreferredBoundary(words, index, config) {
  if (index >= words.length - 1) return false;
  return SENTENCE_END.test(words[index].text) ||
    words[index + 1].startMs - words[index].endMs >= config.preferredPauseMs;
}

function stableSegmentId(runId, configVersion, start, end) {
  return `asr-seg-${createHash("sha256").update(`${runId}\0${configVersion}\0${start}\0${end}`).digest("hex").slice(0, 20)}`;
}

function flattenWords(result) {
  const words = [];
  const ranges = [];
  for (const segment of result.segments) {
    if (!segment.words.length) throw fail("UNSEGMENTABLE_INPUT", "ASR segment has no word timing");
    const combined = segment.words.map((word) => word.text).join("");
    if (semanticText(combined) !== semanticText(segment.text)) {
      throw fail("UNSEGMENTABLE_INPUT", "ASR segment text does not match its words");
    }
    const segmentWords = segment.words.map((word) => ({ ...word, language: segment.language }));
    for (let index = 0; index < segmentWords.length;) {
      const isLegacyZero = (word) => word.rawStartMs === word.rawEndMs &&
        word.repairCodes?.includes("zero_duration_tokens_partitioned");
      if (!isLegacyZero(segmentWords[index])) {
        index += 1;
        continue;
      }
      let runEnd = index;
      while (runEnd + 1 < segmentWords.length && isLegacyZero(segmentWords[runEnd + 1])) runEnd += 1;
      const lower = segmentWords[index - 1]?.endMs ?? segment.startMs;
      const upper = segmentWords[runEnd + 1]?.startMs ?? segment.endMs;
      let startMs = lower;
      for (let cursor = index; cursor <= runEnd; cursor += 1) {
        const remaining = runEnd - cursor + 1;
        startMs = Math.max(startMs, Math.min(segmentWords[cursor].rawStartMs, upper - remaining));
        segmentWords[cursor] = { ...segmentWords[cursor], startMs, endMs: startMs + 1 };
        startMs += 1;
      }
      index = runEnd + 1;
    }
    const startIndex = words.length;
    words.push(...segmentWords);
    ranges.push({
      startIndex,
      endIndex: words.length - 1,
      startMs: segment.startMs,
      endMs: segment.endMs,
    });
  }
  return { words, ranges };
}

function candidate(words, startIndex, endIndex, mediaDurationMs, config) {
  const first = words[startIndex];
  const last = words[endIndex];
  const visibleLastEnd = startIndex === endIndex
    ? Math.min(last.endMs, first.startMs + config.maxDurationMs)
    : last.endMs;
  if (visibleLastEnd - first.startMs > config.maxDurationMs) return null;
  const original = words.slice(startIndex, endIndex + 1).map((word) => word.text).join("");
  const normalized = wrappedText(original, config);
  if (!normalized) return null;
  const chars = [...normalized.replaceAll("\n", "")].length;
  const requiredDuration = Math.max(config.minDurationMs, Math.ceil(chars / config.maxCps * 1_000));
  const latestEnd = endIndex === words.length - 1
    ? mediaDurationMs
    : words[endIndex + 1].startMs - config.minGapMs;
  if (endIndex < words.length - 1 && visibleLastEnd - latestEnd > config.minGapMs) return null;
  const visibleWordEnd = Math.min(visibleLastEnd, latestEnd);
  const naturalEnd = Math.max(visibleWordEnd, first.startMs + config.minDurationMs);
  // 补读秒不能无限延后：语音结束之后最多再留 maxTrailingHangMs，
  // 否则句间一有停顿，字幕就一路铺到下一条，人不说话字幕也不消失。
  const hangLimit = Math.max(visibleWordEnd + config.maxTrailingHangMs, first.startMs + config.minDurationMs);
  const readableEnd = Math.min(Math.max(visibleWordEnd, first.startMs + requiredDuration), hangLimit);
  const endMs = readableEnd <= latestEnd ? readableEnd : naturalEnd;
  if (endMs > latestEnd || endMs - first.startMs > config.maxDurationMs) return null;
  const languages = new Set(words.slice(startIndex, endIndex + 1).map((word) => word.language));
  return {
    startMs: first.startMs,
    endMs,
    sourceLanguage: languages.size === 1 ? languages.values().next().value : "und",
    sourceText: { original, normalized },
    wordStartIndex: startIndex,
    wordEndIndex: endIndex,
  };
}

function readabilityPenalty(value, config) {
  const chars = [...value.sourceText.normalized.replaceAll("\n", "")].length;
  return chars / ((value.endMs - value.startMs) / 1_000) > config.maxCps ? 100_000 : 0;
}

function planWords(words, mediaDurationMs, config) {
  const best = new Array(words.length + 1).fill(null);
  best[words.length] = { cost: 0, segments: [] };
  for (let start = words.length - 1; start >= 0; start -= 1) {
    let crossedPreferred = 0;
    for (let end = start; end < words.length; end += 1) {
      const value = candidate(words, start, end, mediaDurationMs, config);
      if (value && best[end + 1]) {
        const cost = best[end + 1].cost + 100 + crossedPreferred * 10_000 + readabilityPenalty(value, config) +
          boundaryRank(words, end, mediaDurationMs, config);
        if (!best[start] || cost < best[start].cost) {
          best[start] = { cost, segments: [value, ...best[end + 1].segments] };
        }
      }
      if (isPreferredBoundary(words, end, config)) crossedPreferred += 1;
      const rawChars = [...normalizeText(words.slice(start, end + 1).map((word) => word.text).join(""))].length;
      if (rawChars > config.maxLines * config.maxCharsPerLine || words[end].endMs - words[start].startMs > config.maxDurationMs) break;
    }
  }
  return best[0];
}

async function planWordsAsync(words, mediaDurationMs, config, isCancelled, yieldControl) {
  const best = new Array(words.length + 1).fill(null);
  best[words.length] = { cost: 0, segments: [] };
  for (let start = words.length - 1; start >= 0; start -= 1) {
    if (isCancelled()) throw fail("CANCELLED", "ASR segmentation was cancelled");
    if (start % 32 === 0) await yieldControl();
    let crossedPreferred = 0;
    for (let end = start; end < words.length; end += 1) {
      const value = candidate(words, start, end, mediaDurationMs, config);
      if (value && best[end + 1]) {
        const cost = best[end + 1].cost + 100 + crossedPreferred * 10_000 + readabilityPenalty(value, config) +
          boundaryRank(words, end, mediaDurationMs, config);
        if (!best[start] || cost < best[start].cost) {
          best[start] = { cost, segments: [value, ...best[end + 1].segments] };
        }
      }
      if (isPreferredBoundary(words, end, config)) crossedPreferred += 1;
      const rawChars = [...normalizeText(words.slice(start, end + 1).map((word) => word.text).join(""))].length;
      if (rawChars > config.maxLines * config.maxCharsPerLine || words[end].endMs - words[start].startMs > config.maxDurationMs) break;
    }
  }
  if (isCancelled()) throw fail("CANCELLED", "ASR segmentation was cancelled");
  return best[0];
}

function softenRange(words, range, config) {
  if (words.length === 1) {
    return [{ ...words[0], endMs: Math.min(words[0].endMs, words[0].startMs + config.maxDurationMs) }];
  }
  const weights = words.map((word) => Math.max(1, [...word.text.trim()].length));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const span = range.endMs - range.startMs;
  let cumulativeWeight = 0;
  let previousEnd = range.startMs;
  return words.map((word, index) => {
    const remaining = words.length - index - 1;
    const proportionalStart = range.startMs + Math.floor(span * cumulativeWeight / totalWeight);
    const startMs = Math.max(previousEnd, Math.min(proportionalStart, range.endMs - remaining - 1));
    cumulativeWeight += weights[index];
    const proportionalEnd = range.startMs + Math.floor(span * cumulativeWeight / totalWeight);
    const endMs = Math.min(
      startMs + config.maxDurationMs,
      Math.max(startMs + 1, Math.min(proportionalEnd, range.endMs - remaining)),
    );
    previousEnd = endMs;
    return { ...word, startMs, endMs };
  });
}

function softenUnsegmentableRanges(words, ranges, mediaDurationMs, config) {
  const effective = words.map((word) => ({ ...word }));
  let changed = false;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    const latestEnd = range.endIndex === effective.length - 1
      ? mediaDurationMs
      : effective[range.endIndex + 1].startMs - config.minGapMs;
    const rangeWords = effective.slice(range.startIndex, range.endIndex + 1);
    if (planWords(rangeWords, latestEnd, config)) continue;
    effective.splice(range.startIndex, rangeWords.length, ...softenRange(rangeWords, range, config));
    changed = true;
  }
  return changed ? effective : words;
}

function materialize(runId, configVersion, mediaDurationMs, plan) {
  return {
    configVersion,
    mediaDurationMs,
    segments: plan.segments.map((segment) => ({
      id: stableSegmentId(runId, configVersion, segment.wordStartIndex, segment.wordEndIndex),
      ...segment,
    })),
  };
}

export function segmentAsrResult({
  runId,
  result: rawResult,
  configVersion = ASR_SEGMENTATION_CONFIG_VERSION,
}) {
  safeRunId(runId);
  if (configVersion !== ASR_SEGMENTATION_CONFIG_VERSION) {
    throw fail("INVALID_INPUT", "Segmentation config version is unsupported");
  }
  const result = validateAsrResult(rawResult);
  const timeline = flattenWords(result);
  let words = timeline.words;
  if (!words.length) throw fail("UNSEGMENTABLE_INPUT", "ASR result has no words");
  const config = ASR_SEGMENTATION_CONFIG;
  let plan = planWords(words, result.mediaDurationMs, config);
  if (!plan) {
    words = softenUnsegmentableRanges(words, timeline.ranges, result.mediaDurationMs, config);
    plan = planWords(words, result.mediaDurationMs, config);
  }
  if (!plan) throw fail("UNSEGMENTABLE_INPUT", "ASR words cannot satisfy the subtitle limits");
  return materialize(runId, configVersion, result.mediaDurationMs, plan);
}

export async function segmentAsrResultAsync({
  runId,
  result: rawResult,
  configVersion = ASR_SEGMENTATION_CONFIG_VERSION,
  isCancelled = () => false,
  yieldControl = () => new Promise((resolve) => setImmediate(resolve)),
}) {
  safeRunId(runId);
  if (configVersion !== ASR_SEGMENTATION_CONFIG_VERSION || typeof isCancelled !== "function" || typeof yieldControl !== "function") {
    throw fail("INVALID_INPUT", "Segmentation request is invalid");
  }
  const result = validateAsrResult(rawResult);
  const timeline = flattenWords(result);
  let words = timeline.words;
  if (!words.length) throw fail("UNSEGMENTABLE_INPUT", "ASR result has no words");
  const config = ASR_SEGMENTATION_CONFIG;
  let plan = await planWordsAsync(words, result.mediaDurationMs, config, isCancelled, yieldControl);
  if (!plan) {
    words = softenUnsegmentableRanges(words, timeline.ranges, result.mediaDurationMs, config);
    plan = await planWordsAsync(words, result.mediaDurationMs, config, isCancelled, yieldControl);
  }
  if (!plan) throw fail("UNSEGMENTABLE_INPUT", "ASR words cannot satisfy the subtitle limits");
  return materialize(runId, configVersion, result.mediaDurationMs, plan);
}

export {
  ASR_SEGMENTATION_CONFIG,
  ASR_SEGMENTATION_CONFIG_VERSION,
};
