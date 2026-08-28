import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getActiveSourceTrack,
  getActiveTargetTracks,
  getLatestProjectTask,
} from "../domain/workspace";
import { useWorkspace } from "../state/WorkspaceContext";
import { useProjectStage } from "./ProjectWorkspace";
import { TranslationPlanFields } from "./TranslationPlanFields";
import { useFrontend } from "./state";
import { formatProgress } from "./format";
import { TaskLiveness } from "./TaskLiveness";
import { Icon } from "./visuals";

const LIVE_TASK = new Set(["pending", "running", "pausing", "paused", "cancelling", "recoverable"]);

function effectiveTargetText(value: { manual?: string; postProcessed: string; model: string } | undefined) {
  return value?.manual ?? value?.postProcessed ?? value?.model ?? "";
}

export function TranslatePage() {
  const { project } = useProjectStage();
  const workspace = useWorkspace();
  const app = useFrontend();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const config = project.config;
  const source = getActiveSourceTrack(project);
  const segments = source?.segments ?? [];
  const targets = getActiveTargetTracks(project);
  const task = getLatestProjectTask(workspace.tasks, project.id);
  const running = Boolean(task && LIVE_TASK.has(task.status));

  const translatedCount = (languageCode: string) => segments
    .filter((segment) => effectiveTargetText(segment.targetTexts[languageCode]).trim()).length;

  // 阻塞原因要说清是缺什么、去哪补，而不是只把按钮变灰。
  const blocked = !workspace.isDesktop ? "浏览器预览不执行真实翻译。"
    : !segments.length ? "还没有源字幕可译；先在导入阶段带入字幕，或在转写阶段把音频转成字幕。"
      : !config.targetLanguages.length ? "至少选择一个目标语言。"
        : running ? "本项目有任务正在运行，等它结束再发起新的翻译。"
          : null;

  const start = async () => {
    setBusy(true);
    setMessage(null);
    const result = await workspace.startProject(project.id);
    setBusy(false);
    if (!result.ok) return setMessage({ text: result.message ?? "翻译没有开始", error: true });
    app.play("success");
    setMessage({ text: `翻译已排入队列：${segments.length} 段源字幕 → ${config.targetLanguages.join("、")}。`, error: false });
  };

  const stop = async () => {
    if (!task) return;
    setBusy(true);
    const result = await workspace.controlTask({ taskId: task.id, projectId: project.id, action: "cancel" });
    setBusy(false);
    if (!result.ok) return setMessage({ text: result.message ?? "任务没有停止", error: true });
    app.play("warning");
  };

  return (
    <div className="project-stage-body translate-page" data-fr02-view="translate">
      <header className="stage-header">
        <div><h2>翻译</h2><p>用真实 Provider 把当前源字幕译成目标语言。方案改动即时保存到项目。</p></div>
        <span className={`state-tag ${targets.length ? "done" : "waiting"}`}>{targets.length ? `${targets.length} 条目标轨` : "还没有目标轨"}</span>
      </header>

      {message ? <div className={`runtime-alert ${message.error ? "" : "is-success"}`} role={message.error ? "alert" : "status"}><Icon name={message.error ? "warning" : "check"}/><div><strong>{message.error ? "操作没有完成" : "翻译已更新"}</strong><p>{message.text}</p></div></div> : null}

      <section className="production-panel translate-run-panel">
        <header><div><span>下一步</span><h2>把 {segments.length} 段源字幕送去翻译</h2></div><span className={`state-tag ${blocked ? "waiting" : "done"}`}>{blocked ? "尚不能开始" : "可以开始"}</span></header>

        <TranslationPlanFields project={project} onLanguageError={(error) => setMessage(error ? { text: error, error: true } : null)}/>

        {/* 自动/半自动在创建项目那一屏已经选过，费用也在"开始处理"的对话框里确认过。
            这里不再摆第三道勾选：费用写成按钮旁边的一行说明，点按钮就是那一次确认。
            任务在跑的时候主按钮只剩"停止"，不给第二个入口重复发起。 */}
        <div className="translate-primary-action">
          {running
            ? <button type="button" className="btn btn-primary danger-link" onClick={() => void stop()} disabled={busy}>停止当前任务</button>
            : <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={busy || Boolean(blocked)}>
                {busy ? "正在提交" : "开始翻译"} <Icon name="arrow"/>
              </button>}
          {blocked
            ? <span className="translate-blocked-hint">{blocked}</span>
            : <span className="translate-cost-note">会向 {config.provider} · {config.model} 发送 {segments.length} 段请求，可能产生费用。</span>}
        </div>

        {running && task ? <div className="translate-progress"><div className="production-progress-track"><i style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}/></div><p>{formatProgress(task.progress)}% · {task.stage === "translate" ? "正在翻译" : "正在准备字幕"}</p><TaskLiveness task={task}/></div> : null}
      </section>

      <section className="production-panel translate-target-panel">
        <header><div><span>目标轨</span><h2>每种语言的译文进度</h2></div><span>{segments.length} 段源字幕</span></header>
        {targets.map((target) => {
          const done = translatedCount(target.languageCode);
          return (
            <article key={target.id}>
              <div><strong>{target.languageLabel}</strong><p>{done} / {segments.length} 段有译文 · QA 必须项 {target.qaIssues.filter((issue) => issue.severity === "error").length}</p></div>
              <button type="button" className="btn btn-secondary" onClick={() => navigate(`/projects/${project.id}/editor/${encodeURIComponent(target.languageCode)}`)} disabled={!done}>去校对</button>
            </article>
          );
        })}
        {!targets.length ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>还没有目标轨</strong><p>选好目标语言并开始翻译后，后端会为每种语言建立真实目标轨。</p></div></div> : null}
      </section>
    </div>
  );
}
