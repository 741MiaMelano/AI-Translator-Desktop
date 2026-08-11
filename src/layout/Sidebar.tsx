import {
  ChevronDown,
  FolderKanban,
  Home,
  LibraryBig,
  ListChecks,
  LogOut,
  Moon,
  PlugZap,
  Settings,
  Sun,
  Wrench,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useTheme } from "../theme/ThemeContext";
import { useWorkspace } from "../state/WorkspaceContext";
import { desktopWindowControl, isDesktopRuntime } from "../services/desktop-client";

const navGroups: Array<{ title: string; items: Array<{ to: string; label: string; icon: ReactNode }> }> = [
  {
    title: "工作流",
    items: [
      { to: "/", label: "开始翻译", icon: <Home size={15} /> },
      { to: "/workspace", label: "项目", icon: <FolderKanban size={15} /> },
    ],
  },
  {
    title: "配置",
    items: [
      { to: "/capabilities", label: "模型与连接", icon: <PlugZap size={15} /> },
      { to: "/settings", label: "设置", icon: <Settings size={15} /> },
    ],
  },
];

function SidebarNavItem({ to, icon, label }: { to: string; icon: ReactNode; label: string }) {
  const location = useLocation();
  const isProjectSection = to === "/workspace" && location.pathname.startsWith("/projects/");

  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex h-9 items-center gap-2.5 rounded-[6px] border-l-2 px-2.5 text-[13px] transition ${
          isActive || isProjectSection
            ? "border-l-[var(--color-gold-light)] bg-sidebar-soft font-medium text-[var(--color-text-light)]"
            : "border-l-transparent text-[#9a9083] hover:bg-sidebar-soft hover:text-[var(--color-text-light)]"
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span className={isActive || isProjectSection ? "text-[var(--color-gold-light)]" : ""}>{icon}</span>
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}

function SidebarFooter() {
  const { mode, setMode } = useTheme();
  const { tasks, flushBeforeClose } = useWorkspace();
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const desktop = isDesktopRuntime();

  return (
    <div className="mt-auto space-y-2 border-t border-white/[0.08] py-3">
      <div className="flex items-center gap-2 rounded-[6px] bg-sidebar-soft px-2.5 py-2 text-xs text-[#9a9083]">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${runningCount > 0 ? "bg-[var(--color-gold-light)]" : "bg-[var(--color-success)]"}`}
        />
        <span>{runningCount > 0 ? "任务运行中" : "队列空闲"}</span>
        <span className="tabular ml-auto text-[var(--color-text-light)]">{runningCount}</span>
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-[6px] bg-sidebar-soft p-1 text-xs">
        <button
          type="button"
          aria-pressed={mode === "light"}
          onClick={() => setMode("light")}
          className={`flex items-center justify-center gap-1.5 rounded-[4px] py-1.5 transition ${
            mode === "light"
              ? "bg-white/[0.09] text-[var(--color-text-light)]"
              : "text-[#9a9083] hover:text-[var(--color-text-light)]"
          }`}
        >
          <Sun size={13} />
          浅色
        </button>
        <button
          type="button"
          aria-pressed={mode === "dark"}
          onClick={() => setMode("dark")}
          className={`flex items-center justify-center gap-1.5 rounded-[4px] py-1.5 transition ${
            mode === "dark"
              ? "bg-white/[0.09] text-[var(--color-text-light)]"
              : "text-[#9a9083] hover:text-[var(--color-text-light)]"
          }`}
        >
          <Moon size={13} />
          深色
        </button>
      </div>

      <button
        type="button"
        disabled={!desktop}
        title={desktop ? "关闭主窗口；运行中任务会提供后台、停止或取消选项" : "仅桌面应用可退出"}
        onClick={() => {
          void (async () => {
            if (await flushBeforeClose()) await desktopWindowControl("close");
          })();
        }}
        className="flex h-8 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-[13px] text-[#9a9083] transition hover:bg-sidebar-soft hover:text-[var(--color-text-light)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <LogOut size={15} />
        退出软件
      </button>
    </div>
  );
}

export default function Sidebar() {
  return (
    <aside className="app-sidebar subtle-texture fixed left-0 top-0 z-40 flex h-screen w-[224px] flex-col border-r border-white/[0.08] px-2 text-[var(--color-text-light)]">
      <div className="mb-2 flex items-center gap-2.5 border-b border-white/[0.08] px-1.5 py-3">
        <div className="metal-gold flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-sm font-semibold">
          A
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[13px] font-semibold">AI 翻译工作台</h1>
          <p className="truncate text-[11px] text-[#9a9083]">视频字幕翻译</p>
        </div>
      </div>

      <nav aria-label="主导航" className="flex-1 space-y-3 overflow-y-auto">
        {navGroups.map((group) => (
          <div key={group.title}>
            <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#7b7264]">
              {group.title}
            </p>
            <div className="space-y-px">
              {group.items.map((item) => (
                <SidebarNavItem key={item.to} {...item} />
              ))}
            </div>
          </div>
        ))}
        <details className="group border-t border-white/[0.08] pt-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[6px] px-2.5 py-2 text-[12px] text-[#9a9083] transition hover:bg-sidebar-soft hover:text-[var(--color-text-light)] [&::-webkit-details-marker]:hidden">
            <span>高级工具</span>
            <ChevronDown size={13} className="ml-auto transition group-open:rotate-180" />
          </summary>
          <div className="mt-1 space-y-px">
            <SidebarNavItem to="/batch/review" label="批量处理" icon={<ListChecks size={15} />} />
            <SidebarNavItem to="/media-tools" label="媒体工具" icon={<Wrench size={15} />} />
            <SidebarNavItem to="/library" label="资源库" icon={<LibraryBig size={15} />} />
          </div>
        </details>
      </nav>

      <SidebarFooter />
    </aside>
  );
}
