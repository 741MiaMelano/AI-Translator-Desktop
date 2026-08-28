import { markStaleTargetText } from "../../shared/target-text-state.mjs";
import type { Segment, TargetTextLayers } from "./workspace";

export type TimelineEditFailureReason =
  | "segment_not_found"
  | "invalid_timestamp"
  | "split_point_out_of_range"
  | "invalid_text_split"
  | "locked"
  | "not_adjacent"
  | "invalid_range"
  | "negative_time";

export interface TimelineEditSuccess {
  ok: true;
  segments: Segment[];
  affectedSegmentIds: string[];
}

export interface TimelineEditFailure {
  ok: false;
  reason: TimelineEditFailureReason;
  segments?: undefined;
}

export type TimelineEditResult = TimelineEditSuccess | TimelineEditFailure;

export interface TimelineEditOptions {
  idFactory?: () => string;
}

function fail(reason: TimelineEditFailureReason): TimelineEditFailure {
  return { ok: false, reason };
}

export function parseDomainTimestamp(value: string): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

export function timelinePointerMs(
  clientX: number,
  bounds: { left: number; width: number },
  durationMs: number,
): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(bounds.left) || bounds.width <= 0 || durationMs <= 0) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  return Math.round(ratio * durationMs);
}

export function findSegmentAtTime(segments: Segment[], currentTimeMs: number): Segment | null {
  if (!Number.isFinite(currentTimeMs) || currentTimeMs < 0) return null;
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const index = Math.floor((low + high) / 2);
    const segment = segments[index];
    const startMs = parseDomainTimestamp(segment.start);
    const endMs = parseDomainTimestamp(segment.end);
    if (startMs === null || endMs === null || startMs >= endMs) return null;
    if (currentTimeMs < startMs) high = index - 1;
    else if (currentTimeMs >= endMs) low = index + 1;
    else return segment;
  }
  return null;
}

export function formatDomainTimestamp(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(`Invalid millisecond timestamp: ${ms}`);
  }
  const milliseconds = ms % 1000;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function cloneSourceText(sourceText: Segment["sourceText"]): Segment["sourceText"] {
  const next: Segment["sourceText"] = {
    original: sourceText.original,
    normalized: sourceText.normalized,
  };
  if (sourceText.manual !== undefined) {
    next.manual = sourceText.manual;
  }
  return next;
}

function cloneTargetText(layer: TargetTextLayers): TargetTextLayers {
  return markStaleTargetText(layer).layer as TargetTextLayers;
}

function cloneTargetTexts(targetTexts: Record<string, TargetTextLayers>): Record<string, TargetTextLayers> {
  return Object.fromEntries(
    Object.entries(targetTexts).map(([languageCode, layer]) => [languageCode, cloneTargetText(layer)]),
  );
}

function emptyTargetTexts(targetTexts: Record<string, TargetTextLayers>): Record<string, TargetTextLayers> {
  return Object.fromEntries(
    Object.keys(targetTexts).map((languageCode) => [
      languageCode,
      {
        model: "",
        postProcessed: "",
        stale: true,
        qaFlags: [],
      } satisfies TargetTextLayers,
    ]),
  );
}

function cloneSegment(segment: Segment): Segment {
  return {
    id: segment.id,
    start: segment.start,
    end: segment.end,
    sourceLanguage: segment.sourceLanguage,
    sourceText: cloneSourceText(segment.sourceText),
    targetTexts: Object.fromEntries(
      Object.entries(segment.targetTexts).map(([languageCode, layer]) => [
        languageCode,
        { ...layer, qaFlags: [...layer.qaFlags] },
      ]),
    ),
  };
}

function parseMs(value: string): number | null {
  return parseDomainTimestamp(value);
}

function defaultIdFactory(): () => string {
  let sequence = 0;
  const stamp = Date.now().toString(36);
  return () => {
    sequence += 1;
    return `segment-${stamp}-${sequence}`;
  };
}

function withStaleTargets(segment: Segment): Segment {
  return {
    ...cloneSegment(segment),
    targetTexts: cloneTargetTexts(segment.targetTexts),
  };
}

function assertValidRange(startMs: number, endMs: number): TimelineEditFailure | null {
  if (startMs < 0 || endMs < 0) {
    return fail("negative_time");
  }
  if (startMs >= endMs) {
    return fail("invalid_range");
  }
  return null;
}

/**
 * Split one segment at an exclusive interior timestamp.
 * Creates two new segment ids. Does not auto-split target text:
 * left keeps full historical target layers as stale; right starts empty+stale.
 */
export function splitSegment(
  segments: Segment[],
  segmentId: string,
  atTimestamp: string,
  options: TimelineEditOptions = {},
): TimelineEditResult {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) {
    return fail("segment_not_found");
  }

  const target = segments[index];
  const startMs = parseMs(target.start);
  const endMs = parseMs(target.end);
  const atMs = parseMs(atTimestamp);
  if (startMs === null || endMs === null || atMs === null) {
    return fail("invalid_timestamp");
  }
  if (!(atMs > startMs && atMs < endMs)) {
    return fail("split_point_out_of_range");
  }

  const idFactory = options.idFactory ?? defaultIdFactory();
  const leftId = idFactory();
  const rightId = idFactory();
  if (leftId === rightId || leftId === segmentId || rightId === segmentId) {
    throw new Error("idFactory must return unique segment ids");
  }

  const left: Segment = {
    id: leftId,
    start: target.start,
    end: formatDomainTimestamp(atMs),
    sourceLanguage: target.sourceLanguage,
    sourceText: cloneSourceText(target.sourceText),
    targetTexts: cloneTargetTexts(target.targetTexts),
  };
  const right: Segment = {
    id: rightId,
    start: formatDomainTimestamp(atMs),
    end: target.end,
    sourceLanguage: target.sourceLanguage,
    sourceText: {
      original: "",
      normalized: "",
    },
    targetTexts: emptyTargetTexts(target.targetTexts),
  };

  const next = [
    ...segments.slice(0, index).map(cloneSegment),
    left,
    right,
    ...segments.slice(index + 1).map(cloneSegment),
  ];

  return {
    ok: true,
    segments: next,
    affectedSegmentIds: [leftId, rightId],
  };
}

function splitTextNearRatio(value: string, ratio: number): [string, string] {
  const desired = Math.max(1, Math.min(value.length - 1, Math.round(value.length * ratio)));
  const candidates = [...value.matchAll(/[\s,，;；。.!?！？]+/gu)]
    .flatMap((match) => [match.index, match.index + match[0].length])
    .filter((offset) => offset > 0 && offset < value.length);
  const offset = candidates.length
    ? candidates.reduce((best, candidate) =>
        Math.abs(candidate - desired) < Math.abs(best - desired) ? candidate : best)
    : desired;
  return [value.slice(0, offset).trim(), value.slice(offset).trim()];
}

function splitSourceText(sourceText: Segment["sourceText"], ratio: number): [Segment["sourceText"], Segment["sourceText"]] {
  const split = (value: string) => splitTextNearRatio(value, ratio);
  const [leftOriginal, rightOriginal] = split(sourceText.original);
  const [leftNormalized, rightNormalized] = split(sourceText.normalized);
  const left: Segment["sourceText"] = { original: leftOriginal, normalized: leftNormalized };
  const right: Segment["sourceText"] = { original: rightOriginal, normalized: rightNormalized };
  if (sourceText.manual !== undefined) {
    const [leftManual, rightManual] = split(sourceText.manual);
    left.manual = leftManual;
    right.manual = rightManual;
  }
  return [left, right];
}

function manualTargetText(text: string): TargetTextLayers {
  return {
    model: "",
    postProcessed: "",
    manual: text,
    stale: false,
    qaFlags: [],
  };
}

/**
 * User-confirmed subtitle split: the caret partitions the active target text.
 * Playback partitions time when it is inside the segment; otherwise the caret
 * ratio supplies a usable interior timestamp. Source text follows that ratio at
 * the nearest natural boundary so the aligned rows remain independently usable.
 */
export function splitSegmentText(
  segments: Segment[],
  segmentId: string,
  atTimestamp: string,
  languageCode: string,
  targetText: string,
  targetOffset: number,
  options: TimelineEditOptions = {},
): TimelineEditResult {
  if (
    typeof languageCode !== "string" || !languageCode ||
    typeof targetText !== "string" ||
    !Number.isInteger(targetOffset) || targetOffset <= 0 || targetOffset >= targetText.length
  ) {
    return fail("invalid_text_split");
  }
  const target = segments.find((segment) => segment.id === segmentId);
  const layer = target?.targetTexts[languageCode];
  if (!target || !layer) return fail("segment_not_found");
  if (layer.locked === true) return fail("locked");

  const leftText = targetText.slice(0, targetOffset).trim().replace(/[,，;；]+$/u, "").trim();
  const rightText = targetText.slice(targetOffset).trim().replace(/^[,，;；]+/u, "").trim();
  if (!leftText || !rightText) return fail("invalid_text_split");

  const ratio = targetOffset / targetText.length;
  const startMs = parseMs(target.start);
  const endMs = parseMs(target.end);
  const requestedMs = parseMs(atTimestamp);
  if (startMs === null || endMs === null || requestedMs === null || endMs - startMs <= 1) {
    return fail("invalid_timestamp");
  }
  const splitMs = requestedMs > startMs && requestedMs < endMs
    ? requestedMs
    : Math.max(startMs + 1, Math.min(endMs - 1, startMs + Math.round((endMs - startMs) * ratio)));
  const timeline = splitSegment(segments, segmentId, formatDomainTimestamp(splitMs), options);
  if (!timeline.ok) return timeline;
  const [leftSource, rightSource] = splitSourceText(target.sourceText, ratio);
  if (!leftSource.normalized || !rightSource.normalized) return fail("invalid_text_split");

  const [leftId, rightId] = timeline.affectedSegmentIds;
  const next = timeline.segments.map((segment) => {
    if (segment.id === leftId) {
      return {
        ...segment,
        sourceText: leftSource,
        targetTexts: { ...segment.targetTexts, [languageCode]: manualTargetText(leftText) },
      };
    }
    if (segment.id === rightId) {
      return {
        ...segment,
        sourceText: rightSource,
        targetTexts: { ...segment.targetTexts, [languageCode]: manualTargetText(rightText) },
      };
    }
    return segment;
  });
  return { ...timeline, segments: next };
}

/**
 * Merge two adjacent segments into one new segment id.
 * Source text is joined with newline. Target text is not auto-joined:
 * first segment target layers are kept as stale historical evidence.
 */
export function mergeSegments(
  segments: Segment[],
  leftSegmentId: string,
  rightSegmentId: string,
  options: TimelineEditOptions = {},
): TimelineEditResult {
  const leftIndex = segments.findIndex((segment) => segment.id === leftSegmentId);
  const rightIndex = segments.findIndex((segment) => segment.id === rightSegmentId);
  if (leftIndex < 0 || rightIndex < 0) {
    return fail("segment_not_found");
  }
  if (rightIndex !== leftIndex + 1) {
    return fail("not_adjacent");
  }

  const left = segments[leftIndex];
  const right = segments[rightIndex];
  const startMs = parseMs(left.start);
  const midLeft = parseMs(left.end);
  const midRight = parseMs(right.start);
  const endMs = parseMs(right.end);
  if (startMs === null || midLeft === null || midRight === null || endMs === null) {
    return fail("invalid_timestamp");
  }
  const rangeError = assertValidRange(startMs, endMs);
  if (rangeError) {
    return rangeError;
  }

  const idFactory = options.idFactory ?? defaultIdFactory();
  const mergedId = idFactory();
  if (mergedId === leftSegmentId || mergedId === rightSegmentId) {
    throw new Error("idFactory must return a new segment id");
  }

  const joinSource = (a: string, b: string) => {
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    return `${a}\n${b}`;
  };

  const merged: Segment = {
    id: mergedId,
    start: left.start,
    end: right.end,
    sourceLanguage: left.sourceLanguage,
    sourceText: {
      original: joinSource(left.sourceText.original, right.sourceText.original),
      normalized: joinSource(left.sourceText.normalized, right.sourceText.normalized),
      ...(left.sourceText.manual !== undefined || right.sourceText.manual !== undefined
        ? {
            manual: joinSource(left.sourceText.manual ?? "", right.sourceText.manual ?? ""),
          }
        : {}),
    },
    targetTexts: cloneTargetTexts(left.targetTexts),
  };

  // Ensure every language present on either side exists on the merge result.
  for (const languageCode of Object.keys(right.targetTexts)) {
    if (!merged.targetTexts[languageCode]) {
      merged.targetTexts[languageCode] = {
        model: "",
        postProcessed: "",
        stale: true,
        qaFlags: [],
      };
    }
  }

  const next = [
    ...segments.slice(0, leftIndex).map(cloneSegment),
    merged,
    ...segments.slice(rightIndex + 1).map(cloneSegment),
  ];

  return {
    ok: true,
    segments: next,
    affectedSegmentIds: [mergedId],
  };
}

/**
 * Nudge one boundary by deltaMs. Keeps segment id. Marks all targets stale.
 */
export function nudgeSegmentBoundary(
  segments: Segment[],
  segmentId: string,
  edge: "start" | "end",
  deltaMs: number,
): TimelineEditResult {
  if (!Number.isInteger(deltaMs)) {
    return fail("invalid_timestamp");
  }
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) {
    return fail("segment_not_found");
  }

  const current = segments[index];
  const startMs = parseMs(current.start);
  const endMs = parseMs(current.end);
  if (startMs === null || endMs === null) {
    return fail("invalid_timestamp");
  }

  const nextStart = edge === "start" ? startMs + deltaMs : startMs;
  const nextEnd = edge === "end" ? endMs + deltaMs : endMs;
  const rangeError = assertValidRange(nextStart, nextEnd);
  if (rangeError) {
    return rangeError;
  }

  const updated = withStaleTargets(current);
  updated.start = formatDomainTimestamp(nextStart);
  updated.end = formatDomainTimestamp(nextEnd);

  const next = segments.map((segment, segmentIndex) =>
    segmentIndex === index ? updated : cloneSegment(segment),
  );

  return {
    ok: true,
    segments: next,
    affectedSegmentIds: [segmentId],
  };
}

/**
 * Translate both boundaries by deltaMs. Keeps segment id. Marks all targets stale.
 */
export function shiftSegment(
  segments: Segment[],
  segmentId: string,
  deltaMs: number,
): TimelineEditResult {
  if (!Number.isInteger(deltaMs)) {
    return fail("invalid_timestamp");
  }
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) {
    return fail("segment_not_found");
  }

  const current = segments[index];
  const startMs = parseMs(current.start);
  const endMs = parseMs(current.end);
  if (startMs === null || endMs === null) {
    return fail("invalid_timestamp");
  }

  const nextStart = startMs + deltaMs;
  const nextEnd = endMs + deltaMs;
  const rangeError = assertValidRange(nextStart, nextEnd);
  if (rangeError) {
    return rangeError;
  }

  const updated = withStaleTargets(current);
  updated.start = formatDomainTimestamp(nextStart);
  updated.end = formatDomainTimestamp(nextEnd);

  const next = segments.map((segment, segmentIndex) =>
    segmentIndex === index ? updated : cloneSegment(segment),
  );

  return {
    ok: true,
    segments: next,
    affectedSegmentIds: [segmentId],
  };
}
