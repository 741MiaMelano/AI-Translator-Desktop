import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getEffectiveTargetText } from "../../shared/target-text-state.mjs";
import { parseSrtTimestamp } from "../subtitle/time.mjs";
import { serializeNormalized } from "../subtitle/parse.mjs";

const EXPORT_KINDS = new Set(["source", "target", "bilingual"]);
const FORMATS = new Set(["srt", "vtt", "ass"]);
const APPROVED_STATUSES = new Set(["approved", "exported"]);

function exportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeFilePart(value, fallback) {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || fallback;
}

function activeSourceTrack(project) {
  return project?.sourceTracks?.find(
    (track) => track.id === project.activeSourceTrackId && track.isActive !== false,
  ) ?? project?.sourceTracks?.find((track) => track.isActive) ?? null;
}

function activeTargetTrack(sourceTrack, languageCode) {
  return sourceTrack?.targetTracks?.find(
    (track) => track.languageCode === languageCode
      && track.isActive !== false
      && track.role !== "candidate"
      && !track.trashedAt,
  ) ?? null;
}

function hasHardQaErrors(track) {
  return track?.qaIssues?.some((issue) => issue?.severity === "error") === true;
}

function sourceText(segment) {
  return segment?.sourceText?.manual
    ?? segment?.sourceText?.normalized
    ?? segment?.sourceText?.original
    ?? "";
}

function assStyleSet(payload) {
  if (!payload) return undefined;
  const orderedRoles = payload.bilingualLayout === "target_top_source_bottom"
    ? ["Target", "Source"]
    : ["Source", "Target"];
  const styles = {
    Target: { ...payload.primary, marginV: 29 },
    Source: { ...payload.secondary, marginV: 29 },
  };
  for (const position of ["top", "center", "bottom"]) {
    const names = orderedRoles.filter((name) => styles[name].position === position);
    if (names.length !== 2) continue;
    if (position === "top") {
      styles[names[0]].marginV = 29;
      styles[names[1]].marginV = 41 + styles[names[0]].fontSizePx;
    } else if (position === "bottom") {
      styles[names[1]].marginV = 29;
      styles[names[0]].marginV = 41 + styles[names[1]].fontSizePx;
    } else {
      styles[names[0]].alignment = 8;
      styles[names[0]].marginV = 320;
      styles[names[1]].alignment = 2;
      styles[names[1]].marginV = 320;
    }
  }
  return styles;
}

function styledAssCues(base, request, source, target, payload) {
  if (!payload || request.format !== "ass") return [{ ...base, text: request.exportKind === "source"
    ? source
    : request.exportKind === "target" ? target : `${source}\n${target}` }];
  if (request.exportKind === "source") return [{ ...base, style: "Source", text: source }];
  if (request.exportKind === "target" || payload.bilingualLayout === "target_only") {
    return [{ ...base, style: "Target", text: target }];
  }
  const ordered = payload.bilingualLayout === "target_top_source_bottom"
    ? [["Target", target], ["Source", source]]
    : [["Source", source], ["Target", target]];
  return ordered.map(([style, text]) => ({ ...base, style, text }));
}

function cuesFor(sourceTrack, request, targetTrack, subtitleStyle) {
  return sourceTrack.segments.flatMap((segment) => {
    const startMs = parseSrtTimestamp(segment.start);
    const endMs = parseSrtTimestamp(segment.end);
    if (startMs === null || endMs === null || endMs <= startMs) {
      throw exportError("INVALID_INPUT", `Invalid timeline segment: ${segment.id}`);
    }
    const targetLayer = request.exportKind === "source"
      ? null
      : segment.targetTexts?.[targetTrack.languageCode];
    if (typeof targetLayer?.manual === "string" && targetLayer.manual.trim().length === 0) {
      return [];
    }
    const target = request.exportKind === "source"
      ? null
      : getEffectiveTargetText(targetLayer);
    if (request.exportKind !== "source" && target === "") {
      throw exportError("INVALID_INPUT", `Target text is missing: ${segment.id}`);
    }
    const base = {
      startMs,
      endMs,
    };
    return styledAssCues(base, request, sourceText(segment), target, subtitleStyle);
  });
}

function normalizeRequest(request, index) {
  if (!request || typeof request !== "object") {
    throw exportError("INVALID_INPUT", `Export request ${index + 1} is invalid`);
  }
  if (!EXPORT_KINDS.has(request.exportKind)) {
    throw exportError("INVALID_INPUT", `Unsupported export kind: ${String(request.exportKind)}`);
  }
  if (!FORMATS.has(request.format)) {
    throw exportError("INVALID_INPUT", `Unsupported subtitle format: ${String(request.format)}`);
  }
  const targetLanguageCode = request.exportKind === "source"
    ? null
    : String(request.targetLanguageCode || "").trim();
  if (request.exportKind !== "source" && targetLanguageCode.length === 0) {
    throw exportError("INVALID_INPUT", "Target language is required");
  }
  return {
    ...request,
    id: typeof request.id === "string" && request.id.length > 0
      ? request.id
      : `export-${index + 1}`,
    targetLanguageCode,
  };
}

function baseFileName(project, request, deliveryStatus) {
  const stem = sanitizeFilePart(project.title, "project");
  const language = request.targetLanguageCode
    ? `-${sanitizeFilePart(request.targetLanguageCode, "target")}`
    : "-source";
  const view = request.exportKind === "bilingual" ? "-bilingual" : "";
  const draft = deliveryStatus === "draft" ? "-draft" : "";
  return `${stem}${language}${view}${draft}.${request.format}`;
}

function withVersion(fileName, version) {
  if (version === 1) return fileName;
  const dot = fileName.lastIndexOf(".");
  return dot > 0
    ? `${fileName.slice(0, dot)}-${version}${fileName.slice(dot)}`
    : `${fileName}-${version}`;
}

function writeUniqueFile({ destinationDir, baseName, bytes, writeFile }) {
  for (let version = 1; version <= 10_000; version += 1) {
    const fileName = withVersion(baseName, version);
    const absolutePath = join(destinationDir, fileName);
    try {
      writeFile(absolutePath, bytes, { flag: "wx" });
      return { fileName, absolutePath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw exportError("CONFLICT", "Export version limit was exceeded");
}

function recordId(projectId, requestId, absolutePath, createdAt) {
  return `export-${createHash("sha256")
    .update(`${projectId}:${requestId}:${absolutePath}:${createdAt}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function exportOne({ project, sourceTrack, request, destinationDir, destinationKind, now, writeFile }) {
  const targetTrack = request.exportKind === "source"
    ? null
    : activeTargetTrack(sourceTrack, request.targetLanguageCode);
  if (request.exportKind !== "source" && !targetTrack) {
    throw exportError("NOT_FOUND", `Active target track not found: ${request.targetLanguageCode}`);
  }
  if (targetTrack && hasHardQaErrors(targetTrack)) {
    throw exportError("QA_BLOCKED", `Target track has hard QA errors: ${request.targetLanguageCode}`);
  }

  const trackStatus = targetTrack?.status ?? "source";
  const deliveryStatus = targetTrack && !APPROVED_STATUSES.has(trackStatus) ? "draft" : "approved";
  const output = Buffer.from(
    serializeNormalized({
      format: request.format,
      cues: cuesFor(sourceTrack, request, targetTrack, project.config?.subtitleStyle),
      assStyles: assStyleSet(project.config?.subtitleStyle),
    }),
    "utf8",
  );
  const { fileName, absolutePath } = writeUniqueFile({
    destinationDir,
    baseName: baseFileName(project, request, deliveryStatus),
    bytes: output,
    writeFile,
  });
  const createdAt = now().toISOString();
  const recordPath = destinationKind === "project"
    ? `exports/${fileName}`
    : absolutePath;
  return {
    request,
    fileName,
    warnings: deliveryStatus === "draft"
      ? ["Draft or review track exported; this is not an approved delivery"]
      : [],
    exportRecord: {
      id: recordId(project.id, request.id, absolutePath, createdAt),
      exportKind: request.exportKind,
      targetLanguageCode: request.targetLanguageCode,
      format: request.format,
      path: recordPath,
      createdAt,
      sourceTrackId: sourceTrack.id,
      targetTrackId: targetTrack?.id ?? null,
      trackStatus,
      deliveryStatus,
      destinationKind,
    },
  };
}

export function exportSubtitleMatrix({
  project,
  containerDir,
  destinationDir,
  requests,
  now = () => new Date(),
  writeFile = writeFileSync,
}) {
  if (!project || !isAbsolute(containerDir)) {
    throw exportError("INVALID_INPUT", "Project and absolute container directory are required");
  }
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > 100) {
    throw exportError("INVALID_INPUT", "Export requests must contain 1 to 100 items");
  }
  if (destinationDir !== undefined && !isAbsolute(destinationDir)) {
    throw exportError("INVALID_INPUT", "External export directory must be absolute");
  }
  const sourceTrack = activeSourceTrack(project);
  if (!sourceTrack || sourceTrack.trashedAt) {
    throw exportError("INVALID_INPUT", "Active source track is missing");
  }
  const resolvedDestination = destinationDir ?? join(containerDir, "exports");
  const destinationKind = destinationDir ? "external" : "project";
  mkdirSync(resolvedDestination, { recursive: true });

  const succeeded = [];
  const failed = [];
  requests.forEach((rawRequest, index) => {
    let request = rawRequest;
    try {
      request = normalizeRequest(rawRequest, index);
      succeeded.push(exportOne({
        project,
        sourceTrack,
        request,
        destinationDir: resolvedDestination,
        destinationKind,
        now,
        writeFile,
      }));
    } catch (error) {
      failed.push({
        request,
        error: {
          code: error?.code ?? "EXPORT_FAILED",
          message: error?.message ?? "Subtitle export failed",
          retryable: !["INVALID_INPUT", "QA_BLOCKED", "NOT_FOUND"].includes(error?.code),
        },
      });
    }
  });

  return {
    ok: failed.length === 0,
    partial: succeeded.length > 0 && failed.length > 0,
    succeeded,
    failed,
  };
}

export function retryFailedExportRequests(summary) {
  if (!summary || !Array.isArray(summary.failed)) return [];
  return summary.failed.map((item) => item.request);
}
