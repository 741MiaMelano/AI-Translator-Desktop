import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseSubtitleBytes, segmentsFromParsed } from "../subtitle/parse.mjs";
import { MEDIA_ERROR_CODES, MEDIA_LIMITS } from "./constants.mjs";
import { runManagedProcess } from "./process-runner.mjs";
import { isExtractableTextSubtitleCodec } from "../../shared/media-probe.mjs";

function mediaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function emptyTargetText() {
  return { model: "", postProcessed: "", qaFlags: [] };
}

const CODEC_OUTPUT = {
  subrip: { ext: "srt", ffmpegCodec: "copy" },
  srt: { ext: "srt", ffmpegCodec: "copy" },
  ass: { ext: "ass", ffmpegCodec: "copy" },
  ssa: { ext: "ass", ffmpegCodec: "copy" },
  webvtt: { ext: "vtt", ffmpegCodec: "copy" },
  mov_text: { ext: "srt", ffmpegCodec: "srt" },
  ttml: { ext: "srt", ffmpegCodec: "srt" },
  text: { ext: "srt", ffmpegCodec: "srt" },
};

export function resolveExtractableStream(probe, streamId) {
  if (!probe || !Array.isArray(probe.streams)) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Probe is required");
  }
  if (typeof streamId !== "string" || !streamId.startsWith("s:")) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "streamId is invalid");
  }
  const stream = probe.streams.find((item) => item.streamId === streamId);
  if (!stream || stream.kind !== "subtitle") {
    throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Subtitle stream not found");
  }
  const codec = String(stream.codec || "").toLowerCase();
  if (!stream.extractable || !isExtractableTextSubtitleCodec(codec)) {
    throw mediaError(MEDIA_ERROR_CODES.UNSUPPORTED, "Bitmap or unsupported subtitle streams cannot be extracted");
  }
  const mapping = CODEC_OUTPUT[codec];
  if (!mapping) {
    throw mediaError(MEDIA_ERROR_CODES.UNSUPPORTED, "Subtitle codec is not extractable as text");
  }
  return { stream, mapping };
}

export function buildExtractArgv(inputPath, streamIndex, mapping, outputPath) {
  if (!isAbsolute(inputPath) || !isAbsolute(outputPath)) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "extract paths must be absolute");
  }
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-map",
    `0:${streamIndex}`,
    "-c:s",
    mapping.ffmpegCodec,
    "-y",
    outputPath,
  ];
}

function atomicWriteFile(finalPath, bytes) {
  const dir = dirname(finalPath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tempPath, bytes);
  const fd = openSync(tempPath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, finalPath);
}

/**
 * Build an inactive Candidate Source Track from extracted subtitle bytes.
 * Does not mutate active source tracks.
 */
export function buildCandidateSourceTrackFromBytes({
  bytes,
  fileName,
  targetLanguages,
  sourceLanguage = "auto",
  label = "提取的内嵌字幕候选源轨",
}) {
  const parsed = parseSubtitleBytes({ fileName, bytes });
  if (!parsed.ok) return parsed;

  const sourceTrackId = `source-${createHash("sha1").update(`${randomUUID()}:extract`).digest("hex").slice(0, 12)}`;
  const languages = targetLanguages?.length ? targetLanguages : ["zh-CN"];
  const segments = segmentsFromParsed(parsed, {
    idPrefix: "cue",
    sourceLanguage,
  }).map((segment) => ({
    ...segment,
    targetTexts: Object.fromEntries(languages.map((language) => [language, emptyTargetText()])),
  }));
  const targetTracks = languages.map((language, index) => ({
    id: `target-${language}-${index + 1}-${sourceTrackId.slice(-4)}`,
    languageCode: language,
    languageLabel: language,
    status: "draft",
    isActive: true,
    qaIssues: [],
    snapshotIds: [],
    deliveryLabel: "未开跑",
    lastHumanAction: "extracted",
  }));

  return {
    ok: true,
    sourceTrack: {
      id: sourceTrackId,
      label,
      kind: "embedded_subtitle",
      languageState: "pending",
      defaultLanguage: sourceLanguage,
      isActive: false,
      summary: `${segments.length} cues · ${parsed.format.toUpperCase()} · extracted`,
      segments,
      targetTracks,
    },
    parsed,
    rawRelativePath: `artifacts/raw/${sourceTrackId}.${parsed.format === "ssa" ? "ass" : parsed.format}`,
  };
}

export async function extractEmbeddedSubtitle({
  ffmpegPath,
  inputPath,
  probe,
  streamId,
  projectContainerDir,
  targetLanguages,
  sourceLanguage,
  timeoutMs = MEDIA_LIMITS.EXTRACT_TIMEOUT_MS,
  signal,
  runProcess = runManagedProcess,
}) {
  const { stream, mapping } = resolveExtractableStream(probe, streamId);
  const workDir = join(projectContainerDir, "cache", "media-extract");
  mkdirSync(workDir, { recursive: true });
  const tempOut = join(workDir, `extract-${randomUUID()}.${mapping.ext}`);
  const argv = buildExtractArgv(inputPath, stream.index, mapping, tempOut);

  try {
    await runProcess({
      absoluteExe: ffmpegPath,
      argv,
      cwd: workDir,
      timeoutMs: Math.min(timeoutMs, MEDIA_LIMITS.EXTRACT_TIMEOUT_MAX_MS),
      signal,
    });
    if (!existsSync(tempOut)) {
      throw mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, "Extract produced no output");
    }
    const bytes = readFileSync(tempOut);
    if (bytes.byteLength === 0) {
      throw mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, "Extract produced empty output");
    }
    const built = buildCandidateSourceTrackFromBytes({
      bytes,
      fileName: `extracted.${mapping.ext}`,
      targetLanguages,
      sourceLanguage,
    });
    if (!built.ok) {
      throw mediaError(built.error?.code || MEDIA_ERROR_CODES.CORRUPT_INPUT, built.error?.message || "Parsed extract failed");
    }

    const finalPath = join(projectContainerDir, ...built.rawRelativePath.split("/"));
    try {
      atomicWriteFile(finalPath, bytes);
    } catch (error) {
      throw mediaError(MEDIA_ERROR_CODES.INTERNAL, "Failed to store extracted subtitle asset");
    }

    return {
      ok: true,
      sourceTrack: { ...built.sourceTrack, sourceStreamId: stream.streamId },
      rawRelativePath: built.rawRelativePath,
      streamId: stream.streamId,
      warnings: built.parsed.warnings || [],
    };
  } catch (error) {
    try {
      if (existsSync(tempOut)) rmSync(tempOut, { force: true });
    } catch {
      /* ignore */
    }
    if (error?.code) throw error;
    throw mediaError(MEDIA_ERROR_CODES.PROCESS_FAILED, "Subtitle extraction failed");
  } finally {
    try {
      if (existsSync(tempOut)) rmSync(tempOut, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Attach candidate source track without activating it.
 */
export function attachCandidateSourceTrack(project, sourceTrack, rawRelativePath) {
  if (!project || typeof project !== "object") {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "project is required");
  }
  if (sourceTrack.isActive) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "candidate source track must start inactive");
  }
  return {
    ...project,
    sourceTracks: [...project.sourceTracks, { ...sourceTrack, rawAssetRelativePath: rawRelativePath }],
    // Keep active unchanged until explicit activate.
    activeSourceTrackId: project.activeSourceTrackId,
    updatedAt: new Date().toISOString().replace("T", " ").slice(0, 16),
  };
}

/**
 * Activate a candidate source track; previous active becomes inactive.
 * Old target tracks remain on their source tracks.
 */
export function activateSourceTrack(project, sourceTrackId) {
  const target = project.sourceTracks.find((track) => track.id === sourceTrackId);
  if (!target) {
    throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Source track not found");
  }
  return {
    ...project,
    activeSourceTrackId: sourceTrackId,
    sourceTracks: project.sourceTracks.map((track) => ({
      ...track,
      isActive: track.id === sourceTrackId,
    })),
    updatedAt: new Date().toISOString().replace("T", " ").slice(0, 16),
  };
}
