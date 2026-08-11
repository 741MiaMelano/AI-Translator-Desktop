import { ArrowRight, AudioLines, Captions, FolderOpenDot, Video } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Badge from "../components/ui/Badge";
import Card from "../components/ui/Card";
import EmptyState from "../components/ui/EmptyState";
import Input from "../components/ui/Input";
import {
  ProjectBulkActionBar,
  ProjectSelectionCheckbox,
  ProjectSelectionHeader,
  useProjectSelection,
} from "../components/feature/ProjectSelection";
import {
  deriveProjectStatusSummary,
  formatMediaKind,
  formatTaskStatus,
  getActiveProjects,
  getLatestProjectTranslationTask,
  sortProjectsByPriority,
  type MediaKind,
  type Project,
  type ProjectTask,
  type TaskStatus,
} from "../domain/workspace";
import type { AutomaticWorkflowState } from "../domain/automatic-workflow";
import PageHeader from "../layout/PageHeader";
import { useWorkspace } from "../state/WorkspaceContext";

type BadgeTone = "blue" | "green" | "red" | "gold" | "gray";

function getMediaKindIcon(kind: MediaKind) {
  if (kind === "video") return <Video size={16} />;
  if (kind === "audio") return <AudioLines size={16} />;
  return <Captions size={16} />;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function taskTone(status: TaskStatus): BadgeTone {
  if (["failed"].includes(status)) return "red";
  if (["recoverable", "paused", "pausing"].includes(status)) return "gold";
  if (["running", "pending", "cancelling"].includes(status)) return "blue";
  if (status === "completed") return "green";
  return "gray";
}

function visibleWorkflow(project: Project, workflow?: AutomaticWorkflowState) {
  return ["draft", "processing"].includes(project.lifecycle) ? workflow : undefined;
}

function projectPresentation(
  project: Project,
  workflow: AutomaticWorkflowState | undefined,
  task: ProjectTask | undefined,
): { tone: BadgeTone; label: string; helper: string; focused: boolean } {
  const activeWorkflow = visibleWorkflow(project, workflow);
  if (activeWorkflow && ["running", "queued", "blocked", "failed"].includes(activeWorkflow.status)) {
    return {
      tone: ["blocked", "failed"].includes(activeWorkflow.status) ? "red" : "blue",
      label: activeWorkflow.status === "running"
        ? "自动处理中"
        : activeWorkflow.status === "queued"
          ? "已排队"
          : activeWorkflow.status === "blocked"
            ? "待确认"
            : "处理失败",
      helper: activeWorkflow.message,
      focused: true,
    };
  }

  if (task && !["completed", "cancelled"].includes(task.status)) {
    return {
      tone: taskTone(task.status),
      label: formatTaskStatus(task.status),
      helper: task.detail,
      focused: true,
    };
  }

  const summary = deriveProjectStatusSummary(project);
  return {
    tone: summary.tone,
    label: summary.label,
    helper: summary.helperText,
    focused: !project.archivedAt && summary.tone !== "green",
  };
}

function ProjectRow({
  project,
  workflow,
  task,
  onOpen,
  selecting,
  selected,
  onSelect,
}: {
  project: Project;
  workflow?: AutomaticWorkflowState;
  task?: ProjectTask;
  onOpen: () => void;
  selecting: boolean;
  selected: boolean;
  onSelect: (checked: boolean) => void;
}) {
  const presentation = projectPresentation(project, workflow, task);

  return (
    <div className="group flex items-center border-b border-line transition last:border-b-0 hover:bg-card-soft">
      {selecting ? (
        <span className="pl-3">
          <ProjectSelectionCheckbox projectTitle={project.title} checked={selected} onChange={onSelect} />
        </span>
      ) : null}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`打开项目 ${project.title}`}
        className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 text-left focus-visible:outline-offset-[-2px]"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-[7px] bg-card-soft text-gold-dark">
          {getMediaKindIcon(project.mediaKind)}
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-[var(--color-text-main)]">{project.title}</span>
            {project.archivedAt ? <Badge tone="gray">已归档</Badge> : null}
            <Badge tone={presentation.tone}>{presentation.label}</Badge>
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-text-muted)]">
            {formatMediaKind(project.mediaKind)} · {project.config.targetLanguages.join(" / ") || "未设置目标语言"} · {presentation.helper}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">
            {project.sourceFileName} · 更新于 {formatTimestamp(project.updatedAt)}
          </span>
        </span>
        <ArrowRight size={17} className="text-[var(--color-text-muted)] transition group-hover:translate-x-0.5 group-hover:text-gold-dark" />
      </button>
    </div>
  );
}

export default function TaskCenterPage() {
  const navigate = useNavigate();
  const { projects, tasks, automaticWorkflows } = useWorkspace();
  const [query, setQuery] = useState("");

  const projectRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return sortProjectsByPriority(getActiveProjects(projects))
      .filter((project) => !normalizedQuery || [project.title, project.sourceFileName, ...project.notes]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
      .map((project) => {
        const task = getLatestProjectTranslationTask(tasks, project.id);
        return {
          project,
          task,
          focused: projectPresentation(project, automaticWorkflows[project.id], task).focused,
        };
      });
  }, [automaticWorkflows, projects, query, tasks]);
  const selection = useProjectSelection(projectRows.map(({ project }) => project.id));

  const focusedProjects = projectRows.filter((row) => row.focused);
  const settledProjects = projectRows.filter((row) => !row.focused);

  const renderRow = ({ project, task }: (typeof projectRows)[number]) => (
    <ProjectRow
      key={project.id}
      project={project}
      workflow={automaticWorkflows[project.id]}
      task={task}
      onOpen={() => navigate(`/projects/${project.id}`)}
      selecting={selection.selecting}
      selected={selection.selectedIds.has(project.id)}
      onSelect={(checked) => selection.toggle(project.id, checked)}
    />
  );

  return (
    <>
      <PageHeader
        title="项目"
        description="选择项目即可继续；需要确认或正在处理的项目会排在前面。"
        actions={<ProjectSelectionHeader selection={selection} disabled={projectRows.length === 0} />}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-[11.5px] text-[var(--color-text-muted)]">
          需要处理 <span className="tabular text-[var(--color-text-main)]">{focusedProjects.length}</span>
          {" · "}已完成或归档 <span className="tabular text-[var(--color-text-main)]">{settledProjects.length}</span>
        </p>
        <div className="ml-auto w-full max-w-[280px]">
          <Input
            type="search"
            placeholder="搜索项目名、文件名…"
            aria-label="搜索项目名、文件名"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <Card
        title={`需要处理 (${focusedProjects.length})`}
        description="点击任一项目进入概览，继续当前步骤。"
        dense
      >
        {focusedProjects.length > 0 ? (
          <div>{focusedProjects.map(renderRow)}</div>
        ) : (
          <EmptyState
            icon={<FolderOpenDot size={20} />}
            title={query ? "没有匹配的项目" : "当前没有需要处理的项目"}
            description={query ? "换一个关键词，或清空搜索框。" : "已完成项目收在下方，需要时再展开。"}
          />
        )}

        {settledProjects.length > 0 ? (
          <details className="group mt-2 rounded-[7px] border border-line bg-card-soft">
            <summary className="flex cursor-pointer list-none items-center px-3 py-2.5 text-[12.5px] font-medium text-[var(--color-text-muted)] [&::-webkit-details-marker]:hidden">
              已完成或已归档 {settledProjects.length} 个
              <span className="ml-auto text-gold-dark group-open:hidden">展开</span>
              <span className="ml-auto hidden text-gold-dark group-open:inline">收起</span>
            </summary>
            <div className="border-t border-line bg-card">{settledProjects.map(renderRow)}</div>
          </details>
        ) : null}
      </Card>
      <ProjectBulkActionBar selection={selection} />
    </>
  );
}
