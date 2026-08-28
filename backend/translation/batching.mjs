const DEFAULT_MAX_CHARS = 3500;
const DEFAULT_MAX_CONTEXT_SEGMENTS = 6;
const SENTENCE_END = /[.!?。！？…]["'”’）)]?$/u;

function adaptiveContextBefore(segments, startIndex, maxSegments) {
  if (startIndex === 0) return [];
  let first = startIndex - 1;
  while (
    first > 0
    && startIndex - first < maxSegments
    && !SENTENCE_END.test(segments[first - 1].text.trim())
  ) first -= 1;
  return segments.slice(first, startIndex);
}

function adaptiveContextAfter(segments, endIndex, maxSegments) {
  const context = [];
  for (let index = endIndex + 1; index < segments.length && context.length < maxSegments; index += 1) {
    context.push(segments[index]);
    if (SENTENCE_END.test(segments[index].text.trim())) break;
  }
  return context;
}

/**
 * Deterministic batching that never splits a Segment.
 * Context is read-only and excluded from expected return IDs.
 */
export function planTranslationBatches(segments, {
  maxChars = DEFAULT_MAX_CHARS,
  contextRadius,
  maxContextSegments = DEFAULT_MAX_CONTEXT_SEGMENTS,
} = {}) {
  if (!Array.isArray(segments)) {
    throw new Error("segments must be an array");
  }
  const normalized = segments.map((segment, index) => {
    if (!segment || typeof segment.segmentId !== "string" || typeof segment.text !== "string") {
      throw new Error(`invalid segment at index ${index}`);
    }
    // Reject accidental timing/structure fields in model input path.
    return {
      segmentId: segment.segmentId,
      text: segment.text,
      index,
    };
  });

  if (normalized.length === 0) {
    return [];
  }

  const batches = [];
  let current = [];
  let currentChars = 0;

  function flush() {
    if (current.length === 0) return;
    const startIndex = current[0].index;
    const endIndex = current[current.length - 1].index;
    const contextBefore = (Number.isInteger(contextRadius)
      ? normalized.slice(Math.max(0, startIndex - contextRadius), startIndex)
      : adaptiveContextBefore(normalized, startIndex, maxContextSegments))
      .map(({ segmentId, text }) => ({ segmentId, text }));
    const contextAfter = (Number.isInteger(contextRadius)
      ? normalized.slice(endIndex + 1, endIndex + 1 + contextRadius)
      : adaptiveContextAfter(normalized, endIndex, maxContextSegments))
      .map(({ segmentId, text }) => ({ segmentId, text }));
    batches.push({
      segments: current.map(({ segmentId, text }) => ({ segmentId, text })),
      contextSegments: [...contextBefore, ...contextAfter],
      expectedSegmentIds: current.map((item) => item.segmentId),
    });
    current = [];
    currentChars = 0;
  }

  for (const segment of normalized) {
    const segmentChars = segment.text.length + segment.segmentId.length + 8;
    if (segmentChars > maxChars) {
      // Single oversized segment still forms its own batch; never split text.
      flush();
      current = [segment];
      currentChars = segmentChars;
      flush();
      continue;
    }
    if (current.length > 0 && currentChars + segmentChars > maxChars) {
      flush();
    }
    current.push(segment);
    currentChars += segmentChars;
  }
  flush();
  return batches;
}
