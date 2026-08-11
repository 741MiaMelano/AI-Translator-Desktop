import { Component, type ErrorInfo, type ReactNode } from "react";
import { desktopWindowControl, isDesktopRuntime } from "../services/desktop-client";
import { projectSaveScheduler } from "../services/project-save-scheduler";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/**
 * 最后一道防线：任何组件在 render 期抛出的未捕获异常，React 都会把整棵树卸载。
 * 这个应用是无边框窗口（frame:false），自绘标题栏也在树里——没有这层兜底时，
 * 一次 render 异常的表现就是整窗纯白、连关闭按钮都消失，用户只能强杀进程。
 */
export default class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[AppErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    const detail = this.state.error.message || String(this.state.error);
    return (
      <div className="flex h-screen w-screen flex-col bg-main">
        {/* 顶部保留一条可拖拽区：无边框窗口崩溃后至少还能被拖动 */}
        <div className="h-10 shrink-0 border-b border-line [-webkit-app-region:drag]" />
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="w-full max-w-[460px] rounded-[10px] border border-line bg-card p-6">
            <h1 className="text-[15px] font-semibold text-[var(--color-text-main)]">
              界面遇到错误，已停止渲染
            </h1>
            <p className="mt-2 text-[12.5px] leading-5 text-[var(--color-text-muted)]">
              项目数据都保存在磁盘上，不会因为这个错误丢失。点「重新加载界面」即可恢复；
              如果反复出现，请把下面的错误信息反馈给开发者。
            </p>
            <p className="mt-3 break-any rounded-[6px] border border-line bg-card-soft px-2.5 py-2 font-mono text-[11.5px] leading-5 text-stop">
              {detail}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="metal-gold inline-flex h-8 items-center rounded-[6px] border border-transparent px-3 text-[13px] font-medium"
              >
                重新加载界面
              </button>
              {isDesktopRuntime() ? (
                <button
                  type="button"
                  // 树已卸载，WorkspaceProvider 注册的关闭前 flush 监听不复存在；
                  // 这里直接冲刷防抖中的项目保存，避免最后 400ms 的编辑丢在内存里。
                  onClick={() => {
                    void projectSaveScheduler
                      .flushAll()
                      .finally(() => void desktopWindowControl("close"));
                  }}
                  className="inline-flex h-8 items-center rounded-[6px] border border-line-strong bg-card px-3 text-[13px] text-[var(--color-text-main)] hover:border-gold"
                >
                  退出应用
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
