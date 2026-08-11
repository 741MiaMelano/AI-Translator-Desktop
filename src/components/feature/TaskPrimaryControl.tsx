import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { getPrimaryTaskControl, type ProjectTask } from "../../domain/workspace";
import Button from "../ui/Button";

type TaskAction = "pause" | "resume" | "cancel" | "retry";

const TITLES: Record<TaskAction, string> = {
  pause: "停在下一个安全检查点；已经完成的内容会保留",
  resume: "从最近的安全点继续",
  cancel: "停止这个任务；已经完成并保存的内容会保留",
  retry: "确认后从最近的安全点重试",
};

function actionIcon(action: TaskAction) {
  if (action === "pause") return <Pause size={13} />;
  if (action === "resume") return <Play size={13} />;
  if (action === "retry") return <RotateCcw size={13} />;
  return <Square size={13} />;
}

export default function TaskPrimaryControlButton({
  task,
  busy,
  onControl,
}: {
  task: ProjectTask;
  busy: boolean;
  onControl: (action: TaskAction) => void;
}) {
  const control = getPrimaryTaskControl(task);
  if (!control) return null;
  return (
    <Button
      size="sm"
      variant={control.action === "resume" || control.action === "retry" ? "primary" : "secondary"}
      icon={actionIcon(control.action)}
      disabled={busy}
      title={TITLES[control.action]}
      onClick={() => onControl(control.action)}
    >
      {control.label}
    </Button>
  );
}
