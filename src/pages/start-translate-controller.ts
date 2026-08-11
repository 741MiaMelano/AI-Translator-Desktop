import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { CapabilityReadinessResponse } from "../contracts/desktop-api";
import { formatMediaKind, getActiveProjects, getActiveSourceTrack, getLatestProjectTranslationTask, type Project, type ProjectConfig } from "../domain/workspace";
import { analyzeSourceQuality, describeSourceQuality, type SourceQualityProblem } from "../domain/source-quality";
import { localizeIpcErrorText } from "../i18n/errors";
import { desktopGetCapabilityReadiness } from "../services/desktop-client";
import { useWorkspace } from "../state/WorkspaceContext";

interface PendingDuplicateImport {
  file: File;
  existingProjectId: string;
  existingProjectTitle: string;
  existingProjectUpdatedAt: string;
}

/** 「开始翻译」为什么点不了，以及用户下一步该去哪。null 表示可以开跑。 */
export interface StartBlock {
  /** 一句话原因，用作按钮 title */
  reason: string;
  /** 展开说明，显示在「已导入文件」卡片里 */
  hint: string;
  actionLabel?: string;
  actionRoute?: string;
}

export interface ImportMetaItem {
  label: string;
  value: string;
  /** 数字列走 tabular，避免同列宽度不一致 */
  numeric?: boolean;
}

type Workspace = ReturnType<typeof useWorkspace>;

function useImportFlow(
  activeProjects: Project[],
  importFiles: Workspace["importFiles"],
  navigate: ReturnType<typeof useNavigate>,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingDuplicateImport, setPendingDuplicateImport] =
    useState<PendingDuplicateImport | null>(null);
  const runImport = async (files: File[], titleSuffix = "") => {
    const result = await importFiles(files, titleSuffix ? { titleSuffix } : undefined);
    if (result.status === "review") {
      navigate("/batch/review");
      return;
    }
    if (result.status !== "imported") return;
    if (result.projectIds.length === 1) {
      navigate(`/?projectId=${encodeURIComponent(result.projectIds[0])}`, { replace: true });
    } else {
      navigate("/batch/review");
    }
  };

  const handleFiles = (files: FileList | null) => {
    const fileList = files ? Array.from(files) : [];
    if (fileList.length === 0) return;
    const [file] = fileList;
    const existing = fileList.length === 1 ? activeProjects.find(
      (project) => project.sourceFileName.toLowerCase() === file.name.toLowerCase(),
    ) : undefined;
    if (existing) {
      setPendingDuplicateImport({
        file,
        existingProjectId: existing.id,
        existingProjectTitle: existing.title,
        existingProjectUpdatedAt: existing.updatedAt,
      });
      return;
    }
    setPendingDuplicateImport(null);
    void runImport(fileList);
  };

  const continueExistingProject = () => {
    if (!pendingDuplicateImport) return;
    navigate(`/projects/${pendingDuplicateImport.existingProjectId}`);
    setPendingDuplicateImport(null);
  };
  const createDuplicateCopy = () => {
    if (!pendingDuplicateImport) return;
    void runImport([pendingDuplicateImport.file], " 副本");
    setPendingDuplicateImport(null);
  };
  return {
    inputRef,
    isDragging,
    setIsDragging,
    pendingDuplicateImport,
    handleFiles,
    handleDrop(event: DragEvent<HTMLDivElement>) {
      event.preventDefault();
      setIsDragging(false);
      handleFiles(event.dataTransfer.files);
    },
    continueExistingProject,
    createDuplicateCopy,
    openFilePicker: () => inputRef.current?.click(),
  };
}

function useLaunchFlow({
  draftProject,
  currentConfig,
  startBlock,
  sourceQuality,
  isDesktop,
  runAutomaticProjectWorkflow,
  resolveAutomaticWorkflowBlock,
  navigate,
}: {
  draftProject?: Project;
  currentConfig: ProjectConfig;
  startBlock: StartBlock | null;
  sourceQuality: SourceQualityProblem | null;
  isDesktop: boolean;
  runAutomaticProjectWorkflow: Workspace["runAutomaticProjectWorkflow"];
  resolveAutomaticWorkflowBlock: Workspace["resolveAutomaticWorkflowBlock"];
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [translationStartError, setTranslationStartError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");

  const start = async ({ allowUnsafeSource = false }: { allowUnsafeSource?: boolean } = {}) => {
    // Only the explicit quality acknowledgement may bypass its own gate.
    if (!draftProject || (startBlock && !(sourceQuality && allowUnsafeSource))) return;
    if (isDesktop && currentConfig.provider === "OpenAI Compatible" &&
        (!customModel.trim() || !customBaseUrl.trim())) {
      setTranslationStartError("OpenAI Compatible 需要先填写自定义模型 ID 和 Base URL。");
      return;
    }
    setTranslationStartError(null);
    const result = await runAutomaticProjectWorkflow(draftProject.id, {
      ...(allowUnsafeSource ? { allowUnsafeSource: true } : {}),
      ...(currentConfig.provider === "OpenAI Compatible" ? {
        model: customModel.trim(), baseUrl: customBaseUrl.trim(),
        transportMode: "chat_completions" as const,
      } : {}),
    });
    if (result.status === "failed") return setTranslationStartError(result.message);
    if (result.status === "queued") navigate(`/projects/${draftProject.id}`);
  };
  const resolveAutomaticBlock = async (
    answer: Parameters<Workspace["resolveAutomaticWorkflowBlock"]>[1],
  ) => {
    if (!draftProject) return { ok: false, message: "当前没有可处理的项目" };
    const result = await resolveAutomaticWorkflowBlock(draftProject.id, answer);
    if (!result.ok) setTranslationStartError(result.message ?? "确认没有保存，请重试。");
    else await start();
    return result;
  };
  return {
    customModel, setCustomModel, customBaseUrl, setCustomBaseUrl, translationStartError, start,
    resolveAutomaticBlock,
    dismissStartError: () => setTranslationStartError(null),
  };
}

function useTargetLanguageFlow(
  draftProject: Project | undefined,
  currentConfig: ProjectConfig,
  setProjectTargetLanguages: Workspace["setProjectTargetLanguages"],
  updateDefaults: Workspace["updateDefaults"],
) {
  const [targetLanguageError, setTargetLanguageError] = useState<string | null>(null);

  const toggleTargetLanguage = (language: string) => {
    const selected = currentConfig.targetLanguages;
    const next = selected.includes(language)
      ? selected.filter((item) => item !== language)
      : [...selected, language];
    if (next.length === 0) {
      setTargetLanguageError("至少需要保留一个目标语言。");
      return;
    }
    if (!draftProject) {
      updateDefaults({ targetLanguages: next });
      setTargetLanguageError(null);
      return;
    }
    // setProjectTargetLanguages 直接透传 domain 层 throw 的英文 Error.message，
    // 中文界面里不能原样展示，统一过一遍 i18n 映射层。
    const failure = setProjectTargetLanguages(draftProject.id, next);
    setTargetLanguageError(failure ? localizeIpcErrorText({ message: failure }) : null);
  };

  return { targetLanguageError, toggleTargetLanguage };
}

/**
 * 解析当前页面在操作哪个项目。
 *
 * 带了 ?projectId= 却找不到时**不再**退化成「随便一个 draft」：
 * 那会让用户对着另一个项目改配置、甚至对它发起真实翻译。
 * 没带 projectId 时就是干净的导入首页；旧草稿由「最近项目」明确打开。
 */
function resolveDraftProject(activeProjects: Project[], requestedProjectId: string | null) {
  if (!requestedProjectId) return undefined;
  return activeProjects.find((project) => project.id === requestedProjectId);
}

function resolveStartBlock(
  project: Project | undefined,
  segmentCount: number,
  liveTask: boolean,
  sourceQuality: SourceQualityProblem | null,
): StartBlock | null {
  if (!project) {
    return { reason: "先导入文件", hint: "还没有导入文件。" };
  }
  /*
   * 已经有任务在跑就不许再排一轮。
   *
   * 旧版「开始翻译」要等整轮跑完才返回，按下去十几分钟里没有任何反馈，
   * 用户理所当然地又点了两次——三个任务排进队列，每一个都是真金白银的付费请求。
   */
  if (liveTask) {
    return {
      reason: "这个项目已经有任务在跑了",
      hint: "这个项目已经有一轮翻译在进行或排队。去项目页看进度，也可以在那里暂停或取消。",
      actionLabel: "查看进度",
      actionRoute: `/projects/${project.id}`,
    };
  }
  // 视频和音频没有文字时交给自动流程做 ASR；只有空字幕文件需要在这里拦住。
  if (segmentCount === 0 && project.noSourceMedia) {
    return {
      reason: "字幕文件里没有可翻译的文字",
      hint: "没有解析出有效字幕段。请检查文件内容或编码后重新导入。",
      actionLabel: "重新导入",
      actionRoute: "/",
    };
  }
  if (sourceQuality) {
    const language = project.config.targetLanguages[0];
    return {
      reason: "源字幕文件疑似损坏",
      hint: describeSourceQuality(sourceQuality),
      actionLabel: "检查源字幕",
      actionRoute: language
        ? `/projects/${project.id}/editor/${language}?mode=source&segmentId=${encodeURIComponent(sourceQuality.longestSegmentId)}`
        : `/projects/${project.id}`,
    };
  }
  return null;
}

function buildImportMeta(project: Project | undefined, segmentCount: number): ImportMetaItem[] {
  if (!project) return [];
  const extension = project.sourceFileName.split(".").pop()?.toUpperCase() ?? "FILE";
  const probe = project.sourceProbeSummary;
  return [
    { label: "文件类型", value: `${formatMediaKind(project.mediaKind)} · ${extension}` },
    { label: "当前主源", value: getActiveSourceTrack(project)?.label ?? "等待确认" },
    { label: "片段数量", value: `${segmentCount} 段`, numeric: true },
    { label: "检测语言", value: project.config.sourceLanguage },
    ...(probe?.encoding ? [{ label: "文本编码", value: probe.encoding.toUpperCase() }] : []),
    {
      label: "本轮目标",
      value: project.config.targetLanguages.join(" / ") || "未选择",
    },
  ];
}

function useFirstRunReadiness(enabled: boolean) {
  const [readiness, setReadiness] = useState<CapabilityReadinessResponse | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void desktopGetCapabilityReadiness({}).then((result) => {
      if (!active) return;
      if (result.ok) {
        setReadiness(result.data);
        setReadinessError(null);
      } else {
        setReadinessError(localizeIpcErrorText(result.error));
      }
    });
    return () => { active = false; };
  }, [enabled]);

  return { readiness, readinessError };
}

export function useStartTranslateController() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const workspace = useWorkspace();
  const activeProjects = useMemo(() => getActiveProjects(workspace.projects), [workspace.projects]);
  const showFirstRunReadiness = workspace.isDesktop && activeProjects.length === 0;
  const firstRun = useFirstRunReadiness(showFirstRunReadiness);
  const requestedProjectId = searchParams.get("projectId");
  const draftProject = useMemo(
    () => resolveDraftProject(activeProjects, requestedProjectId),
    [activeProjects, requestedProjectId],
  );
  const currentConfig: ProjectConfig = draftProject?.config ?? {
    ...workspace.defaults,
    burnVideo: false,
    copyMediaIntoProject: false,
  };
  const draftSegments = draftProject ? getActiveSourceTrack(draftProject)?.segments ?? [] : [];
  const sourceQuality = analyzeSourceQuality(draftSegments);
  const recognitionProgress = workspace.tasks
    .filter((task) => task.projectId === draftProject?.id && task.kind === "asr" && task.stage === "asr"
      && ["pending", "running", "pausing", "cancelling"].includes(task.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.progress;
  const hasLiveTask = ["running", "pending", "pausing", "paused", "cancelling"].includes(
    getLatestProjectTranslationTask(workspace.tasks, draftProject?.id ?? "")?.status ?? "",
  );
  const startBlock = resolveStartBlock(draftProject, draftSegments.length, hasLiveTask, sourceQuality);
  const applyConfigPatch = (patch: Partial<Omit<ProjectConfig, "targetLanguages">>) => {
    if (draftProject) workspace.updateProjectConfig(draftProject.id, patch);
    else workspace.updateDefaults(patch);
  };
  const targetLanguages = useTargetLanguageFlow(
    draftProject,
    currentConfig,
    workspace.setProjectTargetLanguages,
    workspace.updateDefaults,
  );
  const importFlow = useImportFlow(
    activeProjects,
    workspace.importFiles,
    navigate,
  );
  const launch = useLaunchFlow({
    draftProject, currentConfig, startBlock, sourceQuality, isDesktop: workspace.isDesktop,
    runAutomaticProjectWorkflow: workspace.runAutomaticProjectWorkflow,
    resolveAutomaticWorkflowBlock: workspace.resolveAutomaticWorkflowBlock,
    navigate,
  });
  return {
    navigate, draftProject, currentConfig, draftSegments, sourceQuality, startBlock, applyConfigPatch,
    showFirstRunReadiness,
    firstRunReadiness: firstRun.readiness,
    firstRunReadinessError: firstRun.readinessError,
    recentProjects: [...activeProjects]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 3),
    /** 请求了具体项目却找不到：显示空状态，而不是静默换一个项目继续操作 */
    requestedProjectMissing: Boolean(requestedProjectId) && !draftProject,
    importMeta: buildImportMeta(draftProject, draftSegments.length),
    encodingConfirmation: workspace.encodingConfirmation,
    confirmSubtitleEncoding: async (encoding: Parameters<typeof workspace.confirmSubtitleEncoding>[0]) => {
      const projectId = await workspace.confirmSubtitleEncoding(encoding);
      if (projectId) navigate(`/?projectId=${encodeURIComponent(projectId)}`, { replace: true });
    },
    cancelSubtitleEncoding: workspace.cancelSubtitleEncoding,
    trashProject: workspace.trashProject,
    automaticWorkflow: draftProject ? workspace.automaticWorkflows[draftProject.id] : undefined,
    recognitionProgress,
    cancelAutomaticWorkflow: () => draftProject
      ? workspace.cancelAutomaticProjectWorkflow(draftProject.id)
      : Promise.resolve({ ok: false, message: "当前没有自动处理任务" }),
    ...targetLanguages,
    ...importFlow,
    ...launch,
  };
}

export type StartTranslateController = ReturnType<typeof useStartTranslateController>;
