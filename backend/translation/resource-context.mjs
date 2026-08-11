import { buildEmptyResourceSnapshot } from "./run-snapshot.mjs";

const LANGUAGE_CODES = new Map([
  ["中文", "zh-CN"],
  ["简体中文", "zh-CN"],
  ["英语", "en-US"],
  ["英文", "en-US"],
  ["日语", "ja-JP"],
  ["日文", "ja-JP"],
]);

function languageCode(value) {
  return LANGUAGE_CODES.get(value) ?? value;
}

function selectedSnapshot(snapshots, kind, selection) {
  if (typeof selection !== "string" || selection.length === 0 || /关闭|none|disabled/i.test(selection)) {
    return null;
  }
  return snapshots
    .filter((snapshot) => snapshot.kind === kind && (
      snapshot.id === selection
      || snapshot.name === selection
      || (snapshot.source.kind === "global" && snapshot.source.resourceId === selection)
    ))
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0] ?? null;
}

function glossaryEntries(snapshot, sourceLanguageCode, targetLanguageCode) {
  if (!snapshot) return [];
  const sourceCode = languageCode(sourceLanguageCode);
  const targetCode = languageCode(targetLanguageCode);
  return snapshot.payload.languagePairs
    .filter((pair) => (
      (sourceCode === "auto" || languageCode(pair.sourceLanguageCode) === sourceCode)
      && languageCode(pair.targetLanguageCode) === targetCode
    ))
    .flatMap((pair) => pair.entries)
    .filter((entry) => entry.enabled);
}

function glossaryHint(entries) {
  if (entries.length === 0) return "";
  return JSON.stringify(entries.map((entry) => ({
    source: entry.source,
    target: entry.target,
    ...(entry.note ? { note: entry.note } : {}),
  })));
}

function styleHint(snapshot, targetLanguageCode) {
  if (!snapshot || languageCode(snapshot.payload.targetLanguageCode) !== languageCode(targetLanguageCode)) {
    return "";
  }
  return snapshot.payload.rules
    .filter((rule) => rule.enabled)
    .map((rule) => `${rule.title}: ${rule.instruction}`)
    .join("\n");
}

export function buildTranslationResourceContext({
  snapshots = [],
  glossarySelection = "",
  styleGuideSelection = "",
  sourceLanguageCode = "auto",
  targetLanguageCode,
}) {
  const glossary = selectedSnapshot(snapshots, "glossary", glossarySelection);
  const selectedStyleGuide = selectedSnapshot(snapshots, "style_guide", styleGuideSelection);
  const entries = glossaryEntries(glossary, sourceLanguageCode, targetLanguageCode);
  const selectedStyleHint = styleHint(selectedStyleGuide, targetLanguageCode);
  const empty = buildEmptyResourceSnapshot();
  return {
    resourceSnapshot: {
      glossary: glossary ? structuredClone(glossary) : empty.glossary,
      styleGuide: selectedStyleGuide && selectedStyleHint
        ? structuredClone(selectedStyleGuide)
        : empty.styleGuide,
    },
    glossaryHint: glossaryHint(entries),
    styleHint: selectedStyleHint,
    termConflictRules: entries.map((entry) => ({ source: entry.source, required: entry.target })),
  };
}
