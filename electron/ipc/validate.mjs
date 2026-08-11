import {
  TRANSLATION_PROVIDER_CATALOG,
  allowsFreeFormModelId,
  isSafeProviderModelId,
} from "../../shared/provider-registry.mjs";
import { validateMediaProbe } from "../../shared/media-probe.mjs";
import { ASR_LANGUAGE_DETECTION_CONFIG } from "../../shared/asr-language-config.mjs";
import { ASR_MODEL_IDS, isAsrModelId } from "../../shared/asr-model-ids.mjs";
import { normalizeAsrVadSettings } from "../../shared/asr-vad-config.mjs";
import {
  normalizeResourceWrite,
  normalizeSubtitleStylePayload,
} from "../../shared/resource-library.mjs";

const ALLOWED_METHODS = new Set([
  "project.create",
  "project.save",
  "project.open",
  "project.runtimeState",
  "project.listRecent",
  "project.package",
  "project.deletePermanently",
  "resource.list",
  "resource.save",
  "resource.delete",
  "resource.snapshot.list",
  "resource.snapshot.refresh",
  "subtitle.import",
  "subtitle.exportSource",
  "subtitle.exportMatrix",
  "subtitle.exportApprovedBatch",
  "subtitle.videoExport",
  "audio.separation.capability",
  "audio.separation.start",
  "window.control",
  "tasks.subscribe",
  "tasks.control",
  "credential.save",
  "credential.delete",
  "credential.status",
  "capability.status",
  "settings.get",
  "settings.selectDirectory",
  "settings.selectModelStorageDestination",
  "settings.transferModelStorage",
  "settings.save",
  "settings.reset",
  "downloads.status",
  "downloads.probeSources",
  "backup.app.create",
  "backup.restore.select",
  "backup.restore.apply",
  "diagnostics.preview",
  "diagnostics.export",
  "provider.testConnection",
  "provider.listModels",
  "provider.runtimeState",
  "asr.capability",
  "asr.model.install",
  "asr.model.import",
  "asr.model.uninstall",
  "asr.model.cancel",
  "asr.runtime.install",
  "asr.runtime.import",
  "asr.runtime.uninstall",
  "asr.runtime.cancel",
  "asr.songClassifier.install",
  "asr.songClassifier.uninstall",
  "asr.songClassifier.cancel",
  "asr.device.status",
  "asr.device.preference",
  "asr.device.detect",
  "asr.device.cancel",
  "asr.project.status",
  "asr.transcribe",
  "asr.segment",
  "asr.language.detect",
  "asr.language.update",
  "asr.cancel",
  "asr.info.open",
  "translation.start",
  "batch.createSession",
  "batch.discardSession",
  "batch.commitSession",
  "batch.start",
  "media.selectSource",
  "media.probe",
  "media.waveform",
  "media.selectStreams",
  "media.extractSubtitle",
  "media.extractAudio",
  "media.activateSourceTrack",
  "media.relink",
  "media.previewUrl",
  "media.cancel",
]);
// 与 shared/provider-registry.mjs 的 supportedTransports、src/contracts/desktop-api.ts
// 的 ProviderTransportMode 必须保持一致。"messages" 为 Anthropic 官方协议。
const PROVIDER_TRANSPORT_MODES = new Set(["responses", "chat_completions", "messages"]);
const ASR_MODEL_ID_SET = new Set(ASR_MODEL_IDS);
const MAX_CREDENTIAL_SECRET_CHARS = 8 * 1024;
const MAX_PROVIDER_NAME_CHARS = 64;
const MAX_PROVIDER_BASE_URL_CHARS = 2048;
const MAX_PROVIDER_TIMEOUT_MS = 60_000;

export function isSafeCredentialId(credentialId) {
  return (
    typeof credentialId === "string" &&
    credentialId.length > 0 &&
    credentialId.length <= 128 &&
    credentialId !== "." &&
    credentialId !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(credentialId)
  );
}

const WINDOW_ACTIONS = new Set(["minimize", "maximizeOrRestore", "close"]);
const TASK_CONTROL_ACTIONS = new Set(["pause", "resume", "cancel", "retry", "prioritize"]);
const MEDIA_KINDS = new Set(["video", "audio", "subtitle"]);
const PROJECT_LIFECYCLES = new Set(["draft", "ready", "processing", "needs_review", "completed"]);
const SOURCE_TRACK_KINDS = new Set(["embedded_subtitle", "asr", "external_subtitle"]);
const SOURCE_LANGUAGE_STATES = new Set(["known", "pending", "multilingual"]);
const TARGET_TRACK_STATUSES = new Set(["draft", "in_review", "approved", "exported"]);
const QA_SEVERITIES = new Set(["warning", "error"]);
const SUBTITLE_ENCODINGS = new Set(["utf-8", "utf-16le", "utf-16be", "gbk", "shift_jis"]);
const SUBTITLE_EXPORT_MODES = new Set(["raw", "normalized"]);
const SUBTITLE_NORMALIZED_FORMATS = new Set(["srt", "vtt", "ass"]);
export const IPC_PROJECT_VALUES = Object.freeze({
  targetLanguages: ["简体中文", "zh-CN", "英语", "en-US", "日语", "ja-JP"],
  providerModels: Object.fromEntries(
    TRANSLATION_PROVIDER_CATALOG.map((provider) => [
      provider.name,
      provider.models.map((model) => model.label),
    ]),
  ),
});
const TARGET_LANGUAGE_VALUES = new Set(IPC_PROJECT_VALUES.targetLanguages);
const PROVIDER_MODELS = new Map(
  Object.entries(IPC_PROJECT_VALUES.providerModels).map(([provider, models]) => [
    provider,
    new Set(models),
  ]),
);
/**
 * 兼容型 / Anthropic 服务商的模型列表来自运行时「拉取模型」，
 * PROVIDER_MODELS 只是内置兜底，不能当成封闭 allowlist，
 * 否则用户拉取到的新型号在 project.save 会被 IPC 拒掉（前端选得到、后端存不进）。
 */
const FREE_FORM_MODEL_PROVIDER_NAMES = new Set(
  TRANSLATION_PROVIDER_CATALOG
    .filter((provider) => allowsFreeFormModelId(provider.profile))
    .map((provider) => provider.name),
);

function isAllowedProviderModel(provider, model) {
  const builtIn = PROVIDER_MODELS.get(provider);
  if (!builtIn) return false;
  if (builtIn.has(model)) return true;
  return FREE_FORM_MODEL_PROVIDER_NAMES.has(provider) && isSafeProviderModelId(model);
}
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const PROJECT_DEFAULT_KEYS = new Set([
  "sourceLanguage",
  "targetLanguages",
  "provider",
  "model",
  "glossary",
  "styleGuide",
  "outputFormat",
]);

export function isSafeProjectId(projectId) {
  return (
    typeof projectId === "string" &&
    projectId !== "." &&
    projectId !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(projectId)
  );
}

export function measureJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isBinaryPayload(value) {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255))
  );
}

export function getBinaryByteLength(value) {
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) return value.length;
  return -1;
}

function isSafeImportFileName(fileName) {
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 255) {
    return false;
  }
  if (fileName !== fileName.normalize("NFC")) return false;
  if (fileName.includes("\0")) return false;
  if (/[\\/]/.test(fileName)) return false;
  if (fileName === "." || fileName === "..") return false;
  return true;
}

function measureRequestBytes(method, request) {
  if (method === "subtitle.import") {
    const fileNameBytes = Buffer.byteLength(String(request?.fileName ?? ""), "utf8");
    const dataBytes = getBinaryByteLength(request?.bytes);
    if (dataBytes < 0) return Number.POSITIVE_INFINITY;
    return fileNameBytes + dataBytes + 64;
  }
  return measureJsonBytes(request);
}

function invalid(message, details) {
  return {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message,
      ...(details ? { details } : {}),
    },
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${field} must be a non-empty string`);
  }
  return null;
}

function assertStringArray(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    return invalid(`${field} must be ${nonEmpty ? "a non-empty " : "an "}array`);
  }
  if (value.some((item) => typeof item !== "string")) {
    return invalid(`${field} must contain only strings`);
  }
  return null;
}

function assertOptionalString(value, field) {
  return value === undefined || typeof value === "string"
    ? null
    : invalid(`${field} must be a string when present`);
}

function parseSubtitleTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match.map(Number);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function validateQaIssue(issue, field) {
  if (!isPlainObject(issue)) return invalid(`${field} must be an object`);
  for (const key of ["id", "label", "detail"]) {
    const error = assertString(issue[key], `${field}.${key}`);
    if (error) return error;
  }
  return QA_SEVERITIES.has(issue.severity)
    ? null
    : invalid(`${field}.severity is invalid`);
}

function validateTargetText(targetText, field) {
  if (!isPlainObject(targetText)) return invalid(`${field} must be an object`);
  for (const key of ["model", "postProcessed"]) {
    if (typeof targetText[key] !== "string") return invalid(`${field}.${key} must be a string`);
  }
  for (const key of ["manual", "previousManual"]) {
    const error = assertOptionalString(targetText[key], `${field}.${key}`);
    if (error) return error;
  }
  if (targetText.locked !== undefined && typeof targetText.locked !== "boolean") {
    return invalid(`${field}.locked must be boolean when present`);
  }
  if (targetText.stale !== undefined && typeof targetText.stale !== "boolean") {
    return invalid(`${field}.stale must be boolean when present`);
  }
  if (targetText.origin !== undefined && typeof targetText.origin !== "string") {
    return invalid(`${field}.origin must be a string when present`);
  }
  return assertStringArray(targetText.qaFlags, `${field}.qaFlags`);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function validateAppSettings(settings) {
  const fields = ["schemaVersion", "startupPage", "translationProvider", "translationModel", "asrDefaultModelId", "asrVad", "asrVocalSeparation", "asrSongHandling", "cachePath", "modelPath", "backupPath", "downloadSource", "customDownloadUrl", "notifications"];
  if (!hasExactKeys(settings, fields) || settings.schemaVersion !== 1) return invalid("settings shape is invalid");
  if (!["resume", "start", "projects"].includes(settings.startupPage)) return invalid("startupPage is invalid");
  if ((settings.translationProvider === null) !== (settings.translationModel === null)) return invalid("translation selection is invalid");
  if (settings.translationProvider !== null && !isAllowedProviderModel(settings.translationProvider, settings.translationModel)) {
    return invalid("translation selection is invalid");
  }
  if (!isAsrModelId(settings.asrDefaultModelId)) return invalid("asrDefaultModelId is invalid");
  if (settings.asrVocalSeparation !== "off" && settings.asrVocalSeparation !== "on") return invalid("asrVocalSeparation is invalid");
  if (settings.asrSongHandling !== "preserve" && settings.asrSongHandling !== "filter") return invalid("asrSongHandling is invalid");
  try {
    normalizeAsrVadSettings(settings.asrVad);
  } catch {
    return invalid("asrVad is invalid");
  }
  if (!["official", "mirror", "custom"].includes(settings.downloadSource)) return invalid("downloadSource is invalid");
  if (typeof settings.customDownloadUrl !== "string" || settings.customDownloadUrl.length > 2_048) return invalid("customDownloadUrl is invalid");
  for (const key of ["cachePath", "modelPath", "backupPath"]) {
    if (typeof settings[key] !== "string" || settings[key].length === 0 || settings[key].length > 1_024) return invalid(`${key} is invalid`);
  }
  const notifications = ["taskDone", "error", "release", "system"];
  if (!hasExactKeys(settings.notifications, notifications) || notifications.some((key) => typeof settings.notifications[key] !== "boolean")) {
    return invalid("notification settings are invalid");
  }
  return null;
}

function validateProjectDefaults(defaults) {
  if (defaults === undefined) return null;
  if (!isPlainObject(defaults)) return invalid("defaults must be an object when present");
  // 未知键一律拒绝：已删除的字段（如 budgetUsd）不能再从 IPC 溜进来
  const unknownKey = Object.keys(defaults).find((key) => !PROJECT_DEFAULT_KEYS.has(key));
  if (unknownKey) return invalid(`defaults.${unknownKey} is not a supported field`);
  if (defaults.targetLanguages !== undefined) {
    const languagesError = assertStringArray(defaults.targetLanguages, "defaults.targetLanguages", {
      nonEmpty: true,
    });
    if (languagesError) return languagesError;
    if (defaults.targetLanguages.some((language) => !TARGET_LANGUAGE_VALUES.has(language))) {
      return invalid("defaults.targetLanguages contains an unsupported language");
    }
    if (new Set(defaults.targetLanguages).size !== defaults.targetLanguages.length) {
      return invalid("defaults.targetLanguages must be unique");
    }
  }
  for (const field of ["sourceLanguage", "provider", "model", "glossary", "styleGuide", "outputFormat"]) {
    if (defaults[field] !== undefined) {
      const fieldError = assertString(defaults[field], `defaults.${field}`);
      if (fieldError) return fieldError;
    }
  }
  const provider = defaults.provider ?? "OpenAI";
  const model = defaults.model ?? "GPT-4.1";
  if (!isAllowedProviderModel(provider, model)) {
    return invalid("defaults provider and model combination is invalid");
  }
  return null;
}

function isSafeOperationId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function isAbsoluteBatchFilePath(value) {
  return typeof value === "string"
    && value.length > 2
    && value.length <= 32_767
    && value === value.normalize("NFC")
    && !value.includes("\0")
    && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}

function isSafeArtifactRelativePath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("artifacts/") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("..")
  );
}

function validateEditorHistory(history, segmentIds) {
  if (!isPlainObject(history)) return invalid("project.editorHistory must be an object");
  for (const stackName of ["undoStack", "redoStack"]) {
    const stack = history[stackName];
    if (!Array.isArray(stack)) return invalid(`project.editorHistory.${stackName} must be an array`);
    for (let index = 0; index < stack.length; index += 1) {
      const entry = stack[index];
      const field = `project.editorHistory.${stackName}[${index}]`;
      if (!isPlainObject(entry)) return invalid(`${field} must be an object`);
      if (entry.kind === "source_manual") {
        if (typeof entry.segmentId !== "string" || !segmentIds.has(entry.segmentId)) {
          return invalid(`${field}.segmentId is invalid`);
        }
        for (const key of ["beforeManual", "afterManual"]) {
          if (entry[key] !== null && typeof entry[key] !== "string") {
            return invalid(`${field}.${key} must be string or null`);
          }
        }
        continue;
      }
      if (entry.kind === "timeline") {
        if (
          !Number.isSafeInteger(entry.index)
          || entry.index < 0
          || !Array.isArray(entry.beforeSegments)
          || !Array.isArray(entry.afterSegments)
          || entry.beforeSegments.length < 1
          || entry.beforeSegments.length > 2
          || entry.afterSegments.length < 1
          || entry.afterSegments.length > 2
        ) {
          return invalid(`${field} timeline patch is invalid`);
        }
        for (const side of ["beforeSegments", "afterSegments"]) {
          for (let segmentIndex = 0; segmentIndex < entry[side].length; segmentIndex += 1) {
            const error = validateSegment(entry[side][segmentIndex], `${field}.${side}[${segmentIndex}]`);
            if (error) return error;
          }
        }
        continue;
      }
      if (entry.kind !== "target_replace" || typeof entry.languageCode !== "string" || !Array.isArray(entry.changes)) {
        return invalid(`${field} is invalid`);
      }
      for (let changeIndex = 0; changeIndex < entry.changes.length; changeIndex += 1) {
        const change = entry.changes[changeIndex];
        const changeField = `${field}.changes[${changeIndex}]`;
        if (!isPlainObject(change) || typeof change.segmentId !== "string" || !segmentIds.has(change.segmentId)) {
          return invalid(`${changeField}.segmentId is invalid`);
        }
        for (const key of ["before", "after"]) {
          const error = validateTargetText(change[key], `${changeField}.${key}`);
          if (error) return error;
        }
      }
    }
  }
  return null;
}

function validateSegment(segment, field) {
  if (!isPlainObject(segment)) return invalid(`${field} must be an object`);
  for (const key of ["id", "sourceLanguage"]) {
    const error = assertString(segment[key], `${field}.${key}`);
    if (error) return error;
  }
  const start = parseSubtitleTimestamp(segment.start);
  const end = parseSubtitleTimestamp(segment.end);
  if (start === null || end === null || end < start) {
    return invalid(`${field} timestamps are invalid`);
  }
  if (!isPlainObject(segment.sourceText)) return invalid(`${field}.sourceText must be an object`);
  for (const key of ["original", "normalized"]) {
    if (typeof segment.sourceText[key] !== "string") {
      return invalid(`${field}.sourceText.${key} must be a string`);
    }
  }
  const manualError = assertOptionalString(segment.sourceText.manual, `${field}.sourceText.manual`);
  if (manualError) return manualError;
  const evidenceFields = [
    "detectedLanguage", "languageConfidence", "languageDetectionMethod",
    "languageDetectionVersion", "languageOverlapStatus",
  ];
  if (evidenceFields.some((key) => Object.hasOwn(segment, key))) {
    if (evidenceFields.some((key) => !Object.hasOwn(segment, key))) {
      return invalid(`${field} language evidence must be complete`);
    }
    const code = /^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/;
    if (!code.test(segment.detectedLanguage)) return invalid(`${field}.detectedLanguage is invalid`);
    if (segment.languageConfidence !== null && (!Number.isFinite(segment.languageConfidence) || segment.languageConfidence < 0 || segment.languageConfidence > 1)) {
      return invalid(`${field}.languageConfidence is invalid`);
    }
    if (
      segment.languageDetectionMethod !== ASR_LANGUAGE_DETECTION_CONFIG.method ||
      segment.languageDetectionVersion !== ASR_LANGUAGE_DETECTION_CONFIG.version ||
      !["none", "overlap_unsupported"].includes(segment.languageOverlapStatus)
    ) {
      return invalid(`${field} language evidence provenance is invalid`);
    }
    if (segment.manualLanguage !== undefined && (segment.manualLanguage === "und" || !code.test(segment.manualLanguage))) {
      return invalid(`${field}.manualLanguage is invalid`);
    }
    const confident = segment.languageOverlapStatus === "none" && segment.detectedLanguage !== "und" &&
      segment.languageConfidence !== null && segment.languageConfidence >= ASR_LANGUAGE_DETECTION_CONFIG.confidenceThreshold;
    if (segment.sourceLanguage !== (segment.manualLanguage ?? (confident ? segment.detectedLanguage : "und"))) {
      return invalid(`${field}.sourceLanguage is not the effective language`);
    }
  } else if (segment.manualLanguage !== undefined) {
    return invalid(`${field}.manualLanguage requires detected evidence`);
  }
  if (!isPlainObject(segment.targetTexts)) return invalid(`${field}.targetTexts must be an object`);
  for (const [languageCode, targetText] of Object.entries(segment.targetTexts)) {
    if (languageCode.length === 0) return invalid(`${field}.targetTexts language is invalid`);
    const error = validateTargetText(targetText, `${field}.targetTexts.${languageCode}`);
    if (error) return error;
  }
  return null;
}

function validateTargetTrack(track, field) {
  if (!isPlainObject(track)) return invalid(`${field} must be an object`);
  for (const key of ["id", "languageCode", "languageLabel", "deliveryLabel", "lastHumanAction"]) {
    const error = assertString(track[key], `${field}.${key}`);
    if (error) return error;
  }
  if (!TARGET_TRACK_STATUSES.has(track.status)) return invalid(`${field}.status is invalid`);
  if (typeof track.isActive !== "boolean") return invalid(`${field}.isActive must be boolean`);
  const trashedError = assertOptionalString(track.trashedAt, `${field}.trashedAt`);
  if (trashedError) return trashedError;
  if (track.trashedAt && track.isActive) return invalid(`${field} trashed target cannot be active`);
  if (track.trashedWithSource !== undefined && typeof track.trashedWithSource !== "boolean") {
    return invalid(`${field}.trashedWithSource must be boolean`);
  }
  if (track.trashedWithSource && !track.trashedAt) {
    return invalid(`${field}.trashedWithSource requires trashedAt`);
  }
  if (track.role !== undefined && track.role !== "active" && track.role !== "candidate") {
    return invalid(`${field}.role is invalid`);
  }
  if (track.role === "candidate" && track.isActive) {
    return invalid(`${field} candidate track cannot be active`);
  }
  if (track.baseTrackId !== undefined && track.baseTrackId !== null && typeof track.baseTrackId !== "string") {
    return invalid(`${field}.baseTrackId is invalid`);
  }
  if (track.candidateTexts !== undefined) {
    if (track.role !== "candidate" || !isPlainObject(track.candidateTexts)) {
      return invalid(`${field}.candidateTexts requires a candidate track`);
    }
    for (const [segmentId, layer] of Object.entries(track.candidateTexts)) {
      const error = validateTargetText(layer, `${field}.candidateTexts.${segmentId}`);
      if (error) return error;
    }
  }
  const snapshotError = assertStringArray(track.snapshotIds, `${field}.snapshotIds`);
  if (snapshotError) return snapshotError;
  if (!Array.isArray(track.qaIssues)) return invalid(`${field}.qaIssues must be an array`);
  for (let index = 0; index < track.qaIssues.length; index += 1) {
    const error = validateQaIssue(track.qaIssues[index], `${field}.qaIssues[${index}]`);
    if (error) return error;
  }
  return null;
}

function validateSourceTrack(track, field, ids) {
  if (!isPlainObject(track)) return invalid(`${field} must be an object`);
  for (const key of ["id", "label", "defaultLanguage"]) {
    const error = assertString(track[key], `${field}.${key}`);
    if (error) return error;
  }
  if (typeof track.summary !== "string") return invalid(`${field}.summary must be a string`);
  if (!SOURCE_TRACK_KINDS.has(track.kind)) return invalid(`${field}.kind is invalid`);
  if (!SOURCE_LANGUAGE_STATES.has(track.languageState)) return invalid(`${field}.languageState is invalid`);
  if (typeof track.isActive !== "boolean") return invalid(`${field}.isActive must be boolean`);
  const trashedError = assertOptionalString(track.trashedAt, `${field}.trashedAt`);
  if (trashedError) return trashedError;
  if (track.trashedAt && track.isActive) return invalid(`${field} trashed source cannot be active`);
  if (track.rawAssetRelativePath !== undefined && !isSafeArtifactRelativePath(track.rawAssetRelativePath)) {
    return invalid(`${field}.rawAssetRelativePath must be a safe project-relative path`);
  }
  if (track.sourceStreamId !== undefined && !/^s:\d+$/.test(track.sourceStreamId)) {
    return invalid(`${field}.sourceStreamId is invalid`);
  }
  if (track.asrRunId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(track.asrRunId)) {
    return invalid(`${field}.asrRunId is invalid`);
  }
  if (
    track.segmentationConfigVersion !== undefined &&
    !/^asr-segmentation-v[A-Za-z0-9._-]{1,64}$/.test(track.segmentationConfigVersion)
  ) {
    return invalid(`${field}.segmentationConfigVersion is invalid`);
  }
  if ((track.asrRunId === undefined) !== (track.segmentationConfigVersion === undefined)) {
    return invalid(`${field} ASR provenance must be paired`);
  }
  if (!Array.isArray(track.segments) || !Array.isArray(track.targetTracks)) {
    return invalid(`${field} segment or target track arrays are invalid`);
  }
  for (let index = 0; index < track.targetTracks.length; index += 1) {
    const target = track.targetTracks[index];
    const error = validateTargetTrack(target, `${field}.targetTracks[${index}]`);
    if (error) return error;
    if (ids.targetTracks.has(target.id)) return invalid("target track ids must be unique");
    ids.targetTracks.add(target.id);
  }
  for (let index = 0; index < track.segments.length; index += 1) {
    const segment = track.segments[index];
    const error = validateSegment(segment, `${field}.segments[${index}]`);
    if (error) return error;
    if (ids.segments.has(segment.id)) return invalid("segment ids must be unique");
    ids.segments.add(segment.id);
  }
  const localTrackIds = new Set(track.targetTracks.map((target) => target.id));
  const localSegmentIds = new Set(track.segments.map((segment) => segment.id));
  for (let index = 0; index < track.targetTracks.length; index += 1) {
    const candidate = track.targetTracks[index];
    if (candidate.role !== "candidate") continue;
    const base = track.targetTracks.find((target) => target.id === candidate.baseTrackId);
    if (!candidate.baseTrackId || !localTrackIds.has(candidate.baseTrackId) || !base?.isActive || base.languageCode !== candidate.languageCode) {
      return invalid(`${field}.targetTracks[${index}].baseTrackId must reference the active same-language track`);
    }
    if (Object.keys(candidate.candidateTexts ?? {}).some((segmentId) => !localSegmentIds.has(segmentId))) {
      return invalid(`${field}.targetTracks[${index}].candidateTexts references an invalid segment`);
    }
  }
  return null;
}

function validateProjectShape(project) {
  if (!isPlainObject(project)) {
    return invalid("project must be an object");
  }
  if (!isSafeProjectId(project.id)) {
    return invalid("project.id is invalid");
  }
  for (const field of ["title", "sourceFileName", "createdAt", "updatedAt"]) {
    const error = assertString(project[field], field);
    if (error) return error;
  }
  if (project.activeSourceTrackId !== null && typeof project.activeSourceTrackId !== "string") {
    return invalid("activeSourceTrackId must be a string or null");
  }
  if (typeof project.activeSourceTrackId === "string") {
    const activeIdError = assertString(project.activeSourceTrackId, "activeSourceTrackId");
    if (activeIdError) return activeIdError;
  }
  if (!MEDIA_KINDS.has(project.mediaKind)) return invalid("mediaKind is invalid");
  if (!PROJECT_LIFECYCLES.has(project.lifecycle)) return invalid("lifecycle is invalid");
  if (typeof project.noSourceMedia !== "boolean") {
    return invalid("noSourceMedia must be boolean");
  }
  for (const field of ["pendingConfirmations", "notes", "recentRunIds"]) {
    const error = assertStringArray(project[field], field);
    if (error) return error;
  }
  if (!isPlainObject(project.config)) {
    return invalid("project.config must be an object");
  }
  for (const field of ["sourceLanguage", "provider", "model", "glossary", "styleGuide", "outputFormat"]) {
    const error = assertString(project.config[field], `project.config.${field}`);
    if (error) return error;
  }
  const targetLanguagesError = assertStringArray(
    project.config.targetLanguages,
    "project.config.targetLanguages",
    { nonEmpty: true },
  );
  if (targetLanguagesError) return targetLanguagesError;
  if (new Set(project.config.targetLanguages).size !== project.config.targetLanguages.length) {
    return invalid("project.config.targetLanguages must be unique");
  }
  if (project.config.targetLanguages.some((language) => !TARGET_LANGUAGE_VALUES.has(language))) {
    return invalid("project.config.targetLanguages contains an unsupported language");
  }
  if (!isAllowedProviderModel(project.config.provider, project.config.model)) {
    return invalid("project.config provider and model combination is invalid");
  }
  if (project.config.asrModelId !== undefined && project.config.asrModelId !== null && !isAsrModelId(project.config.asrModelId)) {
    return invalid("project.config.asrModelId is invalid");
  }
  for (const field of ["burnVideo", "copyMediaIntoProject"]) {
    if (typeof project.config[field] !== "boolean") {
      return invalid(`project.config.${field} must be boolean`);
    }
  }
  if (project.config.subtitleStyle !== undefined) {
    try {
      normalizeSubtitleStylePayload(project.config.subtitleStyle);
    } catch {
      return invalid("project.config.subtitleStyle is invalid");
    }
  }
  const trashedError = assertOptionalString(project.trashedAt, "trashedAt");
  if (trashedError) return trashedError;
  const archivedError = assertOptionalString(project.archivedAt, "archivedAt");
  if (archivedError) return archivedError;
  const relativePathError = assertOptionalString(
    project.sourceProjectRelativePath,
    "sourceProjectRelativePath",
  );
  if (relativePathError) return relativePathError;
  if (project.sourceProjectRelativePath !== undefined) {
    const relativePath = project.sourceProjectRelativePath;
    if (!isSafeArtifactRelativePath(relativePath)) {
      return invalid("sourceProjectRelativePath must be a safe project-relative path");
    }
  }
  if (project.sourceProbeSummary !== undefined) {
    if (!isPlainObject(project.sourceProbeSummary)) {
      return invalid("sourceProbeSummary must be an object when present");
    }
    if (project.sourceProbeSummary.media !== undefined && !isPlainObject(project.sourceProbeSummary.media)) {
      return invalid("sourceProbeSummary.media must be an object when present");
    }
    if (project.sourceProbeSummary.media !== undefined) {
      try {
        validateMediaProbe(project.sourceProbeSummary.media);
      } catch {
        return invalid("sourceProbeSummary.media must use the bounded MediaProbe contract");
      }
    }
  }
  if (project.mediaSource !== undefined && project.mediaSource !== null) {
    if (!isPlainObject(project.mediaSource)) {
      return invalid("mediaSource must be an object or null");
    }
    for (const field of ["assetId", "displayName", "availability"]) {
      const error = assertString(project.mediaSource[field], `mediaSource.${field}`);
      if (error) return error;
    }
    if (project.mediaSource.assetId !== "primary") return invalid("mediaSource.assetId is invalid");
    if (!["available", "missing", "relink_required", "invalid"].includes(project.mediaSource.availability)) {
      return invalid("mediaSource.availability is invalid");
    }
    if (
      project.mediaSource.selectedAudioStreamId != null &&
      !/^s:\d+$/.test(project.mediaSource.selectedAudioStreamId)
    ) {
      return invalid("mediaSource.selectedAudioStreamId must be string or null");
    }
    if (
      project.mediaSource.selectedSubtitleStreamId != null &&
      !/^s:\d+$/.test(project.mediaSource.selectedSubtitleStreamId)
    ) {
      return invalid("mediaSource.selectedSubtitleStreamId must be string or null");
    }
    if (project.mediaSource.identity != null) {
      const identity = project.mediaSource.identity;
      if (!isPlainObject(identity)) return invalid("mediaSource.identity must be an object or null");
      for (const field of ["sizeBytes", "mtimeMs"]) {
        if (identity[field] != null && (!Number.isFinite(identity[field]) || identity[field] < 0)) {
          return invalid(`mediaSource.identity.${field} must be a non-negative finite number or null`);
        }
      }
      if (
        identity.fingerprint != null &&
        (typeof identity.fingerprint !== "string" || identity.fingerprint.length > 128)
      ) {
        return invalid("mediaSource.identity.fingerprint must be a bounded string or null");
      }
    }
  }
  if (!Array.isArray(project.sourceTracks)) {
    return invalid("project.sourceTracks must be an array");
  }
  const ids = { sourceTracks: new Set(), targetTracks: new Set(), segments: new Set() };
  for (let index = 0; index < project.sourceTracks.length; index += 1) {
    const track = project.sourceTracks[index];
    const error = validateSourceTrack(track, `project.sourceTracks[${index}]`, ids);
    if (error) return error;
    if (ids.sourceTracks.has(track.id)) return invalid("source track ids must be unique");
    ids.sourceTracks.add(track.id);
  }
  if (project.sourceTracks.length === 0) {
    if (project.activeSourceTrackId !== null) {
      return invalid("empty sourceTracks requires activeSourceTrackId null");
    }
    if (project.noSourceMedia !== false) {
      return invalid("media draft with empty sourceTracks requires noSourceMedia=false");
    }
    if (!project.mediaSource || project.mediaSource.assetId !== "primary") {
      return invalid("empty sourceTracks requires a Main Media Source summary");
    }
  } else {
    if (project.activeSourceTrackId == null) {
      if (
        project.noSourceMedia !== false ||
        project.mediaSource?.assetId !== "primary" ||
        project.sourceTracks.some((track) => track.isActive)
      ) {
        return invalid("candidate-only media draft requires no active source track and a Main Media Source");
      }
    } else {
      const activeTrack = project.sourceTracks.find((track) => track.id === project.activeSourceTrackId);
      if (!activeTrack?.isActive || project.sourceTracks.filter((track) => track.isActive).length !== 1) {
        return invalid("activeSourceTrackId must reference an active source track");
      }
    }
  }
  if (project.editorHistory !== undefined) {
    const historyError = validateEditorHistory(project.editorHistory, ids.segments);
    if (historyError) return historyError;
  }
  return null;
}

export function validateIpcEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    return invalid("envelope must be an object");
  }
  const { method, request } = envelope;
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
    return invalid("unknown or unsupported method", { method: typeof method === "string" ? method : typeof method });
  }
  if (request === undefined) {
    return invalid("request is required");
  }
  let bytes;
  try {
    bytes = measureRequestBytes(method, request);
  } catch {
    return invalid("request is not serializable");
  }
  if (bytes > MAX_PAYLOAD_BYTES) {
    return invalid("request exceeds 8 MiB limit", { bytes });
  }

  switch (method) {
    case "project.create":
    case "project.save": {
      if (!isPlainObject(request) || !("project" in request)) {
        return invalid("project payload is required");
      }
      const projectError = validateProjectShape(request.project);
      if (projectError) return projectError;
      return { ok: true, method, request };
    }
    case "project.open": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      return { ok: true, method, request };
    }
    case "project.runtimeState": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      return { ok: true, method, request };
    }
    case "project.listRecent": {
      if (!isPlainObject(request)) {
        return invalid("listRecent request must be an object");
      }
      return { ok: true, method, request };
    }
    case "subtitle.import": {
      if (!isPlainObject(request)) {
        return invalid("subtitle import request must be an object");
      }
      if (!isSafeImportFileName(request.fileName)) {
        return invalid("fileName is invalid");
      }
      if (!isBinaryPayload(request.bytes)) {
        return invalid("bytes must be binary data");
      }
      const dataBytes = getBinaryByteLength(request.bytes);
      if (dataBytes < 0 || dataBytes > MAX_SUBTITLE_BYTES) {
        return invalid("subtitle file exceeds 8 MiB limit", { bytes: dataBytes });
      }
      if (request.encoding !== undefined && !SUBTITLE_ENCODINGS.has(request.encoding)) {
        return invalid("encoding is invalid");
      }
      const defaultsError = validateProjectDefaults(request.defaults);
      if (defaultsError) return defaultsError;
      return { ok: true, method, request };
    }
    case "subtitle.exportSource": {
      const keys = isPlainObject(request) ? Object.keys(request) : [];
      if (
        !isPlainObject(request)
        || keys.some((key) => !["projectId", "mode", "format", "destination"].includes(key))
        || !isSafeProjectId(request.projectId)
      ) {
        return invalid("projectId is invalid");
      }
      if (request.destination !== undefined && !["project", "user"].includes(request.destination)) {
        return invalid("export destination is invalid");
      }
      if (!SUBTITLE_EXPORT_MODES.has(request.mode)) {
        return invalid("export mode is invalid");
      }
      if (request.mode === "normalized") {
        if (!SUBTITLE_NORMALIZED_FORMATS.has(request.format)) {
          return invalid("normalized export format is invalid");
        }
      } else if (request.format !== undefined && !SUBTITLE_NORMALIZED_FORMATS.has(request.format)) {
        return invalid("export format is invalid");
      }
      return { ok: true, method, request };
    }
    case "window.control": {
      if (!isPlainObject(request) || !WINDOW_ACTIONS.has(request.action)) {
        return invalid("window action is invalid");
      }
      return { ok: true, method, request };
    }
    case "tasks.subscribe": {
      if (!isPlainObject(request)) {
        return invalid("subscribe request must be an object");
      }
      if (request.projectId !== undefined && !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      return { ok: true, method, request };
    }
    case "credential.save": {
      if (!isPlainObject(request) || !isSafeCredentialId(request.credentialId)) {
        return invalid("credentialId is invalid");
      }
      if (typeof request.secret !== "string" || request.secret.length === 0) {
        return invalid("secret is required");
      }
      if (request.secret.length > MAX_CREDENTIAL_SECRET_CHARS) {
        return invalid("secret exceeds size limit");
      }
      if (request.providerId !== undefined) {
        if (typeof request.providerId !== "string" || request.providerId.length > 128) {
          return invalid("providerId is invalid");
        }
      }
      if (request.label !== undefined) {
        if (typeof request.label !== "string" || request.label.length > 256) {
          return invalid("label is invalid");
        }
      }
      return { ok: true, method, request };
    }
    case "credential.delete": {
      if (!isPlainObject(request) || !isSafeCredentialId(request.credentialId)) {
        return invalid("credentialId is invalid");
      }
      return { ok: true, method, request };
    }
    case "credential.status": {
      if (!isPlainObject(request)) {
        return invalid("credential status request must be an object");
      }
      if (request.credentialId !== undefined && !isSafeCredentialId(request.credentialId)) {
        return invalid("credentialId is invalid");
      }
      return { ok: true, method, request };
    }
    case "provider.testConnection": {
      if (!isPlainObject(request) || typeof request.provider !== "string" || request.provider.length === 0) {
        return invalid("provider is required");
      }
      if (request.credentialId !== undefined && !isSafeCredentialId(request.credentialId)) {
        return invalid("credentialId is invalid");
      }
      if (request.baseUrl !== undefined && typeof request.baseUrl !== "string") {
        return invalid("baseUrl is invalid");
      }
      if (request.model !== undefined && typeof request.model !== "string") {
        return invalid("model is invalid");
      }
      if (
        request.transportMode !== undefined &&
        !PROVIDER_TRANSPORT_MODES.has(request.transportMode)
      ) {
        return invalid("transportMode is invalid");
      }
      if (
        request.timeoutMs !== undefined &&
        (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
      ) {
        return invalid("timeoutMs is invalid");
      }
      return { ok: true, method, request };
    }
    case "provider.listModels": {
      if (!isPlainObject(request)) {
        return invalid("provider listModels request must be an object");
      }
      if (
        typeof request.provider !== "string" ||
        request.provider.length === 0 ||
        request.provider.length > MAX_PROVIDER_NAME_CHARS
      ) {
        return invalid("provider is required");
      }
      if (
        Object.keys(request).some(
          (key) => !["provider", "credentialId", "baseUrl", "timeoutMs"].includes(key),
        )
      ) {
        return invalid("provider listModels request contains unsupported fields");
      }
      if (request.credentialId !== undefined && !isSafeCredentialId(request.credentialId)) {
        return invalid("credentialId is invalid");
      }
      if (
        request.baseUrl !== undefined &&
        (typeof request.baseUrl !== "string" ||
          request.baseUrl.length === 0 ||
          request.baseUrl.length > MAX_PROVIDER_BASE_URL_CHARS)
      ) {
        return invalid("baseUrl is invalid");
      }
      if (
        request.timeoutMs !== undefined &&
        (!Number.isFinite(request.timeoutMs) ||
          request.timeoutMs <= 0 ||
          request.timeoutMs > MAX_PROVIDER_TIMEOUT_MS)
      ) {
        return invalid("timeoutMs is invalid");
      }
      return { ok: true, method, request };
    }
    case "capability.status": {
      if (!isPlainObject(request) || Object.keys(request).some((key) => key !== "projectId")) return invalid("capability request is invalid");
      if (request.projectId !== undefined && !isSafeProjectId(request.projectId)) return invalid("projectId is invalid");
      return { ok: true, method, request };
    }
    case "settings.get":
    case "settings.selectModelStorageDestination":
    case "settings.reset":
    case "downloads.status":
    case "downloads.probeSources":
    case "backup.app.create":
    case "diagnostics.preview":
    case "diagnostics.export": {
      if (!hasExactKeys(request, [])) return invalid(`${method} request must be empty`);
      return { ok: true, method, request };
    }
    case "settings.save": {
      if (!hasExactKeys(request, ["settings"])) return invalid("settings save request is invalid");
      const error = validateAppSettings(request.settings);
      return error ?? { ok: true, method, request };
    }
    case "settings.selectDirectory": {
      if (!hasExactKeys(request, ["pathKey"]) || !["cachePath", "backupPath"].includes(request.pathKey)) {
        return invalid("settings directory request is invalid");
      }
      return { ok: true, method, request };
    }
    case "settings.transferModelStorage": {
      if (!hasExactKeys(request, ["selectionToken"]) || typeof request.selectionToken !== "string" || !/^[0-9a-f-]{36}$/i.test(request.selectionToken)) {
        return invalid("model storage transfer request is invalid");
      }
      return { ok: true, method, request };
    }
    case "backup.restore.select": {
      if (!hasExactKeys(request, ["kind"]) || !["app", "project"].includes(request.kind)) return invalid("backup kind is invalid");
      return { ok: true, method, request };
    }
    case "backup.restore.apply": {
      if (!hasExactKeys(request, ["token", "userConfirmed"]) || !isSafeOperationId(request.token) || typeof request.userConfirmed !== "boolean") {
        return invalid("backup restore request is invalid");
      }
      return { ok: true, method, request };
    }
    case "project.package": {
      const keys = isPlainObject(request) ? Object.keys(request) : [];
      if (
        !isPlainObject(request)
        || keys.some((key) => !["projectId", "kind", "includeTrash", "destination"].includes(key))
        || !isSafeProjectId(request.projectId)
      ) {
        return invalid("projectId is invalid");
      }
      if (!["lightweight", "archive"].includes(request.kind)) {
        return invalid("project package kind is invalid");
      }
      if (request.includeTrash !== undefined && typeof request.includeTrash !== "boolean") {
        return invalid("includeTrash is invalid");
      }
      if (request.destination !== undefined && request.destination !== "backup") {
        return invalid("project package destination is invalid");
      }
      return { ok: true, method, request };
    }
    case "project.deletePermanently": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId) || request.confirmed !== true) {
        return invalid("permanent project deletion requires confirmation");
      }
      return { ok: true, method, request };
    }
    case "subtitle.exportMatrix": {
      const keys = isPlainObject(request) ? Object.keys(request) : [];
      if (
        !isPlainObject(request)
        || keys.some((key) => !["projectId", "requests", "destination", "destinationDir"].includes(key))
        || !isSafeProjectId(request.projectId)
      ) {
        return invalid("projectId is invalid");
      }
      if (request.destinationDir !== undefined) {
        return invalid("renderer export paths are not allowed");
      }
      if (request.destination !== undefined && !["project", "user"].includes(request.destination)) {
        return invalid("export destination is invalid");
      }
      if (!Array.isArray(request.requests) || request.requests.length < 1 || request.requests.length > 100) {
        return invalid("export requests must contain 1 to 100 items");
      }
      for (const item of request.requests) {
        if (!isPlainObject(item) || !["source", "target", "bilingual"].includes(item.exportKind)) {
          return invalid("export kind is invalid");
        }
        if (!SUBTITLE_NORMALIZED_FORMATS.has(item.format)) {
          return invalid("export format is invalid");
        }
        if (item.exportKind !== "source" && (
          typeof item.targetLanguageCode !== "string"
          || item.targetLanguageCode.length < 1
          || item.targetLanguageCode.length > 64
        )) {
          return invalid("target language is invalid");
        }
        if (item.id !== undefined && (
          typeof item.id !== "string"
          || item.id.length < 1
          || item.id.length > 128
        )) {
          return invalid("export request id is invalid");
        }
      }
      return { ok: true, method, request };
    }
    case "subtitle.exportApprovedBatch": {
      if (
        !isPlainObject(request)
        || Object.keys(request).some((key) => key !== "projectIds")
        || !Array.isArray(request.projectIds)
        || request.projectIds.length < 1
        || request.projectIds.length > 200
        || new Set(request.projectIds).size !== request.projectIds.length
        || request.projectIds.some((projectId) => !isSafeProjectId(projectId))
      ) {
        return invalid("approved batch project ids are invalid");
      }
      return { ok: true, method, request };
    }
    case "subtitle.videoExport": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      if (typeof request.subtitleExportRecordId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(request.subtitleExportRecordId)) {
        return invalid("subtitle export record id is invalid");
      }
      if (!["soft_subtitle", "burn_ass"].includes(request.mode)) {
        return invalid("video export mode is invalid");
      }
      if (
        typeof request.operationId !== "string"
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.operationId)
      ) {
        return invalid("operationId is invalid");
      }
      return { ok: true, method, request };
    }
    case "audio.separation.capability": {
      if (!isPlainObject(request) || Object.keys(request).length !== 0) {
        return invalid("audio separation capability request must be empty");
      }
      return { ok: true, method, request };
    }
    case "audio.separation.start": {
      if (
        !isPlainObject(request)
        || Object.keys(request).some((key) => !["projectId", "operationId"].includes(key))
        || !isSafeProjectId(request.projectId)
        || !isSafeOperationId(request.operationId)
      ) {
        return invalid("audio separation request is invalid");
      }
      return { ok: true, method, request };
    }
    case "resource.list": {
      if (!isPlainObject(request) || (request.kind !== undefined && !["glossary", "style_guide", "subtitle_style", "export_preset"].includes(request.kind))) {
        return invalid("resource list filter is invalid");
      }
      return { ok: true, method, request };
    }
    case "resource.save": {
      if (!isPlainObject(request) || !isPlainObject(request.resource)) {
        return invalid("resource payload is required");
      }
      if (request.expectedRevision !== undefined && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1)) {
        return invalid("expectedRevision is invalid");
      }
      try {
        normalizeResourceWrite(request.resource);
      } catch (error) {
        return invalid(String(error?.message || "resource payload is invalid").slice(0, 240));
      }
      return { ok: true, method, request };
    }
    case "resource.delete": {
      if (!isPlainObject(request) || !isSafeProjectId(request.resourceId)) {
        return invalid("resourceId is invalid");
      }
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) {
        return invalid("expectedRevision is invalid");
      }
      return { ok: true, method, request };
    }
    case "resource.snapshot.list": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      if (request.kind !== undefined && !["glossary", "style_guide", "subtitle_style", "export_preset"].includes(request.kind)) {
        return invalid("resource snapshot kind is invalid");
      }
      return { ok: true, method, request };
    }
    case "resource.snapshot.refresh": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId) || !isSafeProjectId(request.resourceId)) {
        return invalid("resource snapshot refresh request is invalid");
      }
      return { ok: true, method, request };
    }
    case "tasks.control": {
      if (
        !isPlainObject(request) ||
        !isSafeOperationId(request.taskId) ||
        !isSafeProjectId(request.projectId) ||
        !TASK_CONTROL_ACTIONS.has(request.action) ||
        (request.userConfirmed !== undefined && typeof request.userConfirmed !== "boolean")
      ) {
        return invalid("task control request is invalid");
      }
      if (Object.keys(request).some((key) => !["taskId", "projectId", "action", "userConfirmed"].includes(key))) {
        return invalid("task control request contains unsupported fields");
      }
      return { ok: true, method, request };
    }
    case "provider.runtimeState": {
      if (!isPlainObject(request) || typeof request.provider !== "string" || request.provider.length === 0) {
        return invalid("provider is required");
      }
      return { ok: true, method, request };
    }
    case "asr.capability": {
      if (!isPlainObject(request) || Object.keys(request).length !== 0) {
        return invalid("asr.capability request must be an empty object");
      }
      return { ok: true, method, request };
    }
    case "asr.model.install": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 3 ||
        !ASR_MODEL_ID_SET.has(request.assetId) ||
        !["official", "mirror", "auto"].includes(request.source) ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid("asr.model.install request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.model.import":
    case "asr.model.uninstall": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 2 ||
        !ASR_MODEL_ID_SET.has(request.assetId) ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid(`${method} request is invalid`);
      }
      return { ok: true, method, request };
    }
    case "asr.model.cancel": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 1 ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid("asr.model.cancel request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.runtime.install": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 3 ||
        !["whisper-cpp-cuda-12.4-x64", "qwen3-asr-transformers-cu128-x64"].includes(request.assetId) ||
        request.source !== "official" ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid("asr.runtime.install request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.runtime.import":
    case "asr.runtime.uninstall": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 2 ||
        !["whisper-cpp-cuda-12.4-x64", "qwen3-asr-transformers-cu128-x64"].includes(request.assetId) ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid(`${method} request is invalid`);
      }
      return { ok: true, method, request };
    }
    case "asr.runtime.cancel": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 1 ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid("asr.runtime.cancel request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.device.status": {
      if (!isPlainObject(request) || Object.keys(request).length !== 0) {
        return invalid("asr.device.status request must be empty");
      }
      return { ok: true, method, request };
    }
    case "asr.device.preference": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 2 ||
        !["auto", "cpu", "cuda"].includes(request.requestedDevice) ||
        typeof request.allowCudaFallback !== "boolean"
      ) {
        return invalid("asr.device.preference request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.device.detect":
    case "asr.device.cancel": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 1 ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid(`${method} request is invalid`);
      }
      return { ok: true, method, request };
    }
    case "asr.project.status": {
      if (!isPlainObject(request) || Object.keys(request).length !== 1 || !isSafeProjectId(request.projectId)) {
        return invalid("asr.project.status request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.transcribe": {
      const keys = Object.keys(request ?? {});
      if (!isPlainObject(request) || keys.length !== 7 || !isSafeProjectId(request.projectId) ||
        !/^s:\d+$/.test(request.audioStreamId) ||
        !["auto", "fixed"].includes(request.languageMode) ||
        !(request.languageMode === "auto" ? request.languageHint === null : /^[A-Za-z]{2,3}$/.test(request.languageHint ?? "")) ||
        !["auto", "cpu", "cuda"].includes(request.requestedDevice) ||
        typeof request.allowCudaFallback !== "boolean" || !isSafeOperationId(request.operationId)) {
        return invalid("asr.transcribe request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.segment": {
      if (!isPlainObject(request) || Object.keys(request).length !== 4 || !isSafeProjectId(request.projectId) ||
        !isSafeOperationId(request.asrRunId) || request.configVersion !== "asr-segmentation-v2" ||
        !isSafeOperationId(request.operationId)) {
        return invalid("asr.segment request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.language.detect": {
      if (!isPlainObject(request) || Object.keys(request).length !== 5 || !isSafeProjectId(request.projectId) ||
        !isSafeOperationId(request.sourceTrackId) || !["auto", "cpu", "cuda"].includes(request.requestedDevice) ||
        typeof request.allowCudaFallback !== "boolean" || !isSafeOperationId(request.operationId)) {
        return invalid("asr.language.detect request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.language.update": {
      if (!isPlainObject(request) || Object.keys(request).length !== 4 || !isSafeProjectId(request.projectId) ||
        !isSafeOperationId(request.sourceTrackId) || !Array.isArray(request.changes) || request.changes.length === 0 ||
        request.changes.length > 20_000 || typeof request.confirmTrackConvergence !== "boolean") {
        return invalid("asr.language.update request is invalid");
      }
      const ids = new Set();
      for (const change of request.changes) {
        if (!isPlainObject(change) || Object.keys(change).length !== 2 || !isSafeOperationId(change.segmentId) ||
          ids.has(change.segmentId) || (change.manualLanguage !== null && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(change.manualLanguage))) {
          return invalid("asr.language.update changes are invalid");
        }
        ids.add(change.segmentId);
      }
      return { ok: true, method, request };
    }
    case "asr.cancel": {
      if (!isPlainObject(request) || Object.keys(request).length !== 2 || !isSafeProjectId(request.projectId) ||
        !isSafeOperationId(request.operationId)) return invalid("asr.cancel request is invalid");
      return { ok: true, method, request };
    }
    case "asr.info.open": {
      const fields = isPlainObject(request) ? Object.keys(request) : [];
      const modelTarget = request?.target?.startsWith("model-") || request?.target?.startsWith("engine-");
      if (!isPlainObject(request) || fields.length < 1 || fields.length > 2 ||
        fields.some((field) => field !== "target" && field !== "modelId") ||
        !["engine-source", "engine-license", "model-source", "model-license", "vad-source", "vad-license"].includes(request.target) ||
        (request.modelId !== undefined && (!modelTarget || !isAsrModelId(request.modelId)))) {
        return invalid("asr.info.open request is invalid");
      }
      return { ok: true, method, request };
    }
    case "translation.start": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      if (request.userConfirmed !== true) {
        return invalid("userConfirmed must be true for paid translation");
      }
      if (request.provider !== undefined && typeof request.provider !== "string") {
        return invalid("provider is invalid");
      }
      if (request.model !== undefined && typeof request.model !== "string") {
        return invalid("model is invalid");
      }
      if (request.credentialId !== undefined && !isSafeCredentialId(request.credentialId)) {
        return invalid("credentialId is invalid");
      }
      if (request.baseUrl !== undefined && typeof request.baseUrl !== "string") {
        return invalid("baseUrl is invalid");
      }
      if (
        request.transportMode !== undefined &&
        !PROVIDER_TRANSPORT_MODES.has(request.transportMode)
      ) {
        return invalid("transportMode is invalid");
      }
      if (request.targetLanguages !== undefined) {
        const languagesError = assertStringArray(request.targetLanguages, "targetLanguages", {
          nonEmpty: true,
        });
        if (languagesError) return languagesError;
        if (
          new Set(request.targetLanguages).size !== request.targetLanguages.length ||
          request.targetLanguages.some((language) => !TARGET_LANGUAGE_VALUES.has(language))
        ) {
          return invalid("targetLanguages must be unique supported languages");
        }
      }
      if (request.segmentIds !== undefined) {
        const segmentError = assertStringArray(request.segmentIds, "segmentIds", { nonEmpty: true });
        if (segmentError) return segmentError;
        if (
          new Set(request.segmentIds).size !== request.segmentIds.length ||
          request.segmentIds.some((segmentId) => !isSafeProjectId(segmentId))
        ) {
          return invalid("segmentIds must be unique safe ids");
        }
      }
      if (request.candidateTrackId !== undefined && !isSafeProjectId(request.candidateTrackId)) {
        return invalid("candidateTrackId is invalid");
      }
      if (request.batchId !== undefined && !isSafeOperationId(request.batchId)) {
        return invalid("batchId is invalid");
      }
      if (
        request.batchEstimatedTokens !== undefined
        && (!Number.isFinite(request.batchEstimatedTokens) || request.batchEstimatedTokens < 0)
      ) {
        return invalid("batchEstimatedTokens is invalid");
      }
      if (request.segmentIds !== undefined && request.candidateTrackId !== undefined) {
        return invalid("selected rerun and candidate destination are mutually exclusive");
      }
      if (
        (request.segmentIds !== undefined || request.candidateTrackId !== undefined) &&
        request.targetLanguages?.length !== 1
      ) {
        return invalid("focused translation requires exactly one target language");
      }
      if (request.parameters !== undefined) {
        if (
          !isPlainObject(request.parameters) ||
          Object.keys(request.parameters).some((key) => key !== "temperature") ||
          (request.parameters.temperature !== undefined &&
            (!Number.isFinite(request.parameters.temperature) ||
              request.parameters.temperature < 0 ||
              request.parameters.temperature > 2))
        ) {
          return invalid("translation parameters are invalid");
        }
      }
      return { ok: true, method, request };
    }
    case "media.selectSource": {
      if (!isPlainObject(request)) return invalid("media.selectSource request must be an object");
      const defaultsError = validateProjectDefaults(request.defaults);
      if (defaultsError) return defaultsError;
      if (request.copyIntoProject !== undefined && typeof request.copyIntoProject !== "boolean") {
        return invalid("copyIntoProject must be boolean");
      }
      if ("filePath" in request || "path" in request || "argv" in request) {
        return invalid("media requests must not include filesystem paths or argv");
      }
      if (request.operationId !== undefined && !isSafeOperationId(request.operationId)) {
        return invalid("operationId is invalid");
      }
      return { ok: true, method, request };
    }
    case "batch.createSession": {
      if (
        !isPlainObject(request)
        || Object.keys(request).some((key) => key !== "filePaths")
        || !Array.isArray(request.filePaths)
        || request.filePaths.length < 1
        || request.filePaths.length > 200
        || new Set(request.filePaths).size !== request.filePaths.length
        || request.filePaths.some((filePath) => !isAbsoluteBatchFilePath(filePath))
      ) {
        return invalid("batch file selection is invalid");
      }
      return { ok: true, method, request };
    }
    case "batch.discardSession": {
      if (
        !isPlainObject(request)
        || Object.keys(request).some((key) => key !== "sessionId")
        || !isSafeOperationId(request.sessionId)
      ) {
        return invalid("batch session id is invalid");
      }
      return { ok: true, method, request };
    }
    case "batch.commitSession": {
      if (
        !isPlainObject(request)
        || Object.keys(request).some((key) => !["sessionId", "defaults", "groups", "fileEncodings"].includes(key))
        || !isSafeOperationId(request.sessionId)
        || !isPlainObject(request.defaults)
        || Object.keys(request.defaults).some((key) => !PROJECT_DEFAULT_KEYS.has(key))
        || !Array.isArray(request.groups)
        || request.groups.length === 0
        || request.groups.length > 200
        || (request.fileEncodings !== undefined && (
          !Array.isArray(request.fileEncodings)
          || request.fileEncodings.length > 200
          || request.fileEncodings.some((selection) => (
            !isPlainObject(selection)
            || Object.keys(selection).some((key) => !["fileId", "encoding"].includes(key))
            || !isSafeOperationId(selection.fileId)
            || !SUBTITLE_ENCODINGS.has(selection.encoding)
          ))
        ))
      ) {
        return invalid("batch commit request is invalid");
      }
      const defaultsError = validateProjectDefaults(request.defaults);
      if (defaultsError) return defaultsError;
      const submittedFileIds = [];
      for (const group of request.groups) {
        if (
          !isPlainObject(group)
          || Object.keys(group).some((key) => !["id", "title", "fileIds", "overrides"].includes(key))
          || !isSafeOperationId(group.id)
          || typeof group.title !== "string"
          || group.title.length === 0
          || group.title.length > 200
          || group.title !== group.title.normalize("NFC")
          || !Array.isArray(group.fileIds)
          || group.fileIds.length === 0
          || group.fileIds.length > 200
          || group.fileIds.some((id) => !isSafeOperationId(id))
          || !isPlainObject(group.overrides)
          || Object.keys(group.overrides).some((key) => !PROJECT_DEFAULT_KEYS.has(key))
        ) {
          return invalid("batch project group is invalid");
        }
        const overridesError = validateProjectDefaults(group.overrides);
        if (overridesError) return overridesError;
        submittedFileIds.push(...group.fileIds);
      }
      if (new Set(submittedFileIds).size !== submittedFileIds.length) {
        return invalid("batch files must belong to one project each");
      }
      const encodingFileIds = (request.fileEncodings ?? []).map((selection) => selection.fileId);
      if (
        new Set(encodingFileIds).size !== encodingFileIds.length
        || encodingFileIds.some((fileId) => !submittedFileIds.includes(fileId))
      ) {
        return invalid("batch subtitle encodings must reference selected files");
      }
      return { ok: true, method, request };
    }
    case "batch.start": {
      const allowedKeys = new Set([
        "batchId", "projectIds", "userConfirmed", "provider", "model", "credentialId",
        "baseUrl", "transportMode", "parameters",
      ]);
      if (
        !isPlainObject(request)
        || Object.keys(request).some((key) => !allowedKeys.has(key))
        || !isSafeOperationId(request.batchId)
        || !Array.isArray(request.projectIds)
        || request.projectIds.length === 0
        || request.projectIds.length > 200
        || new Set(request.projectIds).size !== request.projectIds.length
        || request.projectIds.some((projectId) => !isSafeProjectId(projectId))
        || request.userConfirmed !== true
      ) {
        return invalid("batch start request is invalid");
      }
      for (const key of ["provider", "model"]) {
        if (request[key] !== undefined && (typeof request[key] !== "string" || request[key].length > 200)) {
          return invalid(`${key} is invalid`);
        }
      }
      if (request.credentialId !== undefined && !isSafeCredentialId(request.credentialId)) {
        return invalid("credentialId is invalid");
      }
      if (request.baseUrl !== undefined && (typeof request.baseUrl !== "string" || request.baseUrl.length > 2048)) {
        return invalid("baseUrl is invalid");
      }
      if (request.transportMode !== undefined && !PROVIDER_TRANSPORT_MODES.has(request.transportMode)) {
        return invalid("transportMode is invalid");
      }
      if (
        request.parameters !== undefined
        && (!isPlainObject(request.parameters)
          || Object.keys(request.parameters).some((key) => key !== "temperature")
          || (request.parameters.temperature !== undefined
            && (!Number.isFinite(request.parameters.temperature)
              || request.parameters.temperature < 0
              || request.parameters.temperature > 2)))
      ) {
        return invalid("translation parameters are invalid");
      }
      return { ok: true, method, request };
    }
    case "media.probe":
    case "media.relink": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      if ("filePath" in request || "path" in request) {
        return invalid("media requests must not include filesystem paths");
      }
      if (request.operationId !== undefined && !isSafeOperationId(request.operationId)) {
        return invalid("operationId is invalid");
      }
      return { ok: true, method, request };
    }
    case "media.selectStreams": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      for (const field of ["audioStreamId", "subtitleStreamId"]) {
        if (request[field] != null && (typeof request[field] !== "string" || !/^s:\d+$/.test(request[field]))) {
          return invalid(`${field} is invalid`);
        }
      }
      return { ok: true, method, request };
    }
    case "media.extractSubtitle": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      if (typeof request.streamId !== "string" || !/^s:\d+$/.test(request.streamId)) {
        return invalid("streamId is invalid");
      }
      if (request.operationId !== undefined && !isSafeOperationId(request.operationId)) {
        return invalid("operationId is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.songClassifier.install": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 3 ||
        request.assetId !== "ina-speech-music-noise-v1" ||
        request.source !== "official" ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid("asr.songClassifier.install request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.songClassifier.uninstall": {
      if (
        !isPlainObject(request) ||
        Object.keys(request).length !== 2 ||
        request.assetId !== "ina-speech-music-noise-v1" ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid("asr.songClassifier.uninstall request is invalid");
      }
      return { ok: true, method, request };
    }
    case "asr.songClassifier.cancel": {
      if (!isPlainObject(request) || Object.keys(request).length !== 1 || !isSafeOperationId(request.operationId)) {
        return invalid("asr.songClassifier.cancel request is invalid");
      }
      return { ok: true, method, request };
    }
    case "media.waveform": {
      if (
        !isPlainObject(request)
        || !isSafeProjectId(request.projectId)
        || Object.keys(request).some((key) => !["projectId", "operationId"].includes(key))
        || (request.operationId !== undefined && !isSafeOperationId(request.operationId))
      ) return invalid("waveform request is invalid");
      return { ok: true, method, request };
    }
    case "media.extractAudio": {
      if (
        !isPlainObject(request)
        || !isSafeProjectId(request.projectId)
        || Object.keys(request).some((key) => !["projectId", "streamId", "operationId"].includes(key))
      ) {
        return invalid("audio extraction request is invalid");
      }
      if (typeof request.streamId !== "string" || !/^s:\d+$/.test(request.streamId)) {
        return invalid("streamId is invalid");
      }
      if (request.operationId !== undefined && !isSafeOperationId(request.operationId)) {
        return invalid("operationId is invalid");
      }
      return { ok: true, method, request };
    }
    case "media.activateSourceTrack": {
      if (
        !isPlainObject(request) ||
        !isSafeProjectId(request.projectId) ||
        !isSafeProjectId(request.sourceTrackId)
      ) {
        return invalid("activate source track request is invalid");
      }
      return { ok: true, method, request };
    }
    case "media.previewUrl": {
      if (!isPlainObject(request) || !isSafeProjectId(request.projectId)) {
        return invalid("projectId is invalid");
      }
      if (request.assetId !== undefined && request.assetId !== "primary") {
        return invalid("assetId is invalid");
      }
      return { ok: true, method, request };
    }
    case "media.cancel": {
      if (
        !isPlainObject(request) ||
        !isSafeProjectId(request.projectId) ||
        !isSafeOperationId(request.operationId)
      ) {
        return invalid("media.cancel request is invalid");
      }
      return { ok: true, method, request };
    }
    default:
      return invalid("unknown or unsupported method");
  }
}

const MEDIA_ERROR_CODES = new Set([
  "NOT_AVAILABLE",
  "INVALID_ARTIFACT",
  "UNSUPPORTED",
  "CORRUPT_INPUT",
  "TIMEOUT",
  "CANCELLED",
  "OUTPUT_TOO_LARGE",
  "INVALID_ASR_RESULT",
  "NO_SPEECH_DETECTED",
  "PROCESS_FAILED",
  "WORKER_CRASHED",
  "INVALID_INPUT",
  "UNSEGMENTABLE_INPUT",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "CONFLICT",
  "DOWNLOAD_FAILED",
  "LENGTH_MISMATCH",
  "HASH_MISMATCH",
  "DISK_FULL",
  "INSTALL_FAILED",
  "INVALID_ARCHIVE",
  "CUDA_UNAVAILABLE",
  "CUDA_INITIALIZATION_FAILED",
  "CONFIRMATION_REQUIRED",
]);

export function mapPortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" ? error.code : undefined;
  if (["ENOSPC", "SQLITE_FULL"].includes(code) || /database or disk is full/i.test(message)) {
    return { code: "DISK_FULL", message: "There is not enough disk space", retryable: true };
  }
  if (["EACCES", "EPERM"].includes(code)) {
    return { code: "PERMISSION_DENIED", message: "The selected file or directory is not writable" };
  }
  if (code === "CREDENTIAL_STORE_UNAVAILABLE") {
    return { code: "INTERNAL", message: "Secure credential storage is unavailable" };
  }
  if (code === "TASK_NOT_FOUND") {
    return { code: "NOT_FOUND", message: "Task not found" };
  }
  if (code === "RESOURCE_CONFLICT" || code === "RESOURCE_SNAPSHOT_CONFLICT") {
    return { code: "CONFLICT", message: "Resource changed before this operation" };
  }
  if (code === "INVALID_RESOURCE") {
    return { code: "INVALID_INPUT", message: String(message || "Invalid resource").slice(0, 240) };
  }
  if (["TASK_NOT_PAUSABLE", "INVALID_TASK_TRANSITION", "TASK_ALREADY_RUNNING"].includes(code)) {
    return { code: "CONFLICT", message: String(message || "Task state changed").slice(0, 240) };
  }
  if (["USER_CONFIRMATION_REQUIRED", "INVALID_TASK_CONTROL", "INVALID_TASK", "INVALID_TASK_REQUEST"].includes(code)) {
    return { code: "INVALID_INPUT", message: String(message || "Invalid task request").slice(0, 240) };
  }
  if (code === "TASK_EXECUTOR_UNAVAILABLE") {
    return { code: "NOT_AVAILABLE", message: "Task executor is unavailable" };
  }
  if (typeof code === "string" && MEDIA_ERROR_CODES.has(code)) {
    const safe =
      code === "INTERNAL"
        ? "Desktop operation failed"
        : String(message || "Media operation failed")
            .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
            .slice(0, 240);
    return {
      code,
      message: safe,
      ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {}),
    };
  }
  // Provider 侧失败（鉴权/限流/超时/返回格式不符）必须保留自己的 code，
  // 否则会落到最后的兜底并显示成「持久化失败」，用户会去删项目而不是改 API Key。
  if (typeof code === "string" && code.startsWith("PROVIDER_")) {
    return {
      code,
      message: String(message || "Provider request failed")
        .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
        .slice(0, 240),
      ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {}),
    };
  }
  // 注意：code === "INVALID_INPUT" 走不到这里——MEDIA_ERROR_CODES 里包含 INVALID_INPUT，
  // 上面那个分支会先命中并原样保留 message。这里只拦没有 code 的凭据类错误。
  if (/credentialId is invalid|secret is required|secret exceeds/i.test(message)) {
    return { code: "INVALID_INPUT", message: "Invalid credential request" };
  }
  if (code === "NOT_FOUND" && /credential/i.test(message)) {
    return { code: "NOT_FOUND", message: "Credential not found" };
  }
  if (/Invalid project id/i.test(message)) {
    return { code: "INVALID_INPUT", message: "Invalid project id" };
  }
  if (/not found|no such file|ENOENT/i.test(message)) {
    return { code: "NOT_FOUND", message: "Project not found" };
  }
  if (/Unsupported .* database version|No .* migrations found|Invalid .* migration/i.test(message)) {
    return { code: "INTERNAL", message: "Project storage is unavailable" };
  }
  if (/credential|safeStorage|encrypt|decrypt/i.test(message)) {
    return { code: "INTERNAL", message: "Credential operation failed" };
  }
  return { code: "INTERNAL", message: "Desktop persistence failed" };
}

export const IPC_LIMITS = {
  MAX_PAYLOAD_BYTES,
  MAX_SUBTITLE_BYTES,
  ALLOWED_METHODS: [...ALLOWED_METHODS],
};
