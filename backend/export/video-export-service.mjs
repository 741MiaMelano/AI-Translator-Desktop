import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { runSubtitleVideoExport } from "./media-export.mjs";

const VIDEO_MODES = new Set(["soft_subtitle", "burn_ass"]);

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizePart(value, fallback) {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || fallback;
}

function resolveRecordedPath(containerDir, recordedPath) {
  if (isAbsolute(recordedPath)) return recordedPath;
  const absolute = resolve(containerDir, ...String(recordedPath).split("/"));
  const escaped = relative(resolve(containerDir), absolute);
  if (escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(escaped)) {
    throw serviceError("INVALID_INPUT", "Recorded subtitle path escapes the project");
  }
  return absolute;
}

function outputName(project, record, mode, operationId) {
  const stem = sanitizePart(project.title, "project");
  const language = sanitizePart(record.targetLanguageCode, "und");
  const suffix = mode === "soft_subtitle" ? "soft" : "burned";
  const unique = createHash("sha256").update(operationId).digest("hex").slice(0, 10);
  return `${stem}-${language}-${suffix}-${unique}.mkv`;
}

export function createVideoExportService({
  getProjectRepository,
  resolveMediaPath,
  resolveFfmpegArtifacts,
  runProcess,
  cancelProcess = null,
  selectOutputFile = null,
  revealOutputFile = null,
  now = () => new Date(),
}) {
  if (
    typeof getProjectRepository !== "function"
    || typeof resolveMediaPath !== "function"
    || typeof resolveFfmpegArtifacts !== "function"
    || typeof runProcess !== "function"
  ) {
    throw serviceError("INVALID_INPUT", "Video export service dependencies are required");
  }

  return {
    async exportVideo({ projectId, subtitleExportRecordId, mode, operationId }) {
      if (!VIDEO_MODES.has(mode) || typeof operationId !== "string" || operationId.length < 1) {
        throw serviceError("INVALID_INPUT", "Video export request is invalid");
      }
      const repo = getProjectRepository(projectId);
      const project = repo.loadProject();
      if (!project) throw serviceError("NOT_FOUND", "Project not found");
      const subtitleRecord = repo.listExportRecords().find(
        (record) => record.id === subtitleExportRecordId
          && ["target", "bilingual"].includes(record.exportKind),
      );
      if (!subtitleRecord) throw serviceError("NOT_FOUND", "Subtitle export record not found");
      const subtitlePath = resolveRecordedPath(repo.containerDir, subtitleRecord.path);
      if (!existsSync(subtitlePath)) throw serviceError("NOT_FOUND", "Exported subtitle file is missing");
      const mediaPath = resolveMediaPath(projectId);
      if (!mediaPath || !existsSync(mediaPath)) throw serviceError("NOT_FOUND", "Media source must be relinked first");
      const artifacts = resolveFfmpegArtifacts();
      const suggestedName = outputName(project, subtitleRecord, mode, operationId);
      const selection = selectOutputFile
        ? await selectOutputFile({ suggestedName })
        : { canceled: false, filePath: join(repo.containerDir, "exports", suggestedName) };
      if (selection?.canceled) return { ok: true, canceled: true };
      const outputPath = selection?.filePath;
      if (typeof outputPath !== "string" || !isAbsolute(outputPath)) {
        throw serviceError("INVALID_INPUT", "Video export destination must be absolute");
      }
      if (existsSync(outputPath)) throw serviceError("CONFLICT", "Video export output already exists");

      await runSubtitleVideoExport({
        mode,
        ffmpegPath: artifacts.ffmpegPath,
        mediaPath,
        subtitlePath,
        outputPath,
        languageCode: subtitleRecord.targetLanguageCode,
        operationId,
        runProcess,
      });
      const createdAt = now().toISOString();
      const fileName = basename(outputPath);
      const destinationKind = selectOutputFile ? "external" : "project";
      const exportRecord = {
        id: `export-${createHash("sha256").update(`${projectId}:${mode}:${operationId}`).digest("hex").slice(0, 16)}`,
        exportKind: mode === "soft_subtitle" ? "soft_subtitle" : "burned_video",
        targetLanguageCode: subtitleRecord.targetLanguageCode,
        format: "matroska",
        path: destinationKind === "external" ? outputPath : `exports/${fileName}`,
        createdAt,
        sourceTrackId: subtitleRecord.sourceTrackId,
        targetTrackId: subtitleRecord.targetTrackId,
        trackStatus: subtitleRecord.trackStatus,
        deliveryStatus: subtitleRecord.deliveryStatus,
        destinationKind,
      };
      repo.appendExportRecord(exportRecord);
      try {
        revealOutputFile?.(outputPath);
      } catch {
        // The file is already safe on disk; Explorer failing to open must not turn export into a failure.
      }
      return {
        ok: true,
        canceled: false,
        exportRecordId: exportRecord.id,
        fileName,
        sourceSubtitleFileName: basename(subtitlePath),
        deliveryStatus: exportRecord.deliveryStatus,
      };
    },
    cancel({ operationId }) {
      return cancelProcess ? cancelProcess(operationId) : false;
    },
  };
}
