import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AutomaticWorkflowAnswer } from "../domain/automatic-workflow";
import { analyzeSourceQuality, describeSourceQuality } from "../domain/source-quality";
import {
  countQaIssues,
  deriveProjectStatusSummary,
  getActiveSourceTrack,
  getActiveTargetTracks,
  getLatestProjectTask,
  getPrimaryTaskControl,
  type Project,
} from "../domain/workspace";
import { useWorkspace } from "../state/WorkspaceContext";
import { blockingCapabilities, capabilityReason, repairLabel, repairPath, WHEN_NEEDED } from "./capabilities";
import { useProjectStage } from "./ProjectWorkspace";
import { useFrontend } from "./state";
import { formatProgress } from "./format";
import { TaskLiveness } from "./TaskLiveness";
import { Icon } from "./visuals";

function effectiveTargetText(value: { manual?: string; postProcessed: string; model: string } | undefined) {
  return value?.manual ?? value?.postProcessed ?? value?.model ?? "";
}

function taskStatusLabel(status: string) {
  return ({
    pending: "排队中",
    running: "运行中",
    pausing: "正在暂停",
    paused: "已暂停",
    cancelling: "正在停止",
    cancelled: "已停止",
    failed: "失败",
    recoverable: "可恢复",
    completed: "已完成",
  } as Record<string, string>)[status] ?? status;
}

function stageLabel(stage: string) {
  return ({ media: "媒体处理", detect: "探测", extract: "提取字幕", asr: "语音识别", segment: "整理时间轴", translate: "翻译", qa: "QA", export: "导出" } as Record<string, string>)[stage] ?? stage;
}

function taskDetailLabel(detail: string) {
  return ({ Completed: "已完成", Running: "运行中", Queued: "已排队", Paused: "已暂停", Cancelled: "已取消", Failed: "失败" } as Record<string, string>)[detail] ?? detail;
}

function firstEditorRoute(project: Project) {
  const target = getActiveTargetTracks(project)[0];
  return target ? `/projects/${project.id}/editor/${encodeURIComponent(target.languageCode)}` : null;
}

export function ProjectPage() {
  const { project } = useProjectStage();
  const workspace = useWorkspace();
  const app = useFrontend();
  const navigate = useNavigate();
  const [confirmMode, setConfirmMode] = useState<"normal" | "unsafe" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const task = getLatestProjectTask(workspace.tasks, project.id);
  // 挡住这个项目下一步的能力。报了故障就必须能就地去修。
  const blocker = blockingCapabilities(app.readiness.data?.global.capabilities ?? [], workspace.projects)[0] ?? null;
  const workflow = workspace.automaticWorkflows[project.id];

  const source = getActiveSourceTrack(project);
  const targets = getActiveTargetTracks(project);
  const sourceQuality = useMemo(() => analyzeSourceQuality(source?.segments ?? []), [source]);

  const status = deriveProjectStatusSummary(project);
  const errors = countQaIssues(targets, "error");
  const warnings = countQaIssues(targets, "warning");
  const primaryControl = task ? getPrimaryTaskControl(task) : null;
  const editorRoute = firstEditorRoute(project);

  const mediaStreams = project.sourceProbeSummary?.media && Array.isArray(project.sourceProbeSummary.media.streams)
    ? project.sourceProbeSummary.media.streams as Array<{ kind?: string; extractable?: boolean }>
    : [];
  const hasAudioStream = mediaStreams.some((stream) => stream.kind === "audio");
  const hasExtractableSubtitle = mediaStreams.some((stream) => stream.kind === "subtitle" && stream.extractable);

  const runWorkflow = async (allowUnsafeSource = false, startTranslationNow = false) => {
    setConfirmMode(null);
    setActionBusy(true);
    setActionError(null);
    const pending = workspace.runAutomaticProjectWorkflow(project.id, {
      ...(allowUnsafeSource ? { allowUnsafeSource: true } : {}),
      ...(startTranslationNow ? { startTranslationNow: true } : {}),
    });
    setActionBusy(false);
    const result = await pending;
    // 失败常常意味着某个能力刚变得不可用（比如换成了没下载的模型）。能力状态只在
    // 启动时探测一次，所以这里主动重新探测，让能力门下一帧就能对上。
    if (result.status === "failed") void app.refresh();
    if (result.status === "failed") setActionError(result.message);
    else if (result.status === "blocked" && !result.resolution) setActionError(result.message);
    else app.play(result.status === "queued" ? "success" : "click");
  };

  const control = async (action: "pause" | "resume" | "cancel" | "retry") => {
    if (!task) return;
    setActionBusy(true);
    setActionError(null);
    const result = await workspace.controlTask({
      taskId: task.id,
      projectId: project.id,
      action,
      ...(["resume", "retry"].includes(action) ? { userConfirmed: true } : {}),
    });
    setActionBusy(false);
    if (!result.ok) setActionError(result.message ?? "任务控制失败");
    else app.play(action === "cancel" ? "warning" : "click");
  };

  const resolveWorkflow = async (value: string) => {
    if (!workflow?.resolution) return;
    const answer: AutomaticWorkflowAnswer = workflow.resolution.kind === "stream"
      ? { kind: "stream", streamKind: workflow.resolution.streamKind, value }
      : { kind: "language", sourceTrackId: workflow.resolution.sourceTrackId, value };
    setActionBusy(true);
    const resolved = await workspace.resolveAutomaticWorkflowBlock(project.id, answer);
    if (!resolved.ok) {
      setActionBusy(false);
      setActionError(resolved.message ?? "确认没有保存");
      return;
    }
    setActionBusy(false);
    await runWorkflow();
  };

  const mainAction = () => {
    if (primaryControl) return void control(primaryControl.action);
    if (workflow?.status === "running") return void workspace.cancelAutomaticProjectWorkflow(project.id).then((result) => {
      if (!result.ok) setActionError(result.message ?? "自动处理没有停止");
    });
    if (workflow?.status === "awaiting_translation") return void runWorkflow(false, true);
    if (workflow?.status === "blocked" && workflow.resolution) return;
    if (targets.some((target) => target.status === "approved" || target.status === "exported")) return navigate(`/projects/${project.id}/deliver`);
    if (editorRoute && (project.lifecycle === "needs_review" || targets.some((target) => target.status === "in_review"))) return navigate(editorRoute);
    if (sourceQuality) return navigate(editorRoute ?? `/projects/${project.id}`);
    setConfirmMode("normal");
  };

  const mainLabel = primaryControl?.label
    ?? (workflow?.status === "running" ? "停止自动处理"
      // 半自动项目停在花钱之前。主按钮位置和全自动完全一样，只是文案变成"开始翻译"，
      // 点这一下就是创建时那个开关承诺的"手动确认"，不另开框、不跳页。
      : workflow?.status === "awaiting_translation" ? "开始翻译"
      : workflow?.status === "blocked" && workflow.resolution ? "等待你的确认"
        : targets.some((target) => target.status === "approved" || target.status === "exported") ? "前往交付"
          : editorRoute && (project.lifecycle === "needs_review" || targets.some((target) => target.status === "in_review")) ? "进入字幕编辑与校对"
            : sourceQuality ? "检查源字幕" : workflow?.status === "failed" ? "确认重试" : "开始处理");
  const currentHint = sourceQuality
    ? describeSourceQuality(sourceQuality)
    : workflow?.message ?? status?.helperText ?? "这个项目当前没有待办；可以进入任一阶段继续。";

  return (
    <div className="project-stage-body cockpit-page" data-fr02-view="project">
      <section className={`next-action ${targets.some((target) => target.status === "approved" || target.status === "exported") ? "is-clear" : ""}`}>
        <span className="action-signal"><Icon name={sourceQuality || workflow?.status === "blocked" || task?.status === "failed" ? "warning" : task?.status === "completed" ? "check" : "arrow"}/></span>
        <div className="action-copy"><span>下一步</span><h2>{mainLabel}</h2><p>{currentHint}</p></div>
        <div className="action-stats"><span>源字幕<b>{source?.segments.length ?? 0}</b></span><span>QA 必须项<b>{errors}</b></span><span>运行任务<b>{task && ["pending", "running", "pausing", "paused", "cancelling", "recoverable"].includes(task.status) ? 1 : 0}</b></span></div>
        <button type="button" className="btn btn-primary" onClick={mainAction} disabled={actionBusy || !workspace.isDesktop || Boolean(workflow?.status === "blocked" && workflow.resolution)}>{actionBusy ? "正在处理" : mainLabel} <Icon name="arrow"/></button>
      </section>

      {blocker ? <section className="capability-gate" role="alert"><span><Icon name="warning"/></span><div><strong>{blocker.label}未就绪，这个项目的下一步会失败</strong><p>{capabilityReason(blocker.reason)} · {WHEN_NEEDED[blocker.id]}</p></div><button type="button" className="btn btn-primary" onClick={() => navigate(repairPath(blocker.repairAction))}>{repairLabel(blocker.repairAction) || "去处理"} <Icon name="arrow"/></button></section> : null}

      {sourceQuality ? <section className="source-quality-gate" role="alert"><span><Icon name="warning"/></span><div><strong>源质量门已阻止自动翻译</strong><p>{describeSourceQuality(sourceQuality)}</p></div><div><button type="button" className="btn btn-secondary" onClick={() => editorRoute && navigate(`${editorRoute}?mode=source&segmentId=${encodeURIComponent(sourceQuality.longestSegmentId)}`)} disabled={!editorRoute}>定位源字幕</button><button type="button" className="text-button" onClick={() => setConfirmMode("unsafe")}>明确仍使用原时间轴</button></div></section> : null}

      {workflow?.status === "blocked" && workflow.resolution ? <section className="workflow-resolution"><header><div><strong>{workflow.resolution.prompt}</strong><p>{workflow.message}</p></div><span className="state-tag danger">需要确认</span></header>{workflow.resolution.kind === "language" && workflow.resolution.samples.length ? <div className="language-samples">{workflow.resolution.samples.map((sample) => <q key={sample}>{sample}</q>)}</div> : null}<div>{workflow.resolution.choices.map((choice) => <button type="button" className={choice.recommended ? "btn btn-primary" : "btn btn-secondary"} key={choice.value} onClick={() => void resolveWorkflow(choice.value)} disabled={actionBusy}><strong>{choice.label}</strong>{choice.detail ? <span>{choice.detail}</span> : null}</button>)}</div></section> : null}

      {/* 出口优先取错误自带的（不依赖能力探测的新鲜度），没有再退回能力门推导出来的。 */}
      {actionError || workspace.saveError ? <div className="runtime-alert project-runtime-alert" role="alert"><Icon name="warning"/><div><strong>操作没有完成</strong><p>{actionError ?? workspace.saveError}</p></div>{workflow?.actionRoute && workflow.actionLabel
        ? <button type="button" className="btn btn-primary" onClick={() => navigate(workflow.actionRoute as string)}>{workflow.actionLabel} <Icon name="arrow"/></button>
        : blocker ? <button type="button" className="btn btn-secondary" onClick={() => navigate(repairPath(blocker.repairAction))}>{repairLabel(blocker.repairAction) || "去处理"}</button> : null}</div> : null}

      <div className="cockpit-grid production-cockpit-grid">
        <section className="progress-panel production-panel"><header><h2>任务与恢复</h2><span className={`state-tag ${task?.status === "failed" ? "danger" : task?.status === "completed" ? "done" : "waiting"}`}>{task ? taskStatusLabel(task.status) : "尚未运行"}</span></header>{task ? <><div className="progress-hero"><strong>{formatProgress(task.progress)}<small>%</small></strong><div><div className="production-progress-track"><i style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}/></div><p>{stageLabel(task.stage)} · {taskDetailLabel(task.detail)}</p><TaskLiveness task={task}/></div></div><dl><div><dt>任务类型</dt><dd>{stageLabel(task.kind ?? task.stage)}</dd></div><div className="pro-only"><dt>检查点</dt><dd>{task.checkpointStage ? stageLabel(task.checkpointStage) : "—"}</dd></div><div className="pro-only"><dt>重试次数</dt><dd>{task.attempt ?? 0}</dd></div></dl><div className="task-controls">{primaryControl ? <button type="button" className="btn btn-secondary" onClick={() => void control(primaryControl.action)} disabled={actionBusy}>{primaryControl.label}</button> : null}{["pending", "running", "pausing", "paused", "recoverable"].includes(task.status) && primaryControl?.action !== "cancel" ? <button type="button" className="text-button danger-link" onClick={() => void control("cancel")} disabled={actionBusy}>取消任务</button> : null}</div></> : <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>还没有运行过</strong><p>开始处理后，这里显示进度、失败原因和恢复入口。</p></div></div>}</section>

        <section className="subtitle-preview production-panel"><header><h2>字幕与目标轨</h2><span>{source?.segments.length ?? 0} 段 · {targets.length} 个目标</span></header>{(source?.segments ?? []).slice(0, 3).map((segment) => { const target = targets[0]; const text = target ? effectiveTargetText(segment.targetTexts[target.languageCode]) : ""; return <div className={`subtitle-line ${target?.qaIssues.some((issue) => issue.segmentId === segment.id && issue.severity === "error") ? "has-issue" : ""}`} key={segment.id}><time>{segment.start.slice(3, 8)}</time><p><span>{segment.sourceText.manual ?? segment.sourceText.normalized ?? segment.sourceText.original}</span><strong>{text || "尚无译文"}</strong></p><Icon name={text ? "check" : "file"}/></div>; })}{!source?.segments.length ? <div className="production-empty panel-empty"><span className="empty-seal">—</span><div><strong>还没有可翻译字幕</strong><p>自动流程会先检查内嵌字幕，再按需使用本机 ASR。</p></div></div> : null}{editorRoute ? <button type="button" className="inspector-link" onClick={() => navigate(editorRoute)}>打开字幕编辑与校对 <Icon name="chevron"/></button> : null}</section>

        <aside className="inspector-panel production-panel"><header><h2>项目检查器</h2><span className="state-tag waiting">本机</span></header><dl><div><dt>媒体</dt><dd>{project.mediaKind} · {project.mediaSource?.availability ?? (project.noSourceMedia ? "纯字幕" : "未探测")}</dd></div>{!project.noSourceMedia ? <><div><dt>音轨</dt><dd>{hasAudioStream ? "可提取音频、可转写" : "未检测到音轨"}</dd></div><div><dt>内嵌字幕</dt><dd>{hasExtractableSubtitle ? "有可提取的文本字幕流" : "未检测到"}</dd></div></> : null}<div><dt>Provider</dt><dd>{project.config.provider}</dd></div><div><dt>模型</dt><dd>{project.config.model}</dd></div><div><dt>QA 建议</dt><dd>{warnings}</dd></div><div><dt>资源</dt><dd>{project.config.glossary || "无术语表"}</dd></div></dl>{project.pendingConfirmations.length ? <div className="pending-confirmations"><strong>待确认</strong>{project.pendingConfirmations.map((item) => <p key={item}>{item}</p>)}</div> : <p className="safety-note">当前没有需要你确认的事。</p>}</aside>
      </div>

      {confirmMode ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmMode(null); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="start-confirm-title"><span className="dialog-seal"><Icon name={confirmMode === "unsafe" ? "warning" : "arrow"}/></span><div><h2 id="start-confirm-title">{confirmMode === "unsafe" ? "确认使用异常时间轴" : "确认开始真实处理"}</h2><p>{confirmMode === "unsafe" ? "源字幕结构异常仍会进入翻译与导出；这个确认只对本次运行有效，不会关闭质量门。" : `系统会先完成本机字幕准备，然后使用 ${project.config.provider} · ${project.config.model} 翻译为 ${project.config.targetLanguages.join("、")}。Provider 请求可能产生费用。`}</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmMode(null)}>返回检查</button><button type="button" className="btn btn-primary" onClick={() => void runWorkflow(confirmMode === "unsafe")}>{confirmMode === "unsafe" ? "确认并继续一次" : "确认并开始"}</button></div></section></div> : null}
    </div>
  );
}
