import type {
  CreateProjectRequest,
  CredentialDeleteRequest,
  CredentialSaveRequest,
  CredentialStatusRequest,
  DesktopApi,
  DesktopIpcResult,
  ExportApprovedBatchRequest,
  ExportSubtitleMatrixRequest,
  ExportSourceSubtitleRequest,
  SubtitleVideoExportRequest,
  AudioSeparationRequest,
  ImportSubtitleRequest,
  ListRecentProjectsRequest,
  ListResourcesRequest,
  SaveResourceRequest,
  DeleteResourceRequest,
  ListProjectResourceSnapshotsRequest,
  RefreshProjectResourceSnapshotRequest,
  OpenProjectRequest,
  ProjectRuntimeStateRequest,
  ProjectPackageRequest,
  DeleteProjectPermanentlyRequest,
  AsrCapabilityStatusRequest,
  AsrModelCancelRequest,
  AsrModelInstallRequest,
  AsrModelOperationRequest,
  AsrRuntimeInstallRequest,
  AsrRuntimeOperationRequest,
  AsrSongClassifierInstallRequest,
  AsrSongClassifierOperationRequest,
  AsrDeviceOperationRequest,
  AsrDevicePreferenceRequest,
  AsrProjectRequest,
  AsrTranscribeRequest,
  AsrSegmentRequest,
  AsrLanguageDetectRequest,
  AsrLanguageUpdateRequest,
  AsrCancelRequest,
  AsrInfoOpenRequest,
  BatchStartRequest,
  MediaExtractAudioRequest,
  ProviderListModelsRequest,
  ProviderRuntimeStateRequest,
  ProviderTestConnectionRequest,
  SaveProjectRequest,
  TranslationStartRequest,
  SubscribeTasksRequest,
  TaskControlRequest,
  TaskPurgeRequest,
  WindowControlRequest,
} from "../contracts/desktop-api";
import type { Project } from "../domain/workspace";

function getDesktop(): DesktopApi | null {
  return typeof window !== "undefined" && window.desktop ? window.desktop : null;
}

export function isDesktopRuntime(): boolean {
  return getDesktop() !== null;
}

export function desktopUnavailableError(): DesktopIpcResult<never> {
  return {
    ok: false,
    error: {
      code: "INTERNAL",
      message: "这个功能只能在桌面应用里使用",
    },
  };
}

export async function desktopCreateProject(project: Project) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  const request: CreateProjectRequest = { project };
  return desktop.createProject(request);
}

export async function desktopSaveProject(project: Project) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  const request: SaveProjectRequest = { project };
  return desktop.saveProject(request);
}

export async function desktopOpenProject(projectId: string) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  const request: OpenProjectRequest = { projectId };
  return desktop.openProject(request);
}

export async function desktopListRecentProjects() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  const request: ListRecentProjectsRequest = {};
  return desktop.listRecentProjects(request);
}

export async function desktopWindowControl(action: WindowControlRequest["action"]) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.windowControl({ action });
}

export async function desktopImportSubtitle(request: ImportSubtitleRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.importSubtitle(request);
}

export async function desktopExportSourceSubtitle(request: ExportSourceSubtitleRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.exportSourceSubtitle(request);
}

export function desktopOnBeforeClose(listener: () => void | Promise<void>) {
  const desktop = getDesktop();
  if (!desktop) return () => {};
  return desktop.onBeforeClose(listener);
}

export async function desktopSaveCredential(request: CredentialSaveRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.saveCredential(request);
}

export async function desktopDeleteCredential(request: CredentialDeleteRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.deleteCredential(request);
}

export async function desktopGetCredentialStatus(request: CredentialStatusRequest = {}) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getCredentialStatus(request);
}

export async function desktopTestProviderConnection(request: ProviderTestConnectionRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.testProviderConnection(request);
}

/** Pulls the provider's model catalog so the model field never has to be typed by hand. */
export async function desktopListProviderModels(request: ProviderListModelsRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.listProviderModels(request);
}

export async function desktopStartTranslation(request: TranslationStartRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.startTranslation(request);
}

export async function desktopGetCapabilityReadiness(request: Parameters<DesktopApi["getCapabilityReadiness"]>[0] = {}) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getCapabilityReadiness(request);
}

export async function desktopGetAppSettings() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getAppSettings();
}

export async function desktopSelectSettingsDirectory(request: Parameters<DesktopApi["selectSettingsDirectory"]>[0]) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.selectSettingsDirectory(request);
}

export async function desktopSelectModelStorageDestination() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.selectModelStorageDestination();
}

export async function desktopTransferModelStorage(request: Parameters<DesktopApi["transferModelStorage"]>[0]) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.transferModelStorage(request);
}

export function desktopOnModelStorageTransferProgress(listener: Parameters<DesktopApi["onModelStorageTransferProgress"]>[0]) {
  return getDesktop()?.onModelStorageTransferProgress(listener) ?? (() => {});
}

export async function desktopSaveAppSettings(request: Parameters<DesktopApi["saveAppSettings"]>[0]) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.saveAppSettings(request);
}

export async function desktopResetAppSettings() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.resetAppSettings();
}

export async function desktopGetDownloadStatus() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getDownloadStatus();
}

export async function desktopProbeDownloadSources() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.probeDownloadSources();
}

export async function desktopCreateAppBackup() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.createAppBackup();
}

export async function desktopSelectBackupRestore(request: Parameters<DesktopApi["selectBackupRestore"]>[0]) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.selectBackupRestore(request);
}

export async function desktopApplyBackupRestore(request: Parameters<DesktopApi["applyBackupRestore"]>[0]) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.applyBackupRestore(request);
}

export async function desktopPreviewDiagnostics() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.previewDiagnostics();
}

export async function desktopExportDiagnostics() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.exportDiagnostics();
}

export async function desktopCreateProjectPackage(request: ProjectPackageRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.createProjectPackage(request);
}

export async function desktopDeleteProjectPermanently(request: DeleteProjectPermanentlyRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.deleteProjectPermanently(request);
}

export async function desktopExportSubtitleMatrix(request: ExportSubtitleMatrixRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.exportSubtitleMatrix(request);
}

export async function desktopExportApprovedBatch(request: ExportApprovedBatchRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.exportApprovedBatch(request);
}

export async function desktopExportSubtitleVideo(request: SubtitleVideoExportRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.exportSubtitleVideo(request);
}

export async function desktopGetAudioSeparationCapability() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getAudioSeparationCapability();
}

export async function desktopStartAudioSeparation(request: AudioSeparationRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.startAudioSeparation(request);
}

export async function desktopListResources(request: ListResourcesRequest = {}) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.listResources(request);
}

export async function desktopSaveResource(request: SaveResourceRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.saveResource(request);
}

export async function desktopDeleteResource(request: DeleteResourceRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.deleteResource(request);
}

export async function desktopListProjectResourceSnapshots(request: ListProjectResourceSnapshotsRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.listProjectResourceSnapshots(request);
}

export async function desktopRefreshProjectResourceSnapshot(request: RefreshProjectResourceSnapshotRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.refreshProjectResourceSnapshot(request);
}

export async function desktopSubscribeTasks(request: SubscribeTasksRequest = {}) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.subscribeTasks(request);
}

export async function desktopControlTask(request: TaskControlRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.controlTask(request);
}

export async function desktopPurgeTasks(request: TaskPurgeRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.purgeTasks(request);
}

export function desktopOnWorkerEvent(listener: Parameters<DesktopApi["onWorkerEvent"]>[0]) {
  const desktop = getDesktop();
  if (!desktop) return () => {};
  return desktop.onWorkerEvent(listener);
}

export async function desktopGetProviderRuntimeState(request: ProviderRuntimeStateRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getProviderRuntimeState(request);
}

export async function desktopGetProjectRuntimeState(request: ProjectRuntimeStateRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getProjectRuntimeState(request);
}

export async function desktopSelectMediaSource(request: { copyIntoProject?: boolean; defaults?: Record<string, unknown> } = {}) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.selectMediaSource(request);
}

export async function desktopCreateBatchSession(files: File[]) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.createBatchSession(files);
}

export async function desktopDiscardBatchSession(sessionId: string) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.discardBatchSession({ sessionId });
}

export async function desktopCommitBatchSession(
  request: Parameters<DesktopApi["commitBatchSession"]>[0],
) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.commitBatchSession(request);
}

export async function desktopStartBatch(request: BatchStartRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.startBatch(request);
}

export async function desktopProbeMedia(projectId: string) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.probeMedia({ projectId });
}

export async function desktopSelectMediaStreams(request: {
  projectId: string;
  audioStreamId?: string | null;
  subtitleStreamId?: string | null;
}) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.selectMediaStreams(request);
}

export async function desktopExtractMediaSubtitle(projectId: string, streamId: string) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.extractMediaSubtitle({ projectId, streamId });
}

export async function desktopGetMediaWaveform(projectId: string) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getMediaWaveform({ projectId, operationId: `waveform-${projectId}` });
}

export async function desktopExtractMediaAudio(request: MediaExtractAudioRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.extractMediaAudio(request);
}

export async function desktopActivateMediaSourceTrack(projectId: string, sourceTrackId: string) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.activateMediaSourceTrack({ projectId, sourceTrackId });
}

export async function desktopRelinkMedia(projectId: string) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.relinkMedia({ projectId });
}

export async function desktopGetMediaPreviewUrl(projectId: string, assetId = "primary") {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getMediaPreviewUrl({ projectId, assetId });
}

export async function desktopGetAsrCapabilityStatus(request: AsrCapabilityStatusRequest = {}) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getAsrCapabilityStatus(request);
}

export async function desktopInstallAsrModel(request: AsrModelInstallRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.installAsrModel(request);
}

export async function desktopImportAsrModel(request: AsrModelOperationRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.importAsrModel(request);
}

export async function desktopUninstallAsrModel(request: AsrModelOperationRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.uninstallAsrModel(request);
}

export async function desktopCancelAsrModelOperation(request: AsrModelCancelRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.cancelAsrModelOperation(request);
}

export async function desktopInstallAsrRuntime(request: AsrRuntimeInstallRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.installAsrRuntime(request);
}

export async function desktopImportAsrRuntime(request: AsrRuntimeOperationRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.importAsrRuntime(request);
}

export async function desktopUninstallAsrRuntime(request: AsrRuntimeOperationRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.uninstallAsrRuntime(request);
}

export async function desktopCancelAsrRuntimeOperation(request: AsrModelCancelRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.cancelAsrRuntimeOperation(request);
}

export async function desktopInstallAsrSongClassifier(request: AsrSongClassifierInstallRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.installAsrSongClassifier(request);
}

export async function desktopUninstallAsrSongClassifier(request: AsrSongClassifierOperationRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.uninstallAsrSongClassifier(request);
}

export async function desktopCancelAsrSongClassifierOperation(request: AsrModelCancelRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.cancelAsrSongClassifierOperation(request);
}

export async function desktopGetAsrDeviceStatus() {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getAsrDeviceStatus();
}

export async function desktopSetAsrDevicePreference(request: AsrDevicePreferenceRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.setAsrDevicePreference(request);
}

export async function desktopDetectAsrDevices(request: AsrDeviceOperationRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.detectAsrDevices(request);
}

export async function desktopCancelAsrDeviceDetection(request: AsrDeviceOperationRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.cancelAsrDeviceDetection(request);
}

export async function desktopGetAsrProjectStatus(request: AsrProjectRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.getAsrProjectStatus(request);
}

export async function desktopRunAsrTranscription(request: AsrTranscribeRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.runAsrTranscription(request);
}

export async function desktopSegmentAsrRun(request: AsrSegmentRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.segmentAsrRun(request);
}

export async function desktopDetectAsrSegmentLanguages(request: AsrLanguageDetectRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.detectAsrSegmentLanguages(request);
}

export async function desktopUpdateAsrSegmentLanguages(request: AsrLanguageUpdateRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.updateAsrSegmentLanguages(request);
}

export async function desktopCancelAsrProjectOperation(request: AsrCancelRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.cancelAsrProjectOperation(request);
}

export async function desktopOpenAsrInfo(request: AsrInfoOpenRequest) {
  const desktop = getDesktop();
  if (!desktop) return desktopUnavailableError();
  return desktop.openAsrInfo(request);
}
