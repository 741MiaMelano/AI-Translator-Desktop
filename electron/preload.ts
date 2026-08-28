import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DESKTOP_API_CHANNEL,
  DESKTOP_BEFORE_CLOSE_CHANNEL,
  DESKTOP_EVENT_CHANNEL,
  DESKTOP_MODEL_STORAGE_TRANSFER_CHANNEL,
} from "../src/contracts/desktop-api";
import type {
  CreateProjectResponse,
  CredentialDeleteResponse,
  CredentialSaveResponse,
  CredentialStatusResponse,
  DesktopApi,
  DesktopIpcResult,
  DesktopWorkerEvent,
  ExportApprovedBatchResponse,
  ExportSubtitleMatrixResponse,
  ExportSourceSubtitleResponse,
  SubtitleVideoExportResponse,
  AudioSeparationCapabilityResponse,
  AudioSeparationResponse,
  ImportSubtitleResponse,
  ListRecentProjectsResponse,
  ListResourcesResponse,
  SaveResourceResponse,
  DeleteResourceResponse,
  ListProjectResourceSnapshotsResponse,
  RefreshProjectResourceSnapshotResponse,
  OpenProjectResponse,
  ProviderTestConnectionResponse,
  ProviderListModelsResponse,
  ProviderRuntimeStateResponse,
  ProjectRuntimeStateResponse,
  ProjectPackageResponse,
  DeleteProjectPermanentlyResponse,
  AsrCapabilityStatusResponse,
  AsrModelId,
  AsrModelImportResponse,
  AsrModelInstallResponse,
  AsrRuntimeImportResponse,
  AsrRuntimeInstallResponse,
  AsrRuntimeOperationRequest,
  AsrSongClassifierInstallResponse,
  AsrDeviceStatusResponse,
  AsrProjectStatusResponse,
  AsrProjectMutationResponse,
  BatchSessionResponse,
  BatchCommitResponse,
  BatchStartResponse,
  MediaExtractAudioResponse,
  MediaWaveformResponse,
  ModelStorageTransferProgress,
  SaveProjectResponse,
  SubscribeTasksResponse,
  TaskControlResponse,
  TaskPurgeResponse,
  TranslationStartResponse,
  WindowControlResponse,
} from "../src/contracts/desktop-api";

function invoke<T>(method: string, request: unknown): Promise<DesktopIpcResult<T>> {
  return ipcRenderer.invoke(DESKTOP_API_CHANNEL, { method, request }) as Promise<DesktopIpcResult<T>>;
}

const desktopApi: DesktopApi = {
  createProject(req) {
    return invoke<CreateProjectResponse>("project.create", req);
  },
  saveProject(req) {
    return invoke<SaveProjectResponse>("project.save", req);
  },
  openProject(req) {
    return invoke<OpenProjectResponse>("project.open", req);
  },
  listRecentProjects(req = {}) {
    return invoke<ListRecentProjectsResponse>("project.listRecent", req ?? {});
  },
  importSubtitle(req) {
    return invoke<ImportSubtitleResponse>("subtitle.import", req);
  },
  exportSourceSubtitle(req) {
    return invoke<ExportSourceSubtitleResponse>("subtitle.exportSource", req);
  },
  createProjectPackage(req) {
    return invoke<ProjectPackageResponse>("project.package", req);
  },
  deleteProjectPermanently(req) {
    return invoke<DeleteProjectPermanentlyResponse>("project.deletePermanently", req);
  },
  exportSubtitleMatrix(req) {
    return invoke<ExportSubtitleMatrixResponse>("subtitle.exportMatrix", req);
  },
  exportApprovedBatch(req) {
    return invoke<ExportApprovedBatchResponse>("subtitle.exportApprovedBatch", req);
  },
  exportSubtitleVideo(req) {
    return invoke<SubtitleVideoExportResponse>("subtitle.videoExport", req);
  },
  getAudioSeparationCapability() {
    return invoke<AudioSeparationCapabilityResponse>("audio.separation.capability", {});
  },
  startAudioSeparation(req) {
    return invoke<AudioSeparationResponse>("audio.separation.start", req);
  },
  windowControl(req) {
    return invoke<WindowControlResponse>("window.control", req);
  },
  subscribeTasks(req) {
    return invoke<SubscribeTasksResponse>("tasks.subscribe", req);
  },
  listResources(req = {}) {
    return invoke<ListResourcesResponse>("resource.list", req ?? {});
  },
  saveResource(req) {
    return invoke<SaveResourceResponse>("resource.save", req);
  },
  deleteResource(req) {
    return invoke<DeleteResourceResponse>("resource.delete", req);
  },
  listProjectResourceSnapshots(req) {
    return invoke<ListProjectResourceSnapshotsResponse>("resource.snapshot.list", req);
  },
  refreshProjectResourceSnapshot(req) {
    return invoke<RefreshProjectResourceSnapshotResponse>("resource.snapshot.refresh", req);
  },
  controlTask(req) {
    return invoke<TaskControlResponse>("tasks.control", req);
  },
  purgeTasks(req) {
    return invoke<TaskPurgeResponse>("tasks.purge", req);
  },
  saveCredential(req) {
    return invoke<CredentialSaveResponse>("credential.save", req);
  },
  deleteCredential(req) {
    return invoke<CredentialDeleteResponse>("credential.delete", req);
  },
  getCredentialStatus(req = {}) {
    return invoke<CredentialStatusResponse>("credential.status", req ?? {});
  },
  getCapabilityReadiness(req = {}) {
    return invoke("capability.status", req ?? {});
  },
  getAppSettings() {
    return invoke("settings.get", {});
  },
  selectSettingsDirectory(req) {
    return invoke("settings.selectDirectory", req);
  },
  selectModelStorageDestination() {
    return invoke("settings.selectModelStorageDestination", {});
  },
  transferModelStorage(req) {
    return invoke("settings.transferModelStorage", req);
  },
  saveAppSettings(req) {
    return invoke("settings.save", req);
  },
  resetAppSettings() {
    return invoke("settings.reset", {});
  },
  getDownloadStatus() {
    return invoke("downloads.status", {});
  },
  probeDownloadSources() {
    return invoke("downloads.probeSources", {});
  },
  createAppBackup() {
    return invoke("backup.app.create", {});
  },
  selectBackupRestore(req) {
    return invoke("backup.restore.select", req);
  },
  applyBackupRestore(req) {
    return invoke("backup.restore.apply", req);
  },
  previewDiagnostics() {
    return invoke("diagnostics.preview", {});
  },
  exportDiagnostics() {
    return invoke("diagnostics.export", {});
  },
  testProviderConnection(req) {
    return invoke<ProviderTestConnectionResponse>("provider.testConnection", req);
  },
  listProviderModels(req) {
    return invoke<ProviderListModelsResponse>("provider.listModels", req);
  },
  startTranslation(req) {
    return invoke<TranslationStartResponse>("translation.start", req);
  },
  getProviderRuntimeState(req) {
    return invoke<ProviderRuntimeStateResponse>("provider.runtimeState", req);
  },
  getProjectRuntimeState(req) {
    return invoke<ProjectRuntimeStateResponse>("project.runtimeState", req);
  },
  getAsrCapabilityStatus(req = {}) {
    return invoke<AsrCapabilityStatusResponse>("asr.capability", req ?? {});
  },
  installAsrModel(req) {
    return invoke<AsrModelInstallResponse>("asr.model.install", req);
  },
  importAsrModel(req) {
    return invoke<AsrModelImportResponse>("asr.model.import", req);
  },
  uninstallAsrModel(req) {
    return invoke<{ assetId: AsrModelId; uninstalled: boolean }>("asr.model.uninstall", req);
  },
  cancelAsrModelOperation(req) {
    return invoke<{ cancelled: boolean }>("asr.model.cancel", req);
  },
  installAsrRuntime(req) {
    return invoke<AsrRuntimeInstallResponse>("asr.runtime.install", req);
  },
  importAsrRuntime(req) {
    return invoke<AsrRuntimeImportResponse>("asr.runtime.import", req);
  },
  uninstallAsrRuntime(req) {
    return invoke<{ assetId: AsrRuntimeOperationRequest["assetId"]; uninstalled: boolean }>("asr.runtime.uninstall", req);
  },
  cancelAsrRuntimeOperation(req) {
    return invoke<{ cancelled: boolean }>("asr.runtime.cancel", req);
  },
  installAsrSongClassifier(req) {
    return invoke<AsrSongClassifierInstallResponse>("asr.songClassifier.install", req);
  },
  uninstallAsrSongClassifier(req) {
    return invoke<{ assetId: "ina-speech-music-noise-v1"; uninstalled: boolean }>("asr.songClassifier.uninstall", req);
  },
  cancelAsrSongClassifierOperation(req) {
    return invoke<{ cancelled: boolean }>("asr.songClassifier.cancel", req);
  },
  getAsrDeviceStatus() {
    return invoke<AsrDeviceStatusResponse>("asr.device.status", {});
  },
  setAsrDevicePreference(req) {
    return invoke<AsrDeviceStatusResponse>("asr.device.preference", req);
  },
  detectAsrDevices(req) {
    return invoke<AsrDeviceStatusResponse>("asr.device.detect", req);
  },
  cancelAsrDeviceDetection(req) {
    return invoke<{ cancelled: boolean }>("asr.device.cancel", req);
  },
  getAsrProjectStatus(req) {
    return invoke<AsrProjectStatusResponse>("asr.project.status", req);
  },
  runAsrTranscription(req) {
    return invoke<{ runId: string; operationId: string; segmentCount: number; wordCount: number; deduplicated: boolean }>("asr.transcribe", req);
  },
  segmentAsrRun(req) {
    return invoke<AsrProjectMutationResponse>("asr.segment", req);
  },
  detectAsrSegmentLanguages(req) {
    return invoke<AsrProjectMutationResponse>("asr.language.detect", req);
  },
  updateAsrSegmentLanguages(req) {
    return invoke<AsrProjectMutationResponse>("asr.language.update", req);
  },
  cancelAsrProjectOperation(req) {
    return invoke<{ cancelled: boolean }>("asr.cancel", req);
  },
  openAsrInfo(req) {
    return invoke<{ opened: boolean }>("asr.info.open", req);
  },
  createBatchSession(files) {
    const filePaths = files.map((file) =>
      webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
    );
    return invoke<BatchSessionResponse>("batch.createSession", { filePaths });
  },
  discardBatchSession(req) {
    return invoke<{ discarded: boolean }>("batch.discardSession", req);
  },
  commitBatchSession(req) {
    return invoke<BatchCommitResponse>("batch.commitSession", req);
  },
  startBatch(req) {
    return invoke<BatchStartResponse>("batch.start", req);
  },
  selectMediaSource(req = {}) {
    return invoke("media.selectSource", req ?? {});
  },
  probeMedia(req) {
    return invoke("media.probe", req);
  },
  getMediaWaveform(req) {
    return invoke<MediaWaveformResponse>("media.waveform", req);
  },
  selectMediaStreams(req) {
    return invoke("media.selectStreams", req);
  },
  extractMediaSubtitle(req) {
    return invoke("media.extractSubtitle", req);
  },
  extractMediaAudio(req) {
    return invoke<MediaExtractAudioResponse>("media.extractAudio", req);
  },
  activateMediaSourceTrack(req) {
    return invoke("media.activateSourceTrack", req);
  },
  relinkMedia(req) {
    return invoke("media.relink", req);
  },
  getMediaPreviewUrl(req) {
    return invoke("media.previewUrl", req);
  },
  cancelMediaOperation(req) {
    return invoke("media.cancel", req);
  },
  onModelStorageTransferProgress(listener) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as ModelStorageTransferProgress);
    };
    ipcRenderer.on(DESKTOP_MODEL_STORAGE_TRANSFER_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DESKTOP_MODEL_STORAGE_TRANSFER_CHANNEL, handler);
  },
  onWorkerEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as DesktopWorkerEvent);
    };
    ipcRenderer.on(DESKTOP_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(DESKTOP_EVENT_CHANNEL, handler);
    };
  },
  onBeforeClose(listener) {
    const handler = async () => {
      await listener();
    };
    ipcRenderer.on(DESKTOP_BEFORE_CLOSE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(DESKTOP_BEFORE_CLOSE_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld("desktop", desktopApi);
