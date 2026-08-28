import { domainTimestampFromMs, formatVttTimestamp, parseVttTimestamp } from "./time.mjs";

function parseTimeLine(line) {
  const match = /^(.+?)\s+-->\s+(.+?)(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  const start = parseVttTimestamp(match[1]);
  const end = parseVttTimestamp(match[2]);
  if (start === null || end === null) return null;
  return {
    start,
    end,
    settings: match[3]?.trim() || "",
  };
}

export function parseVtt(text) {
  if (typeof text !== "string" || text.replace(/^\uFEFF/, "").trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "VTT input is empty",
      },
    };
  }

  const body = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!/^WEBVTT(?:\s|$)/.test(body)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "VTT header is missing",
      },
    };
  }

  const lines = body.split("\n");
  let index = 1;
  while (index < lines.length && lines[index].trim() !== "") {
    index += 1;
  }
  while (index < lines.length && lines[index].trim() === "") {
    index += 1;
  }

  const cues = [];
  const warnings = [];
  const skippedBlocks = [];
  let blockLines = [];

  const flush = () => {
    if (blockLines.length === 0) return;
    const first = blockLines[0].trim();
    if (/^(NOTE|STYLE|REGION)\b/.test(first)) {
      skippedBlocks.push(first.split(/\s+/)[0]);
      blockLines = [];
      return;
    }

    let cursor = 0;
    let identifier = "";
    let timing = parseTimeLine(blockLines[0]);
    if (!timing && blockLines.length > 1) {
      identifier = blockLines[0].trim();
      timing = parseTimeLine(blockLines[1]);
      cursor = 1;
    }
    if (!timing) {
      if (blockLines.slice(0, 2).some((line) => line.includes("-->"))) {
        throw Object.assign(new Error("VTT cue timing is malformed"), {
          code: "INVALID_INPUT",
        });
      }
      warnings.push(`已跳过 VTT 里的非字幕块：${first.slice(0, 40)}`);
      blockLines = [];
      return;
    }
    if (timing.end < timing.start) {
      throw Object.assign(new Error("VTT cue end is earlier than start"), {
        code: "INVALID_INPUT",
      });
    }

    const textLines = blockLines.slice(cursor + 1);
    if (timing.settings) {
      warnings.push(`识别到字幕定位参数；标准化导出时会丢失：${timing.settings}`);
    }
    if (identifier) {
      warnings.push(`字幕编号只保留在原始文件里：${identifier}`);
    }

    cues.push({
      index: cues.length + 1,
      identifier,
      settings: timing.settings,
      startMs: timing.start,
      endMs: timing.end,
      text: textLines.join("\n"),
    });
    blockLines = [];
  };

  try {
    for (; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") {
        flush();
      } else {
        blockLines.push(line);
      }
    }
    flush();
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: error instanceof Error ? error.message : "VTT parse failed",
      },
    };
  }

  if (skippedBlocks.length > 0) {
    warnings.push(
      `Non-cue blocks preserved only in raw asset: ${[...new Set(skippedBlocks)].join(", ")}`,
    );
  }

  if (cues.length === 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "VTT input contains no cues",
      },
    };
  }

  return {
    ok: true,
    format: "vtt",
    cues,
    warnings,
    formatSummary: {
      skippedBlocks: [...new Set(skippedBlocks)],
      hasCueSettings: cues.some((cue) => Boolean(cue.settings)),
      hasCueIdentifiers: cues.some((cue) => Boolean(cue.identifier)),
    },
  };
}

export function serializeVtt(cues, { newline = "\n" } = {}) {
  const parts = ["WEBVTT", ""];
  for (const cue of cues) {
    if (cue.identifier) {
      parts.push(String(cue.identifier));
    }
    const settings = cue.settings ? ` ${cue.settings}` : "";
    parts.push(`${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}${settings}`);
    parts.push(String(cue.text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    parts.push("");
  }
  return `${parts.join(newline)}${newline}`;
}

export function vttCuesToDomainSegments(cues, options) {
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
