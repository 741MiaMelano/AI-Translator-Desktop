import type { ReactNode } from "react";
import { useWorkspace } from "../state/WorkspaceContext";
import { ThemeProvider } from "../theme/ThemeContext";
import Sidebar from "./Sidebar";
import TopWindowBar from "./TopWindowBar";

function Notice({ tone, children }: { tone: "info" | "error"; children: ReactNode }) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`mb-3 rounded-[6px] border px-3 py-2 text-[13px] ${
        isError
          ? "border-[var(--color-danger)] bg-stop-wash text-[var(--color-text-main)]"
          : "border-line bg-card-soft text-[var(--color-text-muted)]"
      }`}
    >
      {children}
    </div>
  );
}

function AppShellContent({ children }: { children: ReactNode }) {
  const { loadState, loadError, saveError, retryLoadProjects, isDesktop } = useWorkspace();
  const showChildren = !isDesktop || loadState === "ready" || loadState === "error";

  return (
    <div className="app-surface h-screen overflow-hidden bg-main">
      <div className="desktop-window-frame pointer-events-none fixed inset-0 z-50" />
      <Sidebar />
      <main className="app-main ml-[224px] flex h-screen flex-col overflow-hidden">
        <TopWindowBar />
        {/* pt-10 让开顶栏，pb-[72px] 让开底部操作条；两者都是实底占位元素 */}
        <div className="app-content-scroll flex-1 overflow-y-auto px-4 pb-[72px] pt-10">
          <div className="mx-auto w-full min-w-0 max-w-[1580px] pt-4">
            {isDesktop && loadState === "loading" ? <Notice tone="info">正在从本地数据库加载项目…</Notice> : null}
            {loadState === "error" || loadError ? (
              <Notice tone="error">
                <p>{loadError ?? "项目加载失败"}</p>
                <button type="button" className="mt-1.5 font-medium underline" onClick={retryLoadProjects}>
                  重试
                </button>
              </Notice>
            ) : null}
            {saveError ? <Notice tone="error">操作失败：{saveError}</Notice> : null}
            {showChildren ? children : null}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <AppShellContent>{children}</AppShellContent>
    </ThemeProvider>
  );
}
