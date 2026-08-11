import type { Segment } from "./workspace";
import { parseDomainTimestamp } from "./segment-timeline.ts";

export interface SourceQualityProblem {
  repeatedText: string;
  repeatedCount: number;
  segmentCount: number;
  longestSegmentId: string;
  longestDurationMs: number;
  invalidRangeCount: number;
  extremeDurationCount: number;
  severeOverlapCount: number;
  reasons: Array<
    | "invalid_ranges"
    | "extreme_durations"
    | "severe_overlaps"
    | "repetition_with_abnormal_timeline"
  >;
}

const EXTREME_DURATION_MS = 60_000;
const SEVERE_OVERLAP_MS = 5_000;

/** High-confidence structural diagnostics only; warnings never rewrite timing. */
export function analyzeSourceQuality(segments: Segment[]): SourceQualityProblem | null {
  if (segments.length === 0) return null;

  const counts = new Map<string, { text: string; count: number }>();
  let longestSegmentId = "";
  let longestDurationMs = 0;
  let invalidRangeCount = 0;
  let extremeDurationCount = 0;
  let severeOverlapCount = 0;
  let firstInvalidSegmentId = "";
  let previousEnd: number | null = null;
  for (const segment of segments) {
    const text = (segment.sourceText.manual ?? segment.sourceText.normalized ?? segment.sourceText.original).trim();
    const key = text.replace(/\s+/g, " ").toLocaleLowerCase();
    if (key) {
      const current = counts.get(key);
      counts.set(key, current ? { ...current, count: current.count + 1 } : { text, count: 1 });
    }
    const start = parseDomainTimestamp(segment.start);
    const end = parseDomainTimestamp(segment.end);
    if (start === null || end === null || end <= start) {
      invalidRangeCount += 1;
      firstInvalidSegmentId ||= segment.id;
      previousEnd = null;
      continue;
    }
    const duration = end - start;
    if (duration > longestDurationMs) {
      longestDurationMs = duration;
      longestSegmentId = segment.id;
    }
    if (duration >= EXTREME_DURATION_MS) extremeDurationCount += 1;
    if (previousEnd !== null && previousEnd - start >= SEVERE_OVERLAP_MS) {
      severeOverlapCount += 1;
    }
    previousEnd = end;
  }

  let repeated = { text: "", count: 0 };
  for (const value of counts.values()) {
    if (value.count > repeated.count) repeated = value;
  }
  const reasons: SourceQualityProblem["reasons"] = [];
  if (invalidRangeCount > 0) reasons.push("invalid_ranges");
  if (
    extremeDurationCount >= 5
    && extremeDurationCount / segments.length >= 0.03
  ) {
    reasons.push("extreme_durations");
  }
  if (
    severeOverlapCount >= 10
    && severeOverlapCount / segments.length >= 0.1
  ) {
    reasons.push("severe_overlaps");
  }
  if (
    repeated.count >= 20
    && repeated.count / segments.length >= 0.2
    && longestDurationMs >= EXTREME_DURATION_MS
  ) {
    reasons.push("repetition_with_abnormal_timeline");
  }
  if (reasons.length === 0) return null;

  return {
    repeatedText: repeated.text,
    repeatedCount: repeated.count,
    segmentCount: segments.length,
    longestSegmentId: longestSegmentId || firstInvalidSegmentId,
    longestDurationMs,
    invalidRangeCount,
    extremeDurationCount,
    severeOverlapCount,
    reasons,
  };
}

export function describeSourceQuality(problem: SourceQualityProblem): string {
  const details = [
    problem.invalidRangeCount > 0 ? `${problem.invalidRangeCount} 段开始/结束时间无效` : null,
    problem.extremeDurationCount > 0 ? `${problem.extremeDurationCount} 段持续超过 60 秒` : null,
    problem.severeOverlapCount > 0 ? `${problem.severeOverlapCount} 处重叠超过 5 秒` : null,
    problem.reasons.includes("repetition_with_abnormal_timeline")
      ? `“${problem.repeatedText}”重复 ${problem.repeatedCount} 次`
      : null,
  ].filter(Boolean).join("，");
  return `源字幕时间轴疑似损坏：${details}；最长一段达到 ${Math.round(problem.longestDurationMs / 1_000)} 秒。继续会把这些问题带入翻译和导出，请先检查，或明确选择仍使用原时间轴。`;
}
