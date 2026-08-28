import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseSrtTimestamp } from "./time.mjs";
import { serializeNormalized } from "./parse.mjs";

function sanitizeFileName(name) {
  return String(name || "export")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "export";
}

function uniqueExportPath(exportsDir, baseName) {
  const safe = sanitizeFileName(baseName);
  let candidate = safe;
  let counter = 2;
  while (existsSync(join(exportsDir, candidate))) {
    const dot = safe.lastIndexOf(".");
    if (dot > 0) {
      candidate = `${safe.slice(0, dot)}-${counter}${safe.slice(dot)}`;
    } else {
      candidate = `${safe}-${counter}`;
    }
    counter += 1;
  }
  return candidate;
}

function activeSourceTrack(project) {
  return project.sourceTracks.find((track) => track.id === project.activeSourceTrackId && track.isActive)
    || project.sourceTracks.find((track) => track.isActive)
    || null;
}

function displaySourceText(segment) {
  return segment.sourceText.manual
    ?? segment.sourceText.normalized
    ?? segment.sourceText.original
    ?? "";
}

function cuesFromProject(project) {
  const track = activeSourceTrack(project);
  if (!track) {
    throw new Error("Active source track is missing");
  }
  return track.segments.map((segment) => {
    const startMs = parseSrtTimestamp(segment.start);
    const endMs = parseSrtTimestamp(segment.end);
    if (startMs === null || endMs === null) {
      throw new Error("Segment timestamps are invalid");
    }
    return {
      startMs,
      endMs,
      text: displaySourceText(segment),
    };
  });
}

export function exportSourceSubtitle({
  project,
  containerDir,
  mode,
  format,
  destinationPath,
}) {
  const track = activeSourceTrack(project);
  if (!track) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Active source track is missing",
      },
    };
  }

  if (destinationPath !== undefined && (typeof destinationPath !== "string" || !isAbsolute(destinationPath))) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Export destination must be absolute" } };
  }
  const exportsDir = destinationPath ? dirname(destinationPath) : join(containerDir, "exports");
  mkdirSync(exportsDir, { recursive: true });
  const warnings = [];
  let outputBytes;
  let outputFormat;
  let baseName;

  if (mode === "raw") {
    const relativePath = project.sourceProjectRelativePath;
    if (!relativePath) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Raw subtitle asset is missing",
        },
      };
    }
    const rawPath = join(containerDir, ...relativePath.split("/"));
    if (!existsSync(rawPath)) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Raw subtitle asset file was not found",
        },
      };
    }
    outputBytes = readFileSync(rawPath);
    outputFormat = project.sourceProbeSummary?.subtitleFormat || "raw";
    baseName = project.sourceFileName || `source.${outputFormat}`;
  } else {
    outputFormat = format;
    if (project.sourceProbeSummary?.subtitleFormat === "vtt" || project.sourceProbeSummary?.subtitleFormat === "ass" || project.sourceProbeSummary?.subtitleFormat === "ssa") {
      warnings.push("标准化导出可能丢失只存在于原始文件里的排版结构");
    }
    const cues = cuesFromProject(project);
    const text = serializeNormalized({ format: outputFormat, cues });
    outputBytes = Buffer.from(text, "utf8");
    const stem = sanitizeFileName((project.sourceFileName || "source").replace(/\.[^.]+$/, ""));
    baseName = `${stem}.${outputFormat}`;
  }

  const fileName = destinationPath ? basename(destinationPath) : uniqueExportPath(exportsDir, baseName);
  const absolutePath = destinationPath ?? join(exportsDir, fileName);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, outputBytes);

  const exportRecordId = `export-${createHash("sha1").update(`${project.id}:${fileName}:${Date.now()}`).digest("hex").slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  return {
    ok: true,
    exportRecord: {
      id: exportRecordId,
      exportKind: "source",
      targetLanguageCode: null,
      format: String(outputFormat),
      path: destinationPath ? absolutePath : `exports/${fileName}`,
      createdAt,
      sourceTrackId: track.id,
      targetTrackId: null,
      destinationKind: destinationPath ? "external" : "project",
    },
    fileName,
    format: String(outputFormat),
    warnings,
  };
}
