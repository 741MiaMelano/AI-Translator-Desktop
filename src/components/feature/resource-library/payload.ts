import type { ResourceKind } from "../../../domain/resource-library";

/** 资源库页共用的 payload 工具：新 id、JSON 序列化、把英文解析错误翻成中文。 */

export function newId(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix.slice(0, 8)}`;
}

export function formatPayload(value: unknown) {
  return JSON.stringify(value, null, 2);
}

/**
 * JSON.parse 失败时 V8 抛的是英文原文
 * （"Expected double-quoted property name in JSON at position 412 (line 18 column 5)"）。
 * 这里换算成行列，给中文界面一句能照着改的提示。
 */
export function describeJsonError(error: unknown, text: string): string {
  if (!(error instanceof SyntaxError)) {
    return error instanceof Error && /[一-龥]/.test(error.message)
      ? error.message
      : "内容无法解析，请检查格式";
  }
  const lineColumn = /line (\d+) column (\d+)/.exec(error.message);
  if (lineColumn) return `JSON 格式有误：第 ${lineColumn[1]} 行第 ${lineColumn[2]} 列附近`;
  const position = /position (\d+)/.exec(error.message);
  if (position) {
    const offset = Math.min(Number(position[1]), text.length);
    const before = text.slice(0, offset);
    return `JSON 格式有误：第 ${before.split("\n").length} 行第 ${offset - before.lastIndexOf("\n")} 列附近`;
  }
  return "JSON 格式有误：请检查括号、逗号和引号是否配对";
}

export type PayloadState = { ok: true; value: unknown } | { ok: false; message: string };

export function parsePayload(text: string): PayloadState {
  if (!text.trim()) return { ok: false, message: "内容为空" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, message: describeJsonError(error, text) };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blank(value: unknown) {
  return typeof value !== "string" || value.trim().length === 0;
}

function glossaryProblem(payload: Record<string, unknown>): string | null {
  const pairs = Array.isArray(payload.languagePairs) ? payload.languagePairs : [];
  for (const [pairIndex, rawPair] of pairs.entries()) {
    const pair = record(rawPair);
    if (!pair) return `第 ${pairIndex + 1} 组语言对的结构不对`;
    if (blank(pair.sourceLanguageCode) || blank(pair.targetLanguageCode)) {
      return `第 ${pairIndex + 1} 组语言对还缺语言代码`;
    }
    const entries = Array.isArray(pair.entries) ? pair.entries : [];
    for (const [entryIndex, rawEntry] of entries.entries()) {
      const entry = record(rawEntry);
      if (!entry) return `第 ${entryIndex + 1} 条术语的结构不对`;
      if (blank(entry.source) || blank(entry.target)) {
        return `第 ${entryIndex + 1} 条术语的原文或译文还是空的，填好或删掉这一行再保存`;
      }
    }
  }
  return null;
}

function styleGuideProblem(payload: Record<string, unknown>): string | null {
  if (blank(payload.targetLanguageCode)) return "还缺目标语言代码";
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  for (const [index, rawRule] of rules.entries()) {
    const rule = record(rawRule);
    if (!rule) return `第 ${index + 1} 条规则的结构不对`;
    if (blank(rule.title) || blank(rule.instruction)) {
      return `第 ${index + 1} 条规则的标题或要求还是空的，填好或删掉这一条再保存`;
    }
  }
  return null;
}

function subtitleStyleProblem(payload: Record<string, unknown>): string | null {
  if (payload.format !== "ass") return "字幕样式的输出格式必须是 ASS";
  if (!["target_only", "source_top_target_bottom", "target_top_source_bottom"].includes(String(payload.bilingualLayout))) {
    return "请选择有效的双语排布";
  }
  for (const [key, label] of [["primary", "主字幕"], ["secondary", "次字幕"]] as const) {
    const style = record(payload[key]);
    if (!style) return `${label}设置不完整`;
    if (blank(style.fontFamily) || blank(style.textColor) || blank(style.outlineColor) || blank(style.shadowColor)) {
      return `${label}的字体或颜色不能为空`;
    }
    if (![style.fontSizePx, style.outlineWidthPx, style.shadowDepthPx].every(Number.isFinite)) {
      return `${label}的字号、描边和阴影必须是数字`;
    }
  }
  return record(payload.preview) ? null : "预览设置不完整";
}

function exportPresetProblem(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.outputs) || payload.outputs.length === 0) return "至少保留一个输出文件";
  if (blank(payload.fileNameTemplate)) return "文件名模板不能为空";
  const destination = record(payload.destination);
  if (!destination) return "请选择输出目录";
  if (destination.kind === "custom_directory" && blank(destination.directory)) return "自定义输出目录不能为空";
  return null;
}

/** 保存前的本地体检：把后端会拒绝的空字段提前用中文说清楚，避免撞一句英文校验错误。 */
export function describePayloadProblem(kind: ResourceKind, value: unknown): string | null {
  const payload = record(value);
  if (!payload) return "内容必须是一个 JSON 对象";
  if (kind === "glossary") return glossaryProblem(payload);
  if (kind === "style_guide") return styleGuideProblem(payload);
  if (kind === "subtitle_style") return subtitleStyleProblem(payload);
  return exportPresetProblem(payload);
}
