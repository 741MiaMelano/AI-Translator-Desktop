import type {
  GlossaryEntry,
  GlossaryLanguagePair,
  GlossaryPayload,
} from "./resource-library";

export type GlossaryDelimitedFormat = "csv" | "tsv";

interface ParseGlossaryDelimitedOptions {
  format: GlossaryDelimitedFormat;
  defaultSourceLanguageCode?: string;
  defaultTargetLanguageCode?: string;
  idFactory?: () => string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_FIELD_LENGTH = 4_096;

const HEADERS = {
  sourceLanguage: ["source_language", "source_language_code", "source_lang", "源语言", "源语言代码"],
  targetLanguage: ["target_language", "target_language_code", "target_lang", "目标语言", "目标语言代码"],
  source: ["source", "source_term", "term", "original", "原文", "术语"],
  target: ["target", "target_term", "translation", "translated", "译文", "固定译文"],
  partOfSpeech: ["part_of_speech", "pos", "词性"],
  domain: ["domain", "领域"],
  tags: ["tags", "tag", "标签"],
  note: ["note", "notes", "备注"],
  enabled: ["enabled", "active", "启用"],
} as const;

function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const append = (value: string) => {
    field += value;
    if (field.length > MAX_FIELD_LENGTH) throw new Error(`字段过长，单个字段不能超过 ${MAX_FIELD_LENGTH} 个字符`);
  };
  const finishField = () => {
    row.push(field);
    field = "";
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    if (rows.length > MAX_ROWS + 1) throw new Error(`文件行数过多，最多导入 ${MAX_ROWS} 条术语`);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        append('"');
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        append(character);
      }
    } else if (character === '"') {
      if (field.length) throw new Error("引号只能出现在字段开头");
      quoted = true;
    } else if (character === delimiter) {
      finishField();
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else {
      append(character);
    }
  }

  if (quoted) throw new Error("文件中的引号没有闭合");
  if (field.length || row.length) finishRow();
  return rows.filter((values) => values.some((value) => value.trim()));
}

function normalizedHeader(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLocaleLowerCase().replace(/[ -]+/g, "_");
}

function columnIndex(headers: string[], aliases: readonly string[]) {
  return headers.findIndex((header) => aliases.includes(header as never));
}

function fieldAt(row: string[], index: number) {
  return index < 0 ? "" : (row[index] ?? "").trim();
}

function optional(value: string) {
  return value || undefined;
}

function defaultId() {
  return `term-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function parseGlossaryDelimited(
  text: string,
  options: ParseGlossaryDelimitedOptions,
): GlossaryPayload {
  if (typeof text !== "string" || !text.trim()) throw new Error("导入文件为空");
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw new Error("导入文件超过 2 MB");
  const delimiter = options.format === "csv" ? "," : options.format === "tsv" ? "\t" : null;
  if (!delimiter) throw new Error("只支持 CSV 或 TSV 文件");

  const rows = parseRows(text, delimiter);
  if (rows.length < 2) throw new Error("文件必须包含表头和至少一条术语");
  const headers = rows[0].map(normalizedHeader);
  const columns = Object.fromEntries(
    Object.entries(HEADERS).map(([name, aliases]) => [name, columnIndex(headers, aliases)]),
  ) as Record<keyof typeof HEADERS, number>;
  if (columns.source < 0) throw new Error("表头缺少原文列（source 或 原文）");
  if (columns.target < 0) throw new Error("表头缺少译文列（target 或 固定译文）");

  const pairs: GlossaryLanguagePair[] = [];
  const pairByLanguages = new Map<string, GlossaryLanguagePair>();
  const makeId = options.idFactory ?? defaultId;

  for (const [offset, row] of rows.slice(1).entries()) {
    const source = fieldAt(row, columns.source);
    const target = fieldAt(row, columns.target);
    if (!source || !target) throw new Error(`第 ${offset + 2} 行的原文或译文为空`);
    const sourceLanguageCode = fieldAt(row, columns.sourceLanguage) || options.defaultSourceLanguageCode?.trim();
    const targetLanguageCode = fieldAt(row, columns.targetLanguage) || options.defaultTargetLanguageCode?.trim();
    if (!sourceLanguageCode || !targetLanguageCode) throw new Error(`第 ${offset + 2} 行缺少源语言或目标语言代码`);

    const key = `${sourceLanguageCode}\u0000${targetLanguageCode}`;
    let pair = pairByLanguages.get(key);
    if (!pair) {
      pair = { sourceLanguageCode, targetLanguageCode, entries: [] };
      pairByLanguages.set(key, pair);
      pairs.push(pair);
    }
    const rawTags = fieldAt(row, columns.tags);
    const enabled = fieldAt(row, columns.enabled).toLocaleLowerCase();
    const entry: GlossaryEntry = {
      id: makeId(),
      source,
      target,
      ...(optional(fieldAt(row, columns.partOfSpeech)) ? { partOfSpeech: fieldAt(row, columns.partOfSpeech) } : {}),
      ...(optional(fieldAt(row, columns.domain)) ? { domain: fieldAt(row, columns.domain) } : {}),
      ...(rawTags ? { tags: rawTags.split(/[|;；]/).map((tag) => tag.trim()).filter(Boolean) } : {}),
      ...(optional(fieldAt(row, columns.note)) ? { note: fieldAt(row, columns.note) } : {}),
      enabled: !["false", "0", "no", "否", "禁用"].includes(enabled),
    };
    pair.entries.push(entry);
  }

  return { languagePairs: pairs };
}

const EXPORT_HEADERS = [
  "source_language",
  "target_language",
  "source",
  "target",
  "part_of_speech",
  "domain",
  "tags",
  "note",
  "enabled",
] as const;

function encodeField(value: string, delimiter: string) {
  const safe = /^[=+@]/.test(value) || /^-(?:\d|[A-Z]+\()/i.test(value) ? `'${value}` : value;
  return safe.includes(delimiter) || /["\r\n]/.test(safe)
    ? `"${safe.replace(/"/g, '""')}"`
    : safe;
}

export function serializeGlossaryDelimited(payload: GlossaryPayload, format: GlossaryDelimitedFormat) {
  const delimiter = format === "csv" ? "," : "\t";
  const rows = [EXPORT_HEADERS.join(delimiter)];
  for (const pair of payload.languagePairs ?? []) {
    for (const entry of pair.entries ?? []) {
      rows.push([
        pair.sourceLanguageCode,
        pair.targetLanguageCode,
        entry.source,
        entry.target,
        entry.partOfSpeech ?? "",
        entry.domain ?? "",
        entry.tags?.join("|") ?? "",
        entry.note ?? "",
        String(entry.enabled),
      ].map((value) => encodeField(value, delimiter)).join(delimiter));
    }
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}
