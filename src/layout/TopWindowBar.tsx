import { Bell, CircleHelp, Clock3, Maximize2, Minus, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { desktopWindowControl, isDesktopRuntime } from "../services/desktop-client";
import { useWorkspace } from "../state/WorkspaceContext";

const WINDOW_BUTTONS = [
  { icon: <Minus size={13} />, label: "最小化", action: "minimize" as const, danger: false },
  { icon: <Maximize2 size={12} />, label: "最大化或还原", action: "maximizeOrRestore" as const, danger: false },
  { icon: <X size={13} />, label: "关闭", action: "close" as const, danger: true },
];

const HELP_ITEMS = [
  { title: "如何开始", detail: "拖入视频、音频或字幕文件，确认配置后就能进入项目概览。" },
  { title: "批量处理", detail: "多文件会先进入批量确认页，避免把不同素材误并成同一项目。" },
  { title: "资源库", detail: "术语、风格和字幕样式都集中在资源库中统一维护和调用。" },
];

/** 顶栏右侧图标按钮，尺寸与窗口控制键统一 */
function BarButton({
  label,
  expanded,
  controls,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string;
  expanded?: boolean;
  controls?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-8 items-center justify-center rounded-[4px] text-[var(--color-text-muted)] transition hover:bg-card-soft hover:text-[var(--color-text-main)] disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? "hover:bg-[var(--color-danger)] hover:text-white" : ""
      }`}
    >
      {children}
    </button>
  );
}

function Panel({
  id,
  label,
  items,
}: {
  id: string;
  label: string;
  items: Array<{ icon?: ReactNode; title: string; detail: string }>;
}) {
  return (
    <div
      id={id}
      role="region"
      aria-label={label}
      className="material-card absolute right-3 top-9 z-50 w-[min(340px,calc(100vw-2rem))] rounded-[10px] border border-line p-2 shadow-pop [-webkit-app-region:no-drag]"
    >
      <p className="px-1.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
        {label}
      </p>
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.title} className="rounded-[6px] bg-card-soft p-2.5">
            <div className="flex items-start gap-2.5">
              {item.icon ? <span className="mt-0.5 text-gold-dark">{item.icon}</span> : null}
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-[var(--color-text-main)]">{item.title}</span>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-muted)]">{item.detail}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TopWindowBar() {
  const [openPanel, setOpenPanel] = useState<"notifications" | "help" | null>(null);
  const { capabilities, defaults, tasks, flushBeforeClose, saveError } = useWorkspace();
  const navigate = useNavigate();
  const runningTask = tasks.find((task) => task.status === "running");
  const primaryProvider = capabilities.providers.find(
    (provider) => provider.name === defaults.provider && provider.status === "ready",
  );
  const desktop = isDesktopRuntime();

  useEffect(() => {
    if (!openPanel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPanel(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [openPanel]);

  const notifications = [
    primaryProvider
      ? { icon: <ShieldCheck size={14} />, title: `${primaryProvider.name} 状态`, detail: primaryProvider.summary }
      : {
          icon: <ShieldCheck size={14} />,
          title: "当前没有可用的翻译服务",
          detail: "先在“模型与连接”里保存 API Key 和全局默认模型。",
        },
    runningTask
      ? {
          icon: <Clock3 size={14} />,
          title: `任务：${runningTask.label}`,
          detail: `${runningTask.detail} · ${runningTask.progress}%`,
        }
      : {
          icon: <Clock3 size={14} />,
          title: "当前没有运行中的任务",
          detail: "可以从开始翻译导入新素材，或在项目页查看已有项目。",
        },
    ...(saveError ? [{ icon: <ShieldCheck size={14} />, title: "操作失败", detail: saveError }] : []),
  ];

  const handleWindowAction = async (action: "minimize" | "maximizeOrRestore" | "close") => {
    if (!desktop) return;
    if (action === "close" && !(await flushBeforeClose())) return;
    await desktopWindowControl(action);
  };

  const ready = Boolean(primaryProvider);

  return (
    <div className="app-topbar fixed left-[224px] right-0 top-0 z-30 flex h-10 items-center gap-2 border-b border-line bg-main px-3 [-webkit-app-region:drag]">
      <button
        type="button"
        onClick={() => navigate("/capabilities")}
        title="前往模型与连接"
        className="top-status-pill flex items-center gap-2 rounded-[4px] border border-line bg-card px-2 py-1 text-[11.5px] text-[var(--color-text-muted)] transition hover:border-gold hover:text-[var(--color-text-main)] [-webkit-app-region:no-drag]"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${ready ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]"}`}
        />
        <span className="font-medium text-[var(--color-text-main)]">
          {primaryProvider ? `${primaryProvider.name} · ${defaults.model}` : "未配置翻译服务"}
        </span>
        <span>{ready ? "可用" : "去配置"}</span>
      </button>

      <span className="ml-auto flex items-center gap-0.5 [-webkit-app-region:no-drag]">
        <BarButton
          label="通知"
          expanded={openPanel === "notifications"}
          controls="notifications-panel"
          onClick={() => setOpenPanel((value) => (value === "notifications" ? null : "notifications"))}
        >
          <Bell size={14} />
        </BarButton>
        <BarButton
          label="帮助"
          expanded={openPanel === "help"}
          controls="help-panel"
          onClick={() => setOpenPanel((value) => (value === "help" ? null : "help"))}
        >
          <CircleHelp size={14} />
        </BarButton>
        <span className="mx-1 h-4 w-px bg-line" />
        {WINDOW_BUTTONS.map((button) => (
          <BarButton
            key={button.label}
            label={desktop ? button.label : `${button.label}（仅桌面应用可用）`}
            danger={button.danger}
            disabled={!desktop}
            onClick={() => {
              void handleWindowAction(button.action);
            }}
          >
            {button.icon}
          </BarButton>
        ))}
      </span>

      {openPanel === "notifications" ? (
        <Panel id="notifications-panel" label="通知" items={notifications} />
      ) : null}
      {openPanel === "help" ? <Panel id="help-panel" label="帮助" items={HELP_ITEMS} /> : null}
    </div>
  );
}
