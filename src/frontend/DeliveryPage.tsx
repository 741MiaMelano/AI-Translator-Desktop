import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SubtitleNormalizedFormat } from "../contracts/desktop-api";
import { getActiveSourceTrack, isActionableQaIssue } from "../domain/workspace";
import { useWorkspace } from "../state/WorkspaceContext";
import { useProjectStage } from "./ProjectWorkspace";
import { useFrontend } from "./state";
import { Icon } from "./visuals";

function targetStatusLabel(value: string) {
  return ({ draft: "草稿", in_review: "待校对", approved: "已批准", exported: "已导出" } as Record<string, string>)[value] ?? value;
}

// 这一栏原名有误：识别生成是机器动作，不应记在人工名下，所以改叫「来源」。
function sourceLabel(value: string) {
  return ({
    "explicitly approved": "人工明确批准",
    imported: "导入的字幕",
    extracted: "从媒体提取",
    translated: "模型翻译",
    asr_segmented: "本机识别",
    none: "尚未批准",
  } as Record<string, string>)[value] ?? (/[^\u0000-\u007f]/.test(value) ? value : "已记录操作");
}

export function DeliveryPage() {
  const { project } = useProjectStage();
  const workspace = useWorkspace();
  const app = useFrontend();
  const navigate = useNavigate();
  const source = getActiveSourceTrack(project);
  const targets = source?.targetTracks.filter((track) => track.isActive) ?? [];
  const [selectedLanguage, setSelectedLanguage] = useState(targets[0]?.languageCode ?? "");
  const [subtitleFormat, setSubtitleFormat] = useState<SubtitleNormalizedFormat>("srt");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const target = targets.find((track) => track.languageCode === selectedLanguage) ?? targets[0];
  const issues = (target?.qaIssues ?? []).filter(isActionableQaIssue);
  const hardErrors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const approved = target?.status === "approved" || target?.status === "exported";

  if (!source || !target) return <div className="project-stage-body"><div className="production-empty panel-empty"><span className="empty-seal">—</span><div><strong>还没有可交付的目标字幕</strong><p>先完成翻译并生成目标语言轨，交付选项才会出现。</p></div></div></div>;

  const editorRoute = `/projects/${project.id}/editor/${encodeURIComponent(target.languageCode)}`;
  const mediaUnavailable = project.noSourceMedia
    ? "纯字幕项目没有源视频"
    : project.mediaSource?.availability !== "available" ? "源媒体不可用，先重新关联媒体" : null;

  const approve = () => {
    const refreshed = workspace.refreshTargetTrackQa(project.id, target.languageCode);
    if (!refreshed.ok) return setMessage({ tone: "error", text: refreshed.message ?? "QA 刷新失败" });
    const result = workspace.markTargetTrackStatus(project.id, target.languageCode, "approved");
    if (!result.ok) return setMessage({ tone: "error", text: result.message ?? "批准失败" });
    app.play("success");
    setMessage({ tone: "status", text: `已批准 ${target.languageLabel}；现在可以选择真实导出位置。` });
  };

  const exportSubtitle = async () => {
    setBusy("subtitle");
    setMessage(null);
    const result = await workspace.exportTargetTrack(project.id, target.languageCode, subtitleFormat);
    setBusy(null);
    if (!result.ok) return setMessage({ tone: "error", text: result.message ?? "字幕导出失败" });
    if (result.canceled || result.summary?.canceled) return setMessage({ tone: "status", text: "已取消导出；项目和批准状态没有改变。" });
    const fileName = result.summary?.succeeded[0]?.fileName ?? "字幕文件";
    app.play("success");
    setMessage({ tone: "status", text: `已导出 ${fileName}` });
  };

  const exportVideo = async (mode: "soft_subtitle" | "burn_ass") => {
    setBusy(mode);
    setMessage(null);
    const result = await workspace.exportSubtitleVideo(project.id, target.languageCode, mode);
    setBusy(null);
    if (!result.ok) return setMessage({ tone: "error", text: result.message ?? "视频导出失败" });
    if (result.canceled) return setMessage({ tone: "status", text: "已取消视频导出；不会留下假完成状态。" });
    app.play("success");
    setMessage({ tone: "status", text: `已导出 ${result.fileName ?? "视频文件"}` });
  };

  const packProject = async () => {
    setBusy("package");
    setMessage(null);
    const result = await workspace.createProjectPackage(project.id, "lightweight", false);
    setBusy(null);
    if (!result.ok) return setMessage({ tone: "error", text: result.message ?? "项目包没有创建" });
    app.play("success");
    setMessage({ tone: "status", text: `已打包 ${result.fileName ?? "项目包"}` });
  };

  // 导出目的地在批准前就必须看得见：批准是不可逆的语义动作，不该在信息更少时做。
  const destinations = [
    {
      id: "subtitle",
      badge: subtitleFormat.toUpperCase(),
      label: "导出字幕文件",
      detail: "目标语言 · 保留时间码与人工修改",
      reason: approved ? null : "需先批准当前字幕轨",
      action: exportSubtitle,
    },
    {
      id: "burn_ass",
      badge: "MP4",
      label: "导出带字幕视频",
      detail: "把已批准字幕按当前样式烧录进画面",
      reason: mediaUnavailable ?? (approved ? null : "需先批准当前字幕轨"),
      action: () => exportVideo("burn_ass"),
    },
    {
      id: "soft_subtitle",
      badge: "MKV",
      label: "封装软字幕视频",
      detail: "字幕作为独立轨道封装，播放器可开关",
      reason: mediaUnavailable ?? (approved ? null : "需先批准当前字幕轨"),
      action: () => exportVideo("soft_subtitle"),
    },
    {
      id: "package",
      badge: "ZIP",
      label: "打包项目",
      detail: "字幕、配置与资源快照；不含媒体文件",
      reason: null,
      action: packProject,
    },
  ];

  return (
    <div className="project-stage-body deliver-page" data-fr02-view="deliver">
      <header className="stage-header"><div><h2>交付</h2><p>批准门槛来自真实 QA；导出只读取已批准字幕，不会再次调用模型。</p></div><label className="delivery-language"><span>目标语言</span><select value={target.languageCode} onChange={(event) => setSelectedLanguage(event.target.value)}>{targets.map((track) => <option key={track.id} value={track.languageCode}>{track.languageLabel} · {targetStatusLabel(track.status)}</option>)}</select></label></header>

      {message ? <div className={`runtime-alert delivery-message ${message.tone === "status" ? "is-success" : ""}`} role={message.tone === "error" ? "alert" : "status"}><Icon name={message.tone === "error" ? "warning" : "check"}/><div><strong>{message.tone === "error" ? "交付没有完成" : "交付状态已更新"}</strong><p>{message.text}</p></div></div> : null}

      <section className={`delivery-preflight production-delivery-preflight ${hardErrors.length ? "is-blocked" : "is-clear"}`}>
        <div><span className="preflight-seal"><Icon name={hardErrors.length ? "warning" : "check"}/></span><div><strong>{hardErrors.length ? "QA 门尚未通过" : "QA 门已通过"}</strong><p>{hardErrors.length ? `还有 ${hardErrors.length} 个必须修复的问题；不能批准或导出。` : `当前有 ${issues.length} 条真实 QA 标记，其中 ${warnings.length} 条为建议。`}</p></div></div>
        <dl>
          <div><dt>必须修复</dt><dd>{hardErrors.length}</dd></div>
          {/* "0 必须 + N 建议"时旧实现没有任何入口，建议数只能干看着。 */}
          <div><dt>建议</dt><dd>{warnings.length ? <button type="button" className="text-button" onClick={() => navigate(`${editorRoute}?filter=issues`)}>{warnings.length} 条 · 去看</button> : 0}</dd></div>
          <div><dt>目标轨状态</dt><dd>{targetStatusLabel(target.status)}</dd></div>
          <div><dt>来源</dt><dd>{sourceLabel(target.lastHumanAction || "none")}</dd></div>
        </dl>
        {hardErrors.length ? <div className="preflight-issues">{hardErrors.slice(0, 4).map((issue) => <button type="button" key={issue.id} onClick={() => navigate(`${editorRoute}?segmentId=${encodeURIComponent(issue.segmentId ?? "")}`)}><strong>{issue.label}</strong><span>{issue.detail}</span><Icon name="chevron"/></button>)}</div> : null}
        <div className="preflight-actions"><button type="button" className="btn btn-secondary" onClick={() => navigate(editorRoute)}>返回校对</button><button type="button" className="btn btn-secondary" onClick={() => navigate(`${editorRoute}?preview=1`)}>预览最终效果</button>{!approved ? <button type="button" className="btn btn-primary" onClick={approve} disabled={hardErrors.length > 0 || !workspace.isDesktop}>明确批准当前字幕轨</button> : <span className="state-tag done">已批准，可导出</span>}</div>
      </section>

      {/* 交付单是九套皮肤各自的签名元件（车票有戳、折页有折痕、中继有切角），
          所以常显只改它的状态，不换成一块普通面板。 */}
      <section className={`delivery-sheet ${approved ? "reveal-sheet" : "is-pending"}`}>
        <div className="delivery-seal"><Icon name={approved ? "check" : "file"}/><i/></div>
        <div className="delivery-copy">
          <span>{approved ? "字幕轨已批准" : "等待批准"}</span>
          <h2>{approved ? "最后选择一种真实交付方式" : "批准后你会得到这些"}</h2>
          <p>主进程将打开系统文件选择器；取消不会改变项目。</p>
          <label className="delivery-format"><span>字幕格式</span><select value={subtitleFormat} onChange={(event) => setSubtitleFormat(event.target.value as SubtitleNormalizedFormat)}><option value="srt">SRT</option><option value="vtt">VTT</option><option value="ass">ASS</option></select></label>
        </div>
        <div className="delivery-options">
          {destinations.map((destination) => (
            <button type="button" key={destination.id} onClick={() => void destination.action()} disabled={Boolean(busy) || Boolean(destination.reason)} title={destination.reason ?? undefined}>
              <span className="file-type">{destination.badge}</span>
              <span><strong>{busy === destination.id ? "正在导出" : destination.label}</strong><small>{destination.reason ?? destination.detail}</small></span>
              <Icon name="arrow"/>
            </button>
          ))}
        </div>
        <footer><span><Icon name={hardErrors.length ? "warning" : "check"}/> QA 必须项 {hardErrors.length}</span><span><Icon name="check"/> 人工修改已保护</span><span><Icon name={approved ? "check" : "warning"}/> {approved ? "目标字幕轨已批准" : "目标字幕轨未批准"}</span></footer>
      </section>
    </div>
  );
}
