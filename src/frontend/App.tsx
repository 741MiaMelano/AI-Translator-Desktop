import { useEffect, useRef, useState, type DragEvent } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useWorkspace, WorkspaceProvider } from "../state/WorkspaceContext";
import { getActiveSourceTrack } from "../domain/workspace";
import { blockingCapabilities, capabilityReason, repairLabel, repairPath } from "./capabilities";
import { CommandPalette } from "./CommandPalette";
import { ImportPage } from "./ImportPage";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { SystemPage, WorkbenchPage } from "./pages";
import { ProjectPage } from "./ProjectPage";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { ProjectSettingsPage } from "./ProjectSettingsPage";
import { EditorPage } from "./EditorPage";
import { DeliveryPage } from "./DeliveryPage";
import { WorkspacePage } from "./WorkspacePage";
import { AsrMaintenancePage, ProviderPage } from "./CapabilitiesPage";
import { MediaPage } from "./MediaPage";
import { TranslatePage } from "./TranslatePage";
import { LibraryPage } from "./LibraryPage";
import { SystemSettingsPage } from "./SettingsPage";
import { FrontendProvider, useFrontend } from "./state";
import { THEMES, THEME_BY_ID } from "./theme";
import { Icon, ThemeBrandMark, type IconName } from "./visuals";

// 侧栏只放全局目的地。需要"先选一个项目"的界面属于项目内阶段，不进侧栏。
const navigation: Array<{ path: string; label: string; icon: IconName }> = [
  { path: "/", label: "工作台", icon: "home" },
  { path: "/workspace", label: "项目", icon: "folder" },
  { path: "/library", label: "资源库", icon: "library" },
  { path: "/system", label: "系统", icon: "system" },
];

/**
 * 开启专业密度后真正多出东西的目的地。切完开关只在侧栏闪两下，用户根本不知道该往哪走，
 * 所以这些入口要一直发光，直到他真的进去过一次为止。
 * 技术读数（.pro-only）目前都挂在项目列表的任务账本和项目内各阶段下，全部归属"项目"。
 */
const PRO_REVEAL_PATHS = ["/workspace"];

// /editor 不再是侧栏入口，但保留为深链接：解析到当前项目的真实编辑器，而不是任何只读替代界面。
function EditorShortcut() {
  const app = useFrontend();
  const source = app.activeProject ? getActiveSourceTrack(app.activeProject) : null;
  const target = source?.targetTracks.find((track) => track.isActive) ?? source?.targetTracks[0];
  return app.activeProject && target
    ? <Navigate to={`/projects/${app.activeProject.id}/editor/${encodeURIComponent(target.languageCode)}`} replace/>
    : <Navigate to="/workspace" replace/>;
}

function Shell() {
  const app = useFrontend();
  const workspace = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const [themeOpen, setThemeOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragDepthRef = useRef(0);
  const dragActiveRef = useRef(false);
  const themeTriggerRef = useRef<HTMLButtonElement>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  // 专业密度的分步指引：开关一开，承载技术读数的入口就一直发光；用户走到哪一个，
  // 那一个就灭掉。全部走过之后指引自己收掉，不需要他去点"知道了"。
  const [revealPending, setRevealPending] = useState<string[]>([]);
  useEffect(() => {
    setRevealPending(app.densityReveal ? PRO_REVEAL_PATHS : []);
  }, [app.densityReveal]);
  useEffect(() => {
    if (!revealPending.length) return;
    const remaining = revealPending.filter((path) => !location.pathname.startsWith(path));
    if (remaining.length === revealPending.length) return;
    setRevealPending(remaining);
    if (!remaining.length) app.dismissDensityReveal();
  }, [app.dismissDensityReveal, location.pathname, revealPending]);

  const currentTheme = THEME_BY_ID[app.theme];
  const capabilities = app.readiness.data?.global.capabilities ?? [];
  const blocking = blockingCapabilities(capabilities, workspace.projects);
  const acceptsFileDrop = app.desktopAvailable && (location.pathname === "/" || location.pathname === "/import");
  const projectEditorRoute = /^\/projects\/[^/]+\/editor\/[^/]+$/.test(location.pathname);
  const routeTitle = location.pathname === "/import"
    ? "导入 / 翻译方案"
    : location.pathname.startsWith("/batch/")
      ? "项目 / 批量处理"
    : /^\/projects\/[^/]+\/media$/.test(location.pathname)
      ? "项目 / 素材与识别"
    : projectEditorRoute
      ? "字幕编辑与校对"
    : location.pathname.startsWith("/projects/")
      ? "项目 / 核心工作流"
    : location.pathname.startsWith("/system/asr")
    ? "系统 / 语音识别"
    : location.pathname.startsWith("/system/providers")
    ? "系统 / 翻译 Provider"
    : navigation.find((item) => item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path))?.label ?? "工作台";

  // 校对阶段接管视口：侧栏自动压成 72px 让出编辑宽度，离开后恢复用户自己的偏好。
  useEffect(() => {
    app.setRailAutoCompact(projectEditorRoute);
  }, [projectEditorRoute, app.setRailAutoCompact]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const root = document.documentElement;
    root.classList.add("is-nav");
    const timer = window.setTimeout(() => root.classList.remove("is-nav"), 440);
    setThemeOpen(false);
    return () => window.clearTimeout(timer);
  }, [location.pathname, location.search]);

  // Ctrl+K 与 ? 是全局的。`?` 是无修饰键，所以在文本输入里要让位给打字。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyK" && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        setShortcutsOpen(false);
        setCommandOpen((open) => !open);
        return;
      }
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      event.preventDefault();
      setCommandOpen(false);
      setShortcutsOpen((open) => !open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!themeOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || themeTriggerRef.current?.contains(target) || themeMenuRef.current?.contains(target)) return;
      setThemeOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setThemeOpen(false);
      themeTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [themeOpen]);

  const go = (path: string) => {
    app.play("navigate");
    navigate(path);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>("#main-content")?.focus({ preventScroll: true }));
  };

  const playControlFeedback = (target: EventTarget) => {
    if (!(target instanceof Element)) return;
    const control = target.closest("button:not(:disabled), a[href], summary, select:not(:disabled), input[type=checkbox]:not(:disabled), input[type=radio]:not(:disabled), [role=tab]:not([aria-disabled=true]), [role=menuitemradio]");
    if (!control || control.hasAttribute("data-sound-skip")) return;
    app.play(control.matches("[role=tab]") ? "tab" : control.matches("select, input, summary") ? "toggle" : "click");
  };

  const resetFileDrag = () => {
    dragDepthRef.current = 0;
    dragActiveRef.current = false;
    setIsDraggingFile(false);
  };

  const isExternalFileDrag = (event: DragEvent<HTMLDivElement>) => event.dataTransfer.types.includes("Files");

  const handleFileDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    if (dragActiveRef.current) return;
    dragActiveRef.current = true;
    setIsDraggingFile(true);
    app.play("toggle");
  };

  const handleFileDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = acceptsFileDrop ? "copy" : "none";
  };

  const handleFileDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) resetFileDrag();
  };

  const handleFileDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    const droppedFiles = Array.from(event.dataTransfer.files);
    resetFileDrag();
    if (!acceptsFileDrop || droppedFiles.length === 0) return;
    navigate("/import", { replace: location.pathname === "/import", state: { droppedFiles } });
  };

  // 侧栏只在能力挡住当前项目的下一步时才报警。"按需启用"里的东西没就绪不是故障，
  // 是还没轮到它——旧口径把四项平权计数，纯字幕用户永远看着一个与他无关的红点。
  const statusTitle = app.readiness.loading
    ? "正在读取环境"
    : app.readiness.error
      ? "环境状态不可用"
      : capabilities.length === 0
        ? "没有能力状态"
        : blocking.length === 0
          ? "就绪"
          : `${blocking[0].label}未就绪`;
  const statusDetail = app.readiness.loading
    ? "连接本地服务…"
    : app.readiness.error
      ? "打开系统页查看原因"
      : blocking.length === 0
        ? "本机能力满足当前项目"
        : capabilityReason(blocking[0].reason);

  return (
    <div
      className={`app-shell ${isDraggingFile ? "is-drag-over" : ""} ${isDraggingFile && !acceptsFileDrop ? "is-drop-blocked" : ""}`}
      onClick={(event) => playControlFeedback(event.target)}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      <aside className="sidebar">
        <button type="button" className="brand" onClick={() => go("/")} aria-label="返回工作台">
          <span className="brand-mark" aria-hidden="true"><ThemeBrandMark theme={app.theme}/></span>
          <span className="brand-copy"><strong>桌面 AI 翻译器</strong><small>LOCAL WORKSPACE</small></span>
        </button>
        <nav className="main-nav" aria-label="主导航">
          {navigation.map((item, index) => {
            // 项目内的所有阶段都归属"项目"，因为它们不再是独立的全局目的地。
            const active = item.path === "/"
              ? location.pathname === "/" || location.pathname === "/import"
              : item.path === "/workspace"
                ? ["/workspace", "/batch/", "/projects/"].some((prefix) => location.pathname.startsWith(prefix))
                : location.pathname.startsWith(item.path);
            return (
              <button
                type="button"
                key={item.path}
                className={`nav-item ${active ? "is-active" : ""} ${revealPending.includes(item.path) ? "is-revealing" : ""}`}
                onClick={() => go(item.path)}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                title={item.label}
              >
                <span className="nav-index">0{index + 1}</span><Icon name={item.icon}/><span>{item.label}</span>
                {revealPending.includes(item.path) ? <i className="nav-reveal-dot" aria-hidden="true"/> : null}
              </button>
            );
          })}
        </nav>
        {/* 密度只控制技术读数的显示密度；同意勾选、QA 阻断、批准顺序、删除确认两种模式完全一致。 */}
        <button
          type="button"
          className={`density-toggle ${app.density === "pro" ? "is-pro" : ""}`}
          onClick={app.toggleDensity}
          aria-pressed={app.density === "pro"}
          title={app.density === "pro" ? "切回简单：收起技术读数" : "切到专业：显示全部技术读数"}
        >
          <Icon name={app.density === "pro" ? "expand" : "collapse"}/>
          <span>{app.density === "pro" ? "专业" : "简单"}</span>
        </button>
        {/* 更新入口先占位。本机确实没有更新器：electron-builder 全部 --publish never，
            没有发布源，也没有配仓库地址。按钮保持禁用并说明缺什么，比点了没反应诚实。 */}
        <div className="sidebar-update">
          <button type="button" className="rail-action" disabled title="更新源尚未配置；接线后这里会变成「有新版本 · 去下载」">
            <Icon name="refresh"/><span>检查更新</span>
          </button>
          <button type="button" className="rail-action" disabled title="仓库地址尚未配置">
            <Icon name="arrow"/><span>GitHub</span>
          </button>
        </div>
        {/* 报了故障就必须能就地去修：只显示"坏了"而不给出口，是这一版要治的病。 */}
        {blocking.length ? (
          <button
            type="button"
            className="sidebar-status is-actionable"
            onClick={() => go(repairPath(blocking[0].repairAction))}
            title={`${statusTitle} · ${statusDetail}`}
          >
            <span className="status-orbit" aria-hidden="true"><i className="is-error"/></span>
            <div><strong>{statusTitle}</strong><span>{statusDetail}</span></div>
            <span className="sidebar-status-cta">{repairLabel(blocking[0].repairAction) || "去处理"}<Icon name="chevron"/></span>
          </button>
        ) : (
          <div className="sidebar-status">
            <span className="status-orbit" aria-hidden="true"><i className={app.readiness.error ? "is-error" : ""}/></span>
            <div><strong>{statusTitle}</strong><span>{statusDetail}</span></div>
          </div>
        )}
        <div className="sidebar-foot">
          <button
            type="button"
            className={`sound-toggle ${app.soundEnabled ? "is-enabled" : "is-muted"}`}
            onClick={app.toggleSound}
            aria-pressed={app.soundEnabled}
            aria-label={app.soundEnabled ? "操作音效已开启，点击静音" : "操作音效已静音，点击开启"}
            title={app.soundEnabled ? "关闭操作音效" : "开启操作音效"}
          >
            <span className="sound-icon" aria-hidden="true">
              <span className="sound-wave wave-1"/><span className="sound-wave wave-2"/><span className="sound-wave wave-3"/><i className="sound-mute-bar"/>
            </span>
            <span className="sound-label">{app.soundEnabled ? "操作音效" : "音效静音"}</span>
          </button>
          <button type="button" className="rail-toggle" onClick={app.toggleRail} aria-label={app.compactRail ? "展开侧栏" : "收起侧栏"} title={app.compactRail ? "展开侧栏" : "收起侧栏"}>
            <Icon name="chevron"/>
          </button>
        </div>
      </aside>

      <header className="topbar">
        <div className="production-route-title"><span>AI TRANSLATOR</span><strong>{routeTitle}</strong></div>
        {/* 顶栏这块空白原来什么都没有；命令入口放在这里，键盘和鼠标各有一条路。 */}
        <div className="topbar-spacer">
          <button type="button" className="command-trigger" onClick={() => setCommandOpen(true)} aria-label="搜索项目或命令">
            <Icon name="search"/><span>搜索项目或命令</span><kbd>Ctrl K</kbd>
          </button>
        </div>
        <button type="button" className="shortcuts-trigger" onClick={() => setShortcutsOpen(true)} aria-label="快捷键速查">
          <Icon name="edit"/><span>快捷键</span><kbd>?</kbd>
        </button>
        <div className="top-context">
          <span className={`local-badge ${app.desktopAvailable ? "" : "is-unavailable"}`}><i/> {app.desktopAvailable ? "桌面服务已连接" : "浏览器只读预览"}</span>
        </div>
        <button
          ref={themeTriggerRef}
          type="button"
          className="theme-trigger production-theme-label"
          aria-expanded={themeOpen}
          aria-haspopup="menu"
          aria-controls="production-theme-menu"
          aria-label={`切换视觉皮肤，当前${currentTheme.code} · ${currentTheme.name}`}
          onClick={() => setThemeOpen((open) => !open)}
        >
          <Icon name="palette"/><span className="theme-trigger-label">{currentTheme.code} · {currentTheme.name}</span><Icon name="chevron"/>
        </button>
        <div className="window-actions" role="group" aria-label="窗口控制">
          <button type="button" className="window-action window-minimize" onClick={() => void app.controlWindow("minimize")} disabled={!app.desktopAvailable} aria-label="最小化窗口" title={app.desktopAvailable ? "最小化" : "仅桌面应用可用"}><i/></button>
          <button type="button" className="window-action window-maximize" onClick={() => void app.controlWindow("maximizeOrRestore")} disabled={!app.desktopAvailable} aria-label="最大化或还原窗口" title={app.desktopAvailable ? "最大化或还原" : "仅桌面应用可用"}><i/></button>
          <button type="button" className="window-action window-close" onClick={() => void app.controlWindow("close")} disabled={!app.desktopAvailable} aria-label="关闭窗口" title={app.desktopAvailable ? "关闭" : "仅桌面应用可用"}><i/></button>
        </div>
      </header>

      {themeOpen ? (
        <div ref={themeMenuRef} className="theme-menu production-theme-menu" id="production-theme-menu" role="menu" aria-label="切换视觉版本">
          <div className="theme-menu-head"><strong>保持当前页面，切换视觉与声学风格</strong><small>业务数据、路由与操作状态不变</small></div>
          {THEMES.map((theme) => (
            <button
              type="button"
              className={`theme-option ${theme.id === app.theme ? "is-current" : ""}`}
              key={theme.id}
              role="menuitemradio"
              aria-checked={theme.id === app.theme}
              onClick={() => {
                app.setTheme(theme.id);
                setThemeOpen(false);
              }}
            >
              <span className={`theme-swatch swatch-${theme.id}`}><i/></span>
              <span><strong>{theme.code} · {theme.name}</strong><small>{theme.caption}</small></span>
              {theme.id === app.theme ? <Icon name="check"/> : null}
            </button>
          ))}
          <div className="theme-preferences" aria-label="视觉与声学偏好">
            <button type="button" className="theme-preference" role="switch" aria-checked={app.soundEnabled} onClick={app.toggleSound}>
              <span><strong>操作音效</strong><small>{app.soundEnabled ? `${currentTheme.name}材质配方` : "默认静音，不影响视觉反馈"}</small></span><i className={app.soundEnabled ? "is-on" : ""}><b/></i>
            </button>
            <button type="button" className="theme-preference" role="switch" aria-checked={app.effectsEnabled} onClick={app.toggleEffects}>
              <span><strong>签名视觉动效</strong><small>{app.effectsActive ? "当前窗口正在播放" : "已暂停，静态签名仍保留"}</small></span><i className={app.effectsEnabled ? "is-on" : ""}><b/></i>
            </button>
            <button type="button" className="theme-preference" role="switch" aria-checked={app.reducedMotionForced} onClick={app.toggleReducedMotion}>
              <span><strong>减少动态</strong><small>{app.reducedMotion && !app.reducedMotionForced ? "系统偏好正在生效" : app.reducedMotionForced ? "已主动启用" : "跟随系统偏好"}</small></span><i className={app.reducedMotion ? "is-on" : ""}><b/></i>
            </button>
          </div>
        </div>
      ) : null}

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)}/>

      <main className="main" id="main-content" tabIndex={-1}>
        {/* 光效只说明"这里变了"，说不出"变了什么"、更说不出"该往哪走"。指引挂在外壳上，
            所以用户切完开关再点进任何一页都还能看到它。 */}
        {app.densityReveal ? (
          <div className="density-reveal-hint" role="status">
            <span className="reveal-seal" aria-hidden="true"><Icon name="expand"/></span>
            <div>
              <strong>专业选项已开启</strong>
              <p>{revealPending.length
                ? "左侧「项目」正在闪动：新增的技术读数（任务 ID、失败错误码、进度小数位、探测详情）在项目列表的任务账本和项目内各阶段里。点进去看一眼，提示就会消失。"
                : "本页高亮的就是新露出来的技术读数；鼠标划过即可消除高亮。简单模式只是把它们收起来，能否操作的“门”两种模式完全一致。"}</p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={app.dismissDensityReveal}>知道了</button>
          </div>
        ) : null}
        <Routes>
          <Route path="/" element={<WorkbenchPage/>}/>
          <Route path="/workbench" element={<Navigate to="/" replace/>}/>
          <Route path="/import" element={<ImportPage/>}/>
          <Route path="/workspace" element={<WorkspacePage/>}/>
          <Route path="/workspace/tasks" element={<WorkspacePage initialView="attention" focusTasks/>}/>
          <Route path="/workspace/archive" element={<WorkspacePage initialView="done"/>}/>
          <Route path="/workspace/recycle" element={<WorkspacePage initialView="trash"/>}/>
          <Route path="/batch/review" element={<WorkspacePage batchMode/>}/>
          <Route path="/projects/:projectId" element={<ProjectWorkspace/>}>
            <Route index element={<ProjectPage/>}/>
            <Route path="settings" element={<ProjectSettingsPage/>}/>
            <Route path="media" element={<MediaPage/>}/>
            <Route path="translate" element={<TranslatePage/>}/>
            <Route path="editor/:targetLanguage" element={<EditorPage/>}/>
            <Route path="deliver" element={<DeliveryPage/>}/>
          </Route>
          <Route path="/editor" element={<EditorShortcut/>}/>
          <Route path="/media" element={<Navigate to="/workspace" replace/>}/>
          <Route path="/library" element={<LibraryPage/>}/>
          <Route path="/system" element={<SystemPage/>}/>
          <Route path="/system/providers" element={<ProviderPage/>}/>
          <Route path="/system/asr" element={<AsrMaintenancePage/>}/>
          <Route path="/system/settings" element={<SystemSettingsPage/>}/>
          <Route path="/settings" element={<Navigate to="/system/settings" replace/>}/>
          <Route path="/capabilities" element={<Navigate to="/system/providers" replace/>}/>
          <Route path="/models" element={<Navigate to="/system/providers" replace/>}/>
          <Route path="*" element={<Navigate to="/" replace/>}/>
        </Routes>
      </main>

      {app.notice ? (
        <div className={`toast toast-${app.theme} ${app.notice.tone === "error" ? "is-error" : ""}`} role={app.notice.tone === "error" ? "alert" : "status"}>
          <span className="toast-theme-accent" aria-hidden="true"/><Icon name={app.notice.tone === "error" ? "warning" : "check"}/><span>{app.notice.message}</span>
        </div>
      ) : null}

      <div className="native-drop-overlay" aria-hidden={!isDraggingFile}>
        <div className="drop-modal-box" role="status" aria-live="polite">
          <div className="drop-modal-icon"><Icon name={acceptsFileDrop ? "upload" : "warning"}/></div>
          <h2>{acceptsFileDrop ? "释放文件以快速导入" : "请返回工作台导入新文件"}</h2>
          <p>{acceptsFileDrop ? "支持视频、音频或字幕文件；松开后进入真实探测与方案确认" : "当前项目操作不会被打断，也不会打开拖入的本地文件"}</p>
        </div>
      </div>
    </div>
  );
}

export default function FrontendApp() {
  return <WorkspaceProvider><FrontendProvider><Shell/></FrontendProvider></WorkspaceProvider>;
}
