import { parseSrtTimestamp } from "./time.mjs";

function extensionOf(fileName) {
  const base = String(fileName || "").split(/[/\\]/).pop() || "";
  const index = base.lastIndexOf(".");
  if (index <= 0) return "";
  return base.slice(index + 1).toLowerCase();
}

function looksLikeSrt(text) {
  const blocks = text.replace(/^\uFEFF/, "").trim().split(/\r?\n\r?\n+/);
  if (blocks.length === 0) return false;
  let valid = 0;
  for (const block of blocks.slice(0, 8)) {
    const lines = block.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length < 2) continue;
    let timeLine = lines[0];
    if (/^\d+$/.test(lines[0]) && lines[1]) timeLine = lines[1];
    const match = /^(.+?)\s+-->\s+(.+?)$/.exec(timeLine.trim());
    if (!match) continue;
    if (parseSrtTimestamp(match[1]) === null || parseSrtTimestamp(match[2]) === null) continue;
    valid += 1;
  }
  return valid > 0;
}

function looksLikeVtt(text) {
  return /^\uFEFF?WEBVTT(?:\s|$)/.test(text);
}

function looksLikeAssOrSsa(text) {
  const normalized = text.replace(/^\uFEFF/, "");
  const hasScriptInfo = /\[Script Info\]/i.test(normalized);
  const hasEvents = /\[Events\]/i.test(normalized);
  const hasDialogue = /^Dialogue:/im.test(normalized);
  const hasFormat = /^Format:/im.test(normalized);
  return hasScriptInfo && hasEvents && (hasDialogue || hasFormat);
}

function contentFormat(text) {
  if (looksLikeVtt(text)) return "vtt";
  if (looksLikeAssOrSsa(text)) {
    if (/ScriptType:\s*v4\.00\+/i.test(text) || /\[V4\+ Styles\]/i.test(text)) return "ass";
    if (/ScriptType:\s*v4\.00(?!\+)/i.test(text) || /\[V4 Styles\]/i.test(text)) return "ssa";
    return "ass";
  }
  if (looksLikeSrt(text)) return "srt";
  return null;
}

function extensionFormat(fileName) {
  const extension = extensionOf(fileName);
  if (extension === "srt") return "srt";
  if (extension === "vtt") return "vtt";
  if (extension === "ass") return "ass";
  if (extension === "ssa") return "ssa";
  return null;
}

export function detectSubtitleFormat({ fileName, text }) {
  const fromContent = contentFormat(text);
  const fromExtension = extensionFormat(fileName);
  const warnings = [];

  if (!fromContent && !fromExtension) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Unsupported or unrecognized subtitle format",
        details: { fileName },
      },
    };
  }

  if (fromContent && fromExtension && fromContent !== fromExtension) {
    warnings.push(
      `扩展名是 ${fromExtension.toUpperCase()}，但内容看起来是 ${fromContent.toUpperCase()}；以内容为准`,
    );
  }

  if (!fromContent && fromExtension) {
    warnings.push(
      `内容不完全符合 ${fromExtension.toUpperCase()} 的结构；仍按扩展名当作 ${fromExtension.toUpperCase()} 处理`,
    );
  }

  return {
    ok: true,
    format: fromContent || fromExtension,
    contentFormat: fromContent,
    extensionFormat: fromExtension,
    warnings,
  };
}

export function isSubtitleFileName(fileName) {
  return extensionFormat(fileName) !== null;
}
