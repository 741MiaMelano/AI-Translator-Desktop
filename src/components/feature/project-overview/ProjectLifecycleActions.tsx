import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getActiveSourceTrack, getActiveTargetTracks, type Project, type ProjectTask } from "../../../domain/workspace";
import { useWorkspace } from "../../../state/WorkspaceContext";
import Button from "../../ui/Button";
import ConfirmDialog from "./ConfirmDialog";

/**
 * 「重新翻译」和「删除项目」。
 *
 * 用户反馈：「这三个项目我想选择一个项目进行重做，但是两个字幕项目居然都没有
 * 重新翻译按钮。我想把项目给删除重新导入，但是我也没有删除按钮。」
 *
 * 旧版能重跑的入口只有交付卡上的「换模型重译」——它跳去开始翻译页换模型，
 * 解决不了「就用现在这套配置再来一遍」；而删除只存在于开始翻译页的
 * 「丢弃当前 draft」，已经翻过的项目根本碰不到那个按钮。
 *
 * 两个动作都不便宜也不该误触，所以统一走应用内的二次确认对话框，
 * 而不是系统原生弹框——原生弹框套不上应用的视觉语言，也给不出语义化的按钮文案。
 */

/** 还没走到终态的任务；正在跑的时候不该再排一轮重译。 */
const LIVE_TASK = new Set(["running", "pending", "pausing", "paused", "cancelling", "recoverable"]);

type ButtonSize = "sm" | "md";

function hasLiveTask(tasks: ProjectTask[], projectId: string): boolean {
  return tasks.some((task) => task.projectId === projectId && LIVE_TASK.has(task.status));
}

/** 为什么现在不能重新翻译；null 表示可以。 */
function retranslateBlock(project: Project, tasks: ProjectTask[]): string | null {
  if (hasLiveTask(tasks, project.id)) return "这个项目还有任务在跑，等它结束或先取消再重译";
  const source = getActiveSourceTrack(project);
  if (!source) return "请先提取并确认字幕源轨";
  if (source.segments.length === 0) return "当前源轨还没有可翻译的句子";
  if (getActiveTargetTracks(project).length === 0 && project.config.targetLanguages.length === 0) {
    return "请先在项目配置里选择目标语言";
  }
  return null;
}

export function RetranslateButton({
  project,
  size = "md",
  variant = "outline",
}: {
  project: Project;
  size?: ButtonSize;
  variant?: "outline" | "secondary" | "primary";
}) {
  const navigate = useNavigate();
  const { tasks, startProject } = useWorkspace();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const block = retranslateBlock(project, tasks);

  const start = async () => {
    setAsking(false);
    setBusy(true);
    const result = await startProject(project.id);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    navigate(`/projects/${project.id}`);
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon={<RefreshCw size={size === "sm" ? 14 : 16} />}
        disabled={busy || Boolean(block)}
        title={block ?? "用当前的服务商和模型把整个项目重译一遍"}
        onClick={() => setAsking(true)}
      >
        重新翻译
      </Button>
      <ConfirmDialog
        open={asking}
        title="重新翻译这个项目？"
        description={
          `会用当前配置（${project.config.provider} · ${project.config.model}）把「${project.title}」`
          + "整轮重译一遍，重新调用付费接口。你人工改过的和已锁定的句子会原样保留，不会被覆盖。"
        }
        confirmLabel="开始重译"
        tone="danger"
        onConfirm={() => void start()}
        onCancel={() => setAsking(false)}
      />
      {message ? (
        <span role="alert" className="text-[11.5px] text-stop" title={message}>
          {message}
        </span>
      ) : null}
    </>
  );
}

export function DeleteProjectButton({
  project,
  size = "md",
  onDeleted,
}: {
  project: Project;
  size?: ButtonSize;
  /** 删完之后该去哪；项目页要跳走，列表页原地留着就行。 */
  onDeleted?: () => void;
}) {
  const { trashProject } = useWorkspace();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const remove = async () => {
    setAsking(false);
    setBusy(true);
    const result = await trashProject(project.id);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message ?? "项目没有移入回收站");
      return;
    }
    onDeleted?.();
  };

  return (
    <>
      <Button
        variant="secondary"
        size={size}
        icon={<Trash2 size={size === "sm" ? 14 : 16} />}
        disabled={busy}
        title="把这个项目移入回收站，之后可以在设置页恢复或彻底删除"
        onClick={() => setAsking(true)}
      >
        删除项目
      </Button>
      <ConfirmDialog
        open={asking}
        title="删除这个项目？"
        description={
          `「${project.title}」会从项目列表里移走，同名文件之后可以重新导入。`
          + "如有任务会先停止；项目会进入回收站，可在「设置 → 项目回收站」恢复或彻底删除。"
        }
        confirmLabel="移入回收站"
        tone="danger"
        onConfirm={() => void remove()}
        onCancel={() => setAsking(false)}
      />
      {message ? <span role="alert" className="text-[11.5px] text-stop">{message}</span> : null}
    </>
  );
}
