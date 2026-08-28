import { useNavigate } from "react-router-dom";
import { getActiveSourceTrack, getActiveTargetTracks, getLatestProjectTask, type Project, type ProjectTask } from "../domain/workspace";
import { Icon } from "./visuals";

export type ProjectWorkspaceSection = "intake" | "transcribe" | "translate" | "review" | "delivery" | "settings";

type StageState = "done" | "current" | "waiting";

const LIVE_TASK = new Set(["pending", "running", "pausing", "paused", "cancelling", "recoverable"]);
const STATE_LABEL: Record<StageState, string> = { done: "已完成", current: "进行中", waiting: "未开始" };

function effectiveTargetText(value: { manual?: string; postProcessed: string; model: string } | undefined) {
  return value?.manual ?? value?.postProcessed ?? value?.model ?? "";
}

// 五阶段状态由项目真实内容推导，不由界面自行改写。
function deriveStageStates(project: Project, task: ProjectTask | undefined): StageState[] {
  const source = getActiveSourceTrack(project);
  const targets = getActiveTargetTracks(project);
  const hasSource = Boolean(source?.segments.length);
  const hasTranslation = Boolean(source?.segments.some((segment) => targets.some((target) => effectiveTargetText(segment.targetTexts[target.languageCode]).trim())));
  const anyApproved = targets.some((target) => target.status === "approved" || target.status === "exported");
  const anyExported = targets.some((target) => target.status === "exported");
  const live = task && LIVE_TASK.has(task.status) ? task : undefined;
  const states: StageState[] = [
    "done",
    hasSource || project.noSourceMedia ? "done" : live && ["detect", "extract", "asr", "segment"].includes(live.stage) ? "current" : "waiting",
    hasTranslation ? "done" : live && live.stage === "translate" ? "current" : "waiting",
    anyApproved ? "done" : hasTranslation ? "current" : "waiting",
    anyExported ? "done" : anyApproved ? "current" : "waiting",
  ];
  if (!states.includes("current")) {
    const next = states.findIndex((state) => state === "waiting");
    if (next >= 0) states[next] = "current";
  }
  return states;
}

type Stage = { id: ProjectWorkspaceSection; label: string; path?: string; note?: string };

// 没有目的地的阶段仍然留在导轨上作为进度指示，而不是消失，因为用户需要始终看见完整的五步。
function stageList(project: Project): Stage[] {
  const source = getActiveSourceTrack(project);
  const target = source?.targetTracks.find((track) => track.isActive && !track.trashedAt)
    ?? source?.targetTracks.find((track) => !track.trashedAt);
  return [
    { id: "intake", label: "导入", path: `/projects/${project.id}` },
    project.noSourceMedia
      ? { id: "transcribe", label: "转写", note: "不适用 · 已有字幕" }
      : { id: "transcribe", label: "转写", path: `/projects/${project.id}/media` },
    { id: "translate", label: "翻译", path: `/projects/${project.id}/translate` },
    target
      ? { id: "review", label: "校对", path: `/projects/${project.id}/editor/${encodeURIComponent(target.languageCode)}` }
      : { id: "review", label: "校对", note: "先生成目标字幕轨" },
    target
      ? { id: "delivery", label: "交付", path: `/projects/${project.id}/deliver` }
      : { id: "delivery", label: "交付", note: "先生成目标字幕轨" },
  ];
}

/**
 * 项目当前停在哪一阶段的可达入口。命令面板"继续某项目"必须和导轨给出同一个答案，
 * 所以两边共用同一份阶段推导，而不是各算各的。
 */
export function projectStageEntry(project: Project, tasks: ProjectTask[]) {
  const stages = stageList(project);
  const states = deriveStageStates(project, getLatestProjectTask(tasks, project.id));
  const currentIndex = states.findIndex((state) => state === "current");
  // 当前阶段没有目的地时（例如还没有目标轨的"校对"），退回最后一个能去的地方。
  for (let index = currentIndex; index >= 0; index -= 1) {
    if (stages[index]?.path) return { label: stages[index].label, path: stages[index].path as string };
  }
  return { label: stages[0].label, path: stages[0].path as string };
}

export function ProjectWorkspaceNav({ project, current, tasks }: {
  project: Project;
  current: ProjectWorkspaceSection;
  tasks: ProjectTask[];
}) {
  const navigate = useNavigate();
  const states = deriveStageStates(project, getLatestProjectTask(tasks, project.id));
  const stages = stageList(project);

  // 九套皮肤有 20 多条规则直接选择 `.stage-rail li > span` / `li > i` 来表达各自的签名几何，
  // 所以这里保持 li 的子元素结构完全不变，只叠加一个铺满 li 的透明按钮作为点击与焦点目标。
  return (
    <ol className="stage-rail project-stage-rail" aria-label="项目五阶段">
      {stages.map((stage, index) => {
        const state = states[index];
        return (
          <li
            key={stage.id}
            className={`${state} ${current === stage.id ? "is-current-stage" : ""} ${stage.path ? "" : "is-unreachable"}`}
            title={stage.path ? undefined : `${stage.label} · ${stage.note}`}
          >
            <span>{state === "done" ? <Icon name="check"/> : index + 1}</span>
            <strong>{stage.label}</strong>
            <i/>
            {/* 不可达的阶段不需要点击目标，也不能再套一层 span：`.stage-rail li > span`
                的特异性高于单类名，会把它渲染成第二个阶段圆点。 */}
            {stage.path ? (
              <button
                type="button"
                className="stage-rail-hit"
                aria-current={current === stage.id ? "page" : undefined}
                aria-label={`${stage.label} · ${STATE_LABEL[state]}`}
                title={`${stage.label} · ${STATE_LABEL[state]}`}
                onClick={() => navigate(stage.path as string)}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
