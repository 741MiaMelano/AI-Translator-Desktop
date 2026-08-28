import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ASR_MODEL_IDS } from "../../shared/asr-model-ids.mjs";
import type { AnyProjectResourceSnapshot } from "../domain/resource-library";
import { getActiveSourceTrack, type Project } from "../domain/workspace";
import { localizeIpcErrorText } from "../i18n/errors";
import { desktopListProjectResourceSnapshots } from "../services/desktop-client";
import { OUTPUT_FORMAT_OPTIONS, SOURCE_LANGUAGE_OPTIONS, useWorkspace } from "../state/WorkspaceContext";
import { useFrontend } from "./state";
import { useProjectStage } from "./ProjectWorkspace";
import { Icon } from "./visuals";
import { formatUiDateTime } from "./format";

type ConfirmAction = "trash-project" | "empty-track-trash" | null;

function snapshotSource(snapshot: AnyProjectResourceSnapshot) {
  return snapshot.source.kind === "global"
    ? `全局资源 · revision ${snapshot.source.revision}`
    : "项目本地快照";
}

function resourceKindLabel(value: string) {
  return ({ glossary: "术语表", style_guide: "风格指南", subtitle_style: "字幕样式", export_preset: "导出预设" } as Record<string, string>)[value] ?? value;
}

function targetTrackStatus(value: string) {
  return ({ draft: "草稿", in_review: "校对中", approved: "已批准", exported: "已导出" } as Record<string, string>)[value] ?? value;
}

export function ProjectSettingsPage() {
  const { project } = useProjectStage();
  const projectId = project.id;
  const workspace = useWorkspace();
  const app = useFrontend();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Project["config"] | null>(structuredClone(project.config));
  const [snapshots, setSnapshots] = useState<AnyProjectResourceSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [includeTrash, setIncludeTrash] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  useEffect(() => {
    setDraft(structuredClone(project.config));
  }, [project.id]);

  const loadSnapshots = async () => {
    setSnapshotsLoading(true);
    const result = await desktopListProjectResourceSnapshots({ projectId });
    setSnapshotsLoading(false);
    if (!result.ok) return setMessage({ error: true, text: localizeIpcErrorText(result.error) });
    setSnapshots(result.data);
  };

  useEffect(() => { void loadSnapshots(); }, [projectId]);

  const trashedTrackCount = project.sourceTracks.reduce((count, source) => count + Number(Boolean(source.trashedAt)) + source.targetTracks.filter((target) => target.trashedAt).length, 0);

  if (!draft) return null;

  const updateDraft = (patch: Partial<Project["config"]>) => setDraft((current) => current ? { ...current, ...patch } : current);

  const saveConfig = () => {
    // 目标语言由翻译阶段直接写入，草稿里的那份可能已经过期，不能跟着这里回写。
    const { targetLanguages: _targetLanguages, provider: _provider, model: _model, glossary: _glossary, styleGuide: _styleGuide, ...patch } = draft;
    workspace.updateProjectConfig(project.id, patch);
    app.play("success");
    setMessage({ error: false, text: "项目方案已进入自动保存；若持久化失败，页面会保留修改并显示错误。" });
  };

  const run = async (id: string, operation: () => Promise<{ ok: boolean; message?: string; canceled?: boolean; fileName?: string }>, success: string) => {
    setBusy(id);
    setMessage(null);
    const result = await operation();
    setBusy(null);
    if (!result.ok) return setMessage({ error: true, text: result.message ?? "操作没有完成" });
    if (result.canceled) return setMessage({ error: false, text: "已取消；项目没有改变。" });
    app.play("success");
    setMessage({ error: false, text: result.fileName ? `${success}：${result.fileName}` : success });
  };

  const refreshSnapshot = async (snapshot: AnyProjectResourceSnapshot) => {
    if (snapshot.source.kind !== "global") return;
    setBusy(snapshot.id);
    const result = await workspace.refreshProjectResourceSnapshot(project.id, snapshot.source.resourceId);
    setBusy(null);
    if (!result.ok) return setMessage({ error: true, text: result.message ?? "资源快照没有刷新" });
    await loadSnapshots();
    setMessage({ error: false, text: `已从全局资源刷新“${snapshot.name}”；项目仍保存独立快照。` });
  };

  const trackAction = (result: { ok: boolean; message?: string }, success: string) => {
    if (!result.ok) setMessage({ error: true, text: result.message ?? "轨道操作失败" });
    else {
      setMessage({ error: false, text: success });
      app.play("click");
    }
  };

  const trashProject = async () => {
    setConfirmAction(null);
    setBusy("trash-project");
    const result = await workspace.trashProject(project.id);
    setBusy(null);
    if (!result.ok) return setMessage({ error: true, text: result.message ?? "项目没有移入回收站" });
    navigate("/workspace/recycle");
  };

  const emptyTrackTrash = () => {
    setConfirmAction(null);
    trackAction(workspace.emptyProjectTrackTrash(project.id), "轨道回收站已永久清空。");
  };

  const activeSource = getActiveSourceTrack(project);

  return (
    <div className="project-stage-body project-settings-page" data-fr03-view="project-settings">
      <header className="stage-header"><div><h2>项目设置与资产</h2><p>配置、快照、轨道和项目包都写入真实项目边界。</p></div><span className={`state-tag ${project.archivedAt ? "waiting" : "done"}`}>{project.archivedAt ? "已归档" : "活动项目"}</span></header>

      {workspace.saveError ? <div className="runtime-alert" role="alert"><Icon name="warning"/><div><strong>操作没有完成</strong><p>{workspace.saveError}</p></div></div> : message ? <div className={`runtime-alert ${message.error ? "" : "is-success"}`} role={message.error ? "alert" : "status"}><Icon name={message.error ? "warning" : "check"}/><div><strong>{message.error ? "操作没有完成" : "项目已更新"}</strong><p>{message.text}</p></div></div> : null}

      <div className="settings-layout project-settings-layout">
        {/* Provider / 模型 / 术语表 / 风格指南 / 目标语言都归翻译阶段所有，这里不再摆第二份。 */}
        <section className="production-panel settings-sheet"><header><div><span>项目方案</span><h2>项目默认值</h2></div><span className="state-tag waiting">自动保存项目</span></header><div className="settings-form-grid"><label><span>源语言</span><select value={draft.sourceLanguage} onChange={(event) => updateDraft({ sourceLanguage: event.target.value })}>{SOURCE_LANGUAGE_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></label><label><span>本地 ASR 模型</span><select value={draft.asrModelId ?? ""} onChange={(event) => updateDraft({ asrModelId: event.target.value ? event.target.value as Project["config"]["asrModelId"] : null })}><option value="">使用全局默认</option>{ASR_MODEL_IDS.map((value) => <option key={value}>{value}</option>)}</select></label><label><span>默认导出</span><select value={draft.outputFormat} onChange={(event) => updateDraft({ outputFormat: event.target.value })}>{OUTPUT_FORMAT_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></label></div><div className="settings-plan-elsewhere"><p>翻译方案（Provider、模型、术语表、风格指南、目标语言）在翻译阶段设置。</p><button type="button" className="text-button" onClick={() => navigate(`/projects/${project.id}/translate`)}>前往翻译阶段 <Icon name="chevron"/></button></div><div className="settings-checks"><label><input type="checkbox" checked={draft.copyMediaIntoProject} onChange={(event) => updateDraft({ copyMediaIntoProject: event.target.checked })}/>新关联媒体复制进项目容器</label><label><input type="checkbox" checked={draft.burnVideo} onChange={(event) => updateDraft({ burnVideo: event.target.checked })}/>默认交付包含烧录视频</label></div><footer><span>付费确认不可关闭；预算字段已由后端废弃。</span><button type="button" className="btn btn-primary" onClick={saveConfig} disabled={!workspace.isDesktop}>保存项目方案</button></footer></section>

        <aside className="production-panel project-asset-summary"><header><h2>资产摘要</h2><span>{project.sourceTracks.length} 条源轨</span></header><dl><div><dt>活动源轨</dt><dd>{activeSource?.label ?? "无"}</dd></div><div><dt>资源快照</dt><dd>{snapshotsLoading ? "读取中" : snapshots.length}</dd></div><div><dt>轨道回收站</dt><dd>{trashedTrackCount}</dd></div><div><dt>项目归档</dt><dd>{project.archivedAt ? formatUiDateTime(project.archivedAt) : "未归档"}</dd></div></dl><div className="project-asset-actions"><button type="button" className="btn btn-secondary" onClick={() => workspace.setProjectArchived(project.id, !project.archivedAt)}>{project.archivedAt ? "取消归档" : "归档项目"}</button><button type="button" className="btn btn-secondary danger-link" onClick={() => setConfirmAction("trash-project")} disabled={Boolean(busy)}>移入项目回收站</button></div></aside>
      </div>

      <section className="production-panel snapshot-panel"><header><div><span>项目资源快照</span><h2>项目资源快照</h2></div><button type="button" className="btn btn-secondary" onClick={() => void loadSnapshots()} disabled={snapshotsLoading}><Icon name="refresh"/>{snapshotsLoading ? "读取中" : "重新读取"}</button></header>{snapshots.map((snapshot) => <article key={snapshot.id}><span className="snapshot-kind">{resourceKindLabel(snapshot.kind)}</span><div><strong>{snapshot.name}</strong><p>{snapshotSource(snapshot)} · 捕获于 {formatUiDateTime(snapshot.capturedAt)}</p></div>{snapshot.source.kind === "global" ? <button type="button" className="btn btn-secondary" onClick={() => void refreshSnapshot(snapshot)} disabled={busy === snapshot.id}>{busy === snapshot.id ? "刷新中" : "从全局资源刷新"}</button> : <span className="state-tag waiting">本地不可变</span>}</article>)}{!snapshotsLoading && !snapshots.length ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>还没有资源快照</strong><p>开始翻译或选择项目资源后，后端会保存真实快照。</p></div></div> : null}</section>

      <section className="production-panel track-tree-panel"><header><div><span>轨道树</span><h2>源轨、目标轨与回收站</h2></div><span>{trashedTrackCount} 条已删除轨道</span></header>{project.sourceTracks.map((source) => <article className={`track-tree-source ${source.trashedAt ? "is-trashed" : ""}`} key={source.id}><div className="track-tree-heading"><span className={`track-lamp ${source.isActive ? "is-active" : ""}`}/><div><strong>{source.label}</strong><p>{source.kind} · {source.segments.length} 段 · {source.isActive ? "活动源轨" : "候选源轨"}{source.trashedAt ? ` · 已删除 ${formatUiDateTime(source.trashedAt)}` : ""}</p></div>{source.trashedAt ? <button type="button" className="btn btn-secondary" onClick={() => trackAction(workspace.restoreProjectSourceTrack(project.id, source.id), "源轨已恢复。")}>恢复源轨</button> : <button type="button" className="text-button danger-link" onClick={() => trackAction(workspace.trashProjectSourceTrack(project.id, source.id), "源轨已移入轨道回收站。")}>移入回收站</button>}</div><div className="track-tree-targets">{source.targetTracks.map((target) => <div className={target.trashedAt ? "is-trashed" : ""} key={target.id}><span>{target.role === "candidate" ? "候选" : "目标"}</span><strong>{target.languageLabel}</strong><em>{targetTrackStatus(target.status)}{target.trashedAt ? " · 已删除" : ""}</em>{target.trashedAt ? <button type="button" className="text-button" onClick={() => trackAction(workspace.restoreProjectTargetTrack(project.id, target.id), "目标轨已恢复。")}>恢复</button> : <button type="button" className="text-button danger-link" onClick={() => trackAction(workspace.trashProjectTargetTrack(project.id, target.id), "目标轨已移入轨道回收站。")}>删除</button>}</div>)}</div></article>)}{trashedTrackCount ? <footer><span>永久清空会删除已回收轨道及其级联内容。</span><button type="button" className="btn btn-secondary danger-link" onClick={() => setConfirmAction("empty-track-trash")}>永久清空轨道回收站</button></footer> : null}</section>

      <section className="production-panel package-panel"><header><div><span>项目包</span><h2>导出、项目包与备份入口</h2></div></header><div className="package-actions"><button type="button" className="btn btn-secondary" onClick={() => void run("raw-srt", () => workspace.exportSourceSubtitle(project.id, "raw", "srt"), "原始源字幕已导出")} disabled={Boolean(busy)}>导出原始 SRT</button><button type="button" className="btn btn-secondary" onClick={() => void run("normalized-vtt", () => workspace.exportSourceSubtitle(project.id, "normalized", "vtt"), "规范化 VTT 已导出")} disabled={Boolean(busy)}>导出规范化 VTT</button><button type="button" className="btn btn-secondary" onClick={() => void run("lightweight", () => workspace.createProjectPackage(project.id, "lightweight", includeTrash), "轻量项目包已创建")} disabled={Boolean(busy)}>{busy === "lightweight" ? "正在打包" : "创建轻量项目包"}</button><button type="button" className="btn btn-primary" onClick={() => void run("archive", () => workspace.createProjectPackage(project.id, "archive", includeTrash), "完整项目归档已创建")} disabled={Boolean(busy)}>{busy === "archive" ? "正在归档" : "创建完整项目归档"}</button></div><label className="package-trash-option"><input type="checkbox" checked={includeTrash} onChange={(event) => setIncludeTrash(event.target.checked)}/>项目包包含轨道回收站内容</label><p>应用级备份和恢复在系统设置中执行；当前后端不提供定时备份。</p></section>

      {confirmAction ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmAction(null); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="project-settings-confirm"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="project-settings-confirm">{confirmAction === "trash-project" ? "将项目移入回收站？" : "永久清空轨道回收站？"}</h2><p>{confirmAction === "trash-project" ? "运行中的任务会先停止；项目仍可从项目回收站恢复。" : "已回收的源轨、目标轨和级联内容会永久移除，无法撤销。"}</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmAction(null)}>取消</button><button type="button" className="btn btn-primary" onClick={() => void (confirmAction === "trash-project" ? trashProject() : emptyTrackTrash())}>确认</button></div></section></div> : null}
    </div>
  );
}
