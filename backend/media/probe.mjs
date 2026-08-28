import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { MEDIA_ERROR_CODES, MEDIA_LIMITS } from "./constants.mjs";
import { runManagedProcess } from "./process-runner.mjs";
import { normalizeMediaProbe, validateMediaProbe } from "../../shared/media-probe.mjs";
import { parseSubtitleBytes } from "../subtitle/parse.mjs";

const SUBTITLE_PROBE_MAX_BYTES = 8 * 1024 * 1024;

function mediaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Fixed ffprobe argv — Renderer never participates. Input path is always last. */
export function buildFfprobeArgv(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "input path is required");
  }
  if (!isAbsolute(inputPath)) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "input path must be absolute");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(inputPath) && !/^[a-zA-Z]:\\/.test(inputPath)) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "protocol URLs are not allowed");
  }
  return [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_entries",
    "format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,channels,sample_rate:stream_disposition=default,forced:stream_tags=language,title",
    "-i",
    inputPath,
  ];
}

export function parseFfprobeStdout(stdout, options = {}) {
  const maxBytes = options.stdoutMaxBytes ?? MEDIA_LIMITS.STDOUT_MAX_BYTES_PROBE;
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""), "utf8");
  if (buf.byteLength > maxBytes) {
    throw mediaError(MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE, "ffprobe output exceeded the allowed limit");
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    throw mediaError(MEDIA_ERROR_CODES.CORRUPT_INPUT, "ffprobe returned malformed JSON");
  }
  return validateMediaProbe(normalizeMediaProbe(parsed, options));
}

function withSubtitleDuration(probe, inputPath) {
  if (probe.mediaKind !== "subtitle" || Number.isFinite(probe.format.durationMs)) return probe;
  try {
    const stat = statSync(inputPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > SUBTITLE_PROBE_MAX_BYTES) return probe;
    const parsed = parseSubtitleBytes({ fileName: basename(inputPath), bytes: readFileSync(inputPath) });
    if (!parsed.ok) return probe;
    const durationMs = parsed.cues.reduce((maximum, cue) => Math.max(maximum, cue.endMs), 0);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return probe;
    return {
      ...probe,
      format: { ...probe.format, durationMs },
      warnings: probe.warnings.filter(({ code }) => code !== "MISSING_DURATION"),
    };
  } catch {
    return probe;
  }
}

/**
 * Probe a local media file with a verified ffprobe absolute path.
 */
export async function probeMediaFile({
  ffprobePath,
  inputPath,
  cwd,
  timeoutMs = MEDIA_LIMITS.PROBE_TIMEOUT_MS,
  signal,
  upstreamVersion = null,
  ffprobeSha256 = null,
  runProcess = runManagedProcess,
}) {
  const argv = buildFfprobeArgv(inputPath);
  try {
    const result = await runProcess({
      absoluteExe: ffprobePath,
      argv,
      cwd,
      timeoutMs,
      stdoutMaxBytes: MEDIA_LIMITS.STDOUT_MAX_BYTES_PROBE,
      stderrMaxBytes: MEDIA_LIMITS.STDERR_MAX_BYTES,
      signal,
    });
    return withSubtitleDuration(
      parseFfprobeStdout(result.stdout, { upstreamVersion, ffprobeSha256 }),
      inputPath,
    );
  } catch (error) {
    const code = error?.code;
    if (
      code === MEDIA_ERROR_CODES.TIMEOUT ||
      code === MEDIA_ERROR_CODES.CANCELLED ||
      code === MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE ||
      code === MEDIA_ERROR_CODES.NOT_AVAILABLE ||
      code === MEDIA_ERROR_CODES.INVALID_ARTIFACT ||
      code === MEDIA_ERROR_CODES.INVALID_INPUT
    ) {
      throw error;
    }
    if (code === MEDIA_ERROR_CODES.PROCESS_FAILED) {
      const mapped = mediaError(MEDIA_ERROR_CODES.CORRUPT_INPUT, "Media probe failed for the input file");
      throw mapped;
    }
    throw mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, "Media probe failed");
  }
}
