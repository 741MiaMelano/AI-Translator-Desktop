import {
  TRANSLATION_PROVIDER_CATALOG,
  allowsFreeFormModelId,
  isSafeProviderModelId,
} from "../../shared/provider-registry.mjs";
import { ASR_MODEL_IDS } from "../../shared/asr-model-ids.mjs";
import { isProtectedTargetLayer } from "../../shared/target-text-state.mjs";
import type { ResourceLibrary, SubtitleStylePayload } from "./resource-library";

export type MediaKind = "video" | "audio" | "subtitle";
export type SourceTrackKind = "embedded_subtitle" | "asr" | "external_subtitle";
export type SourceLanguageState = "known" | "pending" | "multilingual";
export type ProjectLifecycle = "draft" | "ready" | "processing" | "needs_review" | "completed";
export type TargetTrackStatus = "draft" | "in_review" | "approved" | "exported";
export type TaskStatus =
  | "pending"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "recoverable"
  | "completed";
export type TaskStage = "detect" | "extract" | "asr" | "segment" | "translate" | "qa" | "export";
export type TaskKind = "media" | "asr" | "translate" | "qa" | "export";
export type QaIssueSeverity = "warning" | "error";

export interface QaIssue {
  id: string;
  ruleId?: string;
  label: string;
  severity: QaIssueSeverity;
  detail: string;
  segmentId?: string | null;
  languageCode?: string | null;
}

export interface SourceTextLayers {
  original: string;
  normalized: string;
  manual?: string;
}

export interface TargetTextLayers {
  model: string;
  postProcessed: string;
  manual?: string;
  previousManual?: string;
  locked?: boolean;
  /** Timeline/source drift marker; persisted, never UI-only. */
  stale?: boolean;
  origin?: string;
  qaFlags: string[];
}

export interface SourceManualHistoryEntry {
  kind: "source_manual";
  segmentId: string;
  beforeManual: string | null;
  afterManual: string | null;
}

export interface TargetReplaceHistoryEntry {
  kind: "target_replace";
  languageCode: string;
  changes: Array<{
    segmentId: string;
    before: TargetTextLayers;
    after: TargetTextLayers;
  }>;
}

export interface TimelineHistoryEntry {
  kind: "timeline";
  index: number;
  beforeSegments: Segment[];
  afterSegments: Segment[];
}

export type EditorHistoryEntry = SourceManualHistoryEntry | TargetReplaceHistoryEntry | TimelineHistoryEntry;

export interface EditorHistory {
  undoStack: EditorHistoryEntry[];
  redoStack: EditorHistoryEntry[];
}

export interface Segment {
  id: string;
  start: string;
  end: string;
  sourceLanguage: string;
  detectedLanguage?: string;
  languageConfidence?: number | null;
  languageDetectionMethod?: string;
  languageDetectionVersion?: string;
  languageOverlapStatus?: "none" | "overlap_unsupported";
  manualLanguage?: string;
  sourceText: SourceTextLayers;
  targetTexts: Record<string, TargetTextLayers>;
}

export interface TargetTrack {
  id: string;
  languageCode: string;
  languageLabel: string;
  status: TargetTrackStatus;
  isActive: boolean;
  qaIssues: QaIssue[];
  snapshotIds: string[];
  deliveryLabel: string;
  lastHumanAction: string;
  role?: "active" | "candidate";
  baseTrackId?: string | null;
  candidateTexts?: Record<string, TargetTextLayers>;
  trashedAt?: string;
  trashedWithSource?: boolean;
}

export interface SourceTrack {
  id: string;
  label: string;
  kind: SourceTrackKind;
  languageState: SourceLanguageState;
  defaultLanguage: string;
  isActive: boolean;
  summary: string;
  rawAssetRelativePath?: string;
  sourceStreamId?: string;
  asrRunId?: string;
  segmentationConfigVersion?: string;
  trashedAt?: string;
  segments: Segment[];
  targetTracks: TargetTrack[];
}

export type AsrModelId = (typeof ASR_MODEL_IDS)[number];

export interface ProjectConfig {
  sourceLanguage: string;
  targetLanguages: string[];
  provider: string;
  model: string;
  asrModelId?: AsrModelId | null;
  glossary: string;
  styleGuide: string;
  outputFormat: string;
  burnVideo: boolean;
  copyMediaIntoProject: boolean;
  /** One project-wide visual style. Resource presets are copied here, never linked live. */
  subtitleStyle?: SubtitleStylePayload;
  /**
   * Whether the automatic pipeline may call the paid translation provider on its own.
   * Chosen once on the create-project screen.
   *
   * Absent or false means semi-automatic: the pipeline runs every local step
   * (probe / extract / transcribe / segment) and then stops before spending tokens,
   * leaving the user to start translation from the translate stage. Translation is the
   * only step that costs money, so it is the only step this switch governs.
   */
  autoTranslate?: boolean;
}

export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa";
export type SubtitleNewline = "lf" | "crlf" | "cr" | "mixed" | "unknown";
export type ExportKind = "source" | "target" | "bilingual";

export interface SourceProbeSummary {
  subtitleFormat?: SubtitleFormat;
  encoding?: string;
  newline?: SubtitleNewline;
  warnings?: string[];
  formatSummary?: Record<string, unknown>;
  /** Bounded media probe when a Main Media Source exists; never raw ffprobe JSON. */
  media?: Record<string, unknown>;
}

export type MediaRelinkState = "available" | "missing" | "relink_required" | "invalid";

/** Renderer-safe media summary. Absolute paths never appear here. */
export interface MediaSourceSummary {
  assetId: string;
  displayName: string;
  availability: MediaRelinkState;
  identity: {
    sizeBytes: number | null;
    mtimeMs: number | null;
    fingerprint: string | null;
  } | null;
  selectedAudioStreamId: string | null;
  selectedSubtitleStreamId: string | null;
  /** Resolved by an unambiguous rule or an explicit user choice. */
  confirmedAudioStreamId: string | null;
  /** Resolved by an unambiguous rule or an explicit user choice. */
  confirmedSubtitleStreamId: string | null;
}

export interface Project {
  id: string;
  title: string;
  sourceFileName: string;
  mediaKind: MediaKind;
  noSourceMedia: boolean;
  lifecycle: ProjectLifecycle;
  createdAt: string;
  updatedAt: string;
  trashedAt?: string;
  archivedAt?: string;
  /** Null only for media-imported drafts that have not extracted a Source Track yet. */
  activeSourceTrackId: string | null;
  pendingConfirmations: string[];
  notes: string[];
  config: ProjectConfig;
  sourceTracks: SourceTrack[];
  recentRunIds: string[];
  /** Project-relative raw asset path only; never an absolute filesystem path. */
  sourceProjectRelativePath?: string;
  sourceProbeSummary?: SourceProbeSummary;
  mediaSource?: MediaSourceSummary | null;
  editorHistory?: EditorHistory;
}

export interface ProjectTask {
  id: string;
  projectId: string;
  /** Durable public association derived from the private task request snapshot. */
  batchId?: string;
  batchEstimatedTokens?: number;
  label: string;
  detail: string;
  stage: TaskStage;
  status: TaskStatus;
  progress: number;
  kind?: TaskKind;
  targetLanguageCode?: string;
  checkpointStage?: TaskStage | null;
  lastErrorCode?: string | null;
  retryable?: boolean;
  runSnapshotId?: string | null;
  /** Higher values run first among tasks that have not started. */
  priority?: number;
  sequence?: number;
  attempt?: number;
  pauseCapability?: "never" | "checkpoint";
  createdAt: string;
  updatedAt: string;
}

export type ProjectTaskControl = {
  action: "pause" | "resume" | "cancel" | "retry";
  label: string;
};

export function getLatestProjectTask(
  tasks: ProjectTask[],
  projectId: string,
): ProjectTask | undefined {
  return tasks
    .filter((task) => task.projectId === projectId)
    .reduce<ProjectTask | undefined>((latest, task) => (
      !latest || task.updatedAt > latest.updatedAt ? task : latest
    ), undefined);
}

export function getPrimaryTaskControl(task: ProjectTask): ProjectTaskControl | null {
  if (task.status === "running" || task.status === "pending") {
    return task.pauseCapability === "checkpoint"
      ? { action: "pause", label: task.status === "pending" ? "开始前暂停" : "暂停" }
      : { action: "cancel", label: "停止" };
  }
  if (task.status === "paused") return { action: "resume", label: "继续" };
  if (task.status === "recoverable") return { action: "resume", label: "确认继续" };
  if (task.status === "failed" && task.retryable !== false) return { action: "retry", label: "确认重试" };
  return null;
}

export function canStartProjectFromSelection(project: Project, latestTask?: ProjectTask): boolean {
  if (!["draft", "processing"].includes(project.lifecycle)) return false;
  if (latestTask?.status === "failed") return false;
  return latestTask?.kind !== "translate" || latestTask.status !== "completed";
}

export function getLatestProjectTranslationTask(
  tasks: ProjectTask[],
  projectId: string,
): ProjectTask | undefined {
  return tasks
    .filter((task) => task.projectId === projectId && (
      task.kind === "translate" || (!task.kind && task.stage === "translate")
    ))
    .reduce<ProjectTask | undefined>((latest, task) => (
      !latest || task.updatedAt > latest.updatedAt ? task : latest
    ), undefined);
}

/** Keep the newest durable state when translation.start returns after a fast worker update. */
export function mergeStartedTaskSnapshot(
  startedTask: ProjectTask | undefined,
  tasks: ProjectTask[],
): ProjectTask[] {
  if (!startedTask) return tasks;
  const refreshed = tasks.find((task) => task.id === startedTask.id);
  const latest = refreshed && (
    (refreshed.sequence ?? 0) > (startedTask.sequence ?? 0)
    || ((refreshed.sequence ?? 0) === (startedTask.sequence ?? 0)
      && refreshed.updatedAt >= startedTask.updatedAt)
  ) ? refreshed : startedTask;
  return [latest, ...tasks.filter((task) => task.id !== startedTask.id)];
}

export interface RunSnapshot {
  id: string;
  projectId: string;
  sourceTrackId: string;
  targetLanguageCode: string;
  provider: string;
  model: string;
  glossarySnapshot: string;
  styleGuideSnapshot: string;
  promptTemplateVersion: string;
  segmentVersion: string;
  createdAt: string;
  cacheHits: number;
  baseUrlDisplay?: string | null;
  transportMode?: ProviderTransportMode | null;
  parameters?: Record<string, unknown>;
  resourceSnapshot?: Record<string, unknown>;
  resourceFingerprint?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

export type CapabilityRuntimeStatus = "ready" | "attention" | "offline" | "unavailable";

export interface CapabilityProvider {
  id: string;
  name: string;
  kind: "llm" | "asr" | "local";
  status: CapabilityRuntimeStatus;
  summary: string;
  models: string[];
  /** Non-secret runtime metadata for UI; never includes secrets. */
  profile?: TranslationProviderProfile;
  transportMode?: ProviderTransportMode | null;
  baseUrlDisplay?: string | null;
  credentialConfigured?: boolean;
  unavailableReason?: string | null;
  supportedParameters?: string[];
}

export interface SettingsGroup {
  title: string;
  rows: Array<{ label: string; value: string }>;
}

export interface WorkspaceDefaults {
  sourceLanguage: string;
  targetLanguages: string[];
  provider: string;
  model: string;
  styleGuide: string;
  glossary: string;
  outputFormat: string;
}

export interface WorkspaceData {
  defaults: WorkspaceDefaults;
  projects: Project[];
  tasks: ProjectTask[];
  runSnapshots: RunSnapshot[];
  library: ResourceLibrary;
  capabilities: {
    providers: CapabilityProvider[];
    downloadSources: Array<{ name: string; status: string }>;
    devices: Array<{ name: string; status: string }>;
  };
  settings: SettingsGroup[];
}

export interface ProjectStatusSummary {
  tone: "gold" | "green" | "red" | "blue" | "gray";
  label: string;
  actionLabel: string;
  helperText: string;
}

export interface TargetLanguageDefinition {
  label: string;
  code: string;
}

export const TARGET_LANGUAGE_REGISTRY: readonly TargetLanguageDefinition[] = [
  { label: "简体中文", code: "zh-CN" },
  { label: "英语", code: "en-US" },
  { label: "日语", code: "ja-JP" },
] as const;

export const TARGET_LANGUAGE_OPTIONS = TARGET_LANGUAGE_REGISTRY.map((language) => language.label);

export type TranslationProviderProfile =
  | "openai_official"
  /** 协议同 OpenAI，但 base URL 固定为厂商官方入口，模型列表可在线拉取。 */
  | "openai_compatible_preset"
  | "openai_compatible_custom"
  | "anthropic_messages"
  | "deepl";

export type ProviderTransportMode = "responses" | "chat_completions" | "messages";

export type TranslationProviderRuntimeStatus =
  | "unconfigured"
  | "configured"
  | "ready"
  | "attention"
  | "offline"
  | "unavailable";

export interface TranslationProviderDefinition {
  id: string;
  name: string;
  models: readonly string[];
  profile: TranslationProviderProfile;
  /** When false, provider stays visible but cannot run real translation. */
  v1TranslationEnabled: boolean;
  unavailableReason?: string;
  defaultBaseUrl?: string;
  defaultTransport?: ProviderTransportMode;
  supportedTransports: readonly ProviderTransportMode[];
  supportedParameters: readonly string[];
  credentialId: string;
}

export interface TranslationSelection {
  provider: string;
  model: string;
}

export interface ProviderRuntimeState {
  credentialConfigured?: boolean;
  connectionStatus?: "untested" | "ok" | "failed";
  connectionMessage?: string;
  requestedModel?: string;
  modelId?: string;
  testedAt?: string;
  transportMode?: ProviderTransportMode | null;
  /** Safe display form only (no secrets/query credentials). */
  baseUrlDisplay?: string | null;
  configuredModels?: readonly string[];
}

export const OPENAI_COMPATIBLE_DEFAULT_PARAMETERS = [
  ...TRANSLATION_PROVIDER_CATALOG[0].supportedParameters,
] as const;

export const TRANSLATION_PROVIDER_REGISTRY: readonly TranslationProviderDefinition[] =
  TRANSLATION_PROVIDER_CATALOG.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => model.label),
    defaultTransport: provider.defaultTransport ?? undefined,
  }));

export const TRANSLATION_PROVIDER_OPTIONS = TRANSLATION_PROVIDER_REGISTRY.map(
  (provider) => provider.name,
);

export const DEFAULT_TRANSLATION_SELECTION: TranslationSelection = {
  provider: TRANSLATION_PROVIDER_REGISTRY[0].name,
  model: TRANSLATION_PROVIDER_REGISTRY[0].models[0],
};

export function resolveAsrLanguageSelection(sourceLanguage: string) {
  const normalized = sourceLanguage.trim().toLowerCase();
  if (["自动检测", "auto", "und"].includes(normalized)) {
    return { languageMode: "auto", languageHint: null } as const;
  }
  const languageHint = ({ 中文: "zh", 英语: "en", 日语: "ja", 韩语: "ko" } as Record<string, string>)[normalized]
    ?? /^([a-z]{2,3})(?:-[a-z]{2})?$/.exec(normalized)?.[1];
  if (!languageHint) throw new Error(`Unsupported ASR source language: ${sourceLanguage}`);
  return { languageMode: "fixed", languageHint } as const;
}

const translationProviderByName = new Map(
  TRANSLATION_PROVIDER_REGISTRY.map((provider) => [provider.name, provider] as const),
);

const translationProviderById = new Map(
  TRANSLATION_PROVIDER_REGISTRY.map((provider) => [provider.id, provider] as const),
);

export function getTranslationProviderByName(
  provider: string,
): TranslationProviderDefinition | undefined {
  return translationProviderByName.get(provider);
}

export function getTranslationProviderById(
  providerId: string,
): TranslationProviderDefinition | undefined {
  return translationProviderById.get(providerId);
}

export function getTranslationModelOptions(provider: string): readonly string[] {
  const definition = translationProviderByName.get(provider);
  if (!definition) {
    throw new Error(`Unsupported translation provider: ${provider}`);
  }
  return definition.models;
}

export function listSelectableTranslationProviders(): readonly TranslationProviderDefinition[] {
  return TRANSLATION_PROVIDER_REGISTRY.filter((provider) => provider.v1TranslationEnabled);
}

export function reconcileTranslationSelection(
  current: TranslationSelection,
  patch: Partial<TranslationSelection>,
): TranslationSelection {
  const nextProvider = patch.provider ?? current.provider;
  const nextModel = patch.model ?? current.model;

  if (!nextProvider || !nextModel) {
    throw new Error("还没有选择翻译服务商和模型");
  }

  const definition = translationProviderByName.get(nextProvider);
  if (!definition) {
    throw new Error(`Unsupported translation provider: ${nextProvider}`);
  }

  if (patch.provider !== undefined && patch.model === undefined) {
    if (definition.models.includes(current.model)) {
      return {
        provider: definition.name,
        model: current.model,
      };
    }

    return {
      provider: definition.name,
      model: definition.models[0],
    };
  }

  // 注册表 models 只是「内置兜底列表」，不是能力清单（见 shared/provider-registry.mjs）。
  // 「拉取模型」取回的真实型号 ID 不在这份列表里，必须与 IPC 校验层同一条规则放行，
  // 否则用户在下拉里选中拉取到的型号会在这里被拒——而调用方在 setState updater 里，
  // throw 会炸掉整棵 React 树。
  const modelAllowed =
    definition.models.includes(nextModel) ||
    (allowsFreeFormModelId(definition.profile) && isSafeProviderModelId(nextModel));
  if (!modelAllowed) {
    throw new Error(
      `Invalid translation selection: ${nextProvider} / ${nextModel}`,
    );
  }

  return {
    provider: definition.name,
    model: nextModel,
  };
}

export function resolveMostRecentSuccessfulTranslationSelection(
  runtimeByProviderId: Record<string, ProviderRuntimeState>,
): TranslationSelection | null {
  const candidates = TRANSLATION_PROVIDER_REGISTRY
    .map((provider) => ({ provider, runtime: runtimeByProviderId[provider.id] }))
    .filter(({ provider, runtime }) =>
      provider.v1TranslationEnabled && runtime?.credentialConfigured === true &&
      runtime.connectionStatus === "ok" && Number.isFinite(Date.parse(runtime.testedAt ?? "")))
    .sort((left, right) => Date.parse(right.runtime!.testedAt!) - Date.parse(left.runtime!.testedAt!));

  for (const { provider, runtime } of candidates) {
    const model = runtime!.requestedModel ?? runtime!.modelId ?? provider.models[0];
    try {
      return reconcileTranslationSelection(DEFAULT_TRANSLATION_SELECTION, {
        provider: provider.name,
        model,
      });
    } catch {
      // Ignore damaged persisted readiness and try the next successful provider.
    }
  }
  return null;
}

/**
 * Single runtime capability catalog for translation providers.
 * UI and app settings must consume this instead of parallel hardcoded arrays.
 */
export function buildTranslationCapabilityCatalog(
  runtimeByProviderId: Record<string, ProviderRuntimeState> = {},
): CapabilityProvider[] {
  return TRANSLATION_PROVIDER_REGISTRY.map((provider) => {
    const runtime = runtimeByProviderId[provider.id] ?? {};
    const models =
      runtime.configuredModels && runtime.configuredModels.length > 0
        ? [...runtime.configuredModels]
        : [...provider.models];

    if (!provider.v1TranslationEnabled) {
      return {
        id: provider.id,
        name: provider.name,
        kind: "llm" as const,
        status: "unavailable" as const,
        summary: provider.unavailableReason ?? "Provider is unavailable in V1.",
        models,
        profile: provider.profile,
        transportMode: null,
        baseUrlDisplay: null,
        credentialConfigured: Boolean(runtime.credentialConfigured),
        unavailableReason: provider.unavailableReason ?? "Provider is unavailable in V1.",
        supportedParameters: [...provider.supportedParameters],
      };
    }

    const credentialConfigured = Boolean(runtime.credentialConfigured);
    const connectionStatus = runtime.connectionStatus ?? "untested";
    let status: CapabilityRuntimeStatus = "attention";
    let summary = "凭据或连接测试尚未完成。";

    if (!credentialConfigured) {
      status = "offline";
      summary = "尚未填写 API Key。";
    } else if (connectionStatus === "ok") {
      status = "ready";
      summary = "凭据已保存，连接测试通过。";
    } else if (connectionStatus === "failed") {
      status = "attention";
      summary = runtime.connectionMessage || "连接测试未通过。";
    } else {
      // 真正翻译前后端会自动做一次短连接验证；前端不能因“尚未手动测试”
      // 把已经保存凭据的服务商拦成未配置。
      status = "ready";
      summary = "凭据已保存，首次使用时会自动检查连接。";
    }

    return {
      id: provider.id,
      name: provider.name,
      kind: "llm" as const,
      status,
      summary,
      models,
      profile: provider.profile,
      transportMode: runtime.transportMode ?? provider.defaultTransport ?? null,
      baseUrlDisplay: runtime.baseUrlDisplay ?? provider.defaultBaseUrl ?? null,
      credentialConfigured,
      unavailableReason: null,
      supportedParameters: [...provider.supportedParameters],
    };
  });
}

/** IPC / persistence allowlist derived from the same registry SSOT. */
export function getTranslationProviderModelAllowlist(): Record<string, string[]> {
  return Object.fromEntries(
    TRANSLATION_PROVIDER_REGISTRY.map((provider) => [provider.name, [...provider.models]]),
  );
}

const targetLanguageByLabel = new Map(
  TARGET_LANGUAGE_REGISTRY.map((language) => [language.label, language] as const),
);

function resolveTargetLanguage(label: string): TargetLanguageDefinition {
  const language = targetLanguageByLabel.get(label);
  if (!language) {
    throw new Error(`Unsupported target language: ${label}`);
  }
  return language;
}

function hasProtectedTargetText(text: TargetTextLayers | undefined): boolean {
  return isProtectedTargetLayer(text);
}

function createEmptyTargetText(): TargetTextLayers {
  return {
    model: "",
    postProcessed: "",
    stale: false,
    qaFlags: [],
  };
}

function allocateTargetTrackId(
  sourceTrackId: string,
  languageCode: string,
  occupiedIds: Set<string>,
): string {
  const baseId = `target-${sourceTrackId}-${languageCode}`;
  if (!occupiedIds.has(baseId)) {
    occupiedIds.add(baseId);
    return baseId;
  }

  let suffix = 2;
  while (occupiedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }

  const nextId = `${baseId}-${suffix}`;
  occupiedIds.add(nextId);
  return nextId;
}

function createTargetTrack(
  sourceTrackId: string,
  language: TargetLanguageDefinition,
  occupiedIds: Set<string>,
): TargetTrack {
  return {
    id: allocateTargetTrackId(sourceTrackId, language.code, occupiedIds),
    languageCode: language.code,
    languageLabel: language.label,
    status: "draft",
    isActive: true,
    qaIssues: [],
    snapshotIds: [],
    deliveryLabel: "未开跑",
    lastHumanAction: "等待首次处理",
  };
}

function assertNoProtectedTargetTextsWillBeRemoved(
  sourceTrack: SourceTrack,
  nextCodes: Set<string>,
): void {
  const labelByCode = new Map(
    sourceTrack.targetTracks.map((track) => [track.languageCode, track.languageLabel] as const),
  );
  for (const language of TARGET_LANGUAGE_REGISTRY) {
    if (!labelByCode.has(language.code)) {
      labelByCode.set(language.code, language.label);
    }
  }

  for (const segment of sourceTrack.segments) {
    for (const [languageCode, text] of Object.entries(segment.targetTexts)) {
      if (nextCodes.has(languageCode) || !hasProtectedTargetText(text)) {
        continue;
      }

      const label = labelByCode.get(languageCode) ?? languageCode;
      throw new Error(
        `Cannot remove target language ${label} (${languageCode}) because protected human edits exist`,
      );
    }
  }
}

export function setTargetLanguages(project: Project, nextTargetLanguages: string[]): Project {
  if (!Array.isArray(nextTargetLanguages) || nextTargetLanguages.length === 0) {
    throw new Error("至少要选择一种目标语言");
  }

  const uniqueLabels = new Set(nextTargetLanguages);
  if (uniqueLabels.size !== nextTargetLanguages.length) {
    throw new Error("目标语言不能重复");
  }

  const resolvedLanguages = nextTargetLanguages.map(resolveTargetLanguage);
  const nextCodes = new Set(resolvedLanguages.map((language) => language.code));

  const activeSourceTrack = getActiveSourceTrack(project);
  if (!activeSourceTrack) {
    throw new Error("项目还没有可用的源字幕轨，请先提取内嵌字幕");
  }

  assertNoProtectedTargetTextsWillBeRemoved(activeSourceTrack, nextCodes);

  const nextTargetTracks: TargetTrack[] = activeSourceTrack.targetTracks.map((track) => {
    if (!nextCodes.has(track.languageCode)) {
      return track.isActive ? { ...track, isActive: false } : track;
    }
    return track;
  });
  const occupiedIds = new Set(nextTargetTracks.map((track) => track.id));

  for (const language of resolvedLanguages) {
    const sameLanguage = nextTargetTracks.filter((track) => track.languageCode === language.code);
    if (sameLanguage.length === 0) {
      nextTargetTracks.push(createTargetTrack(activeSourceTrack.id, language, occupiedIds));
      continue;
    }

    const preferredActive =
      sameLanguage.find((track) => track.isActive) ?? sameLanguage[0];

    for (let index = 0; index < nextTargetTracks.length; index += 1) {
      const track = nextTargetTracks[index];
      if (track.languageCode !== language.code) {
        continue;
      }

      nextTargetTracks[index] = {
        ...track,
        isActive: track.id === preferredActive.id,
      };
    }
  }

  const nextSegments = activeSourceTrack.segments.map((segment) => {
    const nextTargetTexts: Record<string, TargetTextLayers> = {};

    for (const [languageCode, text] of Object.entries(segment.targetTexts)) {
      if (nextCodes.has(languageCode)) {
        nextTargetTexts[languageCode] = text;
      }
    }

    for (const language of resolvedLanguages) {
      if (!nextTargetTexts[language.code]) {
        nextTargetTexts[language.code] = createEmptyTargetText();
      }
    }

    return {
      ...segment,
      targetTexts: nextTargetTexts,
    };
  });

  return {
    ...project,
    config: {
      ...project.config,
      targetLanguages: [...nextTargetLanguages],
    },
    sourceTracks: project.sourceTracks.map((track) =>
      track.id === activeSourceTrack.id
        ? {
            ...track,
            targetTracks: nextTargetTracks,
            segments: nextSegments,
          }
        : track,
    ),
  };
}

export function getActiveSourceTrack(project: Project): SourceTrack | null {
  if (!project.activeSourceTrackId) return null;
  return project.sourceTracks.find((track) => track.id === project.activeSourceTrackId) ?? null;
}

export function getActiveTargetTracks(project: Project): TargetTrack[] {
  const source = getActiveSourceTrack(project);
  return source ? source.targetTracks.filter((track) => track.isActive) : [];
}

export function getTargetTrack(project: Project, languageCode: string): TargetTrack | undefined {
  const source = getActiveSourceTrack(project);
  if (!source) return undefined;
  return source.targetTracks.find((track) => track.languageCode === languageCode && track.isActive);
}

export function countQaIssues(targetTracks: TargetTrack[], severity: QaIssueSeverity): number {
  return targetTracks.reduce(
    (total, track) => total + track.qaIssues.filter(
      (issue) => issue.severity === severity && isActionableQaIssue(issue),
    ).length,
    0,
  );
}

/** 旧版本把正常的长静音当成问题；保留数据兼容，但正式界面不再展示。 */
export function isActionableQaIssue(issue: QaIssue): boolean {
  return issue.ruleId !== "qa.gap" && !issue.id.startsWith("qa.gap:");
}

export function deriveProjectStatusSummary(project: Project): ProjectStatusSummary {
  const activeTargets = getActiveTargetTracks(project);
  const approvedCount = activeTargets.filter(
    (track) => track.status === "approved" || track.status === "exported",
  ).length;
  const warningCount = countQaIssues(activeTargets, "warning");

  if (project.lifecycle === "draft") {
    return {
      tone: "gray",
      label: "草稿",
      actionLabel: "开始处理",
      helperText: "项目已创建，尚未开始处理。",
    };
  }

  if (project.pendingConfirmations.length > 0) {
    return {
      tone: "red",
      label: "待确认",
      actionLabel: "处理待确认",
      helperText: project.pendingConfirmations[0],
    };
  }

  if (project.lifecycle === "processing") {
    return {
      tone: "blue",
      label: "处理中",
      actionLabel: "查看运行中任务",
      helperText: "主源轨已确定，当前流程正在继续推进。",
    };
  }

  if (approvedCount > 0) {
    return {
      tone: "green",
      label: "可交付",
      actionLabel: "导出已批准语言",
      helperText: `已有 ${approvedCount} 个目标语言达到可交付状态。`,
    };
  }

  if (project.lifecycle === "needs_review" || warningCount > 0) {
    return {
      tone: "gold",
      label: "待校对",
      actionLabel: "进入校对",
      helperText: warningCount > 0
        ? `当前译文有 ${warningCount} 条可选的优化建议。`
        : "译文已生成，可以进入字幕编辑检查并确认。",
    };
  }

  return {
    tone: "gray",
    label: "待继续",
    actionLabel: "继续配置",
    helperText: "项目结构已就位，可以继续补参数或发起处理。",
  };
}

export function getLatestRun(project: Project, runs: RunSnapshot[]): RunSnapshot | undefined {
  return runs.find((run) => run.id === project.recentRunIds[0]);
}

export function isProjectTrashed(project: Project): boolean {
  return Boolean(project.trashedAt);
}

export function getActiveProjects(projects: Project[]): Project[] {
  return projects.filter((project) => !isProjectTrashed(project));
}

export function getTrashedProjects(projects: Project[]): Project[] {
  return projects.filter(isProjectTrashed);
}

export function getTargetSegmentText(segment: Segment, languageCode: string): TargetTextLayers | undefined {
  return segment.targetTexts[languageCode];
}

export function getProjectPriority(project: Project): number {
  const summary = deriveProjectStatusSummary(project);
  const ranking: Record<ProjectStatusSummary["tone"], number> = {
    red: 0,
    blue: 1,
    gold: 2,
    gray: 3,
    green: 4,
  };

  return ranking[summary.tone];
}

export function sortProjectsByPriority(projects: Project[]): Project[] {
  return [...projects].sort((left, right) => {
    const archiveDiff = Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt));
    if (archiveDiff !== 0) {
      return archiveDiff;
    }
    const priorityDiff = getProjectPriority(left) - getProjectPriority(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function formatMediaKind(kind: MediaKind): string {
  if (kind === "video") {
    return "视频";
  }

  if (kind === "audio") {
    return "音频";
  }

  return "字幕";
}

export function formatTargetTrackStatus(status: TargetTrackStatus): string {
  if (status === "in_review") {
    return "复核中";
  }

  if (status === "approved") {
    return "已批准";
  }

  if (status === "exported") {
    return "已导出";
  }

  return "草稿";
}

export function formatTaskStatus(status: TaskStatus): string {
  if (status === "running") {
    return "运行中";
  }

  if (status === "paused") {
    return "已暂停";
  }

  if (status === "pausing") {
    return "正在暂停";
  }

  if (status === "cancelling") {
    return "正在取消";
  }

  if (status === "cancelled") {
    return "已取消";
  }

  if (status === "recoverable") {
    return "可恢复";
  }

  if (status === "completed") {
    return "已完成";
  }

  if (status === "failed") {
    return "失败";
  }

  return "排队中";
}
