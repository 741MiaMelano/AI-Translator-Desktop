import { isAbsolute } from "node:path";
import { MEDIA_ERROR_CODES, MEDIA_LIMITS } from "./constants.mjs";

const WAVEFORM_PEAKS = 2_000;
const WAVEFORM_MAX_DURATION_MS = 24 * 60 * 60 * 1_000;

function waveformError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function buildWaveformArgv(inputPath, streamIndex, durationMs) {
  if (
    !isAbsolute(inputPath)
    || !Number.isInteger(streamIndex)
    || streamIndex < 0
    || !Number.isFinite(durationMs)
    || durationMs <= 0
    || durationMs > WAVEFORM_MAX_DURATION_MS
  ) {
    throw waveformError(MEDIA_ERROR_CODES.INVALID_INPUT, "Waveform input is invalid");
  }
  const durationSeconds = durationMs / 1_000;
  const sampleRate = Math.max(8, Math.min(200, Math.ceil(WAVEFORM_PEAKS * 4 / durationSeconds)));
  return [
    "-hide_banner", "-nostdin", "-i", inputPath,
    "-map", `0:${streamIndex}`, "-vn", "-ac", "1", "-ar", String(sampleRate),
    "-f", "f32le", "pipe:1",
  ];
}

export function decodeWaveformPeaks(buffer, maxPeaks = WAVEFORM_PEAKS) {
  if (!Buffer.isBuffer(buffer) || buffer.length % 4 !== 0 || !Number.isInteger(maxPeaks) || maxPeaks < 1) {
    throw waveformError(MEDIA_ERROR_CODES.CORRUPT_INPUT, "Waveform samples are invalid");
  }
  const sampleCount = buffer.length / 4;
  if (sampleCount === 0) return [];
  const bucketSize = Math.ceil(sampleCount / maxPeaks);
  const peaks = [];
  for (let start = 0; start < sampleCount; start += bucketSize) {
    let peak = 0;
    for (let index = start; index < Math.min(sampleCount, start + bucketSize); index += 1) {
      const sample = Math.abs(buffer.readFloatLE(index * 4));
      if (Number.isFinite(sample)) peak = Math.max(peak, sample);
    }
    peaks.push(peak);
  }
  const maximum = Math.max(...peaks);
  return maximum > 0
    ? peaks.map((peak) => Number(Math.min(1, peak / maximum).toFixed(4)))
    : peaks;
}

export async function extractWaveform({
  ffmpegPath,
  inputPath,
  streamIndex,
  durationMs,
  runProcess,
}) {
  if (!isAbsolute(ffmpegPath) || typeof runProcess !== "function") {
    throw waveformError(MEDIA_ERROR_CODES.INVALID_INPUT, "Waveform extractor is unavailable");
  }
  const argv = buildWaveformArgv(inputPath, streamIndex, durationMs);
  const sampleRate = Number(argv[argv.indexOf("-ar") + 1]);
  const stdoutMaxBytes = Math.ceil(durationMs / 1_000 * sampleRate * 4) + 4_096;
  const result = await runProcess({
    absoluteExe: ffmpegPath,
    argv,
    timeoutMs: MEDIA_LIMITS.EXTRACT_TIMEOUT_MAX_MS,
    stdoutMaxBytes,
  });
  const peaks = decodeWaveformPeaks(result.stdout);
  if (!peaks.length) {
    throw waveformError(MEDIA_ERROR_CODES.CORRUPT_INPUT, "Selected audio stream produced no waveform");
  }
  return { durationMs: Math.round(durationMs), peaks };
}

export { WAVEFORM_PEAKS, WAVEFORM_MAX_DURATION_MS };
