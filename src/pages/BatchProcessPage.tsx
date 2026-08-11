import {
  Boxes,
  ArrowUpToLine,
  FileStack,
  FolderOpen,
  Inbox,
  Play,
  Search,
  Square,
  Trash2,
  UploadCloud,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useNavigate } from "react-router-dom";
import Badge from "../components/ui/Badge";
import {
  ProjectBulkActionBar,
  ProjectSelectionCheckbox,
  ProjectSelectionHeader,
  useProjectSelection,
} from "../components/feature/ProjectSelection";
import TaskPrimaryControlButton from "../components/feature/TaskPrimaryControl";
import BottomActionBar from "../components/ui/BottomActionBar";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import EmptyState from "../components/ui/EmptyState";
import StatCard from "../components/ui/StatCard";
import PageHeader from "../layout/PageHeader";
import Select from "../components/ui/Select";
import {
  formatMediaKind,
  formatTaskStatus,
  getActiveProjects,
  type MediaKind,
  type Project,
  type ProjectTask,
  type TaskStatus,
} from "../domain/workspace";
import { inspectProjectDelivery } from "../domain/project-delivery";
import { useWorkspace } from "../state/WorkspaceContext";

type WorkspaceApi = ReturnType<typeof useWorkspace>;
type BatchSessionValue = NonNullable<WorkspaceApi["batchSession"]>;
type BatchTaskAction = "pause" | "resume" | "cancel" | "retry" | "prioritize";

/**
 * 状态筛选用中文标签而不是 pending/running 枚举：筛选值直接跟
 * formatTaskStatus 的输出比对，这样下拉、徽章、按钮三处始终是同一套词。
 */
const TASK_STATUS_FILTERS = [
  "全部",
  "排队中",
  "运行中",
  "正在暂停",
  "已暂停",
  "可恢复",
  "正在取消",
  "已取消",
  "失败",
  "已完成",
];

/**
 * 任务失败码 → 中文短语。原始码值降级到 title 里，只给排查用，
 * 不再作为用户可见的一等文案。
 *
 * 通用的「IPC 错误 → 中文」由 src/i18n/ 下的统一映射层负责；这里只覆盖
 * 任务生命周期这一类码，等那层稳定后应整体并过去，不要两边各写一套。
 */
const TASK_ERROR_LABELS: Record<string, string> = {
  PROVIDER_AUTH: "API Key 无效或未授权",
  PROVIDER_RATE_LIMIT: "服务商限流，请稍后再试",
  PROVIDER_TIMEOUT: "服务商响应超时",
  PROVIDER_NETWORK: "网络连接失败",
  PROVIDER_SERVER: "服务商内部错误",
  PROVIDER_INVALID_CONFIG: "服务商配置不完整",
  PROVIDER_INVALID_PAYLOAD: "请求内容被服务商拒绝",
  PROVIDER_SCHEMA_MISMATCH: "服务商返回结构不符合预期",
  PROVIDER_REDIRECT_BLOCKED: "请求被重定向拦截",
  PROVIDER_UNKNOWN: "服务商返回未知错误",
  WORKER_INTERRUPTED: "任务被中断",
  WORKER_CRASHED: "执行进程异常退出",
  TASK_EXECUTOR_UNAVAILABLE: "执行器不可用",
  TASK_FAILED: "任务执行失败",
  PROCESS_FAILED: "本地进程执行失败",
  OUTPUT_TOO_LARGE: "输出超出大小上限",
  UNSUPPORTED_SUBTITLE_CODEC: "字幕编码格式不受支持",
  MISSING_DURATION: "缺少媒体时长信息",
  CORRUPT_INPUT: "输入文件已损坏",
  INVALID_INPUT: "输入参数不合法",
  NOT_FOUND: "找不到对应资源",
  TIMEOUT: "操作超时",
  CANCELLED: "已取消",
};

function formatTaskErrorCode(code: string): string {
  return TASK_ERROR_LABELS[code] ?? "执行失败";
}

function getTaskTone(status: TaskStatus): "blue" | "green" | "red" | "gray" {
  if (status === "running") {
    return "blue";
  }

  if (status === "completed") {
    return "green";
  }

  if (status === "failed") {
    return "red";
  }

  return "gray";
}

function ProgressBar({ value, className = "" }: { value: number; className?: string }) {
  const width = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={`overflow-hidden rounded-[4px] bg-line ${className}`}>
      <div className="h-full rounded-[4px] bg-gold transition-all" style={{ width: `${width}%` }} />
    </div>
  );
}

function Notice({ tone, children }: { tone: "ok" | "stop"; children: ReactNode }) {
  const isError = tone === "stop";
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`rounded-[6px] border px-3 py-2 text-[12.5px] leading-5 ${
        isError ? "border-stop bg-stop-wash text-[var(--color-text-main)]" : "border-line bg-card-soft text-[var(--color-text-muted)]"
      }`}
    >
      {children}
    </p>
  );
}

/* ============================================================
   批量执行（批次已创建之后）
   ============================================================ */

function BatchTaskCard({
  task,
  title,
  onControl,
}: {
  task: ProjectTask;
  title: string;
  onControl: (taskId: string, projectId: string, action: BatchTaskAction) => void;
}) {
  const errorCode = task.lastErrorCode ?? null;
  return (
    <div className="rounded-[6px] border border-line bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-[var(--color-text-main)]" title={title}>
            {title}
          </p>
          {errorCode ? (
            <p className="mt-0.5 text-[11.5px] text-stop" title={`${errorCode}｜${task.detail}`}>
              失败原因：{formatTaskErrorCode(errorCode)}
            </p>
          ) : (
            <p className="mt-0.5 truncate text-[11.5px] text-[var(--color-text-muted)]" title={task.detail}>
              {task.detail}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="tabular text-[11.5px] text-[var(--color-text-muted)]">{task.progress}%</span>
          <Badge tone={getTaskTone(task.status)}>{formatTaskStatus(task.status)}</Badge>
          {(task.priority ?? 0) > 0 ? <Badge tone="gold">优先</Badge> : null}
        </div>
      </div>
      <ProgressBar value={task.progress} className="mt-2 h-1.5" />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <TaskPrimaryControlButton
          task={task}
          busy={false}
          onControl={(action) => onControl(task.id, task.projectId, action)}
        />
        {task.status === "pending" ? (
          <Button
            size="sm"
            variant="outline"
            icon={<ArrowUpToLine size={13} />}
            title="把这个尚未启动的任务排到当前等待队列最前面"
            onClick={() => onControl(task.id, task.projectId, "prioritize")}
          >
            设为下一项
          </Button>
        ) : null}
        {task.status === "paused" || task.status === "recoverable" ? (
          <Button size="sm" variant="ghost" icon={<Square size={13} />} onClick={() => onControl(task.id, task.projectId, "cancel")}>
            停止
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function BatchRunningCard({
  batchId,
  batchTasks,
  projectById,
  onControl,
}: {
  batchId: string;
  batchTasks: ProjectTask[];
  projectById: Map<string, Project>;
  onControl: (taskId: string, projectId: string, action: BatchTaskAction) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("全部");

  const completed = batchTasks.filter((task) => task.status === "completed").length;
  const failed = batchTasks.filter((task) => task.status === "failed").length;
  const paused = batchTasks.filter((task) => ["paused", "recoverable"].includes(task.status)).length;
  const inProgress = batchTasks.filter((task) =>
    ["pending", "running", "pausing", "cancelling"].includes(task.status),
  ).length;
  const aggregateProgress = Math.round(
    batchTasks.reduce((total, task) => total + task.progress, 0) / batchTasks.length,
  );

  const keyword = query.trim().toLocaleLowerCase();
  const filteredTasks = batchTasks.filter((task) => {
    const title = projectById.get(task.projectId)?.title ?? task.projectId;
    const statusLabel = formatTaskStatus(task.status);
    const matchesQuery = `${title} ${statusLabel}`.toLocaleLowerCase().includes(keyword);
    return matchesQuery && (statusFilter === "全部" || statusLabel === statusFilter);
  });

  return (
    <Card
      title={`批次进度 ${aggregateProgress}%`}
      description={`批次 ${batchId}`}
      actions={
        <Badge tone={failed > 0 ? "red" : completed === batchTasks.length ? "green" : "blue"}>
          {batchTasks.length} 个任务
        </Badge>
      }
    >
      <ProgressBar value={aggregateProgress} className="mb-3 h-1.5" />
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <StatCard label="完成" value={String(completed)} tone="text-ok" />
        <StatCard label="失败" value={String(failed)} tone={failed > 0 ? "text-stop" : undefined} />
        <StatCard label="暂停/待恢复" value={String(paused)} />
        <StatCard label="处理中" value={String(inProgress)} />
      </div>
      <div className="mb-3 grid gap-2 md:grid-cols-[1fr_170px]">
        <label className="flex h-8 min-w-0 items-center gap-2 rounded-[6px] border border-line-strong bg-card px-2.5">
          <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目名称"
            aria-label="搜索项目名称"
            className="w-full min-w-0 bg-transparent text-[13px] text-[var(--color-text-main)] outline-none placeholder:text-[var(--color-text-muted)]"
          />
        </label>
        <Select
          aria-label="按状态筛选"
          options={TASK_STATUS_FILTERS}
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        {filteredTasks.map((task) => (
          <BatchTaskCard
            key={task.id}
            task={task}
            title={projectById.get(task.projectId)?.title ?? task.projectId}
            onControl={onControl}
          />
        ))}
        {filteredTasks.length === 0 ? (
          <EmptyState
            icon={<Search size={20} />}
            title="没有匹配的任务"
            description="换个项目名称关键词，或把状态筛选改回「全部」。"
          />
        ) : null}
      </div>
    </Card>
  );
}

type BatchProjectView = {
  project: Project;
  task?: ProjectTask;
  kind: "processing" | "attention" | "ready" | "done";
  label: string;
  detail: string;
  progress: number;
};

function buildBatchProjectView(
  project: Project,
  task: ProjectTask | undefined,
  workflow: WorkspaceApi["automaticWorkflows"][string] | undefined,
): BatchProjectView {
  if (task && ["failed", "recoverable", "paused", "cancelled"].includes(task.status)) {
    return {
      project,
      kind: "attention",
      label: task.status === "failed" ? "处理失败" : task.status === "cancelled" ? "已取消" : "等待继续",
      detail: task.lastErrorCode ? formatTaskErrorCode(task.lastErrorCode) : task.detail,
      progress: task.progress,
    };
  }
  if (workflow?.status === "blocked" || workflow?.status === "failed") {
    return {
      project,
      kind: "attention",
      label: workflow.status === "failed" ? "自动处理失败" : "需要确认",
      detail: workflow.message,
      progress: task?.progress ?? 0,
    };
  }
  if (task && ["pending", "running", "pausing", "cancelling"].includes(task.status)) {
    return { project, kind: "processing", label: formatTaskStatus(task.status), detail: task.detail, progress: task.progress };
  }
  if (workflow && ["running", "queued"].includes(workflow.status) && task?.status !== "completed") {
    return {
      project,
      kind: "processing",
      label: workflow.status === "queued" ? "翻译已排队" : "自动处理中",
      detail: workflow.message,
      progress: task?.progress ?? 12,
    };
  }
  const delivery = inspectProjectDelivery(project);
  if (delivery.state === "exported") {
    return { project, kind: "done", label: "已导出", detail: "字幕已经交付。", progress: 100 };
  }
  if (delivery.state === "blocked") {
    return { project, kind: "attention", label: "需要修复", detail: `${delivery.errorCount} 处问题会阻止导出。`, progress: 100 };
  }
  if (delivery.state === "ready" || delivery.state === "approved") {
    return {
      project,
      kind: "ready",
      label: delivery.state === "approved" ? "已批准" : "可以交付",
      detail: delivery.warningCount > 0 ? `${delivery.warningCount} 条优化建议，不阻止导出。` : "检查完成，可以整批批准并导出。",
      progress: 100,
    };
  }
  if (task?.status === "completed") {
    return { project, kind: "attention", label: "等待检查", detail: "任务已完成，但还没有可交付字幕。", progress: 100 };
  }
  return { project, kind: "processing", label: "等待开始", detail: "系统正在准备这个项目。", progress: 0 };
}

function BatchProjectRow({
  item,
  onOpen,
  onPrioritize,
  selecting,
  selected,
  onSelect,
}: {
  item: BatchProjectView;
  onOpen: () => void;
  onPrioritize: () => void;
  selecting: boolean;
  selected: boolean;
  onSelect: (checked: boolean) => void;
}) {
  const tone = item.kind === "done" ? "green" : item.kind === "processing" ? "blue" : item.kind === "attention" ? "red" : "gold";
  return (
    <div className="rounded-[6px] border border-line bg-card px-3 py-2.5">
      <div className="flex items-start gap-3">
        {selecting ? (
          <span className="pt-1">
            <ProjectSelectionCheckbox projectTitle={item.project.title} checked={selected} onChange={onSelect} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-[13px] font-medium text-[var(--color-text-main)]">{item.project.title}</p>
            <Badge tone={tone}>{item.label}</Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-[11.5px] leading-4 text-[var(--color-text-muted)]">{item.detail}</p>
          {item.kind === "processing" ? <ProgressBar value={item.progress} className="mt-2 h-1" /> : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {item.task?.status === "pending" ? (
            <Button
              size="sm"
              variant="outline"
              icon={<ArrowUpToLine size={13} />}
              title="把这个排队任务放到当前等待队列最前面"
              onClick={onPrioritize}
            >
              设为下一项
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onOpen}>打开项目</Button>
        </div>
      </div>
    </div>
  );
}

function BatchProgressView() {
  const navigate = useNavigate();
  const {
    activeBatch,
    tasks,
    projects,
    automaticWorkflows,
    startBatch,
    controlTask,
    approveAndExportBatchTargets,
  } = useWorkspace();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!activeBatch) return null;

  const projectById = new Map(getActiveProjects(projects).map((project) => [project.id, project]));
  const batchTasks = tasks.filter((task) => task.batchId === activeBatch.id && projectById.has(task.projectId));
  const items = activeBatch.projectIds.flatMap((projectId) => {
    const project = projectById.get(projectId);
    if (!project) return [];
    const task = tasks
      .filter((entry) => entry.projectId === projectId && (!entry.batchId || entry.batchId === activeBatch.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return [{ ...buildBatchProjectView(project, task, automaticWorkflows[projectId]), task }];
  });
  const selection = useProjectSelection(items.map(({ project }) => project.id));
  const started = Boolean(activeBatch.startedAt) || batchTasks.length > 0 || items.some((item) => item.label !== "等待开始");
  const processing = items.filter((item) => item.kind === "processing");
  const attention = items.filter((item) => item.kind === "attention");
  const ready = items.filter((item) => item.kind === "ready");
  const done = items.filter((item) => item.kind === "done");
  const queuedTaskCount = batchTasks.filter((task) => task.status === "pending").length;
  const runningTaskCount = batchTasks.filter((task) => task.status === "running").length;

  const handleStart = async () => {
    setBusy(true);
    setNotice(null);
    const result = await startBatch(activeBatch);
    setBusy(false);
    setNotice(result.ok
      ? { ok: true, text: "整批已开始；系统会逐个完成字幕准备与翻译。" }
      : { ok: false, text: result.message });
  };

  const handleControl = async (
    taskId: string,
    projectId: string,
    action: BatchTaskAction,
  ) => {
    setNotice(null);
    const result = await controlTask({
      taskId,
      projectId,
      action,
      ...(["resume", "retry"].includes(action) ? { userConfirmed: true } : {}),
    });
    setNotice(result.ok
      ? action === "prioritize" ? { ok: true, text: "已设为下一项；当前运行任务结束后会优先开始。" } : null
      : { ok: false, text: result.message ?? "任务控制失败" });
  };

  const handleExport = async () => {
    setBusy(true);
    setNotice(null);
    const result = await approveAndExportBatchTargets(ready.map((item) => item.project.id));
    setBusy(false);
    if (result.canceled) {
      setNotice({ ok: true, text: "已取消选择保存文件夹；批准状态会保留。" });
      return;
    }
    setNotice(result.ok
      ? { ok: true, text: `已导出 ${result.exportedFileCount ?? 0} 份字幕，保存文件夹只选择了一次。` }
      : { ok: false, text: result.message ?? "整批导出未全部完成。" });
  };

  return (
    <>
      <PageHeader
        title="批量处理"
        description="系统按项目自动完成字幕提取、识别与翻译；这里只突出正在处理和需要你确认的项目。"
        actions={(
          <div className="flex items-center gap-2">
            <Badge tone={attention.length > 0 ? "red" : processing.length > 0 ? "blue" : "green"}>{items.length} 个项目</Badge>
            <ProjectSelectionHeader selection={selection} disabled={items.length === 0} />
          </div>
        )}
      />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card title={started ? "当前需要关注" : "项目已经创建"} description={started ? "完成项会自动折叠。" : "确认一次后，整批会复用同一套自动工作流。"}>
          {items.length === 0 ? (
            <EmptyState icon={<Inbox size={20} />} title="当前批次没有项目" description="从“开始翻译”导入文件后，项目会显示在这里。" />
          ) : (
            <div className="space-y-2">
              {[...attention, ...processing, ...ready].map((item) => (
                <BatchProjectRow
                  key={item.project.id}
                  item={item}
                  onOpen={() => navigate(`/projects/${item.project.id}`)}
                  onPrioritize={() => item.task && void handleControl(item.task.id, item.task.projectId, "prioritize")}
                  selecting={selection.selecting}
                  selected={selection.selectedIds.has(item.project.id)}
                  onSelect={(checked) => selection.toggle(item.project.id, checked)}
                />
              ))}
              {attention.length + processing.length + ready.length === 0 ? (
                <EmptyState icon={<FileStack size={20} />} title="这一批已经全部完成" description="字幕已导出；需要再次处理时可以进入对应项目。" />
              ) : null}
              {done.length > 0 ? (
                <details className="rounded-[6px] border border-line bg-card-soft px-3 py-2">
                  <summary className="cursor-pointer text-[12.5px] font-medium text-[var(--color-text-muted)]">已完成 {done.length} 个</summary>
                  <div className="mt-2 space-y-2">
                    {done.map((item) => (
                      <BatchProjectRow
                        key={item.project.id}
                        item={item}
                        onOpen={() => navigate(`/projects/${item.project.id}`)}
                        onPrioritize={() => item.task && void handleControl(item.task.id, item.task.projectId, "prioritize")}
                        selecting={selection.selecting}
                        selected={selection.selectedIds.has(item.project.id)}
                        onSelect={(checked) => selection.toggle(item.project.id, checked)}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          )}
        </Card>
        <div className="space-y-3">
          <Card title="这一批">
            <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1">
              <StatCard label="处理中" value={String(processing.length)} />
              <StatCard label="需确认或修复" value={String(attention.length)} tone={attention.length > 0 ? "text-stop" : undefined} />
              <StatCard label="可交付" value={String(ready.length)} tone={ready.length > 0 ? "text-ok" : undefined} />
            </div>
          </Card>
          <Card title="下一步">
            <p className="text-[12.5px] leading-5 text-[var(--color-text-muted)]">
              {processing.length > 0
                ? "无需保持在此页面；处理会继续运行。"
                : attention.length > 0
                  ? "先打开标红项目完成必要确认或修复。"
                  : ready.length > 0
                    ? "一次确认并选择一个文件夹，即可导出全部可交付字幕。"
                    : "这一批没有待办。"}
            </p>
          </Card>
          {notice ? <Notice tone={notice.ok ? "ok" : "stop"}>{notice.text}</Notice> : null}
        </div>
      </div>

      {batchTasks.length > 0 ? (
        <details className="mt-3 rounded-[10px] border border-gold bg-gold-wash px-3.5 py-3 shadow-card">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[var(--color-text-main)]">
            <span>
              <strong className="block text-[14px]">任务调度与优先级</strong>
              <span className="mt-0.5 block text-[11.5px] text-[var(--color-text-muted)]">展开后可查看进度、暂停、停止，排队中的任务可直接设为下一项。</span>
            </span>
            <Badge tone={queuedTaskCount > 0 ? "gold" : runningTaskCount > 0 ? "blue" : "green"}>
              排队 {queuedTaskCount} · 运行 {runningTaskCount}
            </Badge>
          </summary>
          <div className="mt-3 border-t border-gold pt-3">
            <BatchRunningCard
              batchId={activeBatch.id}
              batchTasks={batchTasks}
              projectById={projectById}
              onControl={(taskId, projectId, action) => void handleControl(taskId, projectId, action)}
            />
          </div>
        </details>
      ) : null}

      {selection.selecting ? (
        <ProjectBulkActionBar selection={selection} batchId={activeBatch.id} />
      ) : (
        <BottomActionBar>
          <Button variant="dark" onClick={() => navigate("/workspace")}>返回项目</Button>
          {!started ? (
            <Button variant="primary" icon={<Play size={14} />} disabled={busy} onClick={() => void handleStart()}>
              开始处理 {items.length} 个项目
            </Button>
          ) : ready.length > 0 && processing.length === 0 ? (
            <Button variant="primary" icon={<FolderOpen size={14} />} disabled={busy} onClick={() => void handleExport()}>
              批准并导出 {ready.length} 个项目
            </Button>
          ) : null}
        </BottomActionBar>
      )}
    </>
  );
}

/* ============================================================
   批量确认（批次提交之前）
   ============================================================ */

interface BatchTableRow {
  id: string;
  name: string;
  mediaKind: MediaKind;
  status: string;
  tone: "green" | "gray";
  projectIndex: number;
}

function BatchDropzone({
  session,
  inputRef,
  onFiles,
}: {
  session: BatchSessionValue;
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const mediaCounts = session.files.reduce<Partial<Record<MediaKind, number>>>((accumulator, file) => {
    accumulator[file.mediaKind] = (accumulator[file.mediaKind] ?? 0) + 1;
    return accumulator;
  }, {});

  const openPicker = () => inputRef.current?.click();

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    onFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <Card
      title={`已导入 ${session.files.length} 个文件`}
      description="文件已经安全读取；需要更换时可重新选择。"
      actions={<Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={openPicker}>重新选择</Button>}
    >
      <input ref={inputRef} type="file" multiple className="hidden" onChange={(event) => {
        onFiles(Array.from(event.target.files ?? []));
        event.target.value = "";
      }} />
      <div
        role="button"
        tabIndex={0}
        aria-label="拖入或选择文件重建这一批"
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openPicker();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`flex cursor-pointer flex-wrap items-center gap-2 rounded-[6px] border border-dashed px-3 py-2.5 transition ${
          dragging ? "border-gold bg-gold-wash" : "border-line-strong bg-card-soft hover:border-gold"
        }`}
      >
        <UploadCloud size={17} className="text-[var(--color-text-muted)]" />
        <p className="mr-auto text-[12.5px] text-[var(--color-text-muted)]">也可以把另一批文件拖到这里替换</p>
        {(Object.entries(mediaCounts) as Array<[MediaKind, number]>).map(([kind, count]) => (
          <Badge key={kind} tone="gray">{formatMediaKind(kind)} × {count}</Badge>
        ))}
      </div>
    </Card>
  );
}

function BatchFileTable({
  rows,
  groupCount,
  mergedCount,
}: {
  rows: BatchTableRow[];
  groupCount: number;
  mergedCount: number;
}) {
  return (
    <Card
      title={`这批共有 ${groupCount} 个项目`}
      description="系统只自动合并名称和时长都高度匹配的文件；不确定项会标出来。"
      actions={
        <>
          {mergedCount > 0 ? <Badge tone="green">自动合并 {mergedCount} 组</Badge> : null}
          <Badge tone="blue">确认后建 {groupCount} 个项目</Badge>
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<FileStack size={20} />}
          title="这一批还没有文件"
          description="拖入或选择文件后，这里会逐条列出每个文件将要落到哪个项目草稿。"
        />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-3 rounded-[6px] border border-line bg-card-soft px-3 py-2">
              <span className="w-10 shrink-0 text-[11.5px] text-[var(--color-text-muted)]">{formatMediaKind(row.mediaKind)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--color-text-main)]" title={row.name}>{row.name}</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">将进入项目 {row.projectIndex}</p>
              </div>
              <Badge tone={row.tone}>{row.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ImportAmbiguityList({
  session,
  onMediaMatch,
  onEncoding,
}: {
  session: BatchSessionValue;
  onMediaMatch: WorkspaceApi["resolveBatchMediaMatch"];
  onEncoding: WorkspaceApi["resolveBatchSubtitleEncoding"];
}) {
  const fileMap = new Map(session.files.map((file) => [file.id, file]));

  return (
    <Card
      title="只确认有歧义的文件"
      description="高置信分组已自动完成；这里只询问无法安全判断的项目。"
      actions={<Badge tone={session.ambiguities.length > 0 ? "gold" : "green"}>{session.ambiguities.length} 项待确认</Badge>}
    >
      {session.ambiguities.length === 0 ? (
        <Notice tone="ok">全部歧义已确认，可以创建项目。</Notice>
      ) : (
        <div className="space-y-2">
          {session.ambiguities.map((ambiguity) => {
            const file = fileMap.get(ambiguity.fileId);
            if (!file) return null;

            return (
              <div key={`${ambiguity.kind}:${ambiguity.fileId}`} className="rounded-[6px] border border-line bg-card-soft p-3">
                <p className="truncate text-[13px] font-medium text-[var(--color-text-main)]" title={file.name}>{file.name}</p>
                <p className="mt-1 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
                  {ambiguity.kind === "media_match"
                    ? "这个字幕与多个媒体时长相近，请选择它属于哪个媒体。"
                    : "字幕编码无法唯一判断，请选择正确编码。"}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`${file.name} 的确认选项`}>
                  {ambiguity.kind === "media_match" ? (
                    <>
                      {ambiguity.candidateMediaFileIds.map((mediaFileId) => (
                        <Button key={mediaFileId} size="sm" variant="outline" onClick={() => onMediaMatch(file.id, mediaFileId)}>
                          归到 {fileMap.get(mediaFileId)?.name ?? "对应媒体"}
                        </Button>
                      ))}
                      <Button size="sm" variant="ghost" onClick={() => onMediaMatch(file.id, null)}>
                        作为独立字幕项目
                      </Button>
                    </>
                  ) : (
                    ambiguity.encodingCandidates.map((encoding) => (
                      <Button key={encoding} size="sm" variant="outline" onClick={() => onEncoding(file.id, encoding)}>
                        {encoding.toUpperCase().replace("_", "-")}
                      </Button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function EmptyBatchSessionView({ onBack }: { onBack: () => void }) {
  return (
    <>
      <PageHeader
        title="批量处理"
        description="当前没有待确认的批量会话。批量处理只在你导入多文件时临时出现。"
      />
      <Card>
        <EmptyState
          icon={<Boxes size={20} />}
          title="没有待确认的批量会话"
          description="在开始翻译页一次导入多个文件，就会自动进入这里确认分组与默认参数。"
          action={
            <Button variant="primary" onClick={onBack}>
              返回开始翻译
            </Button>
          }
        />
      </Card>
    </>
  );
}

function BatchReviewActions({
  groupCount,
  providerReady,
  unresolvedCount,
  busy,
  onDiscard,
  onCreate,
  onConnect,
}: {
  groupCount: number;
  providerReady: boolean;
  unresolvedCount: number;
  busy: boolean;
  onDiscard: () => void;
  onCreate: () => void;
  onConnect: () => void;
}) {
  return (
    <BottomActionBar>
      <Button variant="dark" icon={<Trash2 size={14} />} disabled={busy} onClick={onDiscard}>
        取消本批
      </Button>
      <Button
        variant="primary"
        icon={<Play size={14} />}
        disabled={busy || unresolvedCount > 0}
        onClick={groupCount === 1 || providerReady ? onCreate : onConnect}
      >
        {unresolvedCount > 0
          ? `先确认 ${unresolvedCount} 项歧义`
          : groupCount === 1
            ? "创建项目"
            : providerReady
            ? `创建并开始处理 ${groupCount} 个项目`
            : "先连接翻译模型"}
      </Button>
    </BottomActionBar>
  );
}

function buildTableRows(session: BatchSessionValue): BatchTableRow[] {
  const fileMap = new Map(session.files.map((file) => [file.id, file]));
  const rows: BatchTableRow[] = [];

  session.groups.forEach((group, groupIndex) => {
    group.fileIds.forEach((fileId) => {
      const file = fileMap.get(fileId);
      if (!file) {
        return;
      }

      rows.push({
        id: file.id,
        name: file.name,
        mediaKind: file.mediaKind,
        status: group.confidence === "high" ? "已归组" : "单独项目",
        tone: group.confidence === "high" ? "green" : "gray",
        projectIndex: groupIndex + 1,
      });
    });
  });

  return rows;
}

export default function BatchProcessPage() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const {
    batchSession,
    activeBatch,
    createBatchSession,
    resolveBatchMediaMatch,
    resolveBatchSubtitleEncoding,
    commitBatchSession,
    startBatch,
    discardBatchSession,
    capabilities,
  } = useWorkspace();

  // Keep hooks above the empty-session early return so commitBatchSession(null)
  // does not change hook order while this route is still mounted.
  const tableRows = useMemo(
    () => (batchSession ? buildTableRows(batchSession) : []),
    [batchSession],
  );

  if (!batchSession && activeBatch) return <BatchProgressView />;

  if (!batchSession) {
    return <EmptyBatchSessionView onBack={() => navigate("/")} />;
  }

  const session = batchSession;
  const providerReady = capabilities.providers.some(
    (provider) => provider.name === session.defaults.provider && provider.status === "ready",
  );

  const handleReplaceFiles = (nextFiles: File[]) => {
    if (nextFiles.length === 0) {
      return;
    }

    const confirmed =
      session.files.length === 0 ||
      window.confirm(
        `将用 ${nextFiles.length} 个新文件重建这一批，当前 ${session.files.length} 个文件的分组与命名会被丢弃。继续？`,
      );
    if (!confirmed) {
      return;
    }

    void createBatchSession(nextFiles);
  };

  const handleDiscard = () => {
    if (
      !window.confirm(
        `将丢弃这一批 ${session.files.length} 个文件的分组与命名，且无法撤销。确认清空列表？`,
      )
    ) {
      return;
    }

    discardBatchSession();
    navigate("/");
  };

  const handleCreateAndStart = async () => {
    setBusy(true);
    setNotice(null);
    const batch = await commitBatchSession();
    if (!batch) {
      setBusy(false);
      setNotice("项目创建失败，请检查上方设置后重试。");
      return;
    }
    if (batch.projectIds.length === 1) {
      setBusy(false);
      navigate(`/?projectId=${batch.projectIds[0]}`);
      return;
    }
    const started = await startBatch(batch);
    setBusy(false);
    if (!started.ok) setNotice(started.message);
  };

  return (
    <>
      <PageHeader
        title="批量处理"
        description="统一确认一次，系统会逐个完成字幕提取、识别与翻译。"
        actions={<Badge tone="blue">{session.groups.length} 个项目</Badge>}
      />

      <div className="space-y-3">
        <BatchDropzone session={session} inputRef={inputRef} onFiles={handleReplaceFiles} />
        <BatchFileTable
          rows={tableRows}
          groupCount={session.groups.length}
          mergedCount={session.groups.filter((group) => group.fileIds.length > 1).length}
        />
        <ImportAmbiguityList
          session={session}
          onMediaMatch={resolveBatchMediaMatch}
          onEncoding={resolveBatchSubtitleEncoding}
        />
        {notice ? <Notice tone="stop">{notice}</Notice> : null}
      </div>

      <BatchReviewActions
        groupCount={session.groups.length}
        providerReady={providerReady}
        unresolvedCount={session.ambiguities.length}
        busy={busy}
        onDiscard={handleDiscard}
        onCreate={() => void handleCreateAndStart()}
        onConnect={() => navigate("/capabilities")}
      />
    </>
  );
}
