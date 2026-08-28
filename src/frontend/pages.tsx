import { useNavigate } from "react-router-dom";
import type { CapabilityReadinessItem } from "../contracts/desktop-api";
import { deriveProjectStatusSummary, getLatestProjectTask, type Project } from "../domain/workspace";
import { useWorkspace } from "../state/WorkspaceContext";
import { blockingCapabilities, capabilityReason, groupCapabilities, repairPath, WHEN_NEEDED } from "./capabilities";
import { useFrontend } from "./state";
import { Icon, ThemeIntakeVisual } from "./visuals";
import { formatProgress, formatUiDateTime } from "./format";

function mediaKindLabel(value: string) {
  return ({ video: "视频", audio: "音频", subtitle: "字幕" } as Record<string, string>)[value] ?? value;
}

function lifecycleLabel(value: string) {
  return ({ draft: "草稿", ready: "待处理", processing: "处理中", needs_review: "待校对", completed: "已完成" } as Record<string, string>)[value] ?? value;
}

function lifecycleTone(value: string) {
  if (value === "completed") return "done";
  if (value === "processing") return "running";
  if (value === "needs_review") return "danger";
  return "waiting";
}

function ProjectRow({ project, index, summary, onOpen, busy }: {
  project: Project;
  index: number;
  summary: string;
  onOpen: () => void;
  busy: boolean;
}) {
  return (
    <button type="button" className="project-row" onClick={onOpen} disabled={busy} aria-label={`打开项目 ${project.title}`}>
      <span className="row-order">{String(index + 1).padStart(2, "0")}</span>
      <span className="row-title"><strong>{project.title}</strong><em>{project.sourceFileName || "未记录源文件"}</em></span>
      <span className={`state-tag ${lifecycleTone(project.lifecycle)}`}>{lifecycleLabel(project.lifecycle)}</span>
      <span className="row-progress production-run-summary"><em>{summary}</em></span>
      <span className="row-updated">{formatUiDateTime(project.updatedAt)}</span><Icon name="chevron"/>
    </button>
  );
}

export function WorkbenchPage() {
  const app = useFrontend();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  // 主页此前读 app.projects（挂载时拉一次的索引缓存），项目页读 workspace.projects，
  // 两份不同源：在项目页删掉项目后主页还在显示，点进去才报"找不到这个项目"。
  // 现在统一读活列表，只保留一个事实来源。
  const projects = [...workspace.projects]
    .filter((project) => !project.trashedAt && !project.archivedAt)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const latest = projects[0] ?? null;
  const recent = projects.slice(1, 5);
  const loading = workspace.loadState === "loading";
  const loadError = workspace.loadError;
  // 索引里的 latestRunSummary 是服务端拼好的；活数据里用项目自己的状态派生代替，
  // 与项目页共用同一个函数，保证两处口径一致。
  const runSummary = (project: Project) => {
    const task = getLatestProjectTask(workspace.tasks, project.id);
    const status = deriveProjectStatusSummary(project);
    if (task) return `${status?.label ?? lifecycleLabel(project.lifecycle)} · ${formatProgress(task.progress)}%`;
    return status?.helperText ?? mediaKindLabel(project.mediaKind);
  };
  const capabilities = app.readiness.data?.global.capabilities ?? [];
  const blocking = blockingCapabilities(capabilities, workspace.projects);

  const open = async (projectId: string) => {
    app.play("click");
    if (await app.openProject(projectId)) navigate(`/projects/${projectId}`);
  };

  return (
    <div className="page-stage workbench-page" data-fr01-view="workbench">
      <header className="page-header">
        <div><h1>今天想翻译什么？</h1><p>选择本机视频、音频或字幕；探测、歧义确认和项目创建都走真实桌面服务。</p></div>
        <button type="button" className="btn btn-secondary" onClick={() => void app.refresh()} disabled={loading}>
          <Icon name="refresh"/>{loading ? "正在读取" : "重新读取"}
        </button>
      </header>

      <section className="start-layout">
        <article className="import-panel" aria-labelledby="import-heading">
          <ThemeIntakeVisual theme={app.theme}/>
          <div className="import-copy">
            <h2 id="import-heading">开始一次新的翻译</h2>
            <p>支持视频、音频或字幕；先在本机探测并确认翻译方案，创建项目时不会调用 Provider。</p>
            <button type="button" className="btn btn-primary" onClick={() => { app.play("navigate"); navigate("/import"); }}>
              <Icon name="upload"/>选择文件
            </button>
            <span>真实统一导入 · 支持拖放、编码确认与重复导入处理</span>
          </div>
        </article>

        <article className="continue-panel">
          <header>
            <div><h2>继续本机项目</h2><p>{loading ? "正在读取本地项目" : "项目内容来自本机数据库"}</p></div>
            {latest ? <span className={`state-tag ${lifecycleTone(latest.lifecycle)}`}>{lifecycleLabel(latest.lifecycle)}</span> : null}
          </header>
          {latest ? (
            <>
              <button type="button" className="continue-project" onClick={() => void open(latest.id)} disabled={app.openingProjectId === latest.id}>
                <span className="project-thumb production-project-thumb" aria-hidden="true"><Icon name="file"/><b>{mediaKindLabel(latest.mediaKind)}</b></span>
                <span className="continue-copy"><strong>{latest.title}</strong><em>{latest.sourceFileName || "未记录源文件"} · {lifecycleLabel(latest.lifecycle)}</em><span className="production-ledger-line"/></span>
                <span className="continue-arrow"><Icon name="arrow"/></span>
              </button>
              <div className="next-note"><span className="note-mark"><Icon name="file"/></span><p><strong>{runSummary(latest)}</strong><span>更新时间：{formatUiDateTime(latest.updatedAt)}</span></p></div>
            </>
          ) : (
            <div className="production-empty continue-empty" role={loadError ? "alert" : "status"}>
              <span className="empty-seal" aria-hidden="true">00</span>
              <div><strong>{loadError ? "无法读取本机项目" : loading ? "正在读取项目" : "本机还没有项目"}</strong><p>{loadError ?? (loading ? "完成后会在这里显示真实项目。" : "选择文件即可创建第一个本机项目。")}</p></div>
            </div>
          )}
        </article>
      </section>

      <section className="status-strip" aria-label="环境状态">
        <div className="status-label"><span className="live-pulse"/><strong>{app.readiness.loading ? "正在检测" : app.readiness.error ? "检测失败" : "后端实时状态"}</strong></div>
        {/* 只报会挡住你的事。四项平权列出来只会让纯字幕用户盯着一个与他无关的红点。 */}
        {app.readiness.error ? <span className="is-unavailable"><i/>{app.readiness.error}</span> : blocking.length ? blocking.map((capability) => (
          <span key={capability.id} className="is-unavailable"><i/>{capability.label}：{capabilityReason(capability.reason)}</span>
        )) : capabilities.length ? <span className="is-available"><i/>本机能力满足当前项目</span> : null}
        {!app.readiness.error && capabilities.length === 0 ? <span><i/>{app.readiness.loading ? "读取本地能力…" : "没有返回能力状态"}</span> : null}
        <button type="button" onClick={() => navigate("/system")}>查看状态 <Icon name="chevron"/></button>
      </section>

      <section className="recent-section">
        <header><h2>最近项目</h2><span className="production-section-meta">{projects.length} 个本机项目</span></header>
        {recent.length > 0 ? (
          <div className="project-list compact-list">
            {recent.map((project, index) => <ProjectRow key={project.id} project={project} index={index} summary={runSummary(project)} onOpen={() => void open(project.id)} busy={app.openingProjectId === project.id}/>)}
          </div>
        ) : (
          <div className="production-empty recent-empty"><span className="empty-seal" aria-hidden="true">—</span><div><strong>没有更多最近项目</strong><p>新项目完成导入后会显示在这里。</p></div></div>
        )}
      </section>
    </div>
  );
}

// 维护组收纳当前几乎不可达的后端能力：它们都真实存在，只是此前没有稳定入口。
const MAINTENANCE: Array<{ code: string; label: string; detail: string; path: string }> = [
  { code: "API", label: "翻译 Provider 与凭据", detail: "连接、测试、模型清单与系统安全凭据", path: "/system/providers" },
  { code: "ASR", label: "识别模型与运行时", detail: "安装、导入、校验与设备检测", path: "/system/asr" },
  // 存储迁移、下载源探测、备份诊断原本是三行并列入口，兑现的却是同一页的三个分页——
  // 三个承诺一扇门。合成一条，说明里把里面有什么列清楚，免得入口合并把功能也藏没了。
  { code: "SET", label: "设置与能力中心", detail: "模型存储位置迁移、下载源探测、备份恢复与脱敏诊断包", path: "/system/settings" },
  { code: "JOB", label: "全局任务账本", detail: "跨项目的运行、失败与恢复记录", path: "/workspace/tasks" },
];

function CapabilityRow({ capability, onRepair }: { capability: CapabilityReadinessItem; onRepair: () => void }) {
  // 每项不可用的能力都必须有一句"什么时候需要它"，外加一个真能到达修复位置的按钮。
  // 说明文字一律走 <em>：第 4 列只有 14px，是留给 chevron 的，塞文字会压到隔壁卡片上。
  const detail = !capability.available
    ? `${capabilityReason(capability.reason)} · ${WHEN_NEEDED[capability.id]}`
    : capability.repairAction ? WHEN_NEEDED[capability.id] : "本机始终可用";
  return (
    <button type="button" onClick={onRepair} disabled={!capability.repairAction} title={detail}>
      <span className="system-glyph">{capability.label.slice(0, 1)}</span>
      <span>
        <strong>{capability.label}</strong>
        <em>{detail}</em>
      </span>
      <i className={capability.available ? "" : "is-unavailable"}/>
      {/* 没有修复目的地就不画 chevron。这里也不能塞占位 <i>：`.system-status button > i`
          是状态圆点的选择器，会变成第二个绿点。空着这条 14px 轨道即可。 */}
      {capability.repairAction ? <Icon name="chevron"/> : null}
    </button>
  );
}

export function SystemPage() {
  const app = useFrontend();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const capabilities = app.readiness.data?.global.capabilities ?? [];
  const { now, onDemand } = groupCapabilities(capabilities, workspace.projects);

  return (
    <div className="page-stage system-page secondary-page" data-fr01-view="system">
      <header className="page-header"><div><h1>系统</h1><p>先告诉你现在能不能用；所有状态都来自桌面后端的实时检测。</p></div><div className="page-actions"><button type="button" className="btn btn-secondary" onClick={() => navigate("/system/settings")}>设置、备份与诊断</button><button type="button" className="btn btn-secondary" onClick={() => void app.refresh()} disabled={app.readiness.loading}><Icon name="refresh"/>{app.readiness.loading ? "检测中" : "重新检测"}</button></div></header>
      {app.readiness.error ? <div className="runtime-alert" role="alert"><Icon name="warning"/><div><strong>无法读取本地能力状态</strong><p>{app.readiness.error}</p></div></div> : null}

      {/* 能力只渲染一次。旧实现渲染两遍，第二遍还是不可点的只读行。 */}
      <section className="capability-tier" aria-label="现在需要">
        <header><h2>现在需要</h2><span>挡住当前项目下一步的能力</span></header>
        <div className="system-status is-tier">
          {now.map((capability) => <CapabilityRow key={capability.id} capability={capability} onRepair={() => navigate(repairPath(capability.repairAction))}/>)}
          {!now.length ? <div className="production-system-empty"><strong>{app.readiness.loading ? "正在读取本地组件" : "没有能力状态"}</strong><span>桌面服务尚未返回可显示的能力项目。</span></div> : null}
        </div>
      </section>

      <section className="capability-tier" aria-label="按需启用">
        <header><h2>按需启用</h2><span>用到了才需要，没就绪不是故障</span></header>
        <div className="system-status is-tier">
          {onDemand.map((capability) => <CapabilityRow key={capability.id} capability={capability} onRepair={() => navigate(repairPath(capability.repairAction))}/>)}
        </div>
      </section>

      <section className="capability-tier" aria-label="维护">
        <header><h2>维护</h2><span>这些后端能力此前几乎没有入口</span></header>
        <div className="settings-list production-settings-list">
          {MAINTENANCE.map((entry) => (
            <button type="button" key={entry.path} onClick={() => navigate(entry.path)}>
              <div><strong>{entry.label}</strong><p>{entry.detail}</p></div>
              <span>{entry.code}</span>
              <Icon name="chevron"/>
            </button>
          ))}
        </div>
      </section>

      {/* 后端没有应用更新器，这里就不摆一个点了没反应的更新按钮——照实说版本从哪儿看。 */}
      <section className="app-version-strip">
        <div><strong>AI Translator Desktop</strong><p>当前后端不提供应用内更新器；版本、平台与架构记录在脱敏诊断 manifest 里。</p></div>
        <button type="button" className="btn btn-secondary" onClick={() => navigate("/system/settings?tab=about")}>关于与许可</button>
        <button type="button" className="btn btn-secondary" onClick={() => navigate("/system/settings?tab=backup")}>生成诊断包</button>
      </section>
    </div>
  );
}
