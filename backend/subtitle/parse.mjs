import { detectSubtitleFormat } from "./detect-format.mjs";
import { decodeSubtitleBytes, toUint8Array } from "./encoding.mjs";
import { assCuesToDomainSegments, parseAss, serializeAss } from "./ass.mjs";
import { cuesToDomainSegments, parseSrt, serializeSrt } from "./srt.mjs";
import { parseVtt, serializeVtt, vttCuesToDomainSegments } from "./vtt.mjs";

export function parseSubtitleBytes({ fileName, bytes, encoding }) {
  const binary = toUint8Array(bytes);
  const decoded = decodeSubtitleBytes(binary, encoding);
  if (!decoded.ok) {
    return decoded;
  }

  const formatResult = detectSubtitleFormat({ fileName, text: decoded.text });
  if (!formatResult.ok) {
    return formatResult;
  }

  let parsed;
  if (formatResult.format === "srt") {
    parsed = parseSrt(decoded.text);
  } else if (formatResult.format === "vtt") {
    parsed = parseVtt(decoded.text);
  } else if (formatResult.format === "ass" || formatResult.format === "ssa") {
    parsed = parseAss(decoded.text);
  } else {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Unsupported subtitle format",
      },
    };
  }

  if (!parsed.ok) {
    return parsed;
  }

  const warnings = [
    ...(decoded.warnings || []),
    ...(formatResult.warnings || []),
    ...(parsed.warnings || []),
  ];

  return {
    ok: true,
    format: formatResult.format,
    encoding: decoded.encoding,
    newline: decoded.newline,
    cues: parsed.cues,
    warnings,
    formatSummary: parsed.formatSummary || {},
    text: decoded.text,
  };
}

export function segmentsFromParsed(parsed, options) {
  if (parsed.format === "vtt") {
    return vttCuesToDomainSegments(parsed.cues, options);
  }
  if (parsed.format === "ass" || parsed.format === "ssa") {
    return assCuesToDomainSegments(parsed.cues, options);
  }
  return cuesToDomainSegments(parsed.cues, options);
}

export function serializeNormalized({ format, cues, assStyles }) {
  if (format === "srt") return serializeSrt(cues);
  if (format === "vtt") return serializeVtt(cues);
  if (format === "ass") return serializeAss(cues, { styles: assStyles });
  throw new Error(`Unsupported normalized export format: ${format}`);
}

export function rawAssetRelativePath(format) {
  if (format === "vtt") return "artifacts/raw/source.vtt";
  if (format === "ass" || format === "ssa") return "artifacts/raw/source.ass";
  return "artifacts/raw/source.srt";
}
