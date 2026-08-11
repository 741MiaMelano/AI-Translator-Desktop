import { existsSync, rmSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

const MODES = new Set(["soft_subtitle", "burn_ass"]);

function mediaExportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertAbsoluteFilePath(value, field) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw mediaExportError("INVALID_INPUT", `${field} must be an absolute path`);
  }
  return normalize(value);
}

function assertSeparateOutput(mediaPath, outputPath) {
  const source = assertAbsoluteFilePath(mediaPath, "mediaPath");
  const output = assertAbsoluteFilePath(outputPath, "outputPath");
  if (source.toLowerCase() === output.toLowerCase()) {
    throw mediaExportError("INVALID_INPUT", "Output must be different from the source media");
  }
  return { source, output };
}

function normalizeLanguageCode(value) {
  const languageCode = String(value || "und").trim();
  if (!/^[A-Za-z0-9-]{1,35}$/.test(languageCode)) {
    throw mediaExportError("INVALID_INPUT", "Subtitle language code is invalid");
  }
  return languageCode;
}

function escapeFilterPath(value) {
  return value
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,");
}

export function buildSoftSubtitleMuxArgv({
  mediaPath,
  subtitlePath,
  outputPath,
  languageCode,
}) {
  const { source, output } = assertSeparateOutput(mediaPath, outputPath);
  const subtitle = assertAbsoluteFilePath(subtitlePath, "subtitlePath");
  return [
    "-hide_banner",
    "-nostdin",
    "-n",
    "-i",
    source,
    "-i",
    subtitle,
    "-map",
    "0",
    "-map",
    "1:0",
    "-c",
    "copy",
    "-c:s",
    "ass",
    "-metadata:s:s:0",
    `language=${normalizeLanguageCode(languageCode)}`,
    output,
  ];
}

export function buildAssBurnArgv({ mediaPath, subtitlePath, outputPath }) {
  const { source, output } = assertSeparateOutput(mediaPath, outputPath);
  const subtitle = assertAbsoluteFilePath(subtitlePath, "subtitlePath");
  return [
    "-hide_banner",
    "-nostdin",
    "-n",
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-vf",
    `ass=filename='${escapeFilterPath(subtitle)}'`,
    "-c:v",
    "mpeg4",
    "-q:v",
    "3",
    "-c:a",
    "copy",
    output,
  ];
}

export async function runSubtitleVideoExport({
  mode,
  ffmpegPath,
  mediaPath,
  subtitlePath,
  outputPath,
  languageCode,
  operationId,
  runProcess,
  signal,
  onSpawn,
}) {
  if (!MODES.has(mode) || typeof runProcess !== "function") {
    throw mediaExportError("INVALID_INPUT", "Media export mode and process runner are required");
  }
  const argv = mode === "soft_subtitle"
    ? buildSoftSubtitleMuxArgv({ mediaPath, subtitlePath, outputPath, languageCode })
    : buildAssBurnArgv({ mediaPath, subtitlePath, outputPath });
  try {
    const processResult = await runProcess({
      absoluteExe: assertAbsoluteFilePath(ffmpegPath, "ffmpegPath"),
      argv,
      ...(operationId ? { operationId } : {}),
      timeoutMs: 30 * 60 * 1000,
      stdoutMaxBytes: 256 * 1024,
      signal,
      onSpawn,
    });
    if (!existsSync(outputPath)) {
      throw mediaExportError("PROCESS_FAILED", "FFmpeg completed without an output file");
    }
    return { ok: true, mode, outputPath, processResult };
  } catch (error) {
    rmSync(outputPath, { force: true });
    throw error;
  }
}
