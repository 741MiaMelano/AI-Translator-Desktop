import { Pause, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  canStartProjectFromSelection,
  getLatestProjectTask,
  getPrimaryTaskControl,
  type ProjectTask,
} from "../../domain/workspace";
import { useWorkspace } from "../../state/WorkspaceContext";
import BottomActionBar from "../ui/BottomActionBar";
import Button from "../ui/Button";
import ConfirmDialog from "./project-overview/ConfirmDialog";

const LIVE_TASK_STATUSES = new Set(["pending", "running", "pausing", "paused", "cancelling", "recoverable"]);

export function useProjectSelection(projectIds: string[]) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const projectIdsKey = projectIds.join("|");

  useEffect(() => {
    const available = new Set(projectIds);
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      const unchanged = next.size === current.size && [...next].every((id) => current.has(id));
      return unchanged ? current : next;
    });
  }, [projectIdsKey]);

  const exit = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };
  const toggle = (projectId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  };
  const selectAll = (checked: boolean) => setSelectedIds(checked ? new Set(projectIds) : new Set());

  return {
    selecting,
    selectedIds,
    allSelected: projectIds.length > 0 && projectIds.every((id) => selectedIds.has(id)),
    enter: () => setSelecting(true),
    exit,
    toggle,
    selectAll,
  };
}

type ProjectSelection = ReturnType<typeof useProjectSelection>;

export function ProjectSelectionHeader({
  selection,
  disabled = false,
}: {
  selection: ProjectSelection;
  disabled?: boolean;
}) {
  if (!selection.selecting) {
    return <Button size="sm" variant="secondary" disabled={disabled} onClick={selection.enter}>选择项目</Button>;
  }
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
        <input
          type="checkbox"
          aria-label="全选当前项目"
          checked={selection.allSelected}
          onChange={(event) => selection.selectAll(event.target.checked)}
        />
        全选
      </label>
      <Button size="sm" variant="secondary" onClick={selection.exit}>退出选择</Button>
    </div>
  );
}

export function ProjectSelectionCheckbox({
  projectTitle,
  checked,
  onChange,
}: {
  projectTitle: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={`选择项目 ${projectTitle}`}
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="h-4 w-4 shrink-0 accent-[var(--color-gold)]"
    />
  );
}

function selectedTaskAction(tasks: ProjectTask[], projectIds: string[]) {
  const selected = new Set(projectIds);
  const controls = tasks.flatMap((task) => {
    if (!selected.has(task.projectId)) return [];
    if (!LIVE_TASK_STATUSES.has(task.status) || task.status === "cancelling") return [];
    if (task.status === "paused" || task.status === "recoverable" || task.status === "pausing") {
      return [{ task, action: "cancel" as const }];
    }
    const control = getPrimaryTaskControl(task);
    return control && (control.action === "pause" || control.action === "cancel")
      ? [{ task, action: control.action }]
      : [];
  });
  const hasPause = controls.some(({ action }) => action === "pause");
  const hasStop = controls.some(({ action }) => action === "cancel");
  return {
    controls,
    label: hasPause && hasStop ? "暂停/停止选中项" : hasPause ? "暂停选中项" : "停止选中项",
  };
}

export function ProjectBulkActionBar({
  selection,
  batchId,
}: {
  selection: ProjectSelection;
  batchId?: string;
}) {
  const {
    projects,
    tasks,
    automaticWorkflows,
    controlTask,
    runAutomaticProjectWorkflow,
    cancelAutomaticProjectWorkflow,
    trashProject,
  } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const projectIds = [...selection.selectedIds];
  const taskAction = selectedTaskAction(tasks, projectIds);
  const hasRunningWorkflow = projectIds.some((projectId) => automaticWorkflows[projectId]?.status === "running");

  const startOrContinue = async () => {
    setBusy(true);
    setNotice(null);
    let started = 0;
    for (const projectId of projectIds) {
      const task = getLatestProjectTask(tasks, projectId);
      const control = task ? getPrimaryTaskControl(task) : null;
      if (task && control && (control.action === "resume" || control.action === "retry")) {
        const result = await controlTask({
          taskId: task.id,
          projectId,
          action: control.action,
          userConfirmed: true,
        });
        if (result.ok) started += 1;
        continue;
      }
      if (task && LIVE_TASK_STATUSES.has(task.status)) continue;
      if (automaticWorkflows[projectId]?.status === "running") continue;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project || !canStartProjectFromSelection(project, task)) continue;
      void runAutomaticProjectWorkflow(projectId, batchId ? { batchId } : undefined);
      started += 1;
    }
    setBusy(false);
    setNotice(started > 0 ? `已开始或继续 ${started} 个项目。` : "所选项目当前没有可开始或继续的任务。");
  };

  const pauseOrStop = async () => {
    setBusy(true);
    setNotice(null);
    let controlled = 0;
    for (const { task, action } of taskAction.controls) {
      const result = await controlTask({ taskId: task.id, projectId: task.projectId, action });
      if (result.ok) controlled += 1;
    }
    const controlledProjectIds = new Set(taskAction.controls.map(({ task }) => task.projectId));
    for (const projectId of projectIds) {
      if (controlledProjectIds.has(projectId) || automaticWorkflows[projectId]?.status !== "running") continue;
      const result = await cancelAutomaticProjectWorkflow(projectId);
      if (result.ok) controlled += 1;
    }
    setBusy(false);
    setNotice(controlled > 0 ? `已控制 ${controlled} 个项目任务。` : "所选项目当前没有运行中的任务。");
  };

  const moveToTrash = async () => {
    setConfirmingTrash(false);
    setBusy(true);
    setNotice(null);
    let moved = 0;
    for (const projectId of projectIds) {
      const result = await trashProject(projectId);
      if (result.ok) moved += 1;
    }
    setBusy(false);
    if (moved === projectIds.length) selection.exit();
    else setNotice(`已移入回收站 ${moved} 个；其余项目因任务未能停止而保留。`);
  };

  if (!selection.selecting) return null;

  return (
    <>
      <BottomActionBar ariaLabel="批量项目操作">
        <span className="text-[12.5px] text-[var(--color-text-muted)]">已选择 {projectIds.length} 个项目</span>
        <Button
          variant="secondary"
          icon={<Play size={14} />}
          disabled={busy || projectIds.length === 0}
          onClick={() => void startOrContinue()}
        >
          开始/继续选中项
        </Button>
        <Button
          variant="secondary"
          icon={taskAction.label.startsWith("暂停") ? <Pause size={14} /> : <Square size={14} />}
          disabled={busy || (taskAction.controls.length === 0 && !hasRunningWorkflow)}
          onClick={() => void pauseOrStop()}
        >
          {taskAction.label}
        </Button>
        <Button
          variant="danger"
          icon={<Trash2 size={14} />}
          disabled={busy || projectIds.length === 0}
          onClick={() => setConfirmingTrash(true)}
        >
          移入回收站
        </Button>
        {notice ? <span role="status" className="text-[11.5px] text-[var(--color-text-muted)]">{notice}</span> : null}
      </BottomActionBar>
      <ConfirmDialog
        open={confirmingTrash}
        title={`将 ${projectIds.length} 个项目移入回收站？`}
        description="运行中的任务会先停止。项目之后可在“设置 → 项目回收站”恢复；这里不会永久删除文件。"
        confirmLabel="停止并移入回收站"
        tone="danger"
        onConfirm={() => void moveToTrash()}
        onCancel={() => setConfirmingTrash(false)}
      />
    </>
  );
}
