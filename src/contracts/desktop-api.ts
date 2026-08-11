// src/contracts/desktop-api.ts
// Shared compile-time contract and runtime IPC channel source of truth.
// This is the single source for preload-exposed API surface and IPC envelope.
// Renderer must import ONLY from this (and domain types); no Node, no Electron, no FS.

import type { AsrModelId, Project, ProjectTask, RunSnapshot, WorkspaceDefaults } from '../domain/workspace';
import type { AsrVadSettings } from '../../shared/asr-vad-config.mjs';
import type { AnyGlobalResource, AnyProjectResourceSnapshot, ResourceKind, ResourceWriteInput } from '../domain/resource-library';
import type { WorkerEvent } from './worker-task';

export type DesktopWorkerEvent = WorkerEvent;
export type DesktopWorkerEventListener = (event: DesktopWorkerEvent) => void;
export type DesktopBeforeCloseListener = () => void | Promise<void>;

// -----------------------------------------------------------------------------
// Single error envelope (P01-T03 requirement)
// All IPC responses use this. Never leak raw paths, stack traces with secrets,
// or credential material.
// -----------------------------------------------------------------------------
export interface DesktopIpcError {
  code:
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'PERMISSION_DENIED'
    | 'CONFLICT'
    | 'INTERNAL'
    | 'CANCELLED'
    | 'NOT_AVAILABLE'
    | 'INVALID_ARTIFACT'
    | 'UNSUPPORTED'
    | 'CORRUPT_INPUT'
    | 'TIMEOUT'
    | 'OUTPUT_TOO_LARGE'
    | 'INVALID_ASR_RESULT'
    | 'NO_SPEECH_DETECTED'
    | 'UNSEGMENTABLE_INPUT'
    | 'PROCESS_FAILED'
    | 'WORKER_CRASHED'
    | 'DOWNLOAD_FAILED'
    | 'LENGTH_MISMATCH'
    | 'HASH_MISMATCH'
    | 'DISK_FULL'
    | 'INSTALL_FAILED'
    | 'INVALID_ARCHIVE'
    | 'CUDA_UNAVAILABLE'
    | 'CUDA_INITIALIZATION_FAILED';
  message: string; // human-readable, sanitized
  retryable?: boolean;
  // details may contain safe, non-sensitive structured data only
  details?: Record<string, unknown>;
}

export type DesktopIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DesktopIpcError };

// -----------------------------------------------------------------------------
// Generic envelope for request/response (for logging, tracing, future batching)
// -----------------------------------------------------------------------------
export interface DesktopIpcEnvelope<Req, Res> {
  id: string;           // correlation id
  method: string;       // e.g. 'project.create'
  request: Req;
  response?: DesktopIpcResult<Res>;
  timestamp: string;    // ISO
}

// -----------------------------------------------------------------------------
// Persistence surface (Phase 2 minimal)
// These MUST delegate to backend/persistence/desktop-persistence-port.mjs
// Handlers must NOT duplicate repository logic.
// -----------------------------------------------------------------------------

export interface CreateProjectRequest {
  project: Project;
}
export interface CreateProjectResponse {
  projectId: string;
  // containerPath is intentionally NOT exposed to renderer.
  // It is held only by main/persistence layer for internal use.
}

export interface SaveProjectRequest {
  project: Project;
}
export interface SaveProjectResponse {
  ok: true;
}

export interface OpenProjectRequest {
  projectId: string;
}
export type OpenProjectResponse = Project | null;

export interface ListRecentProjectsRequest {
  // no filter in Phase 2 minimal; future filters stay additive
}
export interface ProjectIndexSummary {
  id: string;
  title: string;
  // containerPath is intentionally NOT exposed to renderer.
  // Only main/persistence hold real container paths.
  sourceFileName: string;
  mediaKind: string;
  lifecycle: string;
  updatedAt: string;
  latestRunSummary: string;
  trashedAt?: string;
  archivedAt?: string;
}
export type ListRecentProjectsResponse = ProjectIndexSummary[];

export interface ListResourcesRequest {
  kind?: ResourceKind;
}
export type ListResourcesResponse = AnyGlobalResource[];
export interface SaveResourceRequest {
  resource: ResourceWriteInput;
  expectedRevision?: number;
}
export type SaveResourceResponse = AnyGlobalResource;
export interface DeleteResourceRequest {
  resourceId: string;
  expectedRevision: number;
}
export interface DeleteResourceResponse {
  deleted: boolean;
}
export interface ListProjectResourceSnapshotsRequest {
  projectId: string;
  kind?: ResourceKind;
}
export type ListProjectResourceSnapshotsResponse = AnyProjectResourceSnapshot[];
export interface RefreshProjectResourceSnapshotRequest {
  projectId: string;
  resourceId: string;
}
export type RefreshProjectResourceSnapshotResponse = AnyProjectResourceSnapshot;

// -----------------------------------------------------------------------------
// Window control (minimal, for TopWindowBar)
// -----------------------------------------------------------------------------
export type WindowControlAction = 'minimize' | 'maximizeOrRestore' | 'close';
export interface WindowControlRequest {
  action: WindowControlAction;
}
export interface WindowControlResponse {
  ok: true;
}

// -----------------------------------------------------------------------------
// Subtitle import / source export (Phase 3)
// Renderer submits fileName + binary bytes only. Absolute paths are never accepted
// or returned.
// -----------------------------------------------------------------------------
export type SubtitleEncodingChoice =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'gbk'
  | 'shift_jis';

export type SubtitleExportMode = 'raw' | 'normalized';
export type SubtitleNormalizedFormat = 'srt' | 'vtt' | 'ass';

export interface ImportSubtitleRequest {
  fileName: string;
  /** Binary payload. Prefer Uint8Array; ArrayBuffer is also accepted. */
  bytes: ArrayBuffer | Uint8Array;
  /** Required when detection returns needs_encoding_confirmation. */
  encoding?: SubtitleEncodingChoice;
  defaults?: {
    sourceLanguage?: string;
    targetLanguages?: string[];
    provider?: string;
    model?: string;
    glossary?: string;
    styleGuide?: string;
    outputFormat?: string;
  };
}

export interface ImportSubtitleResponse {
  /** Present after a completed import; absent while encoding confirmation is required. */
  project?: Project;
  warnings: string[];
  needsEncodingConfirmation?: boolean;
  encodingCandidates?: SubtitleEncodingChoice[];
}

export interface ExportSourceSubtitleRequest {
  projectId: string;
  mode: SubtitleExportMode;
  /** Required when mode is normalized. */
  format?: SubtitleNormalizedFormat;
  /** Safe renderer intent only; the main process owns the native picker and absolute path. */
  destination?: 'project' | 'user';
}

export type ExportSourceSubtitleResponse = {
  canceled: true;
} | {
  canceled: false;
  exportRecordId: string;
  fileName: string;
  format: string;
  warnings: string[];
};

// -----------------------------------------------------------------------------
// subscribeTasks selects the task stream; onWorkerEvent receives its typed events.
export interface SubscribeTasksRequest {
  projectId?: string; // undefined = global recent
}
export interface SubscribeTasksResponse {
  subscribed: true;
  tasks: ProjectTask[];
  // main will start emitting WorkerEvent values on DESKTOP_EVENT_CHANNEL
}

export interface ProjectPackageRequest {
  projectId: string;
  kind: 'lightweight' | 'archive';
  includeTrash?: boolean;
  /** Main resolves the configured backup directory; renderer never supplies a path. */
  destination?: 'backup';
}

export interface ProjectPackageResponse {
  exportRecordId: string;
  fileName: string;
  kind: 'lightweight' | 'archive';
  sizeBytes: number;
  sha256: string;
  includesTrash: boolean;
}

export interface DeleteProjectPermanentlyRequest {
  projectId: string;
  confirmed: true;
}

export interface DeleteProjectPermanentlyResponse {
  projectId: string;
  deleted: true;
}

export interface SubtitleExportRequestItem {
  id?: string;
  exportKind: 'source' | 'target' | 'bilingual';
  targetLanguageCode?: string;
  format: SubtitleNormalizedFormat;
}

export interface ExportSubtitleMatrixRequest {
  projectId: string;
  requests: SubtitleExportRequestItem[];
  /** Safe renderer intent only; the main process owns the native picker and absolute path. */
  destination?: 'project' | 'user';
}

export interface ExportSubtitleMatrixResponse {
  ok: boolean;
  partial: boolean;
  canceled: boolean;
  succeeded: Array<{
    request: SubtitleExportRequestItem;
    exportRecordId: string;
    fileName: string;
    format: SubtitleNormalizedFormat;
    deliveryStatus: 'approved' | 'draft';
    warnings: string[];
  }>;
  failed: Array<{
    request: SubtitleExportRequestItem;
    error: { code: string; message: string; retryable: boolean };
  }>;
}

export interface ExportApprovedBatchRequest {
  projectIds: string[];
}

export interface ExportApprovedBatchResponse {
  canceled: boolean;
  projects: Array<{
    projectId: string;
    summary: ExportSubtitleMatrixResponse;
  }>;
  skippedProjectIds: string[];
  failedProjects: Array<{
    projectId: string;
    error: { code: string; message: string; retryable: boolean };
  }>;
}

export interface SubtitleVideoExportRequest {
  projectId: string;
  subtitleExportRecordId: string;
  mode: 'soft_subtitle' | 'burn_ass';
  operationId: string;
}

export type SubtitleVideoExportResponse = {
  ok: true;
  canceled: true;
} | {
  ok: true;
  canceled: false;
  exportRecordId: string;
  fileName: string;
  sourceSubtitleFileName: string;
  deliveryStatus: 'approved' | 'draft';
};

export interface AudioSeparationCapabilityResponse {
  available: boolean;
  workerId: string | null;
  modelVersion: string | null;
  reason: string | null;
}

export interface AudioSeparationRequest {
  projectId: string;
  operationId: string;
}

export interface AudioSeparationResponse {
  ok: true;
  exportRecordId: string;
  workerId: string;
  modelVersion: string;
  stems: Array<'vocals' | 'accompaniment' | 'background'>;
}
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'prioritize';
export interface TaskControlRequest {
  taskId: string;
  projectId: string;
  action: TaskControlAction;
  /** Required for recoverable resume and retry; ignored for pause/cancel. */
  userConfirmed?: boolean;
}
export interface TaskControlResponse {
  task: ProjectTask;
}

// -----------------------------------------------------------------------------
// Credentials (Phase 4)
// Renderer may save/replace/delete and read non-secret status only.
// Stored secrets are never returned through this surface.
// -----------------------------------------------------------------------------
export interface CredentialStatus {
  configured: boolean;
  credentialId?: string;
  providerId?: string;
  label?: string;
  updatedAt?: string;
}

export interface CredentialSaveRequest {
  credentialId: string;
  /** One-shot secret write. Never returned by any DesktopApi method. */
  secret: string;
  providerId?: string;
  label?: string;
}
export type CredentialSaveResponse = CredentialStatus;

export interface CredentialDeleteRequest {
  credentialId: string;
}
export interface CredentialDeleteResponse {
  deleted: true;
  existed: boolean;
}

export interface CredentialStatusRequest {
  /** When omitted, returns all non-secret statuses. */
  credentialId?: string;
}
export type CredentialStatusResponse =
  | CredentialStatus
  | { credentials: CredentialStatus[] };

// -----------------------------------------------------------------------------
// Phase 12 system readiness, settings, backup and diagnostics.
// -----------------------------------------------------------------------------
export interface AppSettings {
  schemaVersion: 1;
  startupPage: 'resume' | 'start' | 'projects';
  translationProvider: string | null;
  translationModel: string | null;
  asrDefaultModelId: AsrModelId;
  asrVad: AsrVadSettings;
  asrVocalSeparation: 'off' | 'on';
  asrSongHandling: 'preserve' | 'filter';
  cachePath: string;
  modelPath: string;
  backupPath: string;
  downloadSource: 'official' | 'mirror' | 'custom';
  customDownloadUrl: string;
  notifications: { taskDone: boolean; error: boolean; release: boolean; system: boolean };
}
export type AppStoragePathKey = 'cachePath' | 'backupPath';
export interface SettingsDirectorySelectionResponse {
  canceled: boolean;
  directoryPath?: string;
}
export interface ModelStorageDestinationSelectionResponse {
  canceled: boolean;
  directoryPath?: string;
  selectionToken?: string;
}
export interface ModelStorageTransferResponse {
  fileCount?: number;
  sizeBytes?: number;
  oldDirectoryRemoved?: boolean;
  destinationPath?: string;
}
export type ModelStorageTransferStage = 'scanning' | 'copying' | 'verifying' | 'switching' | 'cleaning' | 'completed' | 'failed';
export interface ModelStorageTransferProgress {
  stage: ModelStorageTransferStage;
  progress: number;
  message: string;
  processedBytes: number;
  totalBytes: number;
}
export type ModelStorageTransferProgressListener = (event: ModelStorageTransferProgress) => void;
export type CapabilityRepairAction =
  | 'open_provider' | 'open_model_manager' | 'open_project' | 'open_environment'
  | 'open_projects' | 'open_project_settings' | 'relink_media' | 'open_editor';
export interface CapabilityReadinessItem {
  id: 'translation' | 'asr' | 'subtitle_export' | 'video_export' | 'audio_separation';
  label: string;
  available: boolean;
  reason: string | null;
  repairAction: CapabilityRepairAction | null;
}
export interface CapabilityReadinessResponse {
  probedAt: string;
  global: { capabilities: CapabilityReadinessItem[] };
  project?: { projectId: string; capabilities: CapabilityReadinessItem[] };
}
export interface DownloadStatusResponse {
  items: Array<{
    operationId: string;
    assetId: string;
    assetKind: 'model' | 'runtime';
    stage: string;
    status: 'active' | 'paused' | 'failed' | 'ready';
    progress: number;
    receivedBytes: number;
    totalBytes: number;
    errorCode?: string;
  }>;
  sources: Array<{ source: 'official' | 'mirror' | 'custom'; status: 'healthy' | 'unavailable'; latencyMs: number | null }>;
}
export interface BackupRestoreSelectionResponse {
  canceled?: true;
  kind?: 'app' | 'project';
  token?: string;
  fileName?: string;
  summary?: Record<string, unknown>;
}
export interface DiagnosticPreviewResponse {
  createdAt: string;
  totalBytes: number;
  entries: Array<{ name: string; content: string }>;
}

// -----------------------------------------------------------------------------
// Provider connection + translation (Phase 4)
// -----------------------------------------------------------------------------
/** "messages" 为 Anthropic 官方协议；与 electron/ipc/validate.mjs 的 PROVIDER_TRANSPORT_MODES 必须保持一致。 */
export type ProviderTransportMode = "responses" | "chat_completions" | "messages";

export interface ProviderTestConnectionRequest {
  provider: string;
  credentialId?: string;
  baseUrl?: string;
  model?: string;
  transportMode?: ProviderTransportMode;
  timeoutMs?: number;
}
export interface ProviderTestConnectionResponse {
  ok: true;
  transportMode: ProviderTransportMode;
  baseUrlDisplay: string;
  model: string | null;
}

export interface ProviderListModelsRequest {
  provider: string;
  credentialId?: string;
  /** Overrides the registry default; must be HTTPS (loopback HTTP only in dev). */
  baseUrl?: string;
  timeoutMs?: number;
}
export interface ProviderModelOption {
  /** Exact model id to send to the provider. */
  id: string;
  /** Display name when the provider supplies one, otherwise the id. */
  label: string;
}
export interface ProviderListModelsResponse {
  providerId: string;
  providerName: string;
  baseUrlDisplay: string;
  models: ProviderModelOption[];
  /** The provider has more models than were returned. */
  truncated: boolean;
}

export interface TranslationStartRequest {
  projectId: string;
  /** Explicit user confirmation for paid work. */
  userConfirmed: true;
  provider?: string;
  model?: string;
  credentialId?: string;
  baseUrl?: string;
  transportMode?: ProviderTransportMode;
  targetLanguages?: string[];
  /** Exact paid/update scope for an explicit selected-segment rerun. */
  segmentIds?: string[];
  /** Persist a full-track result into this inactive candidate track. */
  candidateTrackId?: string;
  /** Optional durable association used by the batch task center. */
  batchId?: string;
  batchEstimatedTokens?: number;
  parameters?: { temperature?: number };
}
export type { AsrVadMode, AsrVadParameters, AsrVadSettings } from '../../shared/asr-vad-config.mjs';
export interface TranslationLanguageResultSummary {
  targetLanguage: string;
  status: string;
  cacheHits: number;
  networkCalls: number;
  snapshotId: string | null;
  reason?: string | null;
  errorClass?: string | null;
}
/**
 * 「开始翻译」是**入队**语义，不是「跑完了」。
 * 调用在任务排进队列的那一刻就返回，之后的进度、暂停、失败原因
 * 全部通过 worker 事件流和 subscribeTasks 观察。
 */
export interface TranslationStartResponse {
  projectId: string;
  /** 刚排入队列的任务；渲染层据此立刻显示进度并提供暂停/取消。 */
  task?: ProjectTask;
  /** 仅在没有任务队列的退化路径上返回（同步跑完的整轮结果）。 */
  results?: TranslationLanguageResultSummary[];
}
export interface ProviderRuntimeStateRequest {
  provider: string;
}
export interface ProviderRuntimeStateResponse {
  providerId: string;
  providerName: string;
  status: "untested" | "ready" | "failed";
  credentialId?: string | null;
  requestedModel?: string;
  modelId?: string;
  baseUrlDisplay?: string;
  transportMode?: ProviderTransportMode;
  testedAt?: string;
  /** 「拉取模型」得到的完整型号列表；渲染层用它替换注册表内置兜底列表 */
  configuredModels?: string[];
}

export interface ProjectRuntimeStateRequest {
  projectId: string;
}
export interface ProjectRuntimeStateResponse {
  projectId: string;
  runSnapshots: RunSnapshot[];
  tasks: ProjectTask[];
}

// -----------------------------------------------------------------------------
// Local ASR capability (Phase 7) — public status only, never managed paths.
// -----------------------------------------------------------------------------
export type AsrInstallState = 'not_installed' | 'installing' | 'ready' | 'corrupt' | 'incompatible';
export interface AsrAssetCapability {
  id: string;
  version: string;
  installState: AsrInstallState;
  reason?: string;
}
export interface AsrRuntimeCapability extends AsrAssetCapability {
  device?: 'cuda';
  engineId?: 'whisper.cpp' | 'qwen3-asr';
  engineVersion?: string;
}
export type { AsrModelId } from '../domain/workspace';
export interface AsrModelCapability extends AsrAssetCapability {
  modelHash: string;
}
export interface AsrCatalogModelCapability extends AsrModelCapability {
  engineId: 'whisper.cpp' | 'qwen3-asr';
  engineVersion: string;
  displayName: string;
  family: 'small' | 'large-v3-turbo' | 'large-v3' | 'qwen3-asr';
  variant: 'full' | 'q5_0' | 'q8_0' | '0.6b' | '1.7b';
  quantization: 'none' | 'q5_0' | 'q8_0';
  format: 'ggml' | 'safetensors';
  sizeBytes: number;
  license: string;
  minimumMemoryBytes: number;
  recommendedMemoryBytes: number;
  recommendedVramBytes: number;
  supportsCpu: boolean;
  supportsCuda: boolean;
  languageScope: 'multilingual';
  timestampSupport: 'segment-and-token' | 'forced-aligner';
  productStatus: 'stable' | 'preview' | 'evaluating';
  dependencySizeBytes?: number;
}
export interface AsrVadModelCapability extends AsrModelCapability {
  displayName: string;
  sizeBytes: number;
  license: string;
}
export interface AsrCapabilityStatusRequest {}
export interface AsrCapabilityStatusResponse {
  engineId: 'whisper.cpp';
  engineVersion: '1.9.1';
  runtime: AsrRuntimeCapability;
  model: AsrModelCapability;
  models: AsrCatalogModelCapability[];
  vadModel?: AsrVadModelCapability;
  optionalRuntimes: AsrRuntimeCapability[];
  engines?: Array<{ id: 'whisper.cpp' | 'qwen3-asr'; version: string; runtime: AsrRuntimeCapability }>;
  qwenAligner?: AsrModelCapability & { sizeBytes: number };
  songClassifier?: AsrSongClassifierCapability;
  ready: boolean;
}
export interface AsrSongClassifierCapability {
  id: 'ina-speech-music-noise-v1';
  version?: string;
  displayName?: string;
  modelHash?: string;
  sizeBytes?: number;
  license?: 'MIT';
  installState: 'not_installed' | 'ready' | 'corrupt';
  reason?: 'shared_runtime_missing' | 'missing' | 'component_incomplete' | 'verification_failed';
}
export interface AsrSongClassifierInstallRequest {
  assetId: 'ina-speech-music-noise-v1';
  source: 'official';
  operationId: string;
}
export interface AsrSongClassifierOperationRequest {
  assetId: 'ina-speech-music-noise-v1';
  operationId: string;
}
export interface AsrSongClassifierInstallResponse {
  assetId: 'ina-speech-music-noise-v1';
  installState: 'ready';
  source: 'official';
  sizeBytes: number;
  sha256: string;
}
export type AsrModelSource = 'official' | 'mirror';
export interface AsrModelInstallRequest {
  assetId: AsrModelId;
  source: AsrModelSource | 'auto';
  operationId: string;
}
export interface AsrModelOperationRequest {
  assetId: AsrModelId;
  operationId: string;
}
export interface AsrModelCancelRequest {
  operationId: string;
}
export interface AsrModelInstallResponse {
  assetId: AsrModelId;
  installState: 'ready';
  source: AsrModelSource | 'manual';
  sizeBytes: number;
  sha256: string;
  resumedFromBytes: number;
}
export type AsrModelImportResponse = AsrModelInstallResponse | { canceled: true };
export interface AsrRuntimeInstallRequest {
  assetId: 'whisper-cpp-cuda-12.4-x64' | 'qwen3-asr-transformers-cu128-x64';
  source: 'official';
  operationId: string;
}
export interface AsrRuntimeOperationRequest {
  assetId: 'whisper-cpp-cuda-12.4-x64' | 'qwen3-asr-transformers-cu128-x64';
  operationId: string;
}
export interface AsrRuntimeInstallResponse {
  assetId: 'whisper-cpp-cuda-12.4-x64' | 'qwen3-asr-transformers-cu128-x64';
  installState: 'ready';
  source: 'official' | 'manual';
  sizeBytes: number;
  sha256: string;
}
export type AsrRuntimeImportResponse = AsrRuntimeInstallResponse | { canceled: true };
export type AsrRequestedDevice = 'auto' | 'cpu' | 'cuda';
export type AsrActualDevice = 'cpu' | 'cuda';
export type AsrFallbackReason = 'cuda_not_ready' | 'cuda_probe_failed' | 'cuda_initialization_failed';
export interface AsrDeviceDetection {
  status: 'not_detected' | 'available' | 'unavailable';
  runtimeId: string;
  runtimeVersion: string;
  reason?: 'runtime_not_ready' | 'probe_failed' | 'initialization_failed';
}
export interface AsrDeviceStatusResponse {
  requestedDevice: AsrRequestedDevice;
  allowCudaFallback: boolean;
  actualDevice: AsrActualDevice | null;
  actualRuntimeId: string | null;
  actualRuntimeVersion: string | null;
  fallbackReason: AsrFallbackReason | null;
  detection: { cpu: AsrDeviceDetection; cuda: AsrDeviceDetection };
  updatedAt: string | null;
}
export interface AsrDevicePreferenceRequest {
  requestedDevice: AsrRequestedDevice;
  allowCudaFallback: boolean;
}
export interface AsrDeviceOperationRequest {
  operationId: string;
}
export interface AsrProjectRequest {
  projectId: string;
}
export interface AsrTranscribeRequest extends AsrProjectRequest {
  audioStreamId: string;
  languageMode: 'auto' | 'fixed';
  languageHint: string | null;
  requestedDevice: AsrRequestedDevice;
  allowCudaFallback: boolean;
  operationId: string;
}
export interface AsrSegmentRequest extends AsrProjectRequest {
  asrRunId: string;
  configVersion: 'asr-segmentation-v2';
  operationId: string;
}
export interface AsrLanguageDetectRequest extends AsrProjectRequest {
  sourceTrackId: string;
  requestedDevice: AsrRequestedDevice;
  allowCudaFallback: boolean;
  operationId: string;
}
export interface AsrLanguageChange {
  segmentId: string;
  manualLanguage: string | null;
}
export interface AsrLanguageUpdateRequest extends AsrProjectRequest {
  sourceTrackId: string;
  changes: AsrLanguageChange[];
  confirmTrackConvergence: boolean;
}
export interface AsrCancelRequest extends AsrProjectRequest {
  operationId: string;
}
export type AsrInfoTarget = 'engine-source' | 'engine-license' | 'model-source' | 'model-license' | 'vad-source' | 'vad-license';
export interface AsrInfoOpenRequest {
  target: AsrInfoTarget;
  modelId?: AsrModelId;
}
export interface AsrRunSummary {
  id: string;
  audioStreamId: string;
  modelId: AsrModelId;
  actualDevice: AsrActualDevice;
  fallbackReason: AsrFallbackReason | null;
  mediaDurationMs: number;
  processingDurationMs: number;
  rawSegmentCount: number;
  wordCount: number;
  detectedLanguage: string;
  completedAt: string;
}
export interface AsrProjectStatusResponse {
  project: Project;
  capability: AsrCapabilityStatusResponse;
  device: AsrDeviceStatusResponse;
  runs: AsrRunSummary[];
}
export interface AsrProjectMutationResponse {
  project: Project;
  sourceTrackId: string;
  pendingSegmentIds?: string[];
  affectedSegmentIds?: string[];
  deduplicated?: boolean;
}

// -----------------------------------------------------------------------------
// Media probe / extract / preview (Phase 6) — no absolute paths from Renderer
// -----------------------------------------------------------------------------
export interface MediaSelectSourceRequest {
  copyIntoProject?: boolean;
  defaults?: Partial<Project['config']>;
  operationId?: string;
}
export interface MediaSelectSourceResponse {
  project: Project;
  recommendation?: Record<string, unknown>;
  probeSummary?: Record<string, unknown>;
}
export interface MediaProjectRequest {
  projectId: string;
  operationId?: string;
}
export interface MediaSelectStreamsRequest {
  projectId: string;
  audioStreamId?: string | null;
  subtitleStreamId?: string | null;
}
export interface MediaExtractSubtitleRequest {
  projectId: string;
  streamId: string;
  operationId?: string;
}
export interface MediaExtractSubtitleResponse {
  project: Project;
  candidateSourceTrackId: string;
  warnings?: string[];
}
export interface MediaExtractAudioRequest {
  projectId: string;
  streamId: string;
  operationId?: string;
}
export interface MediaExtractAudioResponse {
  canceled: boolean;
  fileName?: string;
  streamId?: string;
}
export interface MediaActivateSourceTrackRequest {
  projectId: string;
  sourceTrackId: string;
}
export interface MediaPreviewUrlRequest {
  projectId: string;
  assetId?: string;
}
export interface MediaPreviewUrlResponse {
  url: string;
  expiresAt: number;
  mediaKind: string;
}
export interface MediaCancelRequest {
  projectId: string;
  operationId: string;
}

export interface BatchSessionFile {
  id: string;
  name: string;
  mediaKind: 'video' | 'audio' | 'subtitle';
  probe: Record<string, unknown>;
  encodingCandidates?: SubtitleEncodingChoice[];
}
export interface MediaWaveformResponse {
  durationMs: number;
  peaks: number[];
}
export type BatchImportAmbiguity =
  | {
      kind: 'media_match';
      fileId: string;
      candidateMediaFileIds: string[];
    }
  | {
      kind: 'subtitle_encoding';
      fileId: string;
      encodingCandidates: SubtitleEncodingChoice[];
    };
export interface BatchSessionGroup {
  id: string;
  title: string;
  confidence: 'high' | 'low';
  fileIds: string[];
}
export interface BatchSessionResponse {
  id: string;
  createdAt: string;
  files: BatchSessionFile[];
  groups: BatchSessionGroup[];
  ambiguities: BatchImportAmbiguity[];
}
export interface BatchCommitRequest {
  sessionId: string;
  defaults: WorkspaceDefaults;
  groups: Array<{
    id: string;
    title: string;
    fileIds: string[];
    overrides: Partial<WorkspaceDefaults>;
  }>;
  fileEncodings?: Array<{
    fileId: string;
    encoding: SubtitleEncodingChoice;
  }>;
}
export interface BatchCommitResponse {
  batchId: string;
  projectIds: string[];
  projects: Project[];
}
export interface BatchStartRequest {
  batchId: string;
  projectIds: string[];
  userConfirmed: true;
  provider?: string;
  model?: string;
  credentialId?: string;
  baseUrl?: string;
  transportMode?: ProviderTransportMode;
  parameters?: { temperature?: number };
}
export interface BatchStartResponse {
  batchId: string;
  tasks: ProjectTask[];
}

// -----------------------------------------------------------------------------
// Public API surface exposed through preload
// -----------------------------------------------------------------------------
export interface DesktopApi {
  createProject(req: CreateProjectRequest): Promise<DesktopIpcResult<CreateProjectResponse>>;
  saveProject(req: SaveProjectRequest): Promise<DesktopIpcResult<SaveProjectResponse>>;
  openProject(req: OpenProjectRequest): Promise<DesktopIpcResult<OpenProjectResponse>>;
  listRecentProjects(req: ListRecentProjectsRequest): Promise<DesktopIpcResult<ListRecentProjectsResponse>>;
  createProjectPackage(req: ProjectPackageRequest): Promise<DesktopIpcResult<ProjectPackageResponse>>;
  deleteProjectPermanently(req: DeleteProjectPermanentlyRequest): Promise<DesktopIpcResult<DeleteProjectPermanentlyResponse>>;
  listResources(req?: ListResourcesRequest): Promise<DesktopIpcResult<ListResourcesResponse>>;
  saveResource(req: SaveResourceRequest): Promise<DesktopIpcResult<SaveResourceResponse>>;
  deleteResource(req: DeleteResourceRequest): Promise<DesktopIpcResult<DeleteResourceResponse>>;
  listProjectResourceSnapshots(req: ListProjectResourceSnapshotsRequest): Promise<DesktopIpcResult<ListProjectResourceSnapshotsResponse>>;
  refreshProjectResourceSnapshot(req: RefreshProjectResourceSnapshotRequest): Promise<DesktopIpcResult<RefreshProjectResourceSnapshotResponse>>;
  importSubtitle(req: ImportSubtitleRequest): Promise<DesktopIpcResult<ImportSubtitleResponse>>;
  exportSourceSubtitle(req: ExportSourceSubtitleRequest): Promise<DesktopIpcResult<ExportSourceSubtitleResponse>>;
  exportSubtitleMatrix(req: ExportSubtitleMatrixRequest): Promise<DesktopIpcResult<ExportSubtitleMatrixResponse>>;
  exportApprovedBatch(req: ExportApprovedBatchRequest): Promise<DesktopIpcResult<ExportApprovedBatchResponse>>;
  exportSubtitleVideo(req: SubtitleVideoExportRequest): Promise<DesktopIpcResult<SubtitleVideoExportResponse>>;
  getAudioSeparationCapability(): Promise<DesktopIpcResult<AudioSeparationCapabilityResponse>>;
  startAudioSeparation(req: AudioSeparationRequest): Promise<DesktopIpcResult<AudioSeparationResponse>>;
  windowControl(req: WindowControlRequest): Promise<DesktopIpcResult<WindowControlResponse>>;
  subscribeTasks(req: SubscribeTasksRequest): Promise<DesktopIpcResult<SubscribeTasksResponse>>;
  controlTask(req: TaskControlRequest): Promise<DesktopIpcResult<TaskControlResponse>>;
  saveCredential(req: CredentialSaveRequest): Promise<DesktopIpcResult<CredentialSaveResponse>>;
  deleteCredential(req: CredentialDeleteRequest): Promise<DesktopIpcResult<CredentialDeleteResponse>>;
  getCredentialStatus(req?: CredentialStatusRequest): Promise<DesktopIpcResult<CredentialStatusResponse>>;
  getCapabilityReadiness(req?: { projectId?: string }): Promise<DesktopIpcResult<CapabilityReadinessResponse>>;
  getAppSettings(): Promise<DesktopIpcResult<AppSettings>>;
  selectSettingsDirectory(req: { pathKey: AppStoragePathKey }): Promise<DesktopIpcResult<SettingsDirectorySelectionResponse>>;
  selectModelStorageDestination(): Promise<DesktopIpcResult<ModelStorageDestinationSelectionResponse>>;
  transferModelStorage(req: { selectionToken: string }): Promise<DesktopIpcResult<ModelStorageTransferResponse>>;
  saveAppSettings(req: { settings: AppSettings }): Promise<DesktopIpcResult<AppSettings>>;
  resetAppSettings(): Promise<DesktopIpcResult<AppSettings>>;
  getDownloadStatus(): Promise<DesktopIpcResult<DownloadStatusResponse>>;
  probeDownloadSources(): Promise<DesktopIpcResult<DownloadStatusResponse>>;
  createAppBackup(): Promise<DesktopIpcResult<{ fileName: string; sizeBytes: number; sha256: string }>>;
  selectBackupRestore(req: { kind: 'app' | 'project' }): Promise<DesktopIpcResult<BackupRestoreSelectionResponse>>;
  applyBackupRestore(req: { token: string; userConfirmed: boolean }): Promise<DesktopIpcResult<Record<string, unknown>>>;
  previewDiagnostics(): Promise<DesktopIpcResult<DiagnosticPreviewResponse>>;
  exportDiagnostics(): Promise<DesktopIpcResult<{ canceled: boolean; fileName?: string; sizeBytes?: number }>>;
  testProviderConnection(req: ProviderTestConnectionRequest): Promise<DesktopIpcResult<ProviderTestConnectionResponse>>;
  listProviderModels(req: ProviderListModelsRequest): Promise<DesktopIpcResult<ProviderListModelsResponse>>;
  getProviderRuntimeState(req: ProviderRuntimeStateRequest): Promise<DesktopIpcResult<ProviderRuntimeStateResponse>>;
  startTranslation(req: TranslationStartRequest): Promise<DesktopIpcResult<TranslationStartResponse>>;
  getProjectRuntimeState(req: ProjectRuntimeStateRequest): Promise<DesktopIpcResult<ProjectRuntimeStateResponse>>;
  getAsrCapabilityStatus(req?: AsrCapabilityStatusRequest): Promise<DesktopIpcResult<AsrCapabilityStatusResponse>>;
  installAsrModel(req: AsrModelInstallRequest): Promise<DesktopIpcResult<AsrModelInstallResponse>>;
  importAsrModel(req: AsrModelOperationRequest): Promise<DesktopIpcResult<AsrModelImportResponse>>;
  uninstallAsrModel(req: AsrModelOperationRequest): Promise<DesktopIpcResult<{ assetId: AsrModelId; uninstalled: boolean }>>;
  cancelAsrModelOperation(req: AsrModelCancelRequest): Promise<DesktopIpcResult<{ cancelled: boolean }>>;
  installAsrRuntime(req: AsrRuntimeInstallRequest): Promise<DesktopIpcResult<AsrRuntimeInstallResponse>>;
  importAsrRuntime(req: AsrRuntimeOperationRequest): Promise<DesktopIpcResult<AsrRuntimeImportResponse>>;
  uninstallAsrRuntime(req: AsrRuntimeOperationRequest): Promise<DesktopIpcResult<{ assetId: AsrRuntimeOperationRequest['assetId']; uninstalled: boolean }>>;
  cancelAsrRuntimeOperation(req: AsrModelCancelRequest): Promise<DesktopIpcResult<{ cancelled: boolean }>>;
  installAsrSongClassifier(req: AsrSongClassifierInstallRequest): Promise<DesktopIpcResult<AsrSongClassifierInstallResponse>>;
  uninstallAsrSongClassifier(req: AsrSongClassifierOperationRequest): Promise<DesktopIpcResult<{ assetId: 'ina-speech-music-noise-v1'; uninstalled: boolean }>>;
  cancelAsrSongClassifierOperation(req: AsrModelCancelRequest): Promise<DesktopIpcResult<{ cancelled: boolean }>>;
  getAsrDeviceStatus(): Promise<DesktopIpcResult<AsrDeviceStatusResponse>>;
  setAsrDevicePreference(req: AsrDevicePreferenceRequest): Promise<DesktopIpcResult<AsrDeviceStatusResponse>>;
  detectAsrDevices(req: AsrDeviceOperationRequest): Promise<DesktopIpcResult<AsrDeviceStatusResponse>>;
  cancelAsrDeviceDetection(req: AsrDeviceOperationRequest): Promise<DesktopIpcResult<{ cancelled: boolean }>>;
  getAsrProjectStatus(req: AsrProjectRequest): Promise<DesktopIpcResult<AsrProjectStatusResponse>>;
  runAsrTranscription(req: AsrTranscribeRequest): Promise<DesktopIpcResult<{ runId: string; operationId: string; segmentCount: number; wordCount: number; deduplicated: boolean }>>;
  segmentAsrRun(req: AsrSegmentRequest): Promise<DesktopIpcResult<AsrProjectMutationResponse>>;
  detectAsrSegmentLanguages(req: AsrLanguageDetectRequest): Promise<DesktopIpcResult<AsrProjectMutationResponse>>;
  updateAsrSegmentLanguages(req: AsrLanguageUpdateRequest): Promise<DesktopIpcResult<AsrProjectMutationResponse>>;
  cancelAsrProjectOperation(req: AsrCancelRequest): Promise<DesktopIpcResult<{ cancelled: boolean }>>;
  openAsrInfo(req: AsrInfoOpenRequest): Promise<DesktopIpcResult<{ opened: boolean }>>;
  createBatchSession(files: Array<{ name: string }>): Promise<DesktopIpcResult<BatchSessionResponse>>;
  discardBatchSession(req: { sessionId: string }): Promise<DesktopIpcResult<{ discarded: boolean }>>;
  commitBatchSession(req: BatchCommitRequest): Promise<DesktopIpcResult<BatchCommitResponse>>;
  startBatch(req: BatchStartRequest): Promise<DesktopIpcResult<BatchStartResponse>>;
  selectMediaSource(req?: MediaSelectSourceRequest): Promise<DesktopIpcResult<MediaSelectSourceResponse>>;
  probeMedia(req: MediaProjectRequest): Promise<DesktopIpcResult<MediaSelectSourceResponse>>;
  getMediaWaveform(req: MediaProjectRequest): Promise<DesktopIpcResult<MediaWaveformResponse>>;
  selectMediaStreams(req: MediaSelectStreamsRequest): Promise<DesktopIpcResult<{ project: Project }>>;
  extractMediaSubtitle(req: MediaExtractSubtitleRequest): Promise<DesktopIpcResult<MediaExtractSubtitleResponse>>;
  extractMediaAudio(req: MediaExtractAudioRequest): Promise<DesktopIpcResult<MediaExtractAudioResponse>>;
  activateMediaSourceTrack(req: MediaActivateSourceTrackRequest): Promise<DesktopIpcResult<{ project: Project }>>;
  relinkMedia(req: MediaProjectRequest): Promise<DesktopIpcResult<{ project: Project }>>;
  getMediaPreviewUrl(req: MediaPreviewUrlRequest): Promise<DesktopIpcResult<MediaPreviewUrlResponse>>;
  cancelMediaOperation(req: MediaCancelRequest): Promise<DesktopIpcResult<{ cancelled: boolean }>>;
  onModelStorageTransferProgress(listener: ModelStorageTransferProgressListener): () => void;
  onWorkerEvent(listener: DesktopWorkerEventListener): () => void;
  onBeforeClose(listener: DesktopBeforeCloseListener): () => void;
}

// Channel names (used by preload/main bridge)
export const DESKTOP_API_CHANNEL = 'desktop:api' as const;
export const DESKTOP_EVENT_CHANNEL = 'desktop:event' as const;
export const DESKTOP_MODEL_STORAGE_TRANSFER_CHANNEL = 'desktop:model-storage-transfer' as const;
export const DESKTOP_BEFORE_CLOSE_CHANNEL = 'desktop:before-close' as const;

// -----------------------------------------------------------------------------
// Input validation rules (must be enforced in main before delegating)
// - projectId: /^[A-Za-z0-9._-]+$/ , not "." or ".."
// - All paths resolved + verified inside projectsDir root (main side only)
// - Project objects validated against domain invariants before save
// - No raw file system paths or keys ever returned to renderer unless explicitly
//   turned into safe file:// URLs for media preview (future phases)
// - Errors must be mapped to DesktopIpcError; never throw raw Node errors across IPC
// -----------------------------------------------------------------------------
