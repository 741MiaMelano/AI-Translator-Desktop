import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { inspectProjectDelivery } from "../domain/project-delivery";
import {
  canStartProjectFromSelection,
  deriveProjectStatusSummary,
  getLatestProjectTask,
  getPrimaryTaskControl,
  type Project,
  type ProjectTask,
} from "../domain/workspace";
import { localizeIpcErrorText } from "../i18n/errors";
import { useWorkspace } from "../state/WorkspaceContext";
import { useFrontend } from "./state";
import { Icon } from "./visuals";
import { formatProgress, formatUiDateTime } from "./format";
import { TaskLiveness } from "./TaskLiveness";

type WorkspaceView = "attention" | "all" | "done" | "trash";
type ConfirmAction = "start" | "trash" | "purge-selected" | "export" | "purge-tasks" | null;
type TaskAction = "pause" | "resume" | "cancel" | "retry" | "prioritize";

const LIVE_TASKS = new Set(["pending", "running", "pausing", "paused", "cancelling", "recoverable"]);

function taskState(value: string) {
  return ({ pending: "排队", running: "运行中", pausing: "暂停中", paused: "已暂停", cancelling: "停止中", cancelled: "已取消", failed: "失败", recoverable: "可恢复", completed: "完成" } as Record<string, string>)[value] ?? value;
}

function taskTone(task: ProjectTask) {
  if (task.status === "completed") return "done";
  if (task.status === "failed" || task.status === "recoverable") return "danger";
  if (["running", "pausing", "cancelling"].includes(task.status)) return "running";
  return "waiting";
}

// 排序口径：待确认与失败优先 → 进行中 → 校对中/待校对 → 其余 → 已完成归底。
// "需要处理"就是把已完成的那一档（rank 4）摘掉，所以两件事共用这一个函数。
const DONE_RANK = 4;
// 任务列表必须有上限：本机账本可以很长，界面不替它做无限滚动。上限现在由
// 分页承担（每页 20/50/100），所以这里不再一次性截断。

function attentionRank(project: Project, task: ProjectTask | undefined) {
  if (project.pendingConfirmations.length) return 0;
  if (task && ["failed", "recoverable"].includes(task.status)) return 0;
  if (task && LIVE_TASKS.has(task.status)) return 1;
  if (project.lifecycle === "needs_review") return 2;
  if (project.lifecycle === "completed" || project.archivedAt) return DONE_RANK;
  return 3;
}

function projectMatches(project: Project, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || `${project.title} ${project.sourceFileName}`.toLocaleLowerCase().includes(needle);
}

export function WorkspacePage({ batchMode = false, initialView = "attention", focusTasks = false }: {
  batchMode?: boolean;
  initialView?: WorkspaceView;
  focusTasks?: boolean;
}) {
  const workspace = useWorkspace();
  const app = useFrontend();
  const navigate = useNavigate();
  const [view, setView] = useState<WorkspaceView>(initialView);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [historyPageSize, setHistoryPageSize] = useState(20);
  const [historyPage, setHistoryPage] = useState(0);
  const batch = workspace.activeBatch;

  useEffect(() => setView(initialView), [initialView]);

  const batchIds = useMemo(() => new Set(batch?.projectIds ?? []), [batch]);
  const rankOf = (project: Project) => attentionRank(project, getLatestProjectTask(workspace.tasks, project.id));
  const allVisibleProjects = workspace.projects.filter((project) => {
    if (batchMode) return batchIds.has(project.id) && !project.trashedAt;
    if (project.trashedAt) return view === "trash";
    if (view === "trash") return false;
    if (view === "done") return rankOf(project) === DONE_RANK;
    if (view === "attention") return rankOf(project) < DONE_RANK;
    return true;
  });
  const projects = allVisibleProjects
    .filter((project) => projectMatches(project, query))
    // 需要你处理的排前面；同一档里按最近更新。
    .sort((left, right) => rankOf(left) - rankOf(right) || right.updatedAt.localeCompare(left.updatedAt));
  const projectIdsKey = projects.map((project) => project.id).join("|");
  const tasks = workspace.tasks.filter((task) => !batchMode || batchIds.has(task.projectId));
  // 任务不再是顶级 tab：进行中与最近失败留在"需要处理"里，其余收进历史 disclosure。
  const activeTasks = batchMode
    ? tasks
    : tasks.filter((task) => LIVE_TASKS.has(task.status) || task.status === "failed");
  const showTaskPanel = batchMode || view === "attention";
  // 历史按页取，而不是一次铺 100 条：任务多的时候整页会被历史淹掉。
  const historyTotal = tasks.length;
  const historyPageCount = Math.max(1, Math.ceil(historyTotal / historyPageSize));
  const historyPageIndex = Math.min(historyPage, historyPageCount - 1);
  const taskHistory = useMemo(() => {
    const start = historyPageIndex * historyPageSize;
    const groups = new Map<string, { projectId: string; title: string; tasks: ProjectTask[] }>();
    for (const task of tasks.slice(start, start + historyPageSize)) {
      const existing = groups.get(task.projectId);
      if (existing) existing.tasks.push(task);
      else groups.set(task.projectId, {
        projectId: task.projectId,
        title: workspace.projects.find((project) => project.id === task.projectId)?.title ?? task.projectId,
        tasks: [task],
      });
    }
    return [...groups.values()];
  }, [tasks, workspace.projects, historyPageIndex, historyPageSize]);

  const tabCount = (id: WorkspaceView) => workspace.projects.filter((project) => {
    if (id === "trash") return Boolean(project.trashedAt);
    if (project.trashedAt) return false;
    if (id === "done") return rankOf(project) === DONE_RANK;
    if (id === "attention") return rankOf(project) < DONE_RANK;
    return true;
  }).length;
  const selected = projects.filter((project) => selectedIds.has(project.id));
  const selectedClean = selected.filter((project) => ["ready", "approved"].includes(inspectProjectDelivery(project).state));
  const allSelected = projects.length > 0 && projects.every((project) => selectedIds.has(project.id));

  useEffect(() => {
    const available = new Set(projects.map((project) => project.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [projectIdsKey]);

  const control = async (task: ProjectTask, action: TaskAction) => {
    setBusyTaskId(task.id);
    setError(null);
    const result = await workspace.controlTask({
      taskId: task.id,
      projectId: task.projectId,
      action,
      ...(["resume", "retry"].includes(action) ? { userConfirmed: true as const } : {}),
    });
    setBusyTaskId(null);
    if (!result.ok) setError(result.message ?? "任务控制失败");
    else {
      setStatus(action === "prioritize" ? "已把任务设为下一项。" : "任务状态已更新。");
      app.play(action === "cancel" ? "warning" : "click");
    }
  };

  const startBatch = async () => {
    setConfirmAction(null);
    setBulkBusy(true);
    const result = await workspace.startBatch();
    setBulkBusy(false);
    if (!result.ok) setError(result.message);
    else {
      setStatus("批量任务已建立；每个项目保留独立失败和恢复状态。");
      app.play("success");
    }
  };

  const runSelected = async () => {
    setConfirmAction(null);
    setBulkBusy(true);
    setError(null);
    let changed = 0;
    for (const project of selected) {
      const task = getLatestProjectTask(workspace.tasks, project.id);
      const primary = task ? getPrimaryTaskControl(task) : null;
      if (task && primary && ["resume", "retry"].includes(primary.action)) {
        const result = await workspace.controlTask({ taskId: task.id, projectId: project.id, action: primary.action, userConfirmed: true });
        if (result.ok) changed += 1;
        continue;
      }
      if (task && LIVE_TASKS.has(task.status)) continue;
      if (!canStartProjectFromSelection(project, task)) continue;
      const workflow = await workspace.runAutomaticProjectWorkflow(project.id);
      if (workflow.status !== "failed") changed += 1;
    }
    setBulkBusy(false);
    setStatus(changed ? `已开始或继续 ${changed} 个项目。` : "所选项目当前没有可开始或继续的工作。");
  };

  const pauseSelected = async () => {
    setBulkBusy(true);
    let changed = 0;
    for (const project of selected) {
      const task = getLatestProjectTask(workspace.tasks, project.id);
      const primary = task ? getPrimaryTaskControl(task) : null;
      if (task && primary && ["pause", "cancel"].includes(primary.action)) {
        const result = await workspace.controlTask({ taskId: task.id, projectId: project.id, action: primary.action });
        if (result.ok) changed += 1;
      } else if (workspace.automaticWorkflows[project.id]?.status === "running") {
        const result = await workspace.cancelAutomaticProjectWorkflow(project.id);
        if (result.ok) changed += 1;
      }
    }
    setBulkBusy(false);
    setStatus(changed ? `已暂停或停止 ${changed} 个项目。` : "所选项目没有可暂停的工作。");
  };

  const trashSelected = async () => {
    setConfirmAction(null);
    setBulkBusy(true);
    let moved = 0;
    for (const project of selected) {
      const result = await workspace.trashProject(project.id);
      if (result.ok) moved += 1;
      else setError(result.message ?? "项目没有移入回收站");
    }
    setBulkBusy(false);
    setStatus(`已将 ${moved} 个项目移入回收站。`);
    if (moved === selected.length) {
      setSelectedIds(new Set());
      setSelecting(false);
    }
  };

  const archiveSelected = () => {
    let changed = 0;
    for (const project of selected) {
      if (workspace.setProjectArchived(project.id, view !== "done").ok) changed += 1;
    }
    setStatus(view === "done" ? `已恢复 ${changed} 个归档项目。` : `已归档 ${changed} 个项目。`);
    setSelectedIds(new Set());
    setSelecting(false);
  };

  const exportSelected = async () => {
    setConfirmAction(null);
    setBulkBusy(true);
    const result = await workspace.approveAndExportBatchTargets(selectedClean.map((project) => project.id));
    setBulkBusy(false);
    if (!result.ok) setError(result.message ?? "批量交付没有完成");
    else if (result.canceled) setStatus("已取消选择导出目录；已完成的批准状态保持不变。");
    else setStatus(`已导出 ${result.exportedFileCount ?? 0} 份字幕；${result.blockedProjectCount ?? 0} 个项目被 QA 门阻止。`);
  };

  const purgeTasks = async () => {
    setConfirmAction(null);
    setBulkBusy(true);
    const result = await workspace.purgeFinishedTasks();
    setBulkBusy(false);
    if (!result.ok) return setError(result.message ?? "任务历史没有清理");
    setStatus(result.keptCount
      ? `已删除 ${result.deletedCount ?? 0} 条已结束的任务；${result.keptCount} 条仍在进行或可重试，已保留。`
      : `已删除 ${result.deletedCount ?? 0} 条已结束的任务。`);
  };

  const purgeSelected = async () => {
    setConfirmAction(null);
    setBulkBusy(true);
    const result = await workspace.deleteTrashedProjects(selected.map((project) => project.id));
    setBulkBusy(false);
    setSelectedIds(new Set());
    if (!result.ok) setError(result.message ?? "项目没有删除");
    else setStatus(`已永久删除 ${result.deletedCount ?? 0} 个项目。`);
  };

  const toggleSelected = (projectId: string, checked: boolean) => setSelectedIds((current) => {
    const next = new Set(current);
    if (checked) next.add(projectId); else next.delete(projectId);
    return next;
  });

  const finishedTaskCount = tasks.filter((task) => !LIVE_TASKS.has(task.status)).length;
  // 失败原因原来只在下面的任务面板里，而且是后端英文原文。批量跑十个项目时，
  // 用户看到的是列表里一排"失败"，得逐个点开才知道为什么。
  const failureReason = (task: ProjectTask | null | undefined) => task && task.status === "failed"
    ? localizeIpcErrorText({ code: task.lastErrorCode ?? undefined, message: task.detail })
    : null;
  const confirmCopy = confirmAction === "purge-tasks"
    ? { title: `删除 ${finishedTaskCount} 条已结束的任务记录？`, text: "已完成、失败和已取消的记录会从本机永久删除，不可撤销。正在进行和还能重试的任务会保留，不受影响。", label: "永久删除记录" }
    : confirmAction === "purge-selected"
    ? { title: `永久删除选中的 ${selected.length} 个项目？`, text: "只删除你勾选的这些；项目容器会从本机永久删除，不可撤销。回收站里没勾选的不受影响。", label: `永久删除 ${selected.length} 个` }
    : confirmAction === "trash"
      ? { title: `将 ${selected.length} 个项目移入回收站？`, text: "运行中的任务会先停止；项目之后仍可恢复。", label: "停止并移入回收站" }
      : confirmAction === "export"
        ? { title: `批准并导出 ${selectedClean.length} 个项目？`, text: "系统只处理 QA 门已通过的目标轨，并只打开一次目录选择器。", label: "批准并选择目录" }
        : { title: `开始或继续 ${selected.length || projects.length} 个项目？`, text: "项目会按各自保存的 Provider 方案运行，请求可能产生费用；失败不会自动重试。", label: "确认并开始" };

  return (
    <div className="page-stage projects-page secondary-page" data-fr03-view={batchMode ? "batch" : `workspace-${view}`}>
      {/* 全局任务账本是从系统页的维护入口进来的二级页面，和 /system/asr、/system/settings
          一样必须自带返回，否则只能去点左侧菜单。 */}
      <header className="page-header"><div>{batchMode ? <button type="button" className="back-button" onClick={() => navigate("/workspace")}><Icon name="arrow"/> 返回项目与任务</button> : focusTasks ? <button type="button" className="back-button" onClick={() => navigate("/system")}><Icon name="arrow"/> 返回系统</button> : null}<h1>{batchMode ? "批量处理" : focusTasks ? "全局任务账本" : "项目与任务"}</h1><p>{batchMode ? "每个项目保留独立任务、失败和恢复状态。" : focusTasks ? "跨项目的运行、失败与恢复记录；已结束的记录可以整批清理。" : "默认只显示需要你处理的项目；已完成的收在「已完成与归档」里。"}</p></div><div className="page-actions"><button type="button" className="btn btn-secondary" onClick={() => workspace.retryLoadProjects()} disabled={workspace.loadState === "loading"}><Icon name="refresh"/>{workspace.loadState === "loading" ? "读取中" : "重新读取"}</button><button type="button" className="btn btn-primary" onClick={() => navigate("/import")}><Icon name="upload"/>导入素材</button></div></header>

      {!batchMode ? <div className="workspace-commandbar"><div className="workspace-view-tabs" role="tablist" aria-label="工作区视图">{([['attention','需要处理'],['all','全部'],['done','已完成与归档'],['trash','回收站']] as const).map(([id, label]) => <button type="button" role="tab" aria-selected={view === id} className={view === id ? "is-active" : ""} key={id} onClick={() => { setView(id); setSelecting(false); setSelectedIds(new Set()); }}>{label}<span>{tabCount(id)}</span></button>)}</div>{<label className="workspace-search"><span>搜索项目</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题或文件名"/></label>}<div className="workspace-select-tools">{selecting ? <><label><input type="checkbox" checked={allSelected} onChange={(event) => { const checked = event.target.checked; setSelectedIds(checked ? new Set(projects.map((project) => project.id)) : new Set()); }}/>全选</label><button type="button" className="text-button" onClick={() => { setSelecting(false); setSelectedIds(new Set()); }}>退出选择</button></> : <button type="button" className="btn btn-secondary" onClick={() => setSelecting(true)} disabled={!projects.length}>选择项目</button>}</div></div> : null}

      {/* 这类报错的处理办法就写在正文里（"刷新后重试"），所以刷新必须长在这条提示上，
          而不是让用户自己去页头找"重新读取"。 */}
      {error || workspace.loadError ? <div className="runtime-alert" role="alert"><Icon name="warning"/><div><strong>工作区状态不完整</strong><p>{error ?? workspace.loadError}</p></div><button type="button" className="btn btn-secondary" onClick={() => { setError(null); workspace.retryLoadProjects(); }} disabled={workspace.loadState === "loading"}><Icon name="refresh"/>{workspace.loadState === "loading" ? "刷新中" : "刷新并重试"}</button></div> : status ? <div className="editor-status-line" role="status"><Icon name="check"/><span>{status}</span><button type="button" className="text-button" onClick={() => setStatus(null)}>关闭</button></div> : null}

      {batchMode ? <section className="batch-summary production-batch-summary"><div><span>本次批量</span><strong>{projects.length}</strong><small>个项目</small></div><div><span>批次标识</span><strong>{batch?.id ?? "没有活动批次"}</strong><small>{tasks.length} 个真实任务</small></div><div><span className={`state-tag ${tasks.some((task) => ["running", "pending"].includes(task.status)) ? "running" : "waiting"}`}>{tasks.length ? "任务已建立" : "尚未开始"}</span><p>真正开始前会明确确认 Provider 请求。</p></div></section> : null}

      {<section className="project-board production-project-board"><div className="board-head"><span>{selecting ? "选择" : "类型"}</span><span>项目</span><span>阶段</span><span>最近任务</span><span>更新</span><span/></div>{projects.map((project) => { const summary = deriveProjectStatusSummary(project); const task = getLatestProjectTask(tasks, project.id); return <article className="project-row production-selectable-row" key={project.id}>{selecting ? <label className="project-select"><input type="checkbox" aria-label={`选择项目 ${project.title}`} checked={selectedIds.has(project.id)} onChange={(event) => toggleSelected(project.id, event.target.checked)}/></label> : <span className="row-order">{project.mediaKind.slice(0, 1).toUpperCase()}</span>}<button type="button" className="project-row-open" onClick={() => navigate(`/projects/${project.id}`)}><span className="row-title"><strong>{project.title}</strong><em>{project.sourceFileName}</em></span><span className={`state-tag ${summary.tone === "green" ? "done" : summary.tone === "red" ? "danger" : summary.tone === "blue" ? "running" : "waiting"}`}>{summary.label}</span><span className="row-progress"><em>{task ? `${taskState(task.status)} · ${formatProgress(task.progress)}%` : "无任务"}</em>{failureReason(task) ? <small className="row-failure">{failureReason(task)}</small> : null}</span><span className="row-updated">{formatUiDateTime(project.updatedAt)}</span><Icon name="chevron"/></button>{view === "trash" && !selecting ? <button type="button" className="btn btn-secondary project-restore" onClick={() => { workspace.restoreProject(project.id); setStatus(`已恢复“${project.title}”。`); }}>恢复</button> : null}</article>; })}{projects.length === 0 ? <div className="production-empty workspace-empty"><span className="empty-seal">00</span><div><strong>{batchMode ? "没有可显示的批量项目" : view === "trash" ? "项目回收站为空" : view === "done" ? "还没有完成或归档的项目" : view === "attention" ? "没有需要你处理的项目" : "本机还没有项目"}</strong><p>{batchMode ? "批次可能已结束或项目尚未恢复。" : view === "trash" ? "移入回收站的项目会显示在这里。" : view === "attention" ? "已完成的项目在「已完成与归档」里。" : "导入文件或恢复项目后会显示在这里。"}</p></div></div> : null}</section>}

      {showTaskPanel ? <section className="task-ledger"><header><h2>{batchMode ? "任务账本" : "正在进行与最近失败"}</h2><span>{activeTasks.length} / {tasks.length} 条持久化任务</span></header>{activeTasks.map((task) => { const primary = getPrimaryTaskControl(task); return <article key={task.id}><span className={`task-lamp ${taskTone(task)}`}/><div><strong>{task.label}</strong><p>{failureReason(task) ?? task.detail}</p>{task.lastErrorCode ? <em className="pro-only task-error-code">{task.lastErrorCode}</em> : null}<TaskLiveness task={task}/></div><span className={`state-tag ${taskTone(task)}`}>{taskState(task.status)}</span><div className="ledger-progress"><i style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}/></div><em>{formatProgress(task.progress)}%</em><div className="task-row-controls">{task.status === "pending" ? <button type="button" className="text-button" onClick={() => void control(task, "prioritize")} disabled={busyTaskId === task.id}>设为下一项</button> : null}{primary ? <button type="button" className="btn btn-secondary" onClick={() => void control(task, primary.action)} disabled={busyTaskId === task.id}>{primary.label}</button> : <button type="button" className="text-button" onClick={() => navigate(`/projects/${task.projectId}`)}>打开项目</button>}</div></article>; })}{activeTasks.length === 0 ? <div className="production-empty task-empty"><span className="empty-seal">—</span><div><strong>没有正在进行或失败的任务</strong><p>开始处理后，运行中的任务会出现在这里。</p></div></div> : null}{!batchMode ? (
        <details className="task-history" open={focusTasks}>
          <summary>全部任务历史<small>共 {historyTotal} 条</small></summary>
          {/* 清理和分页放在列表上方：任务一多，放在底部就得一直往下拉才够得着。 */}
          <div className="task-history-bar">
            <label>每页
              <select value={historyPageSize} onChange={(event) => { setHistoryPageSize(Number(event.target.value)); setHistoryPage(0); }}>
                {[20, 50, 100].map((size) => <option key={size} value={size}>{size} 条</option>)}
              </select>
            </label>
            <div className="task-history-pager">
              <button type="button" className="text-button" onClick={() => setHistoryPage((page) => Math.max(0, page - 1))} disabled={historyPageIndex === 0}>上一页</button>
              <span>{historyPageIndex + 1} / {historyPageCount}</span>
              <button type="button" className="text-button" onClick={() => setHistoryPage((page) => Math.min(historyPageCount - 1, page + 1))} disabled={historyPageIndex >= historyPageCount - 1}>下一页</button>
            </div>
            {finishedTaskCount ? <button type="button" className="btn btn-secondary danger-link" onClick={() => setConfirmAction("purge-tasks")} disabled={bulkBusy || !workspace.isDesktop}>清理已结束的 {finishedTaskCount} 条</button> : null}
          </div>
          <div className="task-history-scroll">
            {taskHistory.map((group) => <div key={group.projectId}><h3>{group.title}</h3>{group.tasks.map((task) => <p key={task.id}><span className={`task-lamp ${taskTone(task)}`}/><strong>{task.label}</strong><span className={`state-tag ${taskTone(task)}`}>{taskState(task.status)}</span><time>{formatProgress(task.progress)}%</time></p>)}</div>)}
            {!taskHistory.length ? <p className="task-history-empty">还没有任务记录。</p> : null}
          </div>
        </details>
      ) : null}</section> : null}

      {batchMode && batch && !tasks.length ? <div className="batch-dock production-batch-dock"><span>{projects.length} 个项目将使用各自已保存的真实方案</span><div><button type="button" className="btn btn-secondary" onClick={() => navigate("/workspace")}>暂不开始</button><button type="button" className="btn btn-primary" onClick={() => setConfirmAction("start")} disabled={!projects.length || !workspace.isDesktop || bulkBusy}>确认并开始</button></div></div> : null}

      {selecting ? <div className="batch-dock workspace-bulk-dock" aria-label="批量项目操作"><span>已选择 {selected.length} 个项目{selectedClean.length ? ` · ${selectedClean.length} 个可交付` : ""}</span><div>{view === "trash" ? <><button type="button" className="btn btn-secondary" onClick={() => { selected.forEach((project) => workspace.restoreProject(project.id)); setStatus(`已恢复 ${selected.length} 个项目。`); setSelectedIds(new Set()); }} disabled={!selected.length || bulkBusy}>恢复选中项</button><button type="button" className="btn btn-secondary danger-link" onClick={() => setConfirmAction("purge-selected")} disabled={!selected.length || bulkBusy}>永久删除选中项</button></> : <><button type="button" className="btn btn-secondary" onClick={() => setConfirmAction("start")} disabled={!selected.length || bulkBusy}>开始/继续</button><button type="button" className="btn btn-secondary" onClick={() => void pauseSelected()} disabled={!selected.length || bulkBusy}>暂停/停止</button><button type="button" className="btn btn-secondary" onClick={archiveSelected} disabled={!selected.length || bulkBusy}>{view === "done" ? "取消归档" : "归档"}</button>{selectedClean.length ? <button type="button" className="btn btn-secondary" onClick={() => setConfirmAction("export")} disabled={bulkBusy}>批准并导出</button> : null}<button type="button" className="btn btn-secondary danger-link" onClick={() => setConfirmAction("trash")} disabled={!selected.length || bulkBusy}>移入回收站</button></>}</div></div> : null}

      {confirmAction ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmAction(null); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-confirm-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="workspace-confirm-title">{confirmCopy.title}</h2><p>{confirmCopy.text}</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmAction(null)}>取消</button><button type="button" className="btn btn-primary" onClick={() => void (confirmAction === "purge-tasks" ? purgeTasks() : confirmAction === "purge-selected" ? purgeSelected() : confirmAction === "trash" ? trashSelected() : confirmAction === "export" ? exportSelected() : batchMode ? startBatch() : runSelected())}>{confirmCopy.label}</button></div></section></div> : null}
    </div>
  );
}
