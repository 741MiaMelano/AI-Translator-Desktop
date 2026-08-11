import { domainTimestampFromMs, formatAssTimestamp, parseAssTimestamp } from "./time.mjs";

const OVERRIDE_TAG = /\{\\[^}]*\}/g;

function stripAssTags(text) {
  return String(text ?? "")
    .replace(OVERRIDE_TAG, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

function parseDialogueLine(line, formatFields) {
  const payload = line.replace(/^Dialogue:\s*/i, "");
  const values = [];
  let current = "";
  let fieldIndex = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (char === "," && fieldIndex < formatFields.length - 1) {
      values.push(current);
      current = "";
      fieldIndex += 1;
      continue;
    }
    current += char;
  }
  values.push(current);

  const record = {};
  formatFields.forEach((field, index) => {
    record[field.toLowerCase()] = values[index] ?? "";
  });
  return record;
}

function defaultFormatFields() {
  return ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
}

export function parseAss(text) {
  if (typeof text !== "string" || text.replace(/^\uFEFF/, "").trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "ASS/SSA input is empty",
      },
    };
  }

  const body = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!/\[Script Info\]/i.test(body) || !/\[Events\]/i.test(body)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "ASS/SSA structure is incomplete",
      },
    };
  }

  const lines = body.split("\n");
  let section = "";
  let eventFormat = defaultFormatFields();
  const styles = [];
  const scriptInfo = [];
  const cues = [];
  const warnings = [];
  let removedTags = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const sectionMatch = /^\[(.+)\]\s*$/.exec(line.trim());
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    if (!line.trim() || line.trim().startsWith(";")) continue;

    if (section === "script info") {
      scriptInfo.push(line);
      continue;
    }
    if (section.includes("styles")) {
      if (/^Format:/i.test(line) || /^Style:/i.test(line)) {
        styles.push(line);
      }
      continue;
    }
    if (section === "events") {
      if (/^Format:/i.test(line)) {
        eventFormat = line
          .replace(/^Format:\s*/i, "")
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        continue;
      }
      if (!/^Dialogue:/i.test(line)) {
        if (/^(Comment|Picture|Sound|Movie|Command):/i.test(line)) {
          warnings.push(`有非对白内容只保留在原始文件里：${line.slice(0, 24)}`);
        }
        continue;
      }

      const record = parseDialogueLine(line, eventFormat);
      const start = parseAssTimestamp(record.start);
      const end = parseAssTimestamp(record.end);
      if (start === null || end === null) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "ASS/SSA dialogue has an invalid timestamp",
            details: { start: record.start, end: record.end },
          },
        };
      }
      if (end < start) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "ASS/SSA dialogue end is earlier than start",
          },
        };
      }

      const rawText = record.text ?? "";
      if (OVERRIDE_TAG.test(rawText) || /\\[nNh]/.test(rawText)) {
        removedTags = true;
      }
      OVERRIDE_TAG.lastIndex = 0;
      cues.push({
        index: cues.length + 1,
        startMs: start,
        endMs: end,
        style: record.style || "Default",
        text: stripAssTags(rawText),
        rawText,
      });
    }
  }

  if (cues.length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "ASS/SSA input contains no dialogue cues",
      },
    };
  }

  if (removedTags) {
    warnings.push("ASS 的内嵌特效标记已从可编辑文本中移除；导出时仍按原始文件保留");
  }

  const isSsa = /ScriptType:\s*v4\.00(?!\+)/i.test(body) || /\[V4 Styles\]/i.test(body);
  return {
    ok: true,
    format: isSsa ? "ssa" : "ass",
    cues,
    warnings,
    formatSummary: {
      scriptInfoLines: scriptInfo.length,
      styleLines: styles.length,
      styleNames: styles
        .filter((line) => /^Style:/i.test(line))
        .map((line) => line.replace(/^Style:\s*/i, "").split(",")[0]?.trim())
        .filter(Boolean),
      removedInlineTags: removedTags,
    },
  };
}

function safeAssName(value, fallback) {
  return String(value || fallback).replace(/[,\r\n]/g, " ").trim() || fallback;
}

function assColor(value, fallback) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value ?? ""));
  if (!match) return fallback;
  const [red, green, blue] = match[1].match(/.{2}/g);
  return `&H00${blue}${green}${red}`.toUpperCase();
}

function styleLine(name, style) {
  const alignment = Number.isInteger(style.alignment)
    ? style.alignment
    : style.position === "top" ? 8 : style.position === "center" ? 5 : 2;
  const marginV = Number.isFinite(style.marginV) ? Math.max(0, Math.round(style.marginV)) : 40;
  return [
    `Style: ${safeAssName(name, "Default")}`,
    safeAssName(style.fontFamily, "Arial"),
    Math.max(1, Math.round(Number(style.fontSizePx) || 48)),
    assColor(style.textColor, "&H00FFFFFF"),
    "&H000000FF",
    assColor(style.outlineColor, "&H00000000"),
    assColor(style.shadowColor, "&H64000000"),
    0, 0, 0, 0, 100, 100, 0, 0, 1,
    Math.max(0, Number(style.outlineWidthPx) || 0),
    Math.max(0, Number(style.shadowDepthPx) || 0),
    alignment, 40, 40, marginV, 1,
  ].join(",");
}

export function serializeAss(cues, { newline = "\n", styleName = "Default", styles } = {}) {
  const styleLines = styles && Object.keys(styles).length > 0
    ? Object.entries(styles).map(([name, style]) => styleLine(name, style))
    : [`Style: ${styleName},Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1`];
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = cues.map((cue) => {
    const text = String(cue.text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n/g, "\\N");
    return `Dialogue: 0,${formatAssTimestamp(cue.startMs)},${formatAssTimestamp(cue.endMs)},${cue.style || styleName},,0,0,0,,${text}`;
  });

  return `${[...header, ...events].join(newline)}${newline}`;
}

export function assCuesToDomainSegments(cues, options) {
  return cues.map((cue, index) => ({
    id: `${options?.idPrefix || "cue"}-${index + 1}`,
    start: domainTimestampFromMs(cue.startMs),
    end: domainTimestampFromMs(cue.endMs),
    sourceLanguage: options?.sourceLanguage || "auto",
    sourceText: {
      original: cue.text,
      normalized: cue.text,
    },
    targetTexts: {},
  }));
}
