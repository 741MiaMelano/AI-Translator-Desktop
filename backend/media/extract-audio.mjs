import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync, renameSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { MEDIA_ERROR_CODES } from "./constants.mjs";

function mediaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function buildExtractAudioArgv(inputPath, streamIndex, outputPath) {
  if (!isAbsolute(inputPath) || !isAbsolute(outputPath) || !Number.isInteger(streamIndex) || streamIndex < 0) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Audio extraction input is invalid");
  }
  return [
    "-hide_banner", "-nostdin", "-y", "-i", inputPath,
    "-map", `0:${streamIndex}`, "-vn", "-c:a", "pcm_s16le", outputPath,
  ];
}

export async function extractAudioTrack({
  ffmpegPath,
  inputPath,
  destinationPath,
  streamId,
  probe,
  runProcess,
}) {
  if (!isAbsolute(ffmpegPath) || !isAbsolute(destinationPath) || extname(destinationPath).toLowerCase() !== ".wav") {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Audio extraction destination must be a WAV file");
  }
  const stream = probe?.streams?.find((entry) => entry.streamId === streamId && entry.kind === "audio");
  if (!stream || typeof runProcess !== "function") {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Selected audio stream is unavailable");
  }
  const temporaryPath = join(dirname(destinationPath), `.${basename(destinationPath)}.${randomUUID()}.partial.wav`);
  try {
    await runProcess({
      absoluteExe: ffmpegPath,
      argv: buildExtractAudioArgv(inputPath, stream.index, temporaryPath),
      cwd: dirname(destinationPath),
      timeoutMs: 30 * 60 * 1_000,
    });
    if (!existsSync(temporaryPath) || statSync(temporaryPath).size === 0) {
      throw mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, "Audio extraction produced no output");
    }
    renameSync(temporaryPath, destinationPath);
    return { fileName: basename(destinationPath), streamId: stream.streamId };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (error?.code) throw error;
    throw mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, "Audio extraction failed");
  }
}
