import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isAsrModelId } from "../../shared/asr-model-ids.mjs";
import { DEFAULT_ASR_VAD_SETTINGS, normalizeAsrVadSettings } from "../../shared/asr-vad-config.mjs";
import {
  TRANSLATION_PROVIDER_CATALOG,
  allowsFreeFormModelId,
  isSafeProviderModelId,
} from "../../shared/provider-registry.mjs";

const FIELDS = new Set([
  "schemaVersion",
  "startupPage",
  "translationProvider",
  "translationModel",
  "asrDefaultModelId",
  "asrVad",
  "asrVocalSeparation",
  "asrSongHandling",
  "cachePath",
  "modelPath",
  "backupPath",
  "downloadSource",
  "customDownloadUrl",
  "notifications",
]);
const NOTIFICATIONS = new Set(["taskDone", "error", "release", "system"]);

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  return error;
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !fields.has(key));
  if (unknown) throw invalid(`${label} field is not allowed: ${unknown}`);
}

async function assertWritableDirectory(path, label) {
  if (typeof path !== "string" || path.length === 0 || path.length > 1_024 || !isAbsolute(path)) {
    throw invalid(`${label} must be an absolute directory path`);
  }
  const value = await lstat(path).catch(() => null);
  if (!value?.isDirectory() || value.isSymbolicLink()) throw invalid(`${label} must be an existing ordinary directory`);
  await access(path, constants.R_OK | constants.W_OK).catch(() => {
    throw invalid(`${label} must be readable and writable`);
  });
}

function assertCustomSource(source, urlValue) {
  if (source !== "custom") return;
  try {
    const url = new URL(urlValue);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const privateIp = isIP(host) && /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(host);
    if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".local") || privateIp) {
      throw new Error();
    }
  } catch {
    throw invalid("Custom download source must be a public HTTPS URL without credentials");
  }
}

async function normalizeSettings(input, protectedRoots, defaults) {
  assertExactFields(input, FIELDS, "Settings");
  if (input.schemaVersion !== 1) throw invalid("Settings schemaVersion is invalid");
  if (!new Set(["resume", "start", "projects"]).has(input.startupPage)) throw invalid("Startup page is invalid");
  const translationProvider = input.translationProvider ?? defaults.translationProvider ?? null;
  const translationModel = input.translationModel ?? defaults.translationModel ?? null;
  if ((translationProvider === null) !== (translationModel === null)) {
    throw invalid("Translation provider and model must be saved together");
  }
  if (translationProvider !== null) {
    const provider = TRANSLATION_PROVIDER_CATALOG.find((entry) => entry.name === translationProvider);
    const knownModel = provider?.models.some((model) => model.id === translationModel || model.label === translationModel);
    if (!provider?.v1TranslationEnabled || (!knownModel && !(allowsFreeFormModelId(provider.profile) && isSafeProviderModelId(translationModel)))) {
      throw invalid("Translation provider and model are invalid");
    }
  }
  const asrDefaultModelId = input.asrDefaultModelId ?? defaults.asrDefaultModelId ?? "small";
  if (!isAsrModelId(asrDefaultModelId)) throw invalid("Default ASR model is invalid");
  const asrVad = normalizeAsrVadSettings(input.asrVad ?? defaults.asrVad ?? DEFAULT_ASR_VAD_SETTINGS);
  const asrVocalSeparation = input.asrVocalSeparation ?? defaults.asrVocalSeparation ?? "off";
  if (asrVocalSeparation !== "off" && asrVocalSeparation !== "on") {
    throw invalid("Vocal separation setting is invalid");
  }
  const asrSongHandling = input.asrSongHandling ?? defaults.asrSongHandling ?? "preserve";
  if (asrSongHandling !== "preserve" && asrSongHandling !== "filter") {
    throw invalid("Song handling setting is invalid");
  }
  if (!new Set(["official", "mirror", "custom"]).has(input.downloadSource)) throw invalid("Download source is invalid");
  if (typeof input.customDownloadUrl !== "string" || input.customDownloadUrl.length > 2_048) throw invalid("Custom download URL is invalid");
  assertCustomSource(input.downloadSource, input.customDownloadUrl);
  assertExactFields(input.notifications, NOTIFICATIONS, "Notification settings");
  if ([...NOTIFICATIONS].some((key) => typeof input.notifications[key] !== "boolean")) {
    throw invalid("Notification settings must be boolean");
  }
  await Promise.all([
    assertWritableDirectory(input.cachePath, "Cache path"),
    assertWritableDirectory(input.modelPath, "Model path"),
    assertWritableDirectory(input.backupPath, "Backup path"),
  ]);
  for (const path of [input.cachePath, input.modelPath, input.backupPath]) {
    if (protectedRoots.some((root) => {
      const nested = relative(resolve(root), resolve(path));
      return nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested));
    })) {
      throw invalid("System paths must not be inside the projects directory");
    }
  }
  return structuredClone({ ...input, translationProvider, translationModel, asrDefaultModelId, asrVad, asrVocalSeparation, asrSongHandling });
}

export function createAppSettingsService({ repository, defaults, protectedRoots = [] }) {
  const get = () => structuredClone({ asrVad: DEFAULT_ASR_VAD_SETTINGS, asrVocalSeparation: "off", asrSongHandling: "preserve", ...defaults, ...(repository.getAppSettings() ?? {}) });
  return {
    get,
    async save(settings) {
      const normalized = await normalizeSettings(settings, protectedRoots, defaults);
      if (resolve(normalized.modelPath) !== resolve(get().modelPath)) {
        throw invalid("模型目录只能通过“转移现有模型”功能修改");
      }
      return repository.saveAppSettings(normalized);
    },
    async relocateModelPath(modelPath) {
      return repository.saveAppSettings(await normalizeSettings({ ...get(), modelPath }, protectedRoots, defaults));
    },
    validate: (settings) => normalizeSettings(settings, protectedRoots, defaults),
    async reset() {
      return repository.saveAppSettings(await normalizeSettings({ ...defaults, modelPath: get().modelPath }, protectedRoots, defaults));
    },
  };
}
