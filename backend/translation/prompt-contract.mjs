export const PROMPT_TEMPLATE_VERSION = "translation.structured.v7";

const SENTENCE_END = /[.!?。！？…]["'”’）)]?$/u;

function buildSemanticUnits(segments) {
  const units = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    units.push({
      segmentIds: pending.map((segment) => segment.segmentId),
      sourceText: pending.map((segment) => segment.text.trim().replace(/\s+/gu, " ")).join(" "),
    });
    pending = [];
  };
  for (const segment of segments) {
    pending.push(segment);
    // ponytail: cap malformed punctuation-free transcripts; add timing-aware grouping only if real projects need it.
    if (SENTENCE_END.test(segment.text.trim()) || pending.length === 12) flush();
  }
  flush();
  return units;
}

export function buildProjectContentSummary(segments, { maxChars = 1200, maxUnits = 8 } = {}) {
  if (!Array.isArray(segments) || maxChars < 1 || maxUnits < 1) return [];
  const units = buildSemanticUnits(segments);
  if (!units.length) return [];
  const count = Math.min(maxUnits, units.length);
  const indexes = count === 1
    ? [0]
    : Array.from({ length: count }, (_, index) => Math.round(index * (units.length - 1) / (count - 1)));
  const summary = [];
  let remaining = maxChars;
  for (const index of new Set(indexes)) {
    if (remaining <= 0) break;
    const text = units[index].sourceText.slice(0, remaining).trim();
    if (!text) continue;
    summary.push(text);
    remaining -= text.length;
  }
  return summary;
}

export const TRANSLATION_RESPONSE_SCHEMA = {
  name: "subtitle_translation_batch",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["targetLanguage", "segments"],
    properties: {
      targetLanguage: { type: "string", minLength: 1 },
      segments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["segmentId", "text"],
          properties: {
            segmentId: { type: "string", minLength: 1 },
            text: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
};

export function buildTranslationMessages({
  targetLanguage,
  segments,
  contextSegments = [],
  projectSummary = [],
  glossaryHint = "",
  styleHint = "",
}) {
  const system = [
    "You are a professional subtitle translator.",
    "Translate only the provided segments.",
    "Read segments in array order as one continuous transcript; subtitle boundaries may split a sentence or phrase.",
    "Use adjacent segments as context and never translate a segment in isolation.",
    "Use the read-only project summary only as context for topic, names, and terminology; do not translate or return it.",
    "Use semanticUnits as the sentence-level source of truth: translate each unit as a whole first, then distribute its natural translation across the listed segmentIds.",
    "Preserve each meaning exactly once across the sequence; do not omit or duplicate meaning.",
    "Keep one response item for every segmentId, while distributing the translation so the ordered target segments read fluently.",
    "Prefer a short natural fragment for every non-empty source segment; never leave its target text empty.",
    "Every segments[].text value must be written in the targetLanguage from the user payload.",
    "If source text is already in targetLanguage, keep it in that language; never translate it into another language.",
    "Return JSON that matches the schema exactly.",
    "Do not invent segment ids.",
    "Do not return context-only segments.",
    "Do not include timestamps, indexes, or subtitle file structure.",
    `Prompt template version: ${PROMPT_TEMPLATE_VERSION}`,
  ].join(" ");

  const payload = {
    targetLanguage,
    glossaryHint: glossaryHint || null,
    styleHint: styleHint || null,
    contextReadOnly: contextSegments.map((segment) => ({
      segmentId: segment.segmentId,
      text: segment.text,
    })),
    projectSummaryReadOnly: projectSummary,
    semanticUnits: buildSemanticUnits(segments),
    segments: segments.map((segment) => ({
      segmentId: segment.segmentId,
      text: segment.text,
    })),
  };

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify(payload),
    },
  ];
}

/**
 * Strict local validation after provider structured output.
 * Rejects missing/duplicate/unknown ids, wrong language, and empty or non-string text.
 */
export function validateTranslationResponse(raw, { targetLanguage, expectedSegmentIds, sourceSegments = [] }) {
  const expected = [...expectedSegmentIds];
  const expectedSet = new Set(expected);
  if (expected.length === 0) {
    return { ok: false, error: "expected segment id set is empty" };
  }

  let parsed;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "response is not valid JSON" };
    }
  } else if (raw && typeof raw === "object") {
    parsed = raw;
  } else {
    return { ok: false, error: "response is empty" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "response root must be an object" };
  }
  if (parsed.targetLanguage !== targetLanguage) {
    return { ok: false, error: "targetLanguage mismatch" };
  }
  if (!Array.isArray(parsed.segments)) {
    return { ok: false, error: "segments must be an array" };
  }
  if (parsed.segments.length !== expected.length) {
    return { ok: false, error: "segment count mismatch" };
  }

  const seen = new Set();
  const mapped = new Map();
  for (const item of parsed.segments) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "segment item must be an object" };
    }
    const segmentId = item.segmentId;
    const text = item.text;
    if (typeof segmentId !== "string" || segmentId.length === 0) {
      return { ok: false, error: "segmentId must be a non-empty string" };
    }
    if (typeof text !== "string") {
      return { ok: false, error: "text must be a string" };
    }
    if (text.trim().length === 0) {
      return { ok: false, error: "translated text is empty" };
    }
    if (!expectedSet.has(segmentId)) {
      return { ok: false, error: `unknown segmentId: ${segmentId}` };
    }
    if (seen.has(segmentId)) {
      return { ok: false, error: `duplicate segmentId: ${segmentId}` };
    }
    seen.add(segmentId);
    mapped.set(segmentId, text);
  }

  for (const segmentId of expected) {
    if (!seen.has(segmentId)) {
      return { ok: false, error: `missing segmentId: ${segmentId}` };
    }
  }

  const targetScript = targetLanguage.toLowerCase().split("-")[0] === "zh"
    ? /\p{Script=Han}/u
    : targetLanguage.toLowerCase().split("-")[0] === "ja"
      ? /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
      : targetLanguage.toLowerCase().split("-")[0] === "ko"
        ? /\p{Script=Hangul}/u
        : null;
  if (targetScript && sourceSegments.some((segment) =>
    expectedSet.has(segment.segmentId) && targetScript.test(segment.text) && !targetScript.test(mapped.get(segment.segmentId)))) {
    return { ok: false, error: "translated text does not use target language" };
  }

  return {
    ok: true,
    value: {
      targetLanguage,
      segments: expected.map((segmentId) => ({
        segmentId,
        text: mapped.get(segmentId),
      })),
    },
  };
}
