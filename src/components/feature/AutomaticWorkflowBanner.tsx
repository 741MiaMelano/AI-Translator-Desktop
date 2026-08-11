import { AlertTriangle, CircleHelp, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type AutomaticWorkflowAnswer,
  type AutomaticWorkflowStage,
  type AutomaticWorkflowState,
} from "../../domain/automatic-workflow";
import Button from "../ui/Button";

interface AutomaticWorkflowBannerProps {
  state?: AutomaticWorkflowState;
  recognitionProgress?: number;
  onAction: () => void;
  onResolve?: (answer: AutomaticWorkflowAnswer) => Promise<{ ok: boolean; message?: string }>;
  onCancel: () => void;
  onRetry: () => void;
}

const STAGES: AutomaticWorkflowStage[] = [
  "checking",
  "extracting",
  "recognizing",
  "segmenting",
  "detecting_language",
  "activating",
  "starting_translation",
];

function elapsedLabel(startedAt: number | undefined, now: number) {
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1_000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export default function AutomaticWorkflowBanner({
  state,
  recognitionProgress,
  onAction,
  onResolve,
  onCancel,
  onRetry,
}: AutomaticWorkflowBannerProps) {
  const resolution = state?.resolution;
  const resolutionKey = resolution
    ? `${resolution.kind}:${resolution.choices.map((choice) => choice.value).join(",")}`
    : "";
  const [choice, setChoice] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setChoice(resolution?.choices.find((item) => item.recommended)?.value ?? "");
    setResolutionError(null);
  }, [resolutionKey]);

  useEffect(() => {
    if (state?.status !== "running") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state?.status, state?.startedAt]);

  if (!state || state.status === "queued") return null;
  const running = state.status === "running";
  const blocked = state.status === "blocked";
  const stageNumber = Math.max(1, STAGES.indexOf(state.stage ?? "checking") + 1);
  const stageProgress = Math.round(((stageNumber - 0.5) / STAGES.length) * 100);
  const boundedRecognitionProgress = Number.isFinite(recognitionProgress)
    ? Math.min(100, Math.max(0, Math.round(recognitionProgress!)))
    : null;
  const currentProgress = state.stage === "recognizing" && boundedRecognitionProgress !== null
    ? Math.round(((stageNumber - 1) + boundedRecognitionProgress / 100) / STAGES.length * 100)
    : stageProgress;

  const confirm = async () => {
    if (!resolution || !choice || !onResolve || resolving) return;
    setResolving(true);
    setResolutionError(null);
    const answer: AutomaticWorkflowAnswer = resolution.kind === "stream"
      ? { kind: "stream", streamKind: resolution.streamKind, value: choice }
      : { kind: "language", sourceTrackId: resolution.sourceTrackId, value: choice };
    try {
      const result = await onResolve(answer);
      if (!result.ok) setResolutionError(result.message ?? "确认没有保存，请重试。");
    } catch {
      setResolutionError("确认没有保存，原有结果仍然保留，请重试。");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      role={running ? "status" : blocked ? "region" : "alert"}
      aria-label={blocked ? "自动处理确认" : undefined}
      aria-live="polite"
      data-testid="automatic-workflow-banner"
      className={`mb-3 rounded-[8px] border px-3 py-2.5 ${
        running || blocked ? "border-gold bg-gold-wash" : "border-stop bg-stop-wash"
      }`}
    >
      <div className="flex flex-wrap items-start gap-2.5">
        {running
          ? <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin text-gold-dark" />
          : blocked
            ? <CircleHelp size={17} className="mt-0.5 shrink-0 text-gold-dark" />
            : <AlertTriangle size={17} className="mt-0.5 shrink-0 text-stop" />}
        <div className="min-w-[220px] flex-1">
          <p className="text-[12.5px] font-semibold text-[var(--color-text-main)]">
            {running ? "正在自动处理" : blocked ? "只需要确认一件事" : state.status === "failed" ? "自动处理没有完成" : "自动处理已停止"}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">{state.message}</p>
        </div>
        {running ? <Button variant="ghost" size="sm" onClick={onCancel}>停止</Button> : null}
      </div>

      {running ? (
        <div className="mt-2.5 pl-[27px]">
          <div
            role="progressbar"
            aria-label="自动处理进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={currentProgress}
            className="h-1.5 overflow-hidden rounded-full bg-card"
          >
            <div className="h-full rounded-full bg-gold transition-[width]" style={{ width: `${currentProgress}%` }} />
          </div>
          <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
            <span>第 {stageNumber}/{STAGES.length} 步 · 已用时 {elapsedLabel(state.startedAt, now)}</span>
            {state.stage === "recognizing" && boundedRecognitionProgress !== null
              ? <span>识别进度 {boundedRecognitionProgress}%</span>
              : null}
            <span>剩余时间：{state.stage === "recognizing" ? "取决于音频长度和虚拟机性能，暂时无法准确估算" : "当前步骤完成后会自动继续"}</span>
          </div>
        </div>
      ) : null}

      {running ? null : blocked && resolution ? (
        <div className="mt-2.5 pl-[27px]">
          <fieldset>
            <legend className="text-[12px] font-medium text-[var(--color-text-main)]">{resolution.prompt}</legend>
            {resolution.kind === "language" && resolution.samples.length ? (
              <div className="mt-1.5 space-y-0.5 rounded-[6px] border border-line bg-card-soft px-2.5 py-2 text-[11px] text-[var(--color-text-muted)]">
                {resolution.samples.map((sample, index) => (
                  <p key={`${index}-${sample}`} className="truncate">示例 {index + 1}：{sample}</p>
                ))}
              </div>
            ) : null}
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {resolution.choices.map((item) => (
                <label
                  key={item.value}
                  className={`cursor-pointer rounded-[6px] border px-2.5 py-2 transition ${
                    choice === item.value ? "border-gold bg-card" : "border-line bg-card-soft hover:border-gold"
                  }`}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name={`automatic-${resolutionKey}`}
                    value={item.value}
                    checked={choice === item.value}
                    onChange={() => setChoice(item.value)}
                  />
                  <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-text-main)]">
                    {item.label}
                    {item.recommended ? <span className="rounded bg-gold-wash px-1 py-0.5 text-[10px] text-gold-dark">推荐</span> : null}
                  </span>
                  {item.detail ? <span className="mt-0.5 block text-[10.5px] text-[var(--color-text-muted)]">{item.detail}</span> : null}
                </label>
              ))}
            </div>
          </fieldset>
          {resolutionError ? <p role="alert" className="mt-2 text-[11.5px] text-stop">{resolutionError}</p> : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={!choice || resolving || !onResolve} onClick={() => void confirm()}>
              {resolving ? "正在保存…" : "确认并继续"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onAction}>手动检查</Button>
            <span className="text-[10.5px] text-[var(--color-text-muted)]">确认后会自动接着处理，不需要重新设置。</span>
          </div>
        </div>
      ) : blocked ? (
        <div className="mt-2 flex justify-end">
          <Button variant="primary" size="sm" onClick={onAction}>{state.actionLabel ?? "去处理"}</Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-[27px]">
          <p className="text-[10.5px] text-[var(--color-text-muted)]">
            已完成的步骤不会丢失；检查文件、模型或网络后，可以从断点继续。
          </p>
          <Button variant="secondary" size="sm" icon={<RotateCcw size={13} />} onClick={onRetry}>继续处理</Button>
        </div>
      )}
    </div>
  );
}
