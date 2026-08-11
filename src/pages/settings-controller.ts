import { useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  AppStoragePathKey,
  CapabilityReadinessResponse,
  CredentialStatus,
  DesktopIpcError,
  DiagnosticPreviewResponse,
  DownloadStatusResponse,
  ModelStorageTransferProgress,
} from "../contracts/desktop-api";
import type { Project } from "../domain/workspace";
import { localizeIpcErrorText } from "../i18n/errors";
import {
  desktopApplyBackupRestore,
  desktopCreateAppBackup,
  desktopCreateProjectPackage,
  desktopExportDiagnostics,
  desktopGetAppSettings,
  desktopGetCapabilityReadiness,
  desktopGetCredentialStatus,
  desktopGetDownloadStatus,
  desktopPreviewDiagnostics,
  desktopProbeDownloadSources,
  desktopResetAppSettings,
  desktopSaveAppSettings,
  desktopOnModelStorageTransferProgress,
  desktopSelectModelStorageDestination,
  desktopSelectSettingsDirectory,
  desktopTransferModelStorage,
  desktopSelectBackupRestore,
} from "../services/desktop-client";

export type SettingsMessageTone = "info" | "success" | "error";

/** 状态条需要区分成功与失败，裸字符串做不到，所以带上语气。 */
export interface SettingsMessage {
  tone: SettingsMessageTone;
  text: string;
}

const info = (text: string): SettingsMessage => ({ tone: "info", text });
const ok = (text: string): SettingsMessage => ({ tone: "success", text });

/**
 * 失败文案。
 *
 * 这里原来一律 `setMessage(result.error.message)`，而 message 是后端英文原文
 * （"Desktop persistence failed" 之类），直接盖在中文状态条上。现在统一走
 * src/i18n/errors.ts 的映射层，英文原文只留在 debug 字段里不进界面。
 */
const fail = (error: DesktopIpcError, context: string): SettingsMessage => ({
  tone: "error",
  text: `${context}：${localizeIpcErrorText(error)}`,
});

const sameSettings = (left: AppSettings | null, right: AppSettings | null) =>
  JSON.stringify(left) === JSON.stringify(right);

export function useSettingsController(projects: Project[]) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** 最后一次落盘的值，用来判断「有未保存修改」 */
  const [savedSettings, setSavedSettings] = useState<AppSettings | null>(null);
  const [readiness, setReadiness] = useState<CapabilityReadinessResponse | null>(null);
  const [downloads, setDownloads] = useState<DownloadStatusResponse>({ items: [], sources: [] });
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticPreviewResponse | null>(null);
  /** 「环境能力」的探测对象与「诊断与备份」的备份对象是两件事，不能共用一个 state */
  const [readinessProjectId, setReadinessProjectId] = useState("");
  const [backupProjectId, setBackupProjectId] = useState("");
  const [message, setMessage] = useState<SettingsMessage>(info("正在读取真实系统状态…"));
  const [busy, setBusy] = useState(false);
  const [modelTransferDestination, setModelTransferDestination] = useState("");
  const [modelTransferSelectionToken, setModelTransferSelectionToken] = useState("");
  const [modelTransferProgress, setModelTransferProgress] = useState<ModelStorageTransferProgress | null>(null);
  const projectsRef = useRef(projects);
  const autoSelectedRef = useRef(false);
  projectsRef.current = projects;

  const refreshReadiness = async (projectId: string) => {
    const result = await desktopGetCapabilityReadiness(projectId ? { projectId } : {});
    if (!result.ok) return setMessage(fail(result.error, "能力探测失败"));
    setReadiness(result.data);
  };

  // 依赖必须保持 []：projects 的引用会随后台任务事件（completed/failed/cancelled）变化，
  // 依赖它就会在任务跑完的瞬间用磁盘旧值覆盖用户尚未保存的输入，并重复发 4 个 IPC。
  useEffect(() => {
    let active = true;
    const initialProjectId = projectsRef.current.find((project) => !project.trashedAt)?.id ?? "";
    if (initialProjectId) {
      setReadinessProjectId(initialProjectId);
      autoSelectedRef.current = true;
    }
    void Promise.all([
      desktopGetAppSettings(),
      desktopGetCapabilityReadiness(initialProjectId ? { projectId: initialProjectId } : {}),
      desktopGetDownloadStatus(),
      desktopGetCredentialStatus(),
    ]).then(([settingsResult, readinessResult, downloadResult, credentialResult]) => {
      if (!active) return;
      if (settingsResult.ok) {
        setSettings(settingsResult.data);
        setSavedSettings(settingsResult.data);
      }
      if (readinessResult.ok) setReadiness(readinessResult.data);
      if (downloadResult.ok) setDownloads(downloadResult.data);
      if (credentialResult.ok) setCredentials("credentials" in credentialResult.data ? credentialResult.data.credentials : [credentialResult.data]);
      const failed = [settingsResult, readinessResult, downloadResult, credentialResult].find((result) => !result.ok);
      setMessage(failed && !failed.ok
        ? fail(failed.error, "读取系统状态失败")
        : info("系统状态来自桌面端真实探测。路径修改在下次启动应用后生效。"));
    });
    return () => { active = false; };
  }, []);

  // 挂载时项目可能还没从本地数据库读回来。到达后只补一次「当前项目」，不重新拉设置。
  // autoSelectedRef 保证用户主动选「不选择项目」之后不会被再次自动填回。
  useEffect(() => {
    if (autoSelectedRef.current) return;
    const firstProjectId = projects.find((project) => !project.trashedAt)?.id ?? "";
    if (!firstProjectId) return;
    autoSelectedRef.current = true;
    setReadinessProjectId(firstProjectId);
    void refreshReadiness(firstProjectId);
  }, [projects]);

  useEffect(() => {
    if (!downloads.items.some((item) => item.status === "active")) return;
    const timer = window.setInterval(() => {
      void desktopGetDownloadStatus().then((result) => result.ok && setDownloads(result.data));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [downloads.items]);

  useEffect(() => desktopOnModelStorageTransferProgress(setModelTransferProgress), []);

  const run = async (operation: () => Promise<SettingsMessage | null>) => {
    setBusy(true);
    try {
      const next = await operation();
      if (next) setMessage(next);
    } finally {
      setBusy(false);
    }
  };

  return {
    settings,
    readiness,
    downloads,
    credentials,
    diagnostics,
    readinessProjectId,
    setReadinessProjectId: (projectId: string) => {
      autoSelectedRef.current = true;
      setReadinessProjectId(projectId);
      void refreshReadiness(projectId);
    },
    backupProjectId,
    setBackupProjectId,
    message,
    busy,
    modelTransferDestination,
    modelTransferProgress,
    dirty: Boolean(settings) && !sameSettings(settings, savedSettings),
    updateSettings: (change: Partial<AppSettings>) => setSettings((current) => current ? { ...current, ...change } : current),
    selectDirectory: (pathKey: AppStoragePathKey) => run(async () => {
      const result = await desktopSelectSettingsDirectory({ pathKey });
      if (!result.ok) return fail(result.error, "选择目录失败");
      const directoryPath = result.data.directoryPath;
      if (result.data.canceled || !directoryPath) return info("已取消选择目录。");
      setSettings((current) => current ? { ...current, [pathKey]: directoryPath } : current);
      return info("目录已填入；点击“保存设置”后生效。");
    }),
    selectModelTransferDestination: () => run(async () => {
      const result = await desktopSelectModelStorageDestination();
      if (!result.ok) return fail(result.error, "选择模型转移目录失败");
      if (result.data.canceled || !result.data.directoryPath || !result.data.selectionToken) return info("已取消选择模型转移目录。");
      setModelTransferDestination(result.data.directoryPath);
      setModelTransferSelectionToken(result.data.selectionToken);
      setModelTransferProgress(null);
      return info("已选择模型转移目录；确认无误后点击“转移现有模型”。");
    }),
    transferModels: () => {
      if (!modelTransferSelectionToken || !modelTransferDestination) {
        setMessage(info("请先选择一个空目录作为模型转移路径。"));
        return;
      }
      if (!window.confirm(`将把全部本地语音识别模型和运行时转移到：\n${modelTransferDestination}\n\n校验成功后会切换当前路径并自动重启。是否继续？`)) {
        setMessage(info("已取消转移模型。"));
        return;
      }
      setModelTransferProgress({ stage: "scanning", progress: 0, message: "正在准备转移模型…", processedBytes: 0, totalBytes: 0 });
      setMessage(info("正在转移模型；模型较大时可能需要几分钟，请勿关闭应用。"));
      void run(async () => {
        const result = await desktopTransferModelStorage({ selectionToken: modelTransferSelectionToken });
        if (!result.ok) return fail(result.error, "转移模型失败，旧目录未被改动");
        setSettings((current) => current ? { ...current, modelPath: result.data.destinationPath ?? current.modelPath } : current);
        setSavedSettings((current) => current ? { ...current, modelPath: result.data.destinationPath ?? current.modelPath } : current);
        setModelTransferDestination("");
        setModelTransferSelectionToken("");
        return ok(result.data.oldDirectoryRemoved === false
          ? "模型已转移并切换路径；旧目录未能完全清理，应用即将重启。"
          : "模型已完成复制、校验和路径切换，应用即将重启。");
      });
    },
    save: () => run(async () => {
      if (!settings) return info("设置尚未加载完成。");
      const result = await desktopSaveAppSettings({ settings });
      if (!result.ok) return fail(result.error, "保存设置失败");
      setSettings(result.data);
      setSavedSettings(result.data);
      return ok("系统设置已持久化；路径修改将在下次启动应用后生效。");
    }),
    reset: () => run(async () => {
      const confirmed = window.confirm(
        "恢复默认设置会立即写入磁盘且无法撤销：缓存目录、模型与运行时目录、备份目录、下载源与自定义地址都会回到默认值。是否继续？",
      );
      if (!confirmed) return info("已取消恢复默认设置。");
      const result = await desktopResetAppSettings();
      if (!result.ok) return fail(result.error, "恢复默认设置失败");
      setSettings(result.data);
      setSavedSettings(result.data);
      return ok("系统设置已恢复默认值。界面主题不受此操作影响。");
    }),
    probe: () => run(async () => {
      const [sourceResult] = await Promise.all([desktopProbeDownloadSources(), refreshReadiness(readinessProjectId)]);
      if (!sourceResult.ok) return fail(sourceResult.error, "探测下载源失败");
      setDownloads(sourceResult.data);
      return ok("能力和下载源已重新探测。");
    }),
    createAppBackup: () => run(async () => {
      const result = await desktopCreateAppBackup();
      return result.ok ? ok(`应用备份已创建：${result.data.fileName}`) : fail(result.error, "创建应用备份失败");
    }),
    createProjectBackup: () => run(async () => {
      if (!backupProjectId) return info("请先选择要备份的项目。");
      const result = await desktopCreateProjectPackage({ projectId: backupProjectId, kind: "archive", includeTrash: true, destination: "backup" });
      return result.ok
        ? ok(`项目归档已创建到设置的备份目录，并在资源管理器中定位：${result.data.fileName}`)
        : fail(result.error, "备份所选项目失败");
    }),
    restore: (kind: "app" | "project") => run(async () => {
      const selected = await desktopSelectBackupRestore({ kind });
      if (!selected.ok) return fail(selected.error, "读取备份文件失败");
      if (selected.data.canceled || !selected.data.token) return info("已取消恢复。");
      if (!window.confirm(`将恢复 ${selected.data.fileName ?? "所选备份"}。现有数据不会在未确认时被覆盖，是否继续？`)) return info("已取消恢复。");
      const restored = await desktopApplyBackupRestore({ token: selected.data.token, userConfirmed: true });
      if (!restored.ok) return fail(restored.error, "恢复备份失败，现有数据未被改动");
      await refreshReadiness(readinessProjectId);
      return ok(kind === "app" ? "应用备份已恢复，请重启应用使全部路径生效。" : "项目备份已恢复并完成迁移校验。");
    }),
    previewDiagnostics: () => run(async () => {
      const result = await desktopPreviewDiagnostics();
      if (!result.ok) return fail(result.error, "生成诊断预览失败");
      setDiagnostics(result.data);
      return ok("诊断包已脱敏并可预览；确认内容后再导出。");
    }),
    exportDiagnostics: () => run(async () => {
      if (!diagnostics) return info("请先预览诊断包。");
      const result = await desktopExportDiagnostics();
      if (!result.ok) return fail(result.error, "导出诊断包失败");
      return result.data.canceled ? info("已取消导出。") : ok(`诊断包已导出：${result.data.fileName}`);
    }),
  };
}
