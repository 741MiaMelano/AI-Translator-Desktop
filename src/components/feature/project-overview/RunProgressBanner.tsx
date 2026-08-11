import { CheckCircle2, FileOutput, Loader2, PauseCircle, RotateCcw, Square, TriangleAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getLatestProjectTranslationTask, type Project, type ProjectTask } from "../../../domain/workspace";
import { inspectProjectDelivery } from "../../../domain/project-delivery";
import { localizeIpcError } from "../../../i18n/errors";
import { useWorkspace } from "../../../state/WorkspaceContext";
import Button from "../../ui/Button";
import TaskPrimaryControlButton from "../TaskPrimaryControl";

/**
 * 翻译进行中 / 暂停 / 失败 的横幅，也是这个页面上唯一的任务控制入口。
 *
 * 两条用户反馈直接对应这里：
 * 「点开始之后主区域没有任何变化」——旧版唯一的信号是侧栏那个小数字；
 * 「这个界面没有暂停和开始任务按钮」——控制键此前只存在于「项目与任务 → 任务」页的底栏，
 * 而用户点完开始根本不会走到那里。
 *
 * 完成态不常驻——完成后交付卡本身就会变成「待校对」并给出下一步入口。
 */

/** 还没走到终态的任务：横幅要一直挂着，用户才知道后台还在跑。 */
const LIVE = new Set(["running", "pending", "pausing", "paused", "cancelling", "recoverable"]);
const SPINNING = new Set(["running", "pending", "pausing", "cancelling"]);

function percentOf(task: ProjectTask): number {
  return Number.isFinite(task.progress) ? Math.round(task.progress) : 0;
}

/**
 * 后端的 detail 是英文常量（"Queued" / "Running" / "Translate zh-CN"），
 * 中文界面里不能原样展示，所以这里按状态和语言自己组一句。
 */
function progressText(task: ProjectTask): string {
  const language = task.targetLanguageCode ? `${task.targetLanguageCode} · ` : "";
  if (task.status === "pending") return `${language}排队中，等待前一个任务让出通道`;
  if (task.status === "pausing") return `${language}正在停到下一个安全点`;
  if (task.status === "paused") return `${language}已暂停，已完成的批次都已保存`;
  if (task.status === "cancelling") return `${language}正在取消`;
  if (task.status === "recoverable") return `${language}上次被中断，需要你确认后才继续`;
  return `${language}正在翻译 ${percentOf(task)}%`;
}

function TaskControls({
  task,
  busy,
  onRun,
}: {
  task: ProjectTask;
  busy: boolean;
  onRun: (task: ProjectTask, action: "pause" | "resume" | "cancel" | "retry") => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <TaskPrimaryControlButton task={task} busy={busy} onControl={(action) => onRun(task, action)} />
      {task.status === "paused" || task.status === "recoverable" ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<Square size={13} />}
          disabled={busy}
          title="停止这个任务；已经译完并保存的部分会保留"
          onClick={() => onRun(task, "cancel")}
        >
          停止
        </Button>
      ) : null}
    </div>
  );
}

function LiveTaskRow({
  task,
  busy,
  onRun,
}: {
  task: ProjectTask;
  busy: boolean;
  onRun: (task: ProjectTask, action: "pause" | "resume" | "cancel" | "retry") => void;
}) {
  const text = progressText(task);
  return (
    <div>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--color-text-muted)]" title={text}>
          {text}
        </p>
        <TaskControls task={task} busy={busy} onRun={onRun} />
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full transition-all ${task.status === "paused" ? "bg-line-strong" : "bg-gold"}`}
          style={{ width: `${Math.max(2, Math.min(100, percentOf(task)))}%` }}
        />
      </div>
    </div>
  );
}

export default function RunProgressBanner({
  project,
}: {
  project: Project;
}) {
  const navigate = useNavigate();
  const { tasks, controlTask, approveAndExportProjectTargets } = useWorkspace();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = getLatestProjectTranslationTask(tasks, project.id);
  const live = latest && LIVE.has(latest.status) ? [latest] : [];
  const activeSource = project.sourceTracks.find((track) => track.id === project.activeSourceTrackId);
  const firstTarget = activeSource?.targetTracks.find((track) => track.isActive);
  const delivery = inspectProjectDelivery(project);

  const runControl = async (task: ProjectTask, action: "pause" | "resume" | "cancel" | "retry") => {
    setBusyTaskId(task.id);
    setNotice(null);
    const result = await controlTask({
      taskId: task.id,
      projectId: task.projectId,
      action,
      // 续跑和重试都会再次调用付费服务，后端要求显式确认。
      ...(action === "retry" || (action === "resume" && task.status === "recoverable")
        ? { userConfirmed: true }
        : {}),
    });
    setBusyTaskId(null);
    if (!result.ok) setNotice(result.message ?? "这个操作没有生效，请稍后再试。");
  };

  const runDelivery = async () => {
    setDeliveryBusy(true);
    setNotice(null);
    const result = await approveAndExportProjectTargets(project.id);
    setDeliveryBusy(false);
    const succeeded = result.summary?.succeeded.length ?? 0;
    const failed = result.summary?.failed.length ?? 0;
    if (result.canceled) {
      setNotice(result.approvedCount
        ? "译文已批准；你取消了文件夹选择，稍后可直接导出。"
        : "已取消导出，项目内容没有变化。");
      return;
    }
    if (result.ok) {
      setNotice(`已保存 ${succeeded} 个字幕文件到你选择的位置，并在资源管理器中定位。`);
      return;
    }
    if (succeeded > 0) {
      setNotice(`已保存 ${succeeded} 个字幕文件，另有 ${failed} 个失败；已成功的文件会保留。`);
      return;
    }
    setNotice(result.message ?? "批准或导出没有完成，请稍后再试。");
  };

  if (live.length > 0) {
    const paused = live.every((task) => task.status === "paused");
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="run-progress-banner"
        className="mb-3 rounded-[10px] border border-line bg-gold-wash px-3 py-2.5"
      >
        <div className="flex flex-wrap items-center gap-2">
          {live.some((task) => SPINNING.has(task.status)) ? (
            <Loader2 size={16} className="shrink-0 animate-spin text-gold-dark" />
          ) : (
            <PauseCircle size={16} className="shrink-0 text-[var(--color-text-muted)]" />
          )}
          <span className="text-[13px] font-medium text-[var(--color-text-main)]">
            {paused ? "翻译已暂停" : "正在翻译"}
          </span>
          <span className="ml-auto text-[11.5px] text-[var(--color-text-muted)]">
            可以离开这个页面，任务在后台继续。
          </span>
        </div>
        <div className="mt-2 space-y-1.5">
          {live.map((task) => (
            <LiveTaskRow key={task.id} task={task} busy={busyTaskId === task.id} onRun={runControl} />
          ))}
        </div>
        {notice ? (
          <p role="alert" className="mt-1.5 text-[11.5px] text-stop">
            {notice}
          </p>
        ) : null}
      </div>
    );
  }

  if (latest?.status === "failed") {
    const task = latest;
    const failure = localizeIpcError({ code: task.lastErrorCode ?? undefined, message: task.detail });
    const canRetry = task.retryable !== false && failure.retryable !== false;
    return (
      <div role="alert" className="mb-3 flex flex-wrap items-start gap-2 rounded-[10px] border border-stop bg-stop-wash px-3 py-2.5">
        <XCircle size={16} className="mt-0.5 shrink-0 text-stop" />
        <div className="min-w-[260px] flex-1">
          <p className="text-[13px] font-medium text-[var(--color-text-main)]">翻译没有完成：{failure.title}</p>
          {failure.detail ? (
            <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">{failure.detail}</p>
          ) : null}
        </div>
        {failure.actionRoute && failure.actionLabel ? (
          <Button variant="secondary" size="sm" onClick={() => navigate(failure.actionRoute!)}>
            {failure.actionLabel}
          </Button>
        ) : null}
        <Button
          variant={canRetry ? "primary" : "secondary"}
          size="sm"
          icon={<RotateCcw size={14} />}
          disabled={busyTaskId === task.id || !canRetry}
          title={
            !canRetry
              ? "这类失败重试也不会变，请先按上面的原因改配置"
              : "从最近的安全点继续未完成的部分，会再次调用付费服务"
          }
          onClick={() => void runControl(task, "retry")}
        >
          确认重试
        </Button>
        {notice ? <span className="text-[11.5px] text-stop">{notice}</span> : null}
      </div>
    );
  }

  if (latest?.status === "completed" && project.recentRunIds.length > 0) {
    if (delivery.state === "blocked") {
      const firstIssue = delivery.errorGroups[0];
      return (
        <section
          aria-label="翻译完成后的交付"
          className="mb-3 rounded-[10px] border border-stop bg-stop-wash px-3 py-2.5"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert size={18} className="mt-0.5 shrink-0 text-stop" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--color-text-main)]">
                翻译已完成，还有 {delivery.errorCount} 处必须修复
              </p>
              <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
                这些问题会阻止批准和导出。先定位处理，保存后页面会重新检查。
              </p>
            </div>
          </div>
          <ul className="mt-2 space-y-1.5 pl-6">
            {delivery.errorGroups.slice(0, 3).map((group) => (
              <li key={group.key} className="flex items-center gap-2 rounded-[6px] border border-line bg-card px-2.5 py-1.5 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate text-[var(--color-text-main)]">
                  {group.languageLabel} / {group.label}
                </span>
                <span className="tabular shrink-0 font-semibold text-stop">{group.count} 处</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
            <Button
              variant="primary"
              size="sm"
              disabled={!firstIssue}
              onClick={() => {
                if (!firstIssue) return;
                const segment = firstIssue.firstSegmentId
                  ? `?segmentId=${encodeURIComponent(firstIssue.firstSegmentId)}`
                  : "";
                navigate(`/projects/${project.id}/editor/${firstIssue.languageCode}${segment}`);
              }}
            >
              定位下一处
            </Button>
            {delivery.errorGroups.length > 3 ? (
              <span className="text-[11.5px] text-[var(--color-text-muted)]">
                另有 {delivery.errorGroups.length - 3} 类问题，进入后可逐类定位。
              </span>
            ) : null}
          </div>
        </section>
      );
    }

    const deliveryTitle = delivery.state === "exported" ? "字幕已交付" : "翻译已完成，可以交付";
    const deliveryLabel = delivery.state === "exported"
      ? "再次导出"
      : delivery.state === "approved"
        ? "导出字幕"
        : "批准并导出";
    return (
      <section
        aria-label="翻译完成后的交付"
        className="mb-3 rounded-[10px] border border-ok bg-ok-wash px-3 py-2.5"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-[280px] flex-1 items-start gap-2">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[var(--color-text-main)]">{deliveryTitle}</p>
              <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
                {delivery.state === "empty"
                  ? "当前没有可交付的目标语言，请修改项目配置。"
                  : delivery.warningCount > 0
                    ? `有 ${delivery.warningCount} 条优化建议，不影响交付；点击批准表示你已确认当前结果。`
                    : `已检查 ${delivery.targetCount} 种目标语言，没有阻断交付的问题。`}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!firstTarget}
              onClick={() => firstTarget && navigate(`/projects/${project.id}/editor/${firstTarget.languageCode}`)}
            >
              {delivery.state === "ready" ? "先校对" : "继续校对"}
            </Button>
            <Button
              variant="primary"
              icon={<FileOutput size={16} />}
              disabled={deliveryBusy || delivery.state === "empty"}
              title={delivery.state === "ready" ? "批准当前全部目标语言，然后选择保存文件夹" : "选择字幕保存文件夹"}
              onClick={() => void runDelivery()}
            >
              {deliveryBusy ? "正在准备导出…" : deliveryLabel}
            </Button>
          </div>
        </div>
        {notice ? (
          <p role="status" data-testid="delivery-closure-message" className="mt-1.5 text-[11.5px] text-[var(--color-text-muted)]">
            {notice}
          </p>
        ) : null}
      </section>
    );
  }

  return null;
}
