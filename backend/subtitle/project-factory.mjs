import { createHash, randomUUID } from "node:crypto";
import { parseSubtitleBytes, rawAssetRelativePath, segmentsFromParsed } from "./parse.mjs";

function nowStamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function titleFromFileName(fileName) {
  const base = String(fileName || "subtitle").split(/[/\\]/).pop() || "subtitle";
  return base.replace(/\.[^.]+$/, "") || "subtitle";
}

function emptyTargetText() {
  return {
    model: "",
    postProcessed: "",
    qaFlags: [],
  };
}

export function buildImportedSubtitleProject({
  fileName,
  bytes,
  encoding,
  defaults,
}) {
  const parsed = parseSubtitleBytes({ fileName, bytes, encoding });
  if (!parsed.ok) {
    return parsed;
  }

  const projectId = `project-${randomUUID()}`;
  const sourceTrackId = `source-${createHash("sha1").update(`${projectId}:source`).digest("hex").slice(0, 12)}`;
  const stamp = nowStamp();
  const targetLanguages = defaults?.targetLanguages?.length
    ? defaults.targetLanguages
    : ["简体中文"];
  const segments = segmentsFromParsed(parsed, {
    idPrefix: "cue",
    sourceLanguage: defaults?.sourceLanguage || "auto",
  }).map((segment) => ({
    ...segment,
    targetTexts: Object.fromEntries(targetLanguages.map((language) => [language, emptyTargetText()])),
  }));

  const targetTracks = targetLanguages.map((language, index) => ({
    id: `target-${language}-${index + 1}`,
    languageCode: language,
    languageLabel: language,
    status: "draft",
    isActive: true,
    qaIssues: [],
    snapshotIds: [],
    deliveryLabel: "未开跑",
    lastHumanAction: "imported",
  }));

  const project = {
    id: projectId,
    title: titleFromFileName(fileName),
    sourceFileName: String(fileName).split(/[/\\]/).pop(),
    mediaKind: "subtitle",
    noSourceMedia: true,
    lifecycle: "draft",
    createdAt: stamp,
    updatedAt: stamp,
    activeSourceTrackId: sourceTrackId,
    pendingConfirmations: [],
    notes: [],
    config: {
      sourceLanguage: defaults?.sourceLanguage || "auto",
      targetLanguages,
      provider: defaults?.provider || "OpenAI",
      model: defaults?.model || "GPT-4.1",
      glossary: defaults?.glossary || "default-glossary",
      styleGuide: defaults?.styleGuide || "default-style",
      outputFormat: defaults?.outputFormat || "SRT",
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [
      {
        id: sourceTrackId,
        label: "导入字幕主源轨",
        kind: "external_subtitle",
        languageState: "pending",
        defaultLanguage: defaults?.sourceLanguage || "auto",
        isActive: true,
        summary: `${segments.length} cues · ${parsed.format.toUpperCase()} · ${parsed.encoding}`,
        rawAssetRelativePath: rawAssetRelativePath(parsed.format),
        segments,
        targetTracks,
      },
    ],
    recentRunIds: [],
    sourceProjectRelativePath: rawAssetRelativePath(parsed.format),
    sourceProbeSummary: {
      subtitleFormat: parsed.format,
      encoding: parsed.encoding,
      newline: parsed.newline,
      warnings: parsed.warnings,
      formatSummary: parsed.formatSummary,
    },
  };

  return {
    ok: true,
    project,
    warnings: parsed.warnings,
    rawRelativePath: project.sourceProjectRelativePath,
    rawBytes: bytes,
  };
}
