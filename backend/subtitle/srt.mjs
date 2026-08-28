import { domainTimestampFromMs, formatSrtTimestamp, parseSrtTimestamp } from "./time.mjs";

function parseTimeLine(line) {
  const match = /^(.+?)\s+-->\s+(.+?)$/.exec(line.trim());
  if (!match) return null;
  const start = parseSrtTimestamp(match[1]);
  const end = parseSrtTimestamp(match[2]);
  if (start === null || end === null) return null;
  return { start, end };
}

export function parseSrt(text) {
  if (typeof text !== "string" || text.replace(/^\uFEFF/, "").trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "SRT input is empty",
      },
    };
  }

  const body = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = body.trim().split(/\n\n+/);
  const cues = [];
  const warnings = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const lines = blocks[index].split("\n").filter((line, lineIndex, all) => {
      if (line.length > 0) return true;
      return lineIndex > 0 && lineIndex < all.length - 1;
    });
    if (lines.length === 0) continue;

    let cursor = 0;
    if (/^\d+$/.test(lines[0].trim())) {
      cursor = 1;
    }

    if (cursor >= lines.length) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "SRT cue is missing timing line",
          details: { cueIndex: index },
        },
      };
    }

    const timing = parseTimeLine(lines[cursor]);
    if (!timing) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "SRT cue has an invalid timestamp",
          details: { cueIndex: index, line: lines[cursor] },
        },
      };
    }
    if (timing.end < timing.start) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "SRT cue end is earlier than start",
          details: { cueIndex: index },
        },
      };
    }

    const textLines = lines.slice(cursor + 1);
    if (textLines.length === 0) {
      warnings.push(`第 ${index + 1} 句没有文字`);
    }

    if (cues.length > 0) {
      const previous = cues[cues.length - 1];
      if (timing.start < previous.endMs) {
        warnings.push(`第 ${index + 1} 句和上一句时间重叠`);
      }
      // 字幕之间有间隔是正常的（就是没人说话的地方）。
      // 旧版把它当警告推给用户，还会被选成项目的头条备注，
      // 让人以为文件出了问题。重叠才值得提醒，间隔不值得。
    }

    cues.push({
      index: cues.length + 1,
      startMs: timing.start,
      endMs: timing.end,
      text: textLines.join("\n"),
    });
  }

  if (cues.length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "SRT input contains no cues",
      },
    };
  }

  return {
    ok: true,
    format: "srt",
    cues,
    warnings,
  };
}

export function serializeSrt(cues, { newline = "\n" } = {}) {
  const body = cues
    .map((cue, index) => {
      const start = formatSrtTimestamp(cue.startMs);
      const end = formatSrtTimestamp(cue.endMs);
      const text = String(cue.text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      return `${index + 1}${newline}${start} --> ${end}${newline}${text}`;
    })
    .join(`${newline}${newline}`);
  return `${body}${newline}`;
}

export function cuesToDomainSegments(cues, { sourceLanguage = "auto", idPrefix = "cue" } = {}) {
  return cues.map((cue, index) => ({
    id: `${idPrefix}-${index + 1}`,
    start: domainTimestampFromMs(cue.startMs),
    end: domainTimestampFromMs(cue.endMs),
    sourceLanguage,
    sourceText: {
      original: cue.text,
      normalized: cue.text,
    },
    targetTexts: {},
  }));
}
