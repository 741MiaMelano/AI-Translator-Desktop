import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AppSettings, CapabilityReadinessItem } from "../contracts/desktop-api";
import { useSettingsController } from "../controllers/settings-controller";
import type { Project } from "../domain/workspace";
import { useWorkspace } from "../state/WorkspaceContext";
import { formatUiDateTime } from "./format";
import { useFrontend } from "./state";
import { THEMES } from "./theme";
import { Icon, ThemeBrandMark } from "./visuals";

type SettingsTab = "general" | "appearance" | "storage" | "network" | "environment" | "backup" | "about";
type ConfirmAction = "reset" | "transfer" | "probe" | null;

const tabs: Array<{ id: SettingsTab; label: string; code: string }> = [
  { id: "general", label: "通用", code: "GEN" },
  { id: "appearance", label: "外观与声音", code: "LOOK" },
  { id: "storage", label: "文件与模型", code: "IO" },
  { id: "network", label: "下载与凭据", code: "NET" },
  { id: "environment", label: "环境能力", code: "ENV" },
  { id: "backup", label: "备份与诊断", code: "SAFE" },
  { id: "about", label: "关于", code: "INFO" },
];

function friendlyReason(value: string | null | undefined) {
  if (!value) return "后端没有提供更多原因";
  return ({
    provider_not_configured: "翻译 Provider 尚未配置",
    model_not_installed: "ASR 模型尚未安装",
    runtime_not_ready: "ASR 运行时尚未就绪",
  } as Record<string, string>)[value] ?? value;
}

function sourceLabel(value: string) {
  return ({ official: "官方源", mirror: "镜像源", custom: "自定义 HTTPS" } as Record<string, string>)[value] ?? value;
}

function downloadStatus(value: string) {
  return ({ active: "进行中", paused: "已暂停", failed: "失败", ready: "完成" } as Record<string, string>)[value] ?? value;
}

function stageLabel(value: string) {
  return ({ download: "下载", verify: "校验", extract: "解压", publish: "安装", python: "配置 Python", packages: "安装依赖" } as Record<string, string>)[value] ?? value;
}

function capabilityRepairPath(action: CapabilityReadinessItem["repairAction"], project: Project | null) {
  if (action === "open_provider") return "/system/providers";
  if (action === "open_model_manager") return "/system/asr";
  if (action === "open_environment") return "/system/settings";
  if (action === "open_projects") return "/workspace";
  if (!project) return "/workspace";
  if (action === "open_project_settings") return `/projects/${project.id}/settings`;
  if (action === "relink_media") return `/projects/${project.id}/media`;
  if (action === "open_editor") {
    const target = project.sourceTracks.find((track) => track.isActive)?.targetTracks.find((track) => track.isActive);
    return target ? `/projects/${project.id}/editor/${target.languageCode}` : `/projects/${project.id}`;
  }
  return `/projects/${project.id}`;
}

export function SystemSettingsPage() {
  const workspace = useWorkspace();
  const app = useFrontend();
  const navigate = useNavigate();
  const controller = useSettingsController(workspace.projects);
  // 命令面板要能直接落到某一张卡片上，否则"导出诊断包"只能指到设置页门口。
  const [tab, setTab] = useState<SettingsTab>(() => {
    const requested = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("tab");
    return tabs.some((item) => item.id === requested) ? requested as SettingsTab : "general";
  });
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const activeProjects = workspace.projects.filter((project) => !project.trashedAt);
  const readinessProject = activeProjects.find((project) => project.id === controller.readinessProjectId) ?? null;
  const settings = controller.settings;

  const executeConfirmation = () => {
    const action = confirmAction;
    setConfirmAction(null);
    if (action === "reset") void controller.reset();
    if (action === "transfer") controller.transferModels();
    if (action === "probe") void controller.probe();
  };

  const confirmationCopy = confirmAction === "reset"
    ? { title: "恢复默认系统设置？", text: "缓存目录、模型目录、备份目录、下载源和通知偏好会立即恢复后端默认值。此操作无法撤销，不影响界面皮肤。", label: "确认恢复默认" }
    : confirmAction === "transfer"
      ? { title: "转移全部模型与运行时？", text: `将复制到 ${controller.modelTransferDestination || "所选空目录"}，逐项校验成功后才切换路径并重启；失败时旧目录保持不变。`, label: "确认并开始转移" }
      : { title: "联网探测下载源？", text: "将联系已配置的官方、镜像或自定义模型下载源以测量可用性和延迟；不会开始下载，但会产生真实网络请求。", label: "确认并探测" };

  const repair = (item: CapabilityReadinessItem) => navigate(capabilityRepairPath(item.repairAction, readinessProject));

  return (
    <div className="page-stage system-settings-page secondary-page" data-fr03-view="system-settings">
      <header className="page-header"><div><button type="button" className="back-button" onClick={() => navigate("/system")}><Icon name="arrow"/> 返回系统</button><h1>设置与能力中心</h1><p>设置、路径、备份与诊断均由桌面后端读取和校验；不可用项保留真实原因。</p></div><span className={`state-tag ${controller.dirty ? "waiting" : "done"}`}>{controller.dirty ? "有未保存修改" : "设置已同步"}</span></header>

      <div className={`runtime-alert settings-message is-${controller.message.tone}`} role={controller.message.tone === "error" ? "alert" : "status"}><Icon name={controller.message.tone === "error" ? "warning" : controller.message.tone === "success" ? "check" : "file"}/><div><strong>{controller.message.tone === "error" ? "系统操作没有完成" : controller.message.tone === "success" ? "系统操作已完成" : "真实系统状态"}</strong><p>{controller.message.text}</p></div></div>

      <div className="settings-tabs" role="tablist" aria-label="设置分类">{tabs.map((item) => <button type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : ""} key={item.id} onClick={() => setTab(item.id)}><span>{item.code}</span><strong>{item.label}</strong></button>)}</div>

      {tab === "general" ? <GeneralSettings settings={settings} update={controller.updateSettings} onOpenProvider={() => navigate("/system/providers")} onOpenAsr={() => navigate("/system/asr")}/> : null}
      {tab === "appearance" ? <AppearanceSettings app={app}/> : null}
      {tab === "storage" ? <StorageSettings controller={controller} onTransfer={() => setConfirmAction("transfer")}/> : null}
      {tab === "network" ? <NetworkSettings controller={controller} onProbe={() => setConfirmAction("probe")} onOpenProvider={() => navigate("/system/providers")}/> : null}
      {tab === "environment" ? <EnvironmentSettings controller={controller} projects={activeProjects} onRepair={repair} onProbe={() => setConfirmAction("probe")} onTasks={() => navigate("/workspace/tasks")}/> : null}
      {tab === "backup" ? <BackupSettings controller={controller} projects={activeProjects}/> : null}
      {tab === "about" ? <AboutSettings onDiagnostics={() => setTab("backup")} desktop={workspace.isDesktop}/> : null}

      {(["general", "storage", "network"] as SettingsTab[]).includes(tab) ? <div className="settings-save-bar"><span>{controller.dirty ? "修改还只在当前界面，尚未写入磁盘。" : "当前界面与后端设置一致。"}</span><div><button type="button" className="btn btn-secondary" onClick={() => setConfirmAction("reset")} disabled={controller.busy || !settings || !workspace.isDesktop}>恢复默认设置</button><button type="button" className="btn btn-primary" onClick={() => void controller.save()} disabled={controller.busy || !settings || !controller.dirty || !workspace.isDesktop}>保存设置</button></div></div> : null}

      {confirmAction ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmAction(null); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="settings-confirm-title">{confirmationCopy.title}</h2><p>{confirmationCopy.text}</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmAction(null)}>取消</button><button type="button" className="btn btn-primary" onClick={executeConfirmation}>{confirmationCopy.label}</button></div></section></div> : null}
      {controller.pendingRestore ? <div className="production-dialog-backdrop" role="presentation"><section className="production-dialog settings-restore-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-confirm-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="restore-confirm-title">确认恢复 {controller.pendingRestore.fileName}？</h2><p>{controller.pendingRestore.kind === "app" ? "应用设置与全局资源将按备份内容恢复；完成后需重启应用。" : "项目包会先通过迁移与结构校验，再写入本机项目库；冲突项目按后端保护策略处理。"}</p>{controller.pendingRestore.summary ? <pre className="restore-summary">{JSON.stringify(controller.pendingRestore.summary, null, 2)}</pre> : null}</div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={controller.cancelRestore}>取消</button><button type="button" className="btn btn-primary" onClick={() => void controller.applyRestore()} disabled={controller.busy}>确认并恢复</button></div></section></div> : null}
    </div>
  );
}

type SettingsController = ReturnType<typeof useSettingsController>;

function AppearanceSettings({ app }: { app: ReturnType<typeof useFrontend> }) {
  return (
    <div className="settings-content-grid appearance-settings-grid">
      <section className="production-panel settings-card settings-card-wide appearance-theme-card">
        <header><div><span>视觉皮肤</span><h2>九套视觉皮肤</h2></div><span>{THEMES.find((theme) => theme.id === app.theme)?.name}</span></header>
        <div className="appearance-theme-grid" role="radiogroup" aria-label="视觉皮肤">
          {THEMES.map((theme) => (
            <button type="button" role="radio" aria-checked={app.theme === theme.id} className={app.theme === theme.id ? "is-current" : ""} key={theme.id} onClick={() => app.setTheme(theme.id)}>
              <span className="appearance-theme-mark"><ThemeBrandMark theme={theme.id}/></span>
              <span><strong>{theme.code} · {theme.name}</strong><small>{theme.caption}</small></span>
              <span className={`theme-swatch swatch-${theme.id}`} aria-hidden="true"><i/></span>
            </button>
          ))}
        </div>
      </section>
      <section className="production-panel settings-card appearance-behavior-card">
        <header><div><span>本机反馈</span><h2>声音与动态</h2></div></header>
        <button type="button" className="setting-toggle" role="switch" aria-checked={app.soundEnabled} onClick={app.toggleSound}><span><strong>操作音效</strong><small>默认静音；开启后使用当前皮肤的本地 Web Audio 配方。</small></span><i className={app.soundEnabled ? "is-on" : ""}><b/></i></button>
        <button type="button" className="setting-toggle" role="switch" aria-checked={app.effectsEnabled} onClick={app.toggleEffects}><span><strong>签名视觉动效</strong><small>关闭后保留材质与签名图形，只暂停装饰动画。</small></span><i className={app.effectsEnabled ? "is-on" : ""}><b/></i></button>
        <button type="button" className="setting-toggle" role="switch" aria-checked={app.reducedMotionForced} onClick={app.toggleReducedMotion}><span><strong>减少动态</strong><small>{app.reducedMotion && !app.reducedMotionForced ? "Windows 系统偏好优先级更高，当前正在生效。" : "可主动启用；Windows 系统偏好始终优先。"}</small></span><i className={app.reducedMotion ? "is-on" : ""}><b/></i></button>
      </section>
      <section className="production-panel settings-card appearance-contract-card">
        <header><div><span>项目库</span><h2>切换边界</h2></div></header>
        <p>皮肤只改变 Token、字体、材质、轮廓、签名图形、动效、滚动条、选区和声音配方；不会重载页面或重建项目、字幕与任务状态。</p>
        <dl><div><dt>当前签名</dt><dd>{THEMES.find((theme) => theme.id === app.theme)?.signature}</dd></div><div><dt>声音状态</dt><dd>{app.soundEnabled ? "当前皮肤配方已启用" : "静音（默认）"}</dd></div><div><dt>有效动态</dt><dd>{app.effectsActive ? "标准" : app.reducedMotion ? "减少动态" : "视觉动效关闭"}</dd></div></dl>
      </section>
    </div>
  );
}

function GeneralSettings({ settings, update, onOpenProvider, onOpenAsr }: { settings: AppSettings | null; update: (change: Partial<AppSettings>) => void; onOpenProvider: () => void; onOpenAsr: () => void }) {
  return <div className="settings-content-grid"><section className="production-panel settings-card"><header><div><span>启动</span><h2>启动与默认能力</h2></div></header><div className="settings-control-list"><label><span><strong>启动页面</strong><small>下次打开应用时进入的位置</small></span><select value={settings?.startupPage ?? "resume"} onChange={(event) => update({ startupPage: event.target.value as AppSettings["startupPage"] })} disabled={!settings}><option value="resume">继续上次项目</option><option value="start">工作台</option><option value="projects">项目与任务</option></select></label><div className="settings-link-row"><span><strong>翻译 Provider</strong><small>{settings?.translationProvider && settings.translationModel ? `${settings.translationProvider} · ${settings.translationModel}` : "尚未配置"}</small></span><button type="button" className="btn btn-secondary" onClick={onOpenProvider}>管理 Provider</button></div><div className="settings-link-row"><span><strong>默认 ASR 模型</strong><small>{settings?.asrDefaultModelId ?? "读取中"}</small></span><button type="button" className="btn btn-secondary" onClick={onOpenAsr}>管理本机 ASR</button></div></div></section><section className="production-panel settings-card"><header><div><span>提醒</span><h2>通知</h2></div></header><div className="notification-grid">{([['taskDone','任务完成'],['error','错误'],['release','新版本'],['system','系统状态']] as const).map(([key, label]) => <label key={key}><span><strong>{label}</strong><small>{key === "release" ? "只保存偏好；当前后端没有更新器按钮。" : "由真实桌面事件触发。"}</small></span><input type="checkbox" checked={settings?.notifications[key] ?? false} onChange={(event) => settings && update({ notifications: { ...settings.notifications, [key]: event.target.checked } })} disabled={!settings}/></label>)}</div></section></div>;
}

function StorageSettings({ controller, onTransfer }: { controller: SettingsController; onTransfer: () => void }) {
  const settings = controller.settings;
  const activeDownload = controller.downloads.items.some((item) => item.status === "active");
  const transferReady = Boolean(controller.modelTransferDestination) && !controller.busy && !controller.dirty && !activeDownload;
  return (
    <div className="settings-content-grid storage-settings-grid">
      <section className="production-panel settings-card settings-card-wide">
        <header><div><span>应用存储</span><h2>缓存与备份目录</h2></div><span>保存后下次启动生效</span></header>
        <div className="path-settings-list">{([['cachePath','缓存目录'],['backupPath','备份目录']] as const).map(([key, label]) => <label key={key}><span><strong>{label}</strong><small>绝对路径由主进程的目录选择器返回</small></span><input value={settings?.[key] ?? ""} readOnly/><button type="button" className="btn btn-secondary" onClick={() => void controller.selectDirectory(key)} disabled={!settings || controller.busy}>选择目录</button></label>)}</div>
      </section>
      <section className="production-panel settings-card settings-card-wide">
        <header><div><span>校验后迁移</span><h2>模型与运行时迁移</h2></div><span className={`state-tag ${controller.modelTransferProgress?.stage === "failed" ? "danger" : controller.modelTransferProgress?.stage === "completed" ? "done" : "waiting"}`}>{controller.modelTransferProgress ? controller.modelTransferProgress.stage : "未开始"}</span></header>
        <div className="model-transfer-paths"><label><span>当前受管路径</span><input value={settings?.modelPath ?? ""} readOnly/></label><span className="transfer-arrow">→</span><label><span>目标空目录</span><input value={controller.modelTransferDestination || "尚未选择"} readOnly/></label></div>
        {controller.modelTransferProgress ? <div className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={controller.modelTransferProgress.progress}><div><span>{controller.modelTransferProgress.message}</span><strong>{controller.modelTransferProgress.progress}%</strong></div><i><b style={{ width: `${Math.max(0, Math.min(100, controller.modelTransferProgress.progress))}%` }}/></i></div> : null}
        <div className="settings-card-actions"><p>复制、校验、切换全部成功后才清理旧目录；进行中的下载会阻止迁移。</p><button type="button" className="btn btn-secondary" onClick={() => void controller.selectModelTransferDestination()} disabled={!settings || controller.busy || controller.dirty}>选择目标目录</button><button type="button" className="btn btn-primary" onClick={onTransfer} disabled={!transferReady} title={activeDownload ? "先暂停或完成当前下载" : controller.dirty ? "先保存当前设置" : controller.modelTransferDestination ? undefined : "先选择目标空目录"}>转移现有模型</button></div>
      </section>
    </div>
  );
}

function NetworkSettings({ controller, onProbe, onOpenProvider }: { controller: SettingsController; onProbe: () => void; onOpenProvider: () => void }) {
  const settings = controller.settings;
  return <div className="settings-content-grid"><section className="production-panel settings-card"><header><div><span>下载源</span><h2>模型下载源</h2></div><button type="button" className="btn btn-secondary" onClick={onProbe} disabled={controller.busy}>联网探测</button></header><div className="settings-control-list"><label><span><strong>首选下载源</strong><small>自动下载时由后端应用</small></span><select value={settings?.downloadSource ?? "official"} onChange={(event) => controller.updateSettings({ downloadSource: event.target.value as AppSettings["downloadSource"] })} disabled={!settings}><option value="official">官方源</option><option value="mirror">镜像源</option><option value="custom">自定义 HTTPS</option></select></label>{settings?.downloadSource === "custom" ? <label><span><strong>自定义地址</strong><small>后端会拒绝非 HTTPS 与不安全地址</small></span><input value={settings.customDownloadUrl} onChange={(event) => controller.updateSettings({ customDownloadUrl: event.target.value })} placeholder="https://…"/></label> : null}</div><div className="source-status-list">{controller.downloads.sources.map((source) => <article key={source.source}><span className={`status-dot ${source.status === "healthy" ? "is-ready" : "is-error"}`}/><div><strong>{sourceLabel(source.source)}</strong><small>{source.latencyMs === null ? "未返回延迟" : `${source.latencyMs} ms`}</small></div><em>{source.status === "healthy" ? "可用" : "不可用"}</em></article>)}{!controller.downloads.sources.length ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>还没有探测结果</strong><p>点上方「联网探测」测各下载源的可用性与延迟。</p></div></div> : null}</div></section><section className="production-panel settings-card"><header><div><span>安全凭据</span><h2>凭据状态</h2></div><button type="button" className="btn btn-secondary" onClick={onOpenProvider}>管理凭据</button></header><div className="credential-status-list">{controller.credentials.map((credential) => <article key={credential.credentialId ?? credential.providerId}><span className={`status-dot ${credential.configured ? "is-ready" : ""}`}/><div><strong>{credential.label ?? credential.providerId ?? credential.credentialId}</strong><small>{credential.updatedAt ? `更新于 ${formatUiDateTime(credential.updatedAt)}` : "密钥永不回显"}</small></div><em>{credential.configured ? "已配置" : "未配置"}</em></article>)}{!controller.credentials.length ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>没有已配置凭据</strong><p>前往 Provider 页保存到系统安全凭据。</p></div></div> : null}</div></section></div>;
}

function CapabilityList({ title, items, onRepair }: { title: string; items: CapabilityReadinessItem[] | undefined; onRepair: (item: CapabilityReadinessItem) => void }) {
  return <section className="production-panel settings-card capability-status-card"><header><div><span>能力状态</span><h2>{title}</h2></div><span>{items?.length ?? 0} 项</span></header><div>{items?.map((item) => <article key={item.id}><span className={`status-dot ${item.available ? "is-ready" : "is-warning"}`}/><div><strong>{item.label}</strong><small>{item.available ? "后端检测可用" : friendlyReason(item.reason)}</small></div><span className={`state-tag ${item.available ? "done" : "waiting"}`}>{item.available ? "可用" : "不可用"}</span>{!item.available ? <button type="button" className="text-button" onClick={() => onRepair(item)}>修复 / 查看</button> : <span/>}</article>)}{!items ? <div className="production-empty panel-empty"><span className="empty-seal">—</span><div><strong>等待真实探测</strong><p>不会预填已就绪状态。</p></div></div> : null}</div></section>;
}

function EnvironmentSettings({ controller, projects, onRepair, onProbe, onTasks }: { controller: SettingsController; projects: Project[]; onRepair: (item: CapabilityReadinessItem) => void; onProbe: () => void; onTasks: () => void }) {
  return <><div className="environment-toolbar"><label><span>项目就绪探测</span><select value={controller.readinessProjectId} onChange={(event) => controller.setReadinessProjectId(event.target.value)}><option value="">不选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><button type="button" className="btn btn-secondary" onClick={onProbe} disabled={controller.busy}>重新探测环境与下载源</button><button type="button" className="btn btn-secondary" onClick={onTasks}>打开全局任务账本</button></div><div className="settings-content-grid"><CapabilityList title="全局环境" items={controller.readiness?.global.capabilities} onRepair={onRepair}/><CapabilityList title="当前项目" items={controller.readiness?.project?.capabilities} onRepair={onRepair}/></div>{controller.downloads.items.length ? <section className="production-panel settings-card download-ledger"><header><div><span>已装配资源</span><h2>模型与运行时操作</h2></div><span>{controller.downloads.items.length} 项</span></header>{controller.downloads.items.map((item) => <article key={`${item.operationId}-${item.assetId}`}><div><strong>{item.assetId}</strong><small>{stageLabel(item.stage)} · {downloadStatus(item.status)}</small></div><div className="download-progress"><i><b style={{ width: `${Math.round(item.progress * 100)}%` }}/></i><span>{Math.round(item.progress * 100)}%</span></div><em>{item.errorCode ?? "—"}</em></article>)}</section> : null}</>;
}

function BackupSettings({ controller, projects }: { controller: SettingsController; projects: Project[] }) {
  return <div className="settings-content-grid backup-settings-grid"><section className="production-panel settings-card"><header><div><span>备份与恢复</span><h2>应用与项目备份</h2></div></header><div className="backup-actions"><button type="button" className="btn btn-secondary" onClick={() => void controller.createAppBackup()} disabled={controller.busy}>备份应用设置与资源</button><button type="button" className="btn btn-secondary" onClick={() => void controller.selectRestore("app")} disabled={controller.busy}>选择并预检应用备份</button><label><span>项目备份目标</span><select value={controller.backupProjectId} onChange={(event) => controller.setBackupProjectId(event.target.value)}><option value="">选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label><button type="button" className="btn btn-secondary" onClick={() => void controller.createProjectBackup()} disabled={controller.busy || !controller.backupProjectId}>备份所选项目</button><button type="button" className="btn btn-secondary" onClick={() => void controller.selectRestore("project")} disabled={controller.busy}>选择并预检项目备份</button></div><p className="settings-safety-note">恢复文件先由主进程预检并生成摘要，只有随后确认才会写入。项目冲突与迁移失败不会静默覆盖。</p></section><section className="production-panel settings-card diagnostic-card"><header><div><span>脱敏诊断</span><h2>脱敏诊断包</h2></div><span>{controller.diagnostics ? `${controller.diagnostics.entries.length} 项` : "未生成"}</span></header><div className="settings-card-actions"><p>必须先预览全部条目，再决定是否导出；密钥和受管绝对路径不会进入包内。</p><button type="button" className="btn btn-secondary" onClick={() => void controller.previewDiagnostics()} disabled={controller.busy}>生成脱敏预览</button><button type="button" className="btn btn-primary" onClick={() => void controller.exportDiagnostics()} disabled={controller.busy || !controller.diagnostics}>确认并导出</button></div>{controller.diagnostics ? <div className="diagnostic-entries">{controller.diagnostics.entries.map((entry) => <details key={entry.name}><summary>{entry.name}</summary><pre>{entry.content}</pre></details>)}</div> : <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>还没有诊断预览</strong><p>生成后会列出经脱敏的真实诊断条目。</p></div></div>}</section></div>;
}

function AboutSettings({ onDiagnostics, desktop }: { onDiagnostics: () => void; desktop: boolean }) {
  return <section className="production-panel settings-card about-card"><div className="about-mark" aria-hidden="true"><span>AI</span><i/></div><div><span>AI TRANSLATOR DESKTOP</span><h2>本地字幕翻译与媒体本地化工作台</h2><p>项目、资源、任务、备份与诊断由本机桌面边界管理。当前后端没有应用更新器；版本和平台信息可从脱敏诊断 manifest 查看。</p><dl><div><dt>运行环境</dt><dd>{desktop ? "Electron 桌面应用" : "浏览器只读预览"}</dd></div><div><dt>版本 / 平台 / 架构</dt><dd>见脱敏诊断 manifest</dd></div><div><dt>许可与来源</dt><dd>随应用清单与第三方通知交付</dd></div></dl><button type="button" className="btn btn-secondary" onClick={onDiagnostics}>前往诊断预览</button></div></section>;
}
