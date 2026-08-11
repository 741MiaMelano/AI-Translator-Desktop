import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getActiveSourceTrack,
  getLatestProjectTranslationTask,
  getTranslationModelOptions,
  buildTranslationCapabilityCatalog,
  listSelectableTranslationProviders,
  mergeStartedTaskSnapshot,
  reconcileTranslationSelection,
  resolveAsrLanguageSelection,
  resolveMostRecentSuccessfulTranslationSelection,
  setTargetLanguages,
  TARGET_LANGUAGE_OPTIONS,
  TRANSLATION_PROVIDER_OPTIONS,
} from "../domain/workspace";
import {
  planAutomaticWorkflow,
  type AutomaticWorkflowAnswer,
  type AutomaticWorkflowStage,
  type AutomaticWorkflowState,
} from "../domain/automatic-workflow";
import type {
  MediaKind,
  Project,
  ProjectTask,
  ProviderRuntimeState,
  RunSnapshot,
  Segment,
  TargetTrackStatus,
  TranslationSelection,
  WorkspaceData,
  WorkspaceDefaults,
} from "../domain/workspace";
import {
  adoptProjectCandidateSegment,
  approveProjectTargetTrack,
  createProjectCandidateTrack,
  editProjectTimeline,
  planProjectSelectedRerun,
  redoProjectEdit as redoProjectEditState,
  refreshProjectTargetQa,
  replaceProjectTargetTexts,
  setProjectSourceManual,
  setProjectTargetLocked,
  setProjectTargetManual,
  undoProjectEdit as undoProjectEditState,
  type TimelineEditCommand,
} from "../domain/project-editor";
import { approveProjectDelivery } from "../domain/project-delivery";
import { workspaceMock } from "../mock/workspace";
import {
  desktopActivateMediaSourceTrack,
  desktopGetCredentialStatus,
  desktopGetAppSettings,
  desktopGetProviderRuntimeState,
  desktopCreateProject,
  desktopCreateProjectPackage,
  desktopExportSubtitleMatrix,
  desktopExportSubtitleVideo,
  desktopExportSourceSubtitle,
  desktopExtractMediaAudio,
  desktopExtractMediaSubtitle,
  desktopGetMediaPreviewUrl,
  desktopGetMediaWaveform,
  desktopGetAsrCapabilityStatus,
  desktopGetAsrProjectStatus,
  desktopRunAsrTranscription,
  desktopSegmentAsrRun,
  desktopDetectAsrSegmentLanguages,
  desktopUpdateAsrSegmentLanguages,
  desktopCancelAsrProjectOperation,
  desktopControlTask,
  desktopCreateBatchSession,
  desktopCommitBatchSession,
  desktopDiscardBatchSession,
  desktopGetProjectRuntimeState,
  desktopImportSubtitle,
  desktopListRecentProjects,
  desktopListResources,
  desktopSaveProject,
  desktopSaveResource,
  desktopDeleteResource,
  desktopDeleteProjectPermanently,
  desktopExportApprovedBatch,
  desktopRefreshProjectResourceSnapshot,
  desktopOnBeforeClose,
  desktopOnWorkerEvent,
  desktopOpenProject,
  desktopProbeMedia,
  desktopRelinkMedia,
  desktopSelectMediaSource,
  desktopSelectMediaStreams,
  desktopStartTranslation,
  desktopSubscribeTasks,
  desktopWindowControl,
  isDesktopRuntime,
} from "../services/desktop-client";
import { projectSaveScheduler } from "../services/project-save-scheduler";
import {
  archiveProject as archiveProjectState,
  emptyTrackTrash,
  restoreSourceTrack,
  restoreTargetTrack,
  trashSourceTrack,
  trashTargetTrack,
} from "../../shared/project-trash-lifecycle.mjs";
import type {
  AsrCancelRequest,
  AsrLanguageDetectRequest,
  AsrLanguageUpdateRequest,
  AsrProjectStatusResponse,
  AsrSegmentRequest,
  AsrTranscribeRequest,
  BatchImportAmbiguity,
  ExportSubtitleMatrixResponse,
  SubtitleExportRequestItem,
  SubtitleEncodingChoice,
  TaskControlRequest,
} from "../contracts/desktop-api";
import type {
  AnyGlobalResource,
  ResourceKind,
  ResourceLibrary,
  ResourceWriteInput,
} from "../domain/resource-library";
import { localizeIpcErrorText } from "../i18n/errors";

export { TARGET_LANGUAGE_OPTIONS, TRANSLATION_PROVIDER_OPTIONS };

/**
 * 只列出 V1 真正能用于翻译的服务商。
 * 旧版直接用 TRANSLATION_PROVIDER_OPTIONS（包含全部注册项），
 * 于是 DeepL 这种明确未接入的选项也能被选中，选完翻译必然失败。
 */
export const PROVIDER_OPTIONS = listSelectableTranslationProviders().map((provider) => provider.name);

export const SOURCE_LANGUAGE_OPTIONS = ["自动检测", "中文", "英语", "日语", "韩语"];

export const GLOSSARY_NONE = "关闭术语约束";

/**
 * 术语表与风格指南的下拉选项必须来自运行时真实加载的资源库。
 * 旧版是模块级常量、map 自 workspaceMock，导致用户自己新建的术语表永远不出现在下拉里，
 * 而下拉里列的全是 src/mock/resource-library.ts 的假条目。
 */
export function deriveGlossaryOptions(library: ResourceLibrary): string[] {
  return [...library.glossaries.map((resource) => resource.name), GLOSSARY_NONE];
}

export function deriveStyleGuideOptions(library: ResourceLibrary): string[] {
  return library.styleGuides.map((resource) => resource.name);
}

/**
 * 把当前已保存的值并入选项列表。
 * 资源库是运行时加载的，项目里存的术语表名可能已被改名或删除；
 * 不做这一步，原生 select 会静默选中第一项，把用户的配置改掉。
 */
export function optionsWithCurrent(options: readonly string[], value: string): string[] {
  return options.includes(value) ? [...options] : [...options, value];
}

export const OUTPUT_FORMAT_OPTIONS = ["双语 SRT", "SRT + ASS", "SRT", "VTT"];
export { getTranslationModelOptions };

/**
 * reconcile 对损坏数据仍会 throw，而它的调用点全在 setState 的 updater 函数里——
 * React 会在 render 阶段重放 updater，未捕获的异常会把整棵树卸载成白屏
 * （无边框窗口连自绘标题栏一起消失，用户看到的就是「整个应用卡死」）。
 * 归一化失败时保持原有选择不变，绝不让异常穿出 updater。
 */
function reconcileSelectionOrKeep(
  current: TranslationSelection,
  patch: { provider?: string; model?: string },
): TranslationSelection {
  try {
    return reconcileTranslationSelection(current, patch);
  } catch {
    return { provider: current.provider, model: current.model };
  }
}

interface BatchFile {
  id: string;
  name: string;
  type?: string;
  mediaKind: MediaKind;
  suggestedProjectTitle: string;
  probe?: Record<string, unknown>;
  encodingCandidates?: SubtitleEncodingChoice[];
}

interface BatchGroup {
  id: string;
  title: string;
  confidence: "high" | "low";
  fileIds: string[];
  overrides: Partial<WorkspaceDefaults>;
}

interface BatchSession {
  id: string;
  createdAt: string;
  defaults: WorkspaceDefaults;
  files: BatchFile[];
  groups: BatchGroup[];
  ambiguities: BatchImportAmbiguity[];
  fileEncodings: Record<string, SubtitleEncodingChoice>;
}

interface DraftProjectOptions {
  titleSuffix?: string;
  note?: string;
}

interface ActiveBatch {
  id: string;
  projectIds: string[];
  startedAt?: string;
}

type FileImportResult =
  | { status: "imported"; projectIds: string[] }
  | { status: "review" }
  | { status: "failed" };

interface LocalImportFile {
  name: string;
  type?: string;
  size?: number;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

interface PendingEncodingImport {
  file: LocalImportFile;
  options?: DraftProjectOptions;
  candidates: SubtitleEncodingChoice[];
}

type ProjectConfigPatch = Partial<Omit<Project["config"], "targetLanguages">>;

type TranslationStartOptions = {
  model?: string;
  baseUrl?: string;
  transportMode?: "responses" | "chat_completions";
  targetLanguages?: string[];
  segmentIds?: string[];
  candidateTrackId?: string;
  batchId?: string;
  batchEstimatedTokens?: number;
  /** One-run acknowledgement; never persisted or forwarded to a provider. */
  allowUnsafeSource?: boolean;
};

type WorkspaceLoadState = "loading" | "ready" | "error";

interface WorkspaceContextValue extends WorkspaceData {
  batchSession: BatchSession | null;
  activeBatch: ActiveBatch | null;
  /** 重新拉取翻译能力目录（凭据是否已配置、连接是否验证过）。保存或测试连接后调用 */
  refreshCapabilities: () => Promise<void>;
  /** 术语表下拉选项，来自运行时真实加载的资源库（不是 mock） */
  glossaryOptions: string[];
  /** 风格指南下拉选项，来自运行时真实加载的资源库（不是 mock） */
  styleGuideOptions: string[];
  loadState: WorkspaceLoadState;
  loadError: string | null;
  saveError: string | null;
  encodingConfirmation: { fileName: string; candidates: SubtitleEncodingChoice[] } | null;
  isDesktop: boolean;
  automaticWorkflows: Record<string, AutomaticWorkflowState>;
  retryLoadProjects: () => void;
  flushBeforeClose: () => Promise<boolean>;
  saveLibraryResource: (
    resource: ResourceWriteInput,
    expectedRevision?: number,
  ) => Promise<{ ok: true; resource: AnyGlobalResource } | { ok: false; message: string }>;
  deleteLibraryResource: (
    resourceId: string,
    expectedRevision: number,
  ) => Promise<{ ok: boolean; message?: string }>;
  refreshProjectResourceSnapshot: (
    projectId: string,
    resourceId: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  updateDefaults: (patch: Partial<WorkspaceDefaults>) => void;
  updateProjectConfig: (projectId: string, patch: ProjectConfigPatch) => void;
  setProjectTargetLanguages: (
    projectId: string,
    nextTargetLanguages: string[],
  ) => string | null;
  trashProject: (projectId: string) => Promise<{ ok: boolean; message?: string }>;
  restoreProject: (projectId: string) => void;
  clearTrashedProjects: () => Promise<{ ok: boolean; message?: string; deletedCount?: number }>;
  setProjectArchived: (projectId: string, archived: boolean) => { ok: boolean; message?: string };
  trashProjectSourceTrack: (projectId: string, sourceTrackId: string) => { ok: boolean; message?: string };
  restoreProjectSourceTrack: (projectId: string, sourceTrackId: string) => { ok: boolean; message?: string };
  trashProjectTargetTrack: (projectId: string, targetTrackId: string) => { ok: boolean; message?: string };
  restoreProjectTargetTrack: (projectId: string, targetTrackId: string) => { ok: boolean; message?: string };
  emptyProjectTrackTrash: (projectId: string) => { ok: boolean; message?: string };
  createDraftProject: (
    file: LocalImportFile,
    options?: DraftProjectOptions,
  ) => Promise<string | null>;
  importDesktopMediaSource: (options?: { copyIntoProject?: boolean }) => Promise<string | null>;
  probeProjectMedia: (projectId: string) => Promise<{ ok: boolean; message?: string }>;
  selectProjectMediaStreams: (
    projectId: string,
    selection: { audioStreamId?: string | null; subtitleStreamId?: string | null },
  ) => Promise<{ ok: boolean; message?: string }>;
  extractProjectSubtitle: (
    projectId: string,
    streamId: string,
  ) => Promise<{ ok: boolean; message?: string; candidateSourceTrackId?: string }>;
  exportProjectAudio: (
    projectId: string,
  ) => Promise<{ ok: boolean; canceled?: boolean; message?: string; fileName?: string }>;
  activateProjectSourceTrack: (
    projectId: string,
    sourceTrackId: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  relinkProjectMedia: (projectId: string) => Promise<{ ok: boolean; message?: string }>;
  getProjectMediaPreviewUrl: (
    projectId: string,
  ) => Promise<{ ok: true; url: string; mediaKind: string } | { ok: false; message: string }>;
  getProjectMediaWaveform: (
    projectId: string,
  ) => Promise<{ ok: true; durationMs: number; peaks: number[] } | { ok: false; message: string }>;
  getProjectAsrStatus: (projectId: string) => Promise<{ ok: true; data: AsrProjectStatusResponse } | { ok: false; message: string }>;
  runProjectAsr: (request: AsrTranscribeRequest) => Promise<{ ok: boolean; message?: string; runId?: string }>;
  segmentProjectAsrRun: (request: AsrSegmentRequest) => Promise<{ ok: boolean; message?: string; sourceTrackId?: string }>;
  detectProjectAsrLanguages: (request: AsrLanguageDetectRequest) => Promise<{ ok: boolean; message?: string; pendingSegmentIds?: string[] }>;
  updateProjectAsrLanguages: (request: AsrLanguageUpdateRequest) => Promise<{ ok: boolean; message?: string; affectedSegmentIds?: string[]; pendingSegmentIds?: string[] }>;
  cancelProjectAsrOperation: (request: AsrCancelRequest) => Promise<{ ok: boolean; message?: string; cancelled?: boolean }>;
  controlTask: (request: TaskControlRequest) => Promise<{ ok: boolean; message?: string; task?: ProjectTask }>;
  confirmSubtitleEncoding: (encoding: SubtitleEncodingChoice) => Promise<string | null>;
  cancelSubtitleEncoding: () => void;
  updateSourceSegmentManual: (
    projectId: string,
    segmentId: string,
    manualText: string | undefined,
  ) => void;
  undoProjectEdit: (projectId: string) => void;
  redoProjectEdit: (projectId: string) => void;
  exportSourceSubtitle: (
    projectId: string,
    mode: "raw" | "normalized",
    format?: "srt" | "vtt" | "ass",
  ) => Promise<
    { ok: true; canceled: true }
    | { ok: true; canceled: false; fileName: string; warnings: string[] }
    | { ok: false; message: string }
  >;
  exportSubtitleMatrix: (
    projectId: string,
    requests: SubtitleExportRequestItem[],
    destination?: "project" | "user",
  ) => Promise<
    { ok: true; summary: ExportSubtitleMatrixResponse }
    | { ok: false; message: string }
  >;
  exportSubtitleVideo: (
    projectId: string,
    languageCode: string,
    mode: "soft_subtitle" | "burn_ass",
  ) => Promise<{ ok: boolean; canceled?: boolean; message?: string; fileName?: string }>;
  createProjectPackage: (
    projectId: string,
    kind: "lightweight" | "archive",
    includeTrash?: boolean,
  ) => Promise<{ ok: boolean; message?: string; fileName?: string }>;
  createBatchSession: (files: File[]) => Promise<boolean>;
  importFiles: (files: File[], options?: DraftProjectOptions) => Promise<FileImportResult>;
  updateBatchSessionDefaults: (patch: Partial<WorkspaceDefaults>) => void;
  updateBatchGroupTitle: (groupId: string, title: string) => void;
  updateBatchGroupDefaults: (
    groupId: string,
    patch: Partial<WorkspaceDefaults> | null,
  ) => void;
  mergeBatchGroupIntoPrevious: (groupId: string) => void;
  splitBatchGroup: (groupId: string) => void;
  resolveBatchMediaMatch: (fileId: string, mediaFileId: string | null) => void;
  resolveBatchSubtitleEncoding: (fileId: string, encoding: SubtitleEncodingChoice) => void;
  commitBatchSession: () => Promise<ActiveBatch | null>;
  startBatch: (batch?: ActiveBatch) => Promise<{ ok: true } | { ok: false; message: string }>;
  discardBatchSession: () => void;
  startProject: (
    projectId: string,
    options?: TranslationStartOptions,
    /** ok 表示「任务已排入队列」，不表示「已经译完」；进度与失败原因看任务流。 */
  ) => Promise<{ ok: true; taskId?: string } | { ok: false; message: string }>;
  runAutomaticProjectWorkflow: (
    projectId: string,
    options?: TranslationStartOptions,
  ) => Promise<AutomaticWorkflowState>;
  resolveAutomaticWorkflowBlock: (
    projectId: string,
    answer: AutomaticWorkflowAnswer,
  ) => Promise<{ ok: boolean; message?: string }>;
  cancelAutomaticProjectWorkflow: (
    projectId: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  resolvePendingConfirmations: (projectId: string) => void;
  markTargetTrackStatus: (
    projectId: string,
    languageCode: string,
    status: TargetTrackStatus,
  ) => { ok: boolean; message?: string };
  exportTargetTrack: (
    projectId: string,
    languageCode: string,
  ) => Promise<{ ok: boolean; canceled?: boolean; message?: string; summary?: ExportSubtitleMatrixResponse }>;
  approveAndExportProjectTargets: (
    projectId: string,
  ) => Promise<{
    ok: boolean;
    canceled?: boolean;
    blocked?: boolean;
    approvedCount?: number;
    message?: string;
    summary?: ExportSubtitleMatrixResponse;
  }>;
  approveAndExportBatchTargets: (
    projectIds: string[],
  ) => Promise<{
    ok: boolean;
    canceled?: boolean;
    approvedProjectCount?: number;
    exportedProjectCount?: number;
    exportedFileCount?: number;
    blockedProjectCount?: number;
    message?: string;
  }>;
  updateSegmentTranslation: (
    projectId: string,
    languageCode: string,
    segmentId: string,
    manualText: string,
  ) => { ok: boolean; message?: string };
  setTargetSegmentLocked: (
    projectId: string,
    languageCode: string,
    segmentId: string,
    locked: boolean,
  ) => { ok: boolean; message?: string };
  editTimeline: (projectId: string, command: TimelineEditCommand) => { ok: boolean; message?: string };
  refreshTargetTrackQa: (projectId: string, languageCode: string) => { ok: boolean; message?: string };
  replaceTargetTexts: (
    projectId: string,
    languageCode: string,
    findText: string,
    replaceText: string,
    scopeSegmentIds?: string[] | null,
    matchField?: "target" | "source",
  ) => { ok: boolean; message?: string; replacedCount?: number; skippedLockedCount?: number };
  rerunSegment: (
    projectId: string,
    languageCode: string,
    segmentId: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  createCandidateTranslation: (
    projectId: string,
    languageCode: string,
  ) => Promise<{ ok: boolean; message?: string; candidateTrackId?: string }>;
  adoptCandidateText: (
    projectId: string,
    candidateTrackId: string,
    segmentId: string,
  ) => { ok: boolean; message?: string };
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const MAX_LOCAL_SUBTITLE_BYTES = 8 * 1024 * 1024;

function knownMediaKind(fileName: string): MediaKind | undefined {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (extension === "mp3" || extension === "wav" || extension === "m4a") {
    return "audio";
  }

  if (extension === "srt" || extension === "ass" || extension === "ssa" || extension === "vtt") {
    return "subtitle";
  }

  if (["mp4", "mov", "mkv", "avi", "webm"].includes(extension ?? "")) {
    return "video";
  }

  return undefined;
}

function inferMediaKind(fileName: string): MediaKind {
  return knownMediaKind(fileName) ?? "video";
}

function removeExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function timestampNow(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const AUTOMATIC_STAGE_MESSAGES: Record<AutomaticWorkflowStage, string> = {
  checking: "正在检查文件与本地语音识别组件…",
  extracting: "正在提取媒体自带字幕…",
  recognizing: "正在把声音转成字幕…",
  segmenting: "正在整理字幕与时间轴…",
  detecting_language: "正在确认原文语言…",
  activating: "正在准备可翻译字幕…",
  starting_translation: "字幕已准备好，正在开始翻译…",
};

function cloneDefaults(defaults: WorkspaceDefaults): WorkspaceDefaults {
  return {
    ...defaults,
    targetLanguages: [...defaults.targetLanguages],
  };
}

function buildBatchFile(file: { name: string; type?: string }): BatchFile {
  return {
    id: createId("batch-file"),
    name: file.name,
    type: file.type,
    mediaKind: inferMediaKind(file.name),
    suggestedProjectTitle: removeExtension(file.name),
  };
}

function pickPrimaryBatchFile(files: BatchFile[]): BatchFile {
  const rank: Record<MediaKind, number> = {
    video: 0,
    audio: 1,
    subtitle: 2,
  };

  return [...files].sort((left, right) => rank[left.mediaKind] - rank[right.mediaKind])[0];
}

function deriveBatchGroupConfidence(files: BatchFile[]): "high" | "low" {
  const hasMainMedia = files.some((file) => file.mediaKind === "video" || file.mediaKind === "audio");
  const hasSubtitle = files.some((file) => file.mediaKind === "subtitle");
  return files.length > 1 && hasMainMedia && hasSubtitle ? "high" : "low";
}

function createSingleFileGroup(
  file: BatchFile,
  overrides: Partial<WorkspaceDefaults> = {},
): BatchGroup {
  return {
    id: createId("batch-group"),
    title: file.suggestedProjectTitle,
    confidence: "low",
    fileIds: [file.id],
    overrides,
  };
}

function buildBatchGroups(files: BatchFile[]): BatchGroup[] {
  return files.map((file) => createSingleFileGroup(file));
}

function getBatchGroupFiles(files: BatchFile[], group: BatchGroup): BatchFile[] {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  return group.fileIds
    .map((fileId) => fileMap.get(fileId))
    .filter((file): file is BatchFile => Boolean(file));
}

function buildDraftSegments(): Segment[] {
  return [
    {
      id: "draft-segment-1",
      start: "00:00:02,000",
      end: "00:00:05,800",
      sourceLanguage: "auto",
      sourceText: {
        original: "这里会在接入真实后端后替换成实际识别结果。",
        normalized: "这里会在接入真实后端后替换成实际识别结果。",
      },
      targetTexts: {},
    },
    {
      id: "draft-segment-2",
      start: "00:00:06,200",
      end: "00:00:10,400",
      sourceLanguage: "auto",
      sourceText: {
        original: "把字幕翻译、校对和导出放在同一条工作流里，会让处理过程更清晰。",
        normalized: "把字幕翻译、校对和导出放在同一条工作流里，会让处理过程更清晰。",
      },
      targetTexts: {},
    },
  ];
}

function buildDraftProject(
  defaults: WorkspaceDefaults,
  file: { name: string; type?: string },
  options: DraftProjectOptions = {},
): Project {
  const mediaKind = inferMediaKind(file.name);
  const noSourceMedia = mediaKind === "subtitle";
  const now = timestampNow();
  const uniqueId = createId("draft");
  const projectId = `project-${uniqueId}`;
  const sourceTrackId = `source-${uniqueId}`;

  const skeleton: Project = {
    id: projectId,
    title: `${removeExtension(file.name)}${options.titleSuffix ?? ""}`,
    sourceFileName: file.name,
    mediaKind,
    noSourceMedia,
    lifecycle: "draft",
    createdAt: now,
    updatedAt: now,
    activeSourceTrackId: sourceTrackId,
    pendingConfirmations:
      mediaKind === "video"
        ? ["开始处理后会优先确认推荐主源轨，默认先看是否存在可提取字幕轨。"]
        : [],
    notes: [
      ...(options.note ? [options.note] : []),
      ...(noSourceMedia
        ? [
            "这是纯字幕草稿项目，字幕编辑和常规导出都可以直接继续。",
            "如果之后补入媒体文件，还可以继续使用预览、重提取和烧录流程。",
          ]
        : [
            "系统会沿用当前配置创建草稿，你可以随时回到项目概览调整。",
            "多语言目标轨会围绕同一条时间轴继续处理。",
          ]),
    ],
    config: {
      sourceLanguage: defaults.sourceLanguage,
      targetLanguages: [],
      provider: defaults.provider,
      model: defaults.model,
      glossary: defaults.glossary,
      styleGuide: defaults.styleGuide,
      outputFormat: defaults.outputFormat,
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [
      {
        id: sourceTrackId,
        label: noSourceMedia ? "导入字幕主源轨" : "推荐主源轨",
        kind: noSourceMedia ? "external_subtitle" : "embedded_subtitle",
        languageState: "pending",
        defaultLanguage: defaults.sourceLanguage,
        isActive: true,
        summary: noSourceMedia
          ? "纯字幕项目会保留标准项目结构，但暂时不依赖媒体预览。"
          : "主媒体项目会先围绕推荐源轨继续，之后可按需要再做确认或切换。",
        segments: buildDraftSegments(),
        targetTracks: [],
      },
    ],
    recentRunIds: [],
  };

  return setTargetLanguages(skeleton, [...defaults.targetLanguages]);
}

function buildDraftProjectFromBatchGroup(
  defaults: WorkspaceDefaults,
  group: BatchGroup,
  files: BatchFile[],
): Project {
  const groupFiles = getBatchGroupFiles(files, group);
  const primaryFile = pickPrimaryBatchFile(groupFiles);
  const attachedFiles = groupFiles.filter((file) => file.id !== primaryFile.id);
  const effectiveDefaults = {
    ...defaults,
    ...group.overrides,
    targetLanguages: group.overrides.targetLanguages ?? defaults.targetLanguages,
  };
  const baseProject = buildDraftProject(effectiveDefaults, {
    name: primaryFile.name,
    type: primaryFile.type,
  });
  const includesSubtitleAttachment = attachedFiles.some((file) => file.mediaKind === "subtitle");

  return {
    ...baseProject,
    title: group.title.trim() || primaryFile.suggestedProjectTitle,
    notes:
      groupFiles.length > 1
        ? [
            `批量导入时已将 ${groupFiles.length} 个关联文件合并为同一个项目。`,
            `附带文件：${attachedFiles.map((file) => file.name).join("、")}`,
            ...baseProject.notes,
          ]
        : baseProject.notes,
    pendingConfirmations:
      includesSubtitleAttachment && primaryFile.mediaKind !== "subtitle"
        ? [
            "这个项目包含主媒体和外部字幕附件，后续可在概览页确认主源与附件关系。",
            ...baseProject.pendingConfirmations,
          ]
        : baseProject.pendingConfirmations,
  };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const desktop = isDesktopRuntime();
  const [defaults, setDefaults] = useState(workspaceMock.defaults);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [runSnapshots, setRunSnapshots] = useState<RunSnapshot[]>([]);
  const [automaticWorkflows, setAutomaticWorkflows] =
    useState<Record<string, AutomaticWorkflowState>>({});
  const [library, setLibrary] = useState<ResourceLibrary>(desktop
    ? { glossaries: [], styleGuides: [], subtitleStyles: [], exportPresets: [] }
    : workspaceMock.library);
  const [batchSession, setBatchSession] = useState<BatchSession | null>(null);
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null>(null);
  const [loadState, setLoadState] = useState<WorkspaceLoadState>(desktop ? "loading" : "ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingEncodingImport, setPendingEncodingImport] =
    useState<PendingEncodingImport | null>(null);
  const [loadToken, setLoadToken] = useState(0);
  /**
   * 翻译能力目录。
   *
   * 旧版这里无条件用 workspaceMock.capabilities，而 mock 把 credentialConfigured 写死 false，
   * 于是 buildTranslationCapabilityCatalog 恒出 status:"offline"，顶栏状态灯永远显示
   * 「未配置翻译服务」——用户把 API Key 配好、连接也测通了，顶栏还在说没配好。
   */
  const [capabilities, setCapabilities] = useState(workspaceMock.capabilities);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const automaticWorkflowsRef = useRef(automaticWorkflows);
  automaticWorkflowsRef.current = automaticWorkflows;
  const automaticWorkflowLocksRef = useRef(new Set<string>());
  const automaticWorkflowCancelledRef = useRef(new Set<string>());
  const pendingTrashAtRef = useRef(new Map<string, string>());

  const refreshCapabilities = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    const providers = listSelectableTranslationProviders();
    const [credentials, asrCapability, appSettings] = await Promise.all([
      desktopGetCredentialStatus({}),
      desktopGetAsrCapabilityStatus(),
      desktopGetAppSettings(),
    ]);
    const configured = new Set<string>();
    if (credentials.ok) {
      const list = "credentials" in credentials.data ? credentials.data.credentials : [credentials.data];
      for (const item of list) {
        if (item.configured && item.credentialId) configured.add(item.credentialId);
      }
    }

    const runtimeByProviderId: Record<string, ProviderRuntimeState> = {};
    await Promise.all(providers.map(async (provider) => {
      const state = await desktopGetProviderRuntimeState({ provider: provider.name });
      const readiness = state.ok ? state.data : null;
      runtimeByProviderId[provider.id] = {
        credentialConfigured: configured.has(provider.credentialId),
        // readiness 存的是 "ready"，能力目录用的是 "ok"；失败状态也必须保留，
        // 否则一次真实失败会被误判成“等待首次检查”。
        connectionStatus: readiness?.status === "ready" ? "ok" : readiness?.status === "failed" ? "failed" : "untested",
        requestedModel: readiness?.requestedModel,
        modelId: readiness?.modelId,
        testedAt: readiness?.testedAt,
        baseUrlDisplay: readiness?.baseUrlDisplay ?? null,
        transportMode: readiness?.transportMode ?? null,
        // 「拉取模型」的结果。有它时能力目录会用它替换注册表兜底列表，
        // 于是项目页的模型下拉能看到用户真正拉到的型号。
        configuredModels: readiness?.configuredModels ?? undefined,
      };
    }));

    const persistedSelection = appSettings.ok
      && appSettings.data.translationProvider
      && appSettings.data.translationModel
      ? { provider: appSettings.data.translationProvider, model: appSettings.data.translationModel }
      : null;
    const legacyConfiguredProvider = providers.find((provider) => runtimeByProviderId[provider.id]?.credentialConfigured);
    const legacyRuntime = legacyConfiguredProvider ? runtimeByProviderId[legacyConfiguredProvider.id] : null;
    const preferredSelection = persistedSelection
      ?? resolveMostRecentSuccessfulTranslationSelection(runtimeByProviderId)
      ?? (legacyConfiguredProvider
        ? {
            provider: legacyConfiguredProvider.name,
            model: legacyRuntime?.requestedModel
              ?? legacyRuntime?.configuredModels?.[0]
              ?? legacyConfiguredProvider.models[0]
              ?? "",
          }
        : null);
    if (preferredSelection) {
      setDefaults((current) => {
        const next = { ...current, ...preferredSelection };
        defaultsRef.current = next;
        return next;
      });
    }

    setCapabilities((current) => ({
      ...current,
      providers: [
        ...buildTranslationCapabilityCatalog(runtimeByProviderId),
        ...current.providers.filter((entry) => entry.kind !== "llm").map((entry) => (
          entry.kind === "asr" && asrCapability.ok
            ? {
                ...entry,
                status: asrCapability.data.runtime.installState === "ready" && asrCapability.data.models.some((model) => model.installState === "ready")
                  ? "ready" as const
                  : "attention" as const,
                summary: "模型目录来自桌面端受信清单。",
                models: asrCapability.data.models.map((model) => model.id),
              }
            : entry
        )),
      ],
    }));
  }, []);

  useEffect(() => {
    void refreshCapabilities();
  }, [refreshCapabilities]);

  const persistProject = useCallback((project: Project) => {
    if (!isDesktopRuntime()) {
      return;
    }
    projectSaveScheduler.markDirty(project);
  }, []);

  const flushBeforeClose = useCallback(async () => {
    if (!isDesktopRuntime()) {
      return true;
    }
    return projectSaveScheduler.flushAll();
  }, []);

  const loadProjectsFromDesktop = useCallback(async () => {
    if (!isDesktopRuntime()) {
      setProjects([]);
      setTasks([]);
      setRunSnapshots([]);
      setLibrary(workspaceMock.library);
      setLoadState("ready");
      setLoadError(null);
      return;
    }
    setLoadState("loading");
    setLoadError(null);
    const resources = await desktopListResources();
    if (resources.ok) {
      const byKind = <K extends ResourceKind>(kind: K) =>
        resources.data.filter((resource) => resource.kind === kind) as Extract<AnyGlobalResource, { kind: K }>[];
      setLibrary({
        glossaries: byKind("glossary"),
        styleGuides: byKind("style_guide"),
        subtitleStyles: byKind("subtitle_style"),
        exportPresets: byKind("export_preset"),
      });
    }
    const listed = await desktopListRecentProjects();
    if (!listed.ok) {
      setProjects([]);
      setLoadState("error");
      setLoadError(localizeIpcErrorText(listed.error));
      return;
    }
    const loaded: Project[] = [];
    const loadedTasks: ProjectTask[] = [];
    const loadedSnapshots: RunSnapshot[] = [];
    const diagnostics: string[] = resources.ok ? [] : [localizeIpcErrorText(resources.error)];
    for (const summary of listed.data) {
      const opened = await desktopOpenProject(summary.id);
      if (!opened.ok) {
        diagnostics.push(localizeIpcErrorText(opened.error));
        continue;
      }
      if (!opened.data) {
        diagnostics.push(`Project ${summary.id} is missing on disk`);
        continue;
      }
      loaded.push(opened.data);
      const runtime = await desktopGetProjectRuntimeState({ projectId: summary.id });
      if (runtime.ok) {
        loadedTasks.push(...runtime.data.tasks);
        loadedSnapshots.push(...runtime.data.runSnapshots);
      } else {
        diagnostics.push(localizeIpcErrorText(runtime.error));
      }
    }
    const subscribed = await desktopSubscribeTasks({});
    if (!subscribed.ok) diagnostics.push(localizeIpcErrorText(subscribed.error));
    setProjects(loaded);
    setTasks(subscribed.ok ? subscribed.data.tasks : loadedTasks);
    setRunSnapshots(loadedSnapshots);
    setLoadState("ready");
    setLoadError(diagnostics.length > 0 ? diagnostics[0] : null);
  }, []);

  useEffect(() => {
    void loadProjectsFromDesktop();
  }, [loadProjectsFromDesktop, loadToken]);

  useEffect(() => {
    if (activeBatch || batchSession) return;
    const latest = tasks
      .filter((task) => task.batchId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!latest?.batchId) return;
    setActiveBatch({
      id: latest.batchId,
      projectIds: [...new Set(
        tasks.filter((task) => task.batchId === latest.batchId).map((task) => task.projectId),
      )],
    });
  }, [activeBatch, batchSession, tasks]);

  useEffect(() => {
    return projectSaveScheduler.onSettle((_projectId: string, errorMessage: string | null) => {
      setSaveError(errorMessage);
    });
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    return desktopOnWorkerEvent((event) => {
      setTasks((current) => current.map((task) => task.id !== event.taskId
        ? task
        : {
            ...task,
            stage: event.stage,
            updatedAt: event.timestamp,
            sequence: event.sequence,
            ...(event.type === "status" ? {
              status: event.status,
              ...(event.progress !== undefined ? { progress: event.progress } : {}),
              ...(event.checkpointStage ? { checkpointStage: event.checkpointStage } : {}),
              ...(event.errorCode ? { lastErrorCode: event.errorCode } : {}),
            } : {}),
            ...(event.type === "progress" ? { progress: event.progress } : {}),
          }));
      if (event.type === "status") {
        void desktopSubscribeTasks({}).then((result) => {
          if (result.ok) setTasks(result.data.tasks);
        });
        const completedTask = tasksRef.current.find((task) => task.id === event.taskId);
        const refreshesProject = completedTask?.kind === "translate"
          || (!completedTask?.kind && event.stage === "translate");
        if (["completed", "failed", "cancelled"].includes(event.status) && refreshesProject) {
          // ASR/media IPC calls already return their persisted project. Re-saving a terminal
          // ASR snapshot here can race the next automatic step and revert an activated source.
          void (async () => {
            const opened = await desktopOpenProject(event.projectId);
            if (!opened.ok || !opened.data) return;
            const currentProject = projectsRef.current.find((project) => project.id === event.projectId);
            const preservedTrashedAt = pendingTrashAtRef.current.get(event.projectId) ?? currentProject?.trashedAt;
            const refreshedProject = {
              ...opened.data,
              ...(preservedTrashedAt ? { trashedAt: preservedTrashedAt } : {}),
              ...(currentProject?.archivedAt ? { archivedAt: currentProject.archivedAt } : {}),
            };
            const accepted = await projectSaveScheduler.acceptExternal(refreshedProject);
            if (!accepted) {
              setSaveError("后台任务结果已落盘，但项目视图同步失败");
              return;
            }
            setProjects((current) => current.map((project) => (
              project.id === event.projectId ? refreshedProject : project
            )));
            const runtime = await desktopGetProjectRuntimeState({ projectId: event.projectId });
            if (runtime.ok) {
              setRunSnapshots((current) => [
                ...runtime.data.runSnapshots,
                ...current.filter((snapshot) => snapshot.projectId !== event.projectId),
              ]);
            }
          })();
        }
      }
    });
  }, []);

  const replaceLibraryResource = useCallback((resource: AnyGlobalResource) => {
    const collectionByKind = {
      glossary: "glossaries",
      style_guide: "styleGuides",
      subtitle_style: "subtitleStyles",
      export_preset: "exportPresets",
    } as const;
    const collection = collectionByKind[resource.kind];
    setLibrary((current) => ({
      ...current,
      [collection]: [
        resource,
        ...current[collection].filter((entry) => entry.id !== resource.id),
      ],
    }) as ResourceLibrary);
  }, []);

  const saveLibraryResource = useCallback(async (
    resource: ResourceWriteInput,
    expectedRevision?: number,
  ) => {
    if (isDesktopRuntime()) {
      const saved = await desktopSaveResource({ resource, expectedRevision });
      if (!saved.ok) return { ok: false as const, message: localizeIpcErrorText(saved.error) };
      replaceLibraryResource(saved.data);
      return { ok: true as const, resource: saved.data };
    }
    const existing = Object.values(library).flat().find((entry) => entry.id === resource.id);
    const saved = {
      ...resource,
      scope: "global" as const,
      schemaVersion: 1 as const,
      revision: existing ? existing.revision + 1 : 1,
      updatedAt: new Date().toISOString(),
    } as AnyGlobalResource;
    replaceLibraryResource(saved);
    return { ok: true as const, resource: saved };
  }, [library, replaceLibraryResource]);

  const deleteLibraryResource = useCallback(async (resourceId: string, expectedRevision: number) => {
    if (isDesktopRuntime()) {
      const deleted = await desktopDeleteResource({ resourceId, expectedRevision });
      if (!deleted.ok) return { ok: false, message: localizeIpcErrorText(deleted.error) };
    }
    setLibrary((current) => ({
      glossaries: current.glossaries.filter((entry) => entry.id !== resourceId),
      styleGuides: current.styleGuides.filter((entry) => entry.id !== resourceId),
      subtitleStyles: current.subtitleStyles.filter((entry) => entry.id !== resourceId),
      exportPresets: current.exportPresets.filter((entry) => entry.id !== resourceId),
    }));
    return { ok: true };
  }, []);

  const refreshProjectResourceSnapshot = useCallback(async (projectId: string, resourceId: string) => {
    if (!isDesktopRuntime()) return { ok: false, message: "项目快照刷新仅在桌面运行时可用" };
    const refreshed = await desktopRefreshProjectResourceSnapshot({ projectId, resourceId });
    if (!refreshed.ok) return { ok: false, message: localizeIpcErrorText(refreshed.error) };
    const subtitleStyle = library.subtitleStyles.find((entry) => entry.id === resourceId)?.payload;
    if (subtitleStyle) {
      setProjects((current) => current.map((project) => {
        if (project.id !== projectId) return project;
        const nextProject = {
          ...project,
          config: { ...project.config, subtitleStyle: structuredClone(subtitleStyle) },
          updatedAt: timestampNow(),
        };
        persistProject(nextProject);
        return nextProject;
      }));
    }
    return { ok: true };
  }, [library.subtitleStyles, persistProject]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    return desktopOnBeforeClose(async () => {
      if (await flushBeforeClose()) {
        await desktopWindowControl("close");
      }
    });
  }, [flushBeforeClose]);

  const controlTask = async (request: TaskControlRequest) => {
    const result = await desktopControlTask(request);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    setTasks((current) => [
      result.data.task,
      ...current.filter((task) => task.id !== result.data.task.id),
    ]);
    return { ok: true, task: result.data.task };
  };

  const retryLoadProjects = () => {
    setLoadToken((value) => value + 1);
  };

  const updateDefaults = (patch: Partial<WorkspaceDefaults>) => {
    setDefaults((current) => {
      const next = { ...current, ...patch };
      if (patch.provider !== undefined || patch.model !== undefined) {
        const selection = reconcileSelectionOrKeep(
          { provider: current.provider, model: current.model },
          { provider: patch.provider, model: patch.model },
        );
        next.provider = selection.provider;
        next.model = selection.model;
      }
      defaultsRef.current = next;
      return next;
    });
  };

  const updateProjectConfig = (projectId: string, patch: ProjectConfigPatch) => {
    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) {
          return project;
        }

        const nextConfig = { ...project.config, ...patch };
        if (patch.provider !== undefined || patch.model !== undefined) {
          const selection = reconcileSelectionOrKeep(
            { provider: project.config.provider, model: project.config.model },
            { provider: patch.provider, model: patch.model },
          );
          nextConfig.provider = selection.provider;
          nextConfig.model = selection.model;
        }

        const { archivedAt: _archivedAt, ...editableProject } = project;
        const nextProject = {
          ...editableProject,
          config: nextConfig,
          updatedAt: timestampNow(),
        } as Project;
        persistProject(nextProject);
        return nextProject;
      }),
    );
  };

  const setProjectTargetLanguages = (
    projectId: string,
    nextTargetLanguages: string[],
  ): string | null => {
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) {
      return `Project not found: ${projectId}`;
    }

    try {
      const updated = setTargetLanguages(project, nextTargetLanguages);
      const { archivedAt: _archivedAt, ...editableProject } = updated;
      const nextProject = {
        ...editableProject,
        updatedAt: timestampNow(),
      } as Project;
      setProjects((current) =>
        current.map((entry) => (entry.id === projectId ? nextProject : entry)),
      );
      persistProject(nextProject);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const trashProject = async (projectId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    if (tasksRef.current.some((task) => task.projectId === projectId && task.status === "cancelling")) {
      return { ok: false, message: "任务正在停止，请稍后再移入回收站" };
    }
    const now = timestampNow();
    pendingTrashAtRef.current.set(projectId, now);
    try {
      const liveTasks = tasksRef.current.filter((task) => task.projectId === projectId
        && ["pending", "running", "pausing", "paused", "recoverable"].includes(task.status));
      for (const task of liveTasks) {
        const stopped = await controlTask({ taskId: task.id, projectId, action: "cancel" });
        if (!stopped.ok) return { ok: false, message: stopped.message ?? "任务停止失败，项目没有删除" };
      }
      const workflow = automaticWorkflowsRef.current[projectId];
      if (workflow?.status === "running") {
        if (workflow.stage === "starting_translation") {
          automaticWorkflowCancelledRef.current.add(projectId);
          setAutomaticWorkflow(projectId, { status: "cancelled", message: "自动处理已停止；已完成的结果会保留。" });
        } else {
          const stopped = await cancelAutomaticProjectWorkflow(projectId);
          if (!stopped.ok) return { ok: false, message: stopped.message ?? "自动处理停止失败，项目没有删除" };
        }
      }
      const latestProject = projectsRef.current.find((entry) => entry.id === projectId) ?? project;
      const nextProject = { ...latestProject, trashedAt: now, updatedAt: now };
      projectsRef.current = projectsRef.current.map((entry) => entry.id === projectId ? nextProject : entry);
      setProjects(projectsRef.current);
      persistProject(nextProject);
      return { ok: true };
    } finally {
      pendingTrashAtRef.current.delete(projectId);
    }
  };

  const restoreProject = (projectId: string) => {
    const now = timestampNow();

    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) {
          return project;
        }
        const nextProject = {
          ...project,
          trashedAt: undefined,
          updatedAt: now,
        };
        persistProject(nextProject);
        return nextProject;
      }),
    );
  };

  const clearTrashedProjects = async () => {
    const trashed = projectsRef.current.filter((project) => project.trashedAt);
    if (!isDesktopRuntime()) {
      projectsRef.current = projectsRef.current.filter((project) => !project.trashedAt);
      setProjects(projectsRef.current);
      return { ok: true, deletedCount: trashed.length };
    }
    let deletedCount = 0;
    for (const project of trashed) {
      const result = await desktopDeleteProjectPermanently({ projectId: project.id, confirmed: true });
      if (!result.ok) {
        setSaveError(localizeIpcErrorText(result.error));
        return { ok: false, message: localizeIpcErrorText(result.error), deletedCount };
      }
      deletedCount += 1;
      projectsRef.current = projectsRef.current.filter((entry) => entry.id !== project.id);
    }
    setProjects(projectsRef.current);
    setSaveError(null);
    return { ok: true, deletedCount };
  };

  const importDraftProject = async (
    file: LocalImportFile,
    options?: DraftProjectOptions,
    encoding?: SubtitleEncodingChoice,
  ) => {
    const mediaKind = knownMediaKind(file.name);

    if (!isDesktopRuntime()) {
      setSaveError("浏览器预览不读取本地文件，请启动桌面应用导入素材。");
      return null;
    }

    if (isDesktopRuntime() && (mediaKind === "video" || mediaKind === "audio")) {
      const selected = await desktopSelectMediaSource({
        copyIntoProject: false,
        defaults: {
          sourceLanguage: defaults.sourceLanguage,
          targetLanguages: [...defaults.targetLanguages],
          provider: defaults.provider,
          model: defaults.model,
          glossary: defaults.glossary,
          styleGuide: defaults.styleGuide,
          outputFormat: defaults.outputFormat,
        },
      });
      if (!selected.ok) {
        setSaveError(localizeIpcErrorText(selected.error));
        return null;
      }
      const project = selected.data.project;
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      setSaveError(null);
      return project.id;
    }

    const canTrySubtitle =
      isDesktopRuntime() &&
      Boolean(file.arrayBuffer) &&
      (file.size === undefined || file.size <= MAX_LOCAL_SUBTITLE_BYTES);

    if (canTrySubtitle && file.arrayBuffer) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const request = {
        fileName: file.name,
        bytes,
        ...(encoding ? { encoding } : {}),
        defaults: {
          sourceLanguage: defaults.sourceLanguage,
          targetLanguages: [...defaults.targetLanguages],
          provider: defaults.provider,
          model: defaults.model,
          glossary: defaults.glossary,
          styleGuide: defaults.styleGuide,
          outputFormat: defaults.outputFormat,
        },
      };
      const imported = await desktopImportSubtitle(request);

      if (imported.ok && imported.data.needsEncodingConfirmation) {
        setPendingEncodingImport({
          file,
          options,
          candidates: imported.data.encodingCandidates ?? [],
        });
        setSaveError(null);
        return null;
      }

      if (imported.ok && imported.data.project) {
        const importedProject = imported.data.project;
        const project = {
          ...importedProject,
          ...(options?.titleSuffix
            ? { title: `${importedProject.title}${options.titleSuffix}` }
            : {}),
          notes: [
            ...(options?.note ? [options.note] : []),
            ...importedProject.notes,
            ...(imported.data.warnings || []),
          ],
        };
        setProjects((current) => [project, ...current]);
        persistProject(project);
        setSaveError(null);
        return project.id;
      }

      if (!mediaKind || mediaKind === "subtitle") {
        setSaveError(imported.ok ? "字幕导入没有生成项目，文件可能是空的或格式不受支持" : localizeIpcErrorText(imported.error));
        return null;
      }
    } else if (isDesktopRuntime() && (!mediaKind || mediaKind === "subtitle")) {
      setSaveError(
        file.size !== undefined && file.size > MAX_LOCAL_SUBTITLE_BYTES
          ? "字幕文件超过 8 MiB 限制"
          : "读取字幕文件内容失败",
      );
      return null;
    }

    const project = buildDraftProject(defaults, file, options);
    if (isDesktopRuntime()) {
      const created = await desktopCreateProject(project);
      if (!created.ok) {
        setSaveError(localizeIpcErrorText(created.error));
        return null;
      }
    }
    setProjects((current) => [project, ...current]);
    setSaveError(null);
    return project.id;
  };

  const createDraftProject = (file: LocalImportFile, options?: DraftProjectOptions) =>
    importDraftProject(file, options);

  const upsertProject = (project: Project) => {
    projectsRef.current = [project, ...projectsRef.current.filter((item) => item.id !== project.id)];
    setProjects(projectsRef.current);
  };

  const importDesktopMediaSource = async (options?: { copyIntoProject?: boolean }) => {
    if (!isDesktopRuntime()) {
      setSaveError("导入媒体只能在桌面应用里进行");
      return null;
    }
    const selected = await desktopSelectMediaSource({
      copyIntoProject: Boolean(options?.copyIntoProject),
      defaults: {
        sourceLanguage: defaults.sourceLanguage,
        targetLanguages: [...defaults.targetLanguages],
        provider: defaults.provider,
        model: defaults.model,
        glossary: defaults.glossary,
        styleGuide: defaults.styleGuide,
        outputFormat: defaults.outputFormat,
      },
    });
    if (!selected.ok) {
      setSaveError(localizeIpcErrorText(selected.error));
      return null;
    }
    upsertProject(selected.data.project);
    setSaveError(null);
    return selected.data.project.id;
  };

  const probeProjectMedia = async (projectId: string) => {
    const result = await desktopProbeMedia(projectId);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    if (result.data.project) upsertProject(result.data.project);
    return { ok: true };
  };

  const selectProjectMediaStreams = async (
    projectId: string,
    selection: { audioStreamId?: string | null; subtitleStreamId?: string | null },
  ) => {
    const result = await desktopSelectMediaStreams({ projectId, ...selection });
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    upsertProject(result.data.project);
    return { ok: true };
  };

  const extractProjectSubtitle = async (projectId: string, streamId: string) => {
    const result = await desktopExtractMediaSubtitle(projectId, streamId);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    upsertProject(result.data.project);
    return { ok: true, candidateSourceTrackId: result.data.candidateSourceTrackId };
  };

  const exportProjectAudio = async (projectId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    const streamId = project.mediaSource?.confirmedAudioStreamId
      ?? project.mediaSource?.selectedAudioStreamId;
    if (!streamId) return { ok: false, message: "这个项目没有可提取的音频流" };
    const result = await desktopExtractMediaAudio({
      projectId,
      streamId,
      operationId: createId("media-audio"),
    });
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    return result.data.canceled
      ? { ok: true, canceled: true }
      : { ok: true, fileName: result.data.fileName };
  };

  const activateProjectSourceTrack = async (projectId: string, sourceTrackId: string) => {
    const result = await desktopActivateMediaSourceTrack(projectId, sourceTrackId);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    upsertProject(result.data.project);
    return { ok: true };
  };

  const relinkProjectMedia = async (projectId: string) => {
    const result = await desktopRelinkMedia(projectId);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    upsertProject(result.data.project);
    return { ok: true };
  };

  const getProjectMediaPreviewUrl = async (projectId: string) => {
    const result = await desktopGetMediaPreviewUrl(projectId);
    if (!result.ok) return { ok: false as const, message: localizeIpcErrorText(result.error) };
    return { ok: true as const, url: result.data.url, mediaKind: result.data.mediaKind };
  };

  const confirmSubtitleEncoding = async (encoding: SubtitleEncodingChoice) => {
    const pending = pendingEncodingImport;
    if (!pending || !pending.candidates.includes(encoding)) {
      setSaveError("字幕编码选择无效，请重新导入文件");
      return null;
    }
    setPendingEncodingImport(null);
    return importDraftProject(pending.file, pending.options, encoding);
  };

  const getProjectMediaWaveform = useCallback(async (projectId: string) => {
    const result = await desktopGetMediaWaveform(projectId);
    if (!result.ok) return { ok: false as const, message: localizeIpcErrorText(result.error) };
    return { ok: true as const, durationMs: result.data.durationMs, peaks: result.data.peaks };
  }, []);

  const getProjectAsrStatus = async (projectId: string) => {
    const result = await desktopGetAsrProjectStatus({ projectId });
    if (!result.ok) return { ok: false as const, message: localizeIpcErrorText(result.error) };
    upsertProject(result.data.project);
    return { ok: true as const, data: result.data };
  };

  const runProjectAsr = async (request: AsrTranscribeRequest) => {
    const result = await desktopRunAsrTranscription(request);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    return { ok: true, runId: result.data.runId };
  };

  const segmentProjectAsrRun = async (request: AsrSegmentRequest) => {
    const result = await desktopSegmentAsrRun(request);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    upsertProject(result.data.project);
    return { ok: true, sourceTrackId: result.data.sourceTrackId };
  };

  const detectProjectAsrLanguages = async (request: AsrLanguageDetectRequest) => {
    const result = await desktopDetectAsrSegmentLanguages(request);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    upsertProject(result.data.project);
    return { ok: true, pendingSegmentIds: result.data.pendingSegmentIds };
  };

  const updateProjectAsrLanguages = async (request: AsrLanguageUpdateRequest) => {
    const result = await desktopUpdateAsrSegmentLanguages(request);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    upsertProject(result.data.project);
    return {
      ok: true,
      affectedSegmentIds: result.data.affectedSegmentIds,
      pendingSegmentIds: result.data.pendingSegmentIds,
    };
  };

  const cancelProjectAsrOperation = async (request: AsrCancelRequest) => {
    const result = await desktopCancelAsrProjectOperation(request);
    if (!result.ok) return { ok: false, message: localizeIpcErrorText(result.error) };
    return { ok: true, cancelled: result.data.cancelled };
  };

  const cancelSubtitleEncoding = () => {
    setPendingEncodingImport(null);
    setSaveError("已取消字幕导入");
  };

  const commitEditorProject = (project: Project) => {
    const { archivedAt: _archivedAt, ...unarchivedProject } = project;
    const nextProject = { ...unarchivedProject, updatedAt: timestampNow() } as Project;
    projectsRef.current = projectsRef.current.map((entry) =>
      entry.id === nextProject.id ? nextProject : entry,
    );
    setProjects(projectsRef.current);
    persistProject(nextProject);
    setSaveError(null);
    return nextProject;
  };

  const commitEditorResult = (result: { ok: boolean; reason?: string; project: Project }) => {
    if (!result.ok) {
      const message = result.reason ?? "编辑操作失败";
      setSaveError(message);
      return { ok: false, message };
    }
    commitEditorProject(result.project);
    return { ok: true };
  };

  const setProjectArchived = (projectId: string, archived: boolean) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    const nextProject = archived
      ? archiveProjectState(project, timestampNow()).project
      : { ...project, archivedAt: undefined };
    const saved = { ...nextProject, updatedAt: timestampNow() };
    projectsRef.current = projectsRef.current.map((entry) => entry.id === projectId ? saved : entry);
    setProjects(projectsRef.current);
    persistProject(saved);
    return { ok: true };
  };

  const trashProjectSourceTrack = (projectId: string, sourceTrackId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(trashSourceTrack(project, sourceTrackId, timestampNow()));
  };

  const restoreProjectSourceTrack = (projectId: string, sourceTrackId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(restoreSourceTrack(project, sourceTrackId));
  };

  const trashProjectTargetTrack = (projectId: string, targetTrackId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(trashTargetTrack(project, targetTrackId, timestampNow()));
  };

  const restoreProjectTargetTrack = (projectId: string, targetTrackId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(restoreTargetTrack(project, targetTrackId));
  };

  const emptyProjectTrackTrash = (projectId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(emptyTrackTrash(project));
  };

  const updateSourceSegmentManual = (
    projectId: string,
    segmentId: string,
    manualText: string | undefined,
  ) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return;
    commitEditorResult(setProjectSourceManual(project, segmentId, manualText ?? null));
  };

  const undoProjectEdit = (projectId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return;
    commitEditorResult(undoProjectEditState(project));
  };

  const redoProjectEdit = (projectId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return;
    commitEditorResult(redoProjectEditState(project));
  };

  const exportSourceSubtitle = async (
    projectId: string,
    mode: "raw" | "normalized",
    format?: "srt" | "vtt" | "ass",
  ) => {
    if (!isDesktopRuntime()) {
      return { ok: false as const, message: "导出源字幕只能在桌面应用里进行" };
    }
    const result = await desktopExportSourceSubtitle({
      projectId,
      mode,
      format,
      destination: "user",
    });
    if (!result.ok) {
      setSaveError(localizeIpcErrorText(result.error));
      return { ok: false as const, message: localizeIpcErrorText(result.error) };
    }
    setSaveError(null);
    if (result.data.canceled) return { ok: true as const, canceled: true as const };
    if (projectsRef.current.find((entry) => entry.id === projectId)?.archivedAt) {
      setProjectArchived(projectId, false);
    }
    return {
      ok: true as const,
      canceled: false as const,
      fileName: result.data.fileName,
      warnings: result.data.warnings,
    };
  };

  const prepareBatchSession = async (
    files: File[],
    options: DraftProjectOptions = {},
  ): Promise<BatchSession | null> => {
    if (isDesktopRuntime()) {
      // 应用启动后立即导入时，也必须先拿到已持久化的全局模型；否则会用启动占位值创建项目。
      await refreshCapabilities();
      const result = await desktopCreateBatchSession(files);
      if (!result.ok) {
        setSaveError(localizeIpcErrorText(result.error));
        return null;
      }
      if (batchSession) {
        void desktopDiscardBatchSession(batchSession.id);
      }
      const prepared: BatchSession = {
        ...result.data,
        defaults: cloneDefaults(defaultsRef.current),
        files: result.data.files.map((file) => ({
          ...file,
          suggestedProjectTitle: removeExtension(file.name),
        })),
        groups: result.data.groups.map((group) => ({
          ...group,
          title: `${group.title}${options.titleSuffix ?? ""}`,
          overrides: {},
        })),
        ambiguities: result.data.ambiguities ?? [],
        fileEncodings: {},
      };
      setSaveError(null);
      return prepared;
    }
    const batchFiles = files.map(buildBatchFile);
    return {
      id: createId("batch"),
      createdAt: timestampNow(),
      defaults: cloneDefaults(defaults),
      files: batchFiles,
      groups: buildBatchGroups(batchFiles),
      ambiguities: [],
      fileEncodings: {},
    };
  };

  const createBatchSession = async (files: File[]) => {
    const prepared = await prepareBatchSession(files);
    if (!prepared) return false;
    setBatchSession(prepared);
    return true;
  };

  const exportSubtitleMatrix = async (
    projectId: string,
    requests: SubtitleExportRequestItem[],
    destination: "project" | "user" = "user",
  ) => {
    if (!isDesktopRuntime()) {
      return { ok: false as const, message: "导出交付字幕只能在桌面应用里进行" };
    }
    if (!(await projectSaveScheduler.flush(projectId))) {
      return { ok: false as const, message: "项目尚未保存，未开始导出" };
    }
    const result = await desktopExportSubtitleMatrix({ projectId, requests, destination });
    if (!result.ok) {
      setSaveError(localizeIpcErrorText(result.error));
      return { ok: false as const, message: localizeIpcErrorText(result.error) };
    }
    setSaveError(null);
    if (result.data.succeeded.length > 0 && projectsRef.current.find((entry) => entry.id === projectId)?.archivedAt) {
      setProjectArchived(projectId, false);
    }
    return { ok: true as const, summary: result.data };
  };

  const exportSubtitleVideo = async (
    projectId: string,
    languageCode: string,
    mode: "soft_subtitle" | "burn_ass",
  ) => {
    if (!isDesktopRuntime()) {
      return { ok: false, message: "导出视频只能在桌面应用里进行" };
    }
    const deliverable = getApprovedTargetTrack(projectId, languageCode);
    if (!deliverable.ok) return deliverable;
    const subtitleStyle = projectsRef.current.find((project) => project.id === projectId)?.config.subtitleStyle;
    const subtitle = await exportSubtitleMatrix(projectId, [{
      id: `${mode}-${languageCode}-ass`,
      exportKind: subtitleStyle && subtitleStyle.bilingualLayout !== "target_only" ? "bilingual" : "target",
      targetLanguageCode: languageCode,
      format: "ass",
    }], "project");
    if (!subtitle.ok) return subtitle;
    const exportedSubtitle = subtitle.summary.succeeded[0];
    if (!exportedSubtitle) {
      const failure = subtitle.summary.failed[0]?.error;
      return { ok: false, message: failure ? localizeIpcErrorText(failure) : "导出 ASS 字幕失败" };
    }
    const result = await desktopExportSubtitleVideo({
      projectId,
      subtitleExportRecordId: exportedSubtitle.exportRecordId,
      mode,
      operationId: createId("video-export"),
    });
    if (!result.ok) {
      setSaveError(localizeIpcErrorText(result.error));
      return { ok: false, message: localizeIpcErrorText(result.error) };
    }
    setSaveError(null);
    if (result.data.canceled) return { ok: true, canceled: true };
    if (projectsRef.current.find((entry) => entry.id === projectId)?.archivedAt) {
      setProjectArchived(projectId, false);
    }
    return { ok: true, canceled: false, fileName: result.data.fileName };
  };

  const createProjectPackage = async (
    projectId: string,
    kind: "lightweight" | "archive",
    includeTrash = false,
  ) => {
    if (!isDesktopRuntime()) {
      return { ok: false, message: "打包项目只能在桌面应用里进行" };
    }
    const result = await desktopCreateProjectPackage({ projectId, kind, includeTrash });
    if (!result.ok) {
      setSaveError(localizeIpcErrorText(result.error));
      return { ok: false, message: localizeIpcErrorText(result.error) };
    }
    setSaveError(null);
    if (projectsRef.current.find((entry) => entry.id === projectId)?.archivedAt) {
      setProjectArchived(projectId, false);
    }
    return { ok: true, fileName: result.data.fileName };
  };

  const updateBatchSessionDefaults = (patch: Partial<WorkspaceDefaults>) => {
    setBatchSession((current) => {
      if (!current) {
        return current;
      }

      const nextDefaults = {
        ...current.defaults,
        ...patch,
        targetLanguages: patch.targetLanguages
          ? [...patch.targetLanguages]
          : current.defaults.targetLanguages,
      };

      if (patch.provider !== undefined || patch.model !== undefined) {
        const selection = reconcileSelectionOrKeep(
          { provider: current.defaults.provider, model: current.defaults.model },
          { provider: patch.provider, model: patch.model },
        );
        nextDefaults.provider = selection.provider;
        nextDefaults.model = selection.model;
      }

      return {
        ...current,
        defaults: nextDefaults,
      };
    });
  };

  const updateBatchGroupTitle = (groupId: string, title: string) => {
    setBatchSession((current) =>
      current
        ? {
            ...current,
            groups: current.groups.map((group) =>
              group.id === groupId ? { ...group, title } : group,
            ),
          }
        : current,
    );
  };

  const updateBatchGroupDefaults = (
    groupId: string,
    patch: Partial<WorkspaceDefaults> | null,
  ) => {
    setBatchSession((current) => current ? {
      ...current,
      groups: current.groups.map((group) => {
        if (group.id !== groupId) return group;
        if (patch === null) return { ...group, overrides: {} };
        const effective = { ...current.defaults, ...group.overrides };
        const overrides = { ...group.overrides, ...patch };
        if (patch.provider !== undefined || patch.model !== undefined) {
          Object.assign(overrides, reconcileSelectionOrKeep(
            { provider: effective.provider, model: effective.model },
            { provider: patch.provider, model: patch.model },
          ));
        }
        return { ...group, overrides };
      }),
    } : current);
  };

  const mergeBatchGroupIntoPrevious = (groupId: string) => {
    setBatchSession((current) => {
      if (!current) {
        return current;
      }

      const index = current.groups.findIndex((group) => group.id === groupId);
      if (index <= 0) {
        return current;
      }

      const previousGroup = current.groups[index - 1];
      const currentGroup = current.groups[index];
      const mergedFileIds = [...previousGroup.fileIds, ...currentGroup.fileIds];
      const mergedFiles = getBatchGroupFiles(current.files, {
        ...previousGroup,
        fileIds: mergedFileIds,
      });
      const primaryFile = pickPrimaryBatchFile(mergedFiles);
      const mergedGroup: BatchGroup = {
        ...previousGroup,
        title: previousGroup.title.trim() || primaryFile.suggestedProjectTitle,
        confidence: deriveBatchGroupConfidence(mergedFiles),
        fileIds: mergedFileIds,
      };

      return {
        ...current,
        groups: current.groups.flatMap((group, groupIndex) => {
          if (groupIndex === index - 1) {
            return [mergedGroup];
          }

          if (groupIndex === index) {
            return [];
          }

          return [group];
        }),
      };
    });
  };

  const splitBatchGroup = (groupId: string) => {
    setBatchSession((current) => {
      if (!current) {
        return current;
      }

      const group = current.groups.find((item) => item.id === groupId);
      if (!group || group.fileIds.length <= 1) {
        return current;
      }

      const splitGroups = getBatchGroupFiles(current.files, group).map((file) =>
        createSingleFileGroup(file, { ...group.overrides }),
      );

      return {
        ...current,
        groups: current.groups.flatMap((item) =>
          item.id === groupId ? splitGroups : [item],
        ),
      };
    });
  };

  const resolveBatchMediaMatch = (fileId: string, mediaFileId: string | null) => {
    setBatchSession((current) => {
      if (!current) return current;
      const ambiguity = current.ambiguities.find((item) => item.fileId === fileId);
      if (
        !ambiguity
        || ambiguity.kind !== "media_match"
        || (mediaFileId && !ambiguity.candidateMediaFileIds.includes(mediaFileId))
      ) {
        return current;
      }
      const subtitle = current.files.find((file) => file.id === fileId);
      if (!subtitle) return current;

      const withoutSubtitle = current.groups
        .map((group) => ({ ...group, fileIds: group.fileIds.filter((id) => id !== fileId) }))
        .filter((group) => group.fileIds.length > 0);
      let groups = withoutSubtitle;
      if (mediaFileId) {
        groups = withoutSubtitle.map((group) => {
          if (!group.fileIds.includes(mediaFileId)) return group;
          const fileIds = [...group.fileIds, fileId];
          return {
            ...group,
            fileIds,
            confidence: deriveBatchGroupConfidence(getBatchGroupFiles(current.files, { ...group, fileIds })),
          };
        });
      } else {
        groups = [...withoutSubtitle, createSingleFileGroup(subtitle)];
      }

      return {
        ...current,
        groups,
        ambiguities: current.ambiguities.filter((item) => item !== ambiguity),
      };
    });
  };

  const resolveBatchSubtitleEncoding = (
    fileId: string,
    encoding: SubtitleEncodingChoice,
  ) => {
    setBatchSession((current) => {
      if (!current) return current;
      const ambiguity = current.ambiguities.find((item) => item.fileId === fileId);
      if (
        !ambiguity
        || ambiguity.kind !== "subtitle_encoding"
        || !ambiguity.encodingCandidates.includes(encoding)
      ) return current;
      return {
        ...current,
        fileEncodings: { ...current.fileEncodings, [fileId]: encoding },
        ambiguities: current.ambiguities.filter((item) => item !== ambiguity),
      };
    });
  };

  const commitPreparedBatchSession = async (
    prepared: BatchSession,
    activateBatch: boolean,
  ) => {
    let committedBatch: ActiveBatch;
    if (isDesktopRuntime()) {
      const fileMap = new Map(prepared.files.map((file) => [file.id, file]));
      const result = await desktopCommitBatchSession({
        sessionId: prepared.id,
        defaults: prepared.defaults,
        groups: prepared.groups.map((group) => ({
          id: group.id,
          title: group.title.trim()
            || removeExtension(fileMap.get(group.fileIds[0])?.name ?? "project"),
          fileIds: group.fileIds,
          overrides: group.overrides,
        })),
        fileEncodings: Object.entries(prepared.fileEncodings).map(([fileId, encoding]) => ({
          fileId,
          encoding,
        })),
      });
      if (!result.ok) {
        setSaveError(localizeIpcErrorText(result.error));
        return null;
      }
      projectsRef.current = [...result.data.projects, ...projectsRef.current];
      setProjects(projectsRef.current);
      committedBatch = { id: result.data.batchId, projectIds: result.data.projectIds };
    } else {
      const nextProjects = prepared.groups.map((group) =>
        buildDraftProjectFromBatchGroup(prepared.defaults, group, prepared.files),
      );
      projectsRef.current = [...nextProjects, ...projectsRef.current];
      setProjects(projectsRef.current);
      committedBatch = { id: prepared.id, projectIds: nextProjects.map((project) => project.id) };
    }

    setDefaults(cloneDefaults(prepared.defaults));
    setActiveBatch(activateBatch ? committedBatch : null);
    setBatchSession(null);
    setSaveError(null);
    return committedBatch;
  };

  const importFiles = async (
    files: File[],
    options: DraftProjectOptions = {},
  ): Promise<FileImportResult> => {
    const prepared = await prepareBatchSession(files, options);
    if (!prepared) return { status: "failed" };
    if (prepared.ambiguities.length > 0) {
      setBatchSession(prepared);
      return { status: "review" };
    }
    const batch = await commitPreparedBatchSession(prepared, prepared.groups.length > 1);
    if (!batch) {
      setBatchSession(prepared);
      return { status: "failed" };
    }
    return { status: "imported", projectIds: batch.projectIds };
  };

  const commitBatchSession = async () => {
    if (!batchSession || batchSession.ambiguities.length > 0) return null;
    return commitPreparedBatchSession(batchSession, batchSession.groups.length > 1);
  };

  const discardBatchSession = () => {
    if (batchSession && isDesktopRuntime()) {
      void desktopDiscardBatchSession(batchSession.id);
    }
    setBatchSession(null);
  };

  const startProject = async (
    projectId: string,
    options: TranslationStartOptions = {},
  ) => {
    if (isDesktopRuntime()) {
      if (!(await projectSaveScheduler.flush(projectId))) {
        const message = "项目保存失败，翻译未开始";
        setSaveError(message);
        return { ok: false as const, message };
      }
      const result = await desktopStartTranslation({
        projectId,
        userConfirmed: true,
        model: options.model,
        baseUrl: options.baseUrl,
        transportMode: options.transportMode,
        targetLanguages: options.targetLanguages,
        segmentIds: options.segmentIds,
        candidateTrackId: options.candidateTrackId,
        batchId: options.batchId,
        batchEstimatedTokens: options.batchEstimatedTokens,
      });
      if (!result.ok) {
        setSaveError(localizeIpcErrorText(result.error));
        return { ok: false as const, message: localizeIpcErrorText(result.error) };
      }
      /*
       * 这里返回的是「任务已排入队列」，不是「翻译已完成」。
       * 所以后面的失败一律不再让 startProject 返回 ok:false——
       * 任务确实已经开跑，界面该做的是跳到进度视图，而不是报「启动失败」。
       */
      const startedTask = result.data?.task;
      const opened = await desktopOpenProject(projectId);
      if (opened.ok && opened.data) {
        setProjects((current) =>
          current.map((project) => (project.id === projectId ? opened.data! : project)),
        );
      }
      const runtime = await desktopGetProjectRuntimeState({ projectId });
      setTasks((current) => {
        const others = current.filter((task) => task.projectId !== projectId);
        const merged = runtime.ok ? [...runtime.data.tasks, ...others] : current;
        return mergeStartedTaskSnapshot(startedTask, merged);
      });
      if (runtime.ok) {
        setRunSnapshots((current) => [
          ...runtime.data.runSnapshots,
          ...current.filter((snapshot) => snapshot.projectId !== projectId),
        ]);
      }
      setSaveError(runtime.ok ? null : localizeIpcErrorText(runtime.error));
      return { ok: true as const, taskId: startedTask?.id };
    }

    return { ok: false as const, message: "浏览器预览不执行翻译，请启动桌面应用并配置可用 Provider。" };
  };

  const setAutomaticWorkflow = (projectId: string, state: AutomaticWorkflowState) => {
    const next = { ...automaticWorkflowsRef.current, [projectId]: state };
    automaticWorkflowsRef.current = next;
    setAutomaticWorkflows(next);
    return state;
  };

  const setAutomaticStage = (
    projectId: string,
    stage: AutomaticWorkflowStage,
    operationId?: string,
  ) => {
    const current = automaticWorkflowsRef.current[projectId];
    return setAutomaticWorkflow(projectId, {
      status: "running",
      stage,
      operationId,
      startedAt: current?.status === "running" ? current.startedAt ?? Date.now() : Date.now(),
      message: AUTOMATIC_STAGE_MESSAGES[stage],
    });
  };

  const failAutomaticWorkflow = (projectId: string, message: string) =>
    setAutomaticWorkflow(projectId, { status: "failed", message });

  const runAutomaticProjectWorkflow = async (
    projectId: string,
    options: TranslationStartOptions = {},
  ): Promise<AutomaticWorkflowState> => {
    if (automaticWorkflowLocksRef.current.has(projectId)) {
      return automaticWorkflowsRef.current[projectId]
        ?? { status: "running", stage: "checking", startedAt: Date.now(), message: AUTOMATIC_STAGE_MESSAGES.checking };
    }
    automaticWorkflowLocksRef.current.add(projectId);
    automaticWorkflowCancelledRef.current.delete(projectId);
    setAutomaticStage(projectId, "checking");
    let status: AsrProjectStatusResponse | null = null;
    let latestAsrRunId: string | null = null;

    // ponytail: orchestration is renderer-local; every step persists, so rerun resumes.
    // Move it into the main task service only if unattended continuation across app restarts is required.
    try {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (automaticWorkflowCancelledRef.current.has(projectId)) {
          return setAutomaticWorkflow(projectId, { status: "cancelled", message: "已停止自动处理；已完成的结果会保留。" });
        }
        const project = projectsRef.current.find((entry) => entry.id === projectId);
        if (!project) return failAutomaticWorkflow(projectId, "找不到这个项目，请重新导入文件。");
        const step = planAutomaticWorkflow(project, {
          providerConfigured: capabilities.providers.some((provider) =>
            provider.kind === "llm"
            && provider.name === project.config.provider
            && provider.status === "ready"),
          hasLiveTask: ["running", "pending", "pausing", "paused", "cancelling"].includes(
            getLatestProjectTranslationTask(tasksRef.current, projectId)?.status ?? "",
          ),
          asrChecked: Boolean(status),
          asrReady: status?.capability.ready ?? false,
          latestAsrRunId,
          allowUnsafeSource: options.allowUnsafeSource === true,
        });

        if (step.kind === "blocked") {
          return setAutomaticWorkflow(projectId, { status: "blocked", ...step });
        }
        if (step.kind === "translate") {
          setAutomaticStage(projectId, "starting_translation");
          const result = await startProject(projectId, options);
          return result.ok
            ? setAutomaticWorkflow(projectId, { status: "queued", message: "翻译已开始，可在项目页查看进度。" })
            : failAutomaticWorkflow(projectId, result.message);
        }
        if (step.kind === "check_asr") {
          setAutomaticStage(projectId, "checking");
          const [result, settings] = await Promise.all([getProjectAsrStatus(projectId), desktopGetAppSettings()]);
          if (automaticWorkflowCancelledRef.current.has(projectId)) continue;
          if (!result.ok) return failAutomaticWorkflow(projectId, result.message);
          status = result.data;
          const selectedAsrModelId = result.data.project.config.asrModelId
            ?? (settings.ok ? settings.data.asrDefaultModelId : null);
          latestAsrRunId = result.data.runs.find((run) => run.modelId === selectedAsrModelId)?.id ?? null;
          continue;
        }
        if (step.kind === "extract_subtitle") {
          setAutomaticStage(projectId, "extracting");
          const selected = await selectProjectMediaStreams(projectId, {
            subtitleStreamId: step.streamId,
          });
          if (automaticWorkflowCancelledRef.current.has(projectId)) continue;
          if (!selected.ok) return failAutomaticWorkflow(projectId, selected.message ?? "字幕轨选择失败");
          const result = await extractProjectSubtitle(projectId, step.streamId);
          if (automaticWorkflowCancelledRef.current.has(projectId)) continue;
          if (!result.ok) return failAutomaticWorkflow(projectId, result.message ?? "媒体字幕提取失败");
          continue;
        }
        if (step.kind === "run_asr") {
          const operationId = createId("auto-asr");
          setAutomaticStage(projectId, "recognizing", operationId);
          const selected = await selectProjectMediaStreams(projectId, {
            audioStreamId: step.audioStreamId,
          });
          if (automaticWorkflowCancelledRef.current.has(projectId)) continue;
          if (!selected.ok) return failAutomaticWorkflow(projectId, selected.message ?? "音频轨选择失败");
          const result = await runProjectAsr({
            projectId,
            audioStreamId: step.audioStreamId,
            ...resolveAsrLanguageSelection(project.config.sourceLanguage),
            requestedDevice: status?.device.requestedDevice ?? "cpu",
            allowCudaFallback: status?.device.allowCudaFallback ?? false,
            operationId,
          });
          if (automaticWorkflowCancelledRef.current.has(projectId)) continue;
          if (!result.ok) return failAutomaticWorkflow(projectId, result.message ?? "语音识别失败");
          latestAsrRunId = result.runId ?? null;
          continue;
        }
        if (step.kind === "segment_asr") {
          const operationId = createId("auto-segment");
          setAutomaticStage(projectId, "segmenting", operationId);
          const result = await segmentProjectAsrRun({
            projectId,
            asrRunId: step.asrRunId,
            configVersion: "asr-segmentation-v2",
            operationId,
          });
          if (automaticWorkflowCancelledRef.current.has(projectId)) continue;
          if (!result.ok) return failAutomaticWorkflow(projectId, result.message ?? "字幕时间轴生成失败");
          latestAsrRunId = step.asrRunId;
          continue;
        }
        if (step.kind === "detect_languages") {
          const operationId = createId("auto-language");
          setAutomaticStage(projectId, "detecting_language", operationId);
          const result = await detectProjectAsrLanguages({
            projectId,
            sourceTrackId: step.sourceTrackId,
            requestedDevice: status?.device.requestedDevice ?? "cpu",
            allowCudaFallback: status?.device.allowCudaFallback ?? false,
            operationId,
          });
          if (automaticWorkflowCancelledRef.current.has(projectId)) continue;
          if (!result.ok) return failAutomaticWorkflow(projectId, result.message ?? "原文语言检测失败");
          continue;
        }
        setAutomaticStage(projectId, "activating");
        const result = await activateProjectSourceTrack(projectId, step.sourceTrackId);
        if (automaticWorkflowCancelledRef.current.has(projectId)) continue;
        if (!result.ok) return failAutomaticWorkflow(projectId, result.message ?? "字幕准备失败");
      }
      return failAutomaticWorkflow(projectId, "自动处理步骤过多，已安全停止；请检查项目后继续。");
    } catch (error) {
      return failAutomaticWorkflow(projectId, error instanceof Error ? error.message : "自动处理失败，请重试。");
    } finally {
      automaticWorkflowLocksRef.current.delete(projectId);
    }
  };

  const startBatch = async (batch: ActiveBatch | null = activeBatch) => {
    if (!batch) return { ok: false as const, message: "没有可启动的批次" };
    if (!isDesktopRuntime()) {
      return { ok: false as const, message: "批量自动处理只能在桌面应用里进行" };
    }
    const started = { ...batch, startedAt: timestampNow() };
    setActiveBatch(started);
    setSaveError(null);
    for (const projectId of started.projectIds) {
      void runAutomaticProjectWorkflow(projectId, { batchId: started.id });
    }
    return { ok: true as const };
  };

  const resolveAutomaticWorkflowBlock = async (
    projectId: string,
    answer: AutomaticWorkflowAnswer,
  ) => {
    const resolution = automaticWorkflowsRef.current[projectId]?.resolution;
    if (!resolution || !resolution.choices.some((choice) => choice.value === answer.value)) {
      return { ok: false, message: "这项确认已失效，请重新开始自动处理。" };
    }
    if (resolution.kind === "stream") {
      if (answer.kind !== "stream" || answer.streamKind !== resolution.streamKind) {
        return { ok: false, message: "轨道确认与当前步骤不一致。" };
      }
      return selectProjectMediaStreams(projectId, resolution.streamKind === "audio"
        ? { audioStreamId: answer.value }
        : { subtitleStreamId: answer.value });
    }
    if (answer.kind !== "language" || answer.sourceTrackId !== resolution.sourceTrackId) {
      return { ok: false, message: "语言确认与当前字幕不一致。" };
    }
    return updateProjectAsrLanguages({
      projectId,
      sourceTrackId: resolution.sourceTrackId,
      changes: resolution.segmentIds.map((segmentId) => ({ segmentId, manualLanguage: answer.value })),
      confirmTrackConvergence: false,
    });
  };

  const cancelAutomaticProjectWorkflow = async (projectId: string) => {
    const current = automaticWorkflowsRef.current[projectId];
    if (!current || current.status !== "running") return { ok: false, message: "当前没有自动处理任务" };
    if (current.stage === "starting_translation") return { ok: false, message: "翻译任务已开始，请在项目进度中取消" };
    automaticWorkflowCancelledRef.current.add(projectId);
    setAutomaticWorkflow(projectId, { status: "cancelled", message: "正在停止；已完成的结果会保留。" });
    if (!current.operationId) return { ok: true };
    const result = await cancelProjectAsrOperation({ projectId, operationId: current.operationId });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  };

  const resolvePendingConfirmations = (projectId: string) => {
    if (isDesktopRuntime()) return;
    const now = timestampNow();

    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) {
          return project;
        }

        return {
          ...project,
          lifecycle: project.recentRunIds.length > 0 ? "needs_review" : "draft",
          pendingConfirmations: [],
          updatedAt: now,
          sourceTracks: project.sourceTracks.map((sourceTrack) =>
            sourceTrack.id === project.activeSourceTrackId
              ? {
                  ...sourceTrack,
                  summary: "主源轨已人工确认，当前项目将继续沿用这条时间轴。",
                }
              : sourceTrack,
          ),
        };
      }),
    );

    setTasks((current) =>
      current.map((task) =>
        task.projectId === projectId && task.stage === "detect"
          ? {
              ...task,
              status: "completed",
              progress: 100,
              detail: "已确认沿用当前主源轨，项目将继续围绕这条时间轴处理。",
              updatedAt: now,
            }
          : task,
      ),
    );
  };

  const markTargetTrackStatus = (
    projectId: string,
    languageCode: string,
    status: TargetTrackStatus,
  ) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    if (status === "approved") {
      return commitEditorResult(approveProjectTargetTrack(project, languageCode));
    }
    const source = getActiveSourceTrack(project);
    if (!source) return { ok: false, message: "请先提取内嵌字幕，然后才能编辑译文" };
    const track = source.targetTracks.find(
      (entry) => entry.languageCode === languageCode && entry.isActive,
    );
    if (!track) return { ok: false, message: "找不到目标语言轨" };
    if (status === "exported" && (track.status !== "approved" || track.qaIssues.some((issue) => issue.severity === "error"))) {
      return { ok: false, message: "只有通过校验且已批准的译文轨才能导出" };
    }
    const nextProject: Project = {
      ...project,
      lifecycle: status === "exported" ? "completed" : "needs_review",
      sourceTracks: project.sourceTracks.map((sourceTrack) =>
        sourceTrack.id !== project.activeSourceTrackId
          ? sourceTrack
          : {
              ...sourceTrack,
              targetTracks: sourceTrack.targetTracks.map((targetTrack) =>
                targetTrack.id === track.id
                  ? { ...targetTrack, status, lastHumanAction: `status changed to ${status}` }
                  : targetTrack,
              ),
            },
      ),
    };
    commitEditorProject(nextProject);
    return { ok: true };
  };

  const getApprovedTargetTrack = (projectId: string, languageCode: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    const source = project ? getActiveSourceTrack(project) : null;
    const track = source?.targetTracks.find(
      (entry) => entry.isActive && entry.languageCode === languageCode,
    );
    if (!project) return { ok: false as const, message: "找不到这个项目" };
    if (!track) return { ok: false as const, message: "找不到目标语言轨" };
    if (track.status !== "approved" && track.status !== "exported") {
      return { ok: false as const, message: "请先明确批准译文，再选择导出位置" };
    }
    if (track.qaIssues.some((issue) => issue.severity === "error")) {
      return { ok: false as const, message: "存在必须修复的问题，处理后才能导出" };
    }
    return { ok: true as const, project, track };
  };

  const persistExportedTargetTracks = async (projectId: string, languageCodes: string[]) => {
    if (languageCodes.length === 0) return { ok: true as const };
    const opened = await desktopOpenProject(projectId);
    if (!opened.ok || !opened.data) {
      return { ok: false as const, message: "字幕已写出，但无法重新载入交付状态" };
    }
    const openedProject = opened.data;
    const exportedLanguages = new Set(languageCodes);
    const exportedProject: Project = {
      ...openedProject,
      lifecycle: "completed",
      updatedAt: timestampNow(),
      sourceTracks: openedProject.sourceTracks.map((sourceTrack) => sourceTrack.id !== openedProject.activeSourceTrackId
        ? sourceTrack
        : {
            ...sourceTrack,
            targetTracks: sourceTrack.targetTracks.map((track) =>
              track.isActive && exportedLanguages.has(track.languageCode)
                ? { ...track, status: "exported", lastHumanAction: "status changed to exported" }
                : track,
            ),
          }),
    };
    const saved = await desktopSaveProject(exportedProject);
    if (!saved.ok) {
      return { ok: false as const, message: `字幕已写出，但交付状态保存失败：${localizeIpcErrorText(saved.error)}` };
    }
    projectSaveScheduler.acceptPersisted(exportedProject);
    projectsRef.current = projectsRef.current.map((project) => project.id === projectId ? exportedProject : project);
    setProjects(projectsRef.current);
    setSaveError(null);
    return { ok: true as const };
  };

  const exportTargetTrack = async (projectId: string, languageCode: string) => {
    if (!isDesktopRuntime()) {
      return { ok: false, message: "浏览器预览不写出文件，请在桌面应用中导出。" };
    }
    const deliverable = getApprovedTargetTrack(projectId, languageCode);
    if (!deliverable.ok) return deliverable;
    const result = await exportSubtitleMatrix(projectId, [{
      id: `target-${languageCode}`,
      exportKind: "target",
      targetLanguageCode: languageCode,
      format: "srt",
    }]);
    if (!result.ok) return result;
    if (result.summary.canceled) return { ok: true, canceled: true, summary: result.summary };
    const failed = result.summary.failed[0];
    if (failed) return { ok: false, message: localizeIpcErrorText(failed.error), summary: result.summary };
    const persisted = await persistExportedTargetTracks(projectId, [languageCode]);
    return persisted.ok ? { ok: true, summary: result.summary } : { ...persisted, summary: result.summary };
  };

  const approveAndExportProjectTargets = async (projectId: string) => {
    if (!isDesktopRuntime()) {
      return { ok: false, message: "浏览器预览不写出文件，请在桌面应用中导出。" };
    }
    const project = projectsRef.current.find((item) => item.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };

    const approval = approveProjectDelivery(project);
    commitEditorProject(approval.project);
    if (!approval.ok) {
      return {
        ok: false,
        blocked: approval.reason === "hard_qa_errors",
        message: approval.reason === "hard_qa_errors"
          ? `还有 ${approval.inspection.errorCount} 处必须修复的问题，暂未批准或导出`
          : "当前没有可交付的目标语言",
      };
    }
    const approvedProject = projectsRef.current.find((item) => item.id === projectId);
    const activeSource = approvedProject ? getActiveSourceTrack(approvedProject) : null;
    const exportableTracks = activeSource?.targetTracks.filter(
      (track) => track.isActive && (track.status === "approved" || track.status === "exported"),
    ) ?? [];
    if (exportableTracks.length === 0) {
      return { ok: false, approvedCount: approval.approvedLanguageCodes.length, message: "当前没有已批准的目标语言" };
    }

    const result = await exportSubtitleMatrix(projectId, exportableTracks.map((track) => ({
      id: `target-${track.languageCode}`,
      exportKind: "target" as const,
      targetLanguageCode: track.languageCode,
      format: "srt" as const,
    })));
    if (!result.ok) return { ...result, approvedCount: approval.approvedLanguageCodes.length };
    if (result.summary.canceled) {
      return { ok: true, canceled: true, approvedCount: approval.approvedLanguageCodes.length, summary: result.summary };
    }

    const exportedLanguages = result.summary.succeeded
      .map((entry) => entry.request.targetLanguageCode)
      .filter((languageCode): languageCode is string => Boolean(languageCode));
    const persisted = await persistExportedTargetTracks(projectId, exportedLanguages);
    if (!persisted.ok) {
      return { ...persisted, approvedCount: approval.approvedLanguageCodes.length, summary: result.summary };
    }
    return {
      ok: result.summary.failed.length === 0,
      approvedCount: approval.approvedLanguageCodes.length,
      summary: result.summary,
    };
  };

  const approveAndExportBatchTargets = async (projectIds: string[]) => {
    if (!isDesktopRuntime()) {
      return { ok: false, message: "浏览器预览不写出文件，请在桌面应用中导出。" };
    }
    const selectedIds = [...new Set(projectIds)];
    const approvedProjectIds: string[] = [];
    let blockedProjectCount = 0;

    for (const projectId of selectedIds) {
      const project = projectsRef.current.find((entry) => entry.id === projectId);
      if (!project) {
        blockedProjectCount += 1;
        continue;
      }
      const approval = approveProjectDelivery(project);
      commitEditorProject(approval.project);
      if (approval.ok) approvedProjectIds.push(projectId);
      else blockedProjectCount += 1;
    }

    if (approvedProjectIds.length === 0) {
      return {
        ok: false,
        blockedProjectCount,
        message: blockedProjectCount > 0 ? "这批项目仍有必须修复或尚未生成的字幕" : "当前没有可交付字幕",
      };
    }
    const saved = await Promise.all(approvedProjectIds.map((projectId) => projectSaveScheduler.flush(projectId)));
    if (saved.some((ok) => !ok)) {
      return { ok: false, blockedProjectCount, message: "部分项目尚未保存，未开始整批导出" };
    }

    const result = await desktopExportApprovedBatch({ projectIds: approvedProjectIds });
    if (!result.ok) {
      const message = localizeIpcErrorText(result.error);
      setSaveError(message);
      return { ok: false, blockedProjectCount, message };
    }
    if (result.data.canceled) {
      return { ok: true, canceled: true, approvedProjectCount: approvedProjectIds.length, blockedProjectCount };
    }

    let exportedFileCount = 0;
    let stateSaveFailed = false;
    for (const entry of result.data.projects) {
      const languageCodes = entry.summary.succeeded
        .map((item) => item.request.targetLanguageCode)
        .filter((languageCode): languageCode is string => Boolean(languageCode));
      exportedFileCount += languageCodes.length;
      const persisted = await persistExportedTargetTracks(entry.projectId, languageCodes);
      stateSaveFailed ||= !persisted.ok;
    }
    const fileFailures = result.data.projects.reduce(
      (total, entry) => total + entry.summary.failed.length,
      0,
    );
    const failedProjectCount = result.data.failedProjects.length + result.data.skippedProjectIds.length;
    const ok = !stateSaveFailed && fileFailures === 0 && failedProjectCount === 0;
    return {
      ok,
      approvedProjectCount: approvedProjectIds.length,
      exportedProjectCount: result.data.projects.filter((entry) => entry.summary.succeeded.length > 0).length,
      exportedFileCount,
      blockedProjectCount: blockedProjectCount + failedProjectCount,
      ...(ok ? {} : { message: "已导出可交付字幕；仍有项目需要处理" }),
    };
  };

  const updateSegmentTranslation = (
    projectId: string,
    languageCode: string,
    segmentId: string,
    manualText: string,
  ) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(setProjectTargetManual(project, languageCode, segmentId, manualText));
  };

  const setTargetSegmentLocked = (
    projectId: string,
    languageCode: string,
    segmentId: string,
    locked: boolean,
  ) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(setProjectTargetLocked(project, languageCode, segmentId, locked));
  };

  const editTimeline = (projectId: string, command: TimelineEditCommand) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    const result = editProjectTimeline(project, command);
    if (!result.ok) {
      const message = ({
        invalid_text_split: "请把光标放在字幕文字中间再拆分",
        split_point_out_of_range: "播放位置必须位于当前字幕时间范围内",
        locked: "当前字幕已锁定，请先解锁",
      } as Record<string, string>)[result.reason];
      if (message) return { ok: false, message };
    }
    return commitEditorResult(result);
  };

  const refreshTargetTrackQa = (projectId: string, languageCode: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(refreshProjectTargetQa(project, languageCode));
  };

  const replaceTargetTexts = (
    projectId: string,
    languageCode: string,
    findText: string,
    replaceText: string,
    scopeSegmentIds: string[] | null = null,
    matchField: "target" | "source" = "target",
  ) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    const result = replaceProjectTargetTexts(
      project,
      languageCode,
      findText,
      replaceText,
      scopeSegmentIds,
      matchField,
    );
    const committed = commitEditorResult(result);
    return {
      ...committed,
      replacedCount: result.ok ? result.replacedCount : undefined,
      skippedLockedCount: result.ok ? result.skippedLockedCount : undefined,
    };
  };

  const rerunSegment = async (projectId: string, languageCode: string, segmentId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    const plan = planProjectSelectedRerun(project, languageCode, [segmentId]);
    if (!plan.ok) return { ok: false, message: plan.reason };
    if (isDesktopRuntime()) return startProject(projectId, { targetLanguages: [languageCode], segmentIds: plan.requestSegmentIds });
    return { ok: false, message: "浏览器预览不执行翻译，请在桌面应用中重跑。" };
  };

  const createCandidateTranslation = async (projectId: string, languageCode: string) => {
    if (!isDesktopRuntime()) return { ok: false, message: "浏览器预览不执行翻译，请在桌面应用中创建候选轨。" };
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    const created = createProjectCandidateTrack(
      project,
      languageCode,
      () => `candidate-${crypto.randomUUID()}`,
    );
    if (!created.ok) return { ok: false, message: created.reason };
    commitEditorProject(created.project);
    const started = await startProject(projectId, {
      targetLanguages: [languageCode],
      candidateTrackId: created.candidateTrackId,
    });
    return { ...started, candidateTrackId: created.candidateTrackId };
  };

  const adoptCandidateText = (projectId: string, candidateTrackId: string, segmentId: string) => {
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    if (!project) return { ok: false, message: "找不到这个项目" };
    return commitEditorResult(adoptProjectCandidateSegment(project, candidateTrackId, segmentId));
  };

  const value = useMemo(
    () => ({
      batchSession,
      activeBatch,
      loadState,
      loadError,
      saveError,
      encodingConfirmation: pendingEncodingImport
        ? {
            fileName: pendingEncodingImport.file.name,
            candidates: pendingEncodingImport.candidates,
          }
        : null,
      isDesktop: desktop,
      automaticWorkflows,
      retryLoadProjects,
      flushBeforeClose,
      saveLibraryResource,
      deleteLibraryResource,
      refreshProjectResourceSnapshot,
      defaults,
      projects,
      tasks,
      runSnapshots,
      library,
      glossaryOptions: deriveGlossaryOptions(library),
      styleGuideOptions: deriveStyleGuideOptions(library),
      capabilities,
      refreshCapabilities,
      settings: workspaceMock.settings,
      updateDefaults,
      updateProjectConfig,
      setProjectTargetLanguages,
      trashProject,
      restoreProject,
      clearTrashedProjects,
      setProjectArchived,
      trashProjectSourceTrack,
      restoreProjectSourceTrack,
      trashProjectTargetTrack,
      restoreProjectTargetTrack,
      emptyProjectTrackTrash,
      createDraftProject,
      importDesktopMediaSource,
      probeProjectMedia,
      selectProjectMediaStreams,
      extractProjectSubtitle,
      exportProjectAudio,
      activateProjectSourceTrack,
      relinkProjectMedia,
      getProjectMediaPreviewUrl,
      getProjectMediaWaveform,
      getProjectAsrStatus,
      runProjectAsr,
      segmentProjectAsrRun,
      detectProjectAsrLanguages,
      updateProjectAsrLanguages,
      cancelProjectAsrOperation,
      controlTask,
      confirmSubtitleEncoding,
      cancelSubtitleEncoding,
      updateSourceSegmentManual,
      undoProjectEdit,
      redoProjectEdit,
      exportSourceSubtitle,
      exportSubtitleMatrix,
      exportSubtitleVideo,
      createProjectPackage,
      createBatchSession,
      importFiles,
      updateBatchSessionDefaults,
      updateBatchGroupTitle,
      updateBatchGroupDefaults,
      mergeBatchGroupIntoPrevious,
      splitBatchGroup,
      resolveBatchMediaMatch,
      resolveBatchSubtitleEncoding,
      commitBatchSession,
      startBatch,
      discardBatchSession,
      startProject,
      runAutomaticProjectWorkflow,
      resolveAutomaticWorkflowBlock,
      cancelAutomaticProjectWorkflow,
      resolvePendingConfirmations,
      markTargetTrackStatus,
      exportTargetTrack,
      approveAndExportProjectTargets,
      approveAndExportBatchTargets,
      updateSegmentTranslation,
      setTargetSegmentLocked,
      editTimeline,
      refreshTargetTrackQa,
      replaceTargetTexts,
      rerunSegment,
      createCandidateTranslation,
      adoptCandidateText,
    }),
    [
      batchSession,
      activeBatch,
      automaticWorkflows,
      // capabilities 曾漏在依赖里：refreshCapabilities 拉回真实能力目录后 memo 仍返回旧对象，
      // 消费者读到的一直是启动时的占位数据，「拉取模型」的结果永远不出现在下拉里。
      capabilities,
      defaults,
      desktop,
      flushBeforeClose,
      refreshCapabilities,
      saveLibraryResource,
      deleteLibraryResource,
      refreshProjectResourceSnapshot,
      loadError,
      loadState,
      library,
      pendingEncodingImport,
      projects,
      runSnapshots,
      saveError,
      tasks,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider");
  }

  return context;
}
