import { Component, type ErrorInfo, type ReactNode } from "react";
import { desktopWindowControl, isDesktopRuntime } from "../services/desktop-client";
import { projectSaveScheduler } from "../services/project-save-scheduler";

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class FrontendErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[FrontendErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const detail = this.state.error.message || String(this.state.error);
    return (
      <div className="frontend-crash-shell">
        <div className="frontend-crash-drag"/>
        <section className="frontend-crash-panel" role="alert">
          <span className="frontend-crash-seal" aria-hidden="true">!</span>
          <div>
            <h1>界面遇到错误，已停止渲染</h1>
            <p>项目数据仍保存在磁盘上。重新加载界面通常可以恢复；若问题反复出现，请保留下面的信息用于诊断。</p>
            <code>{detail}</code>
            <div className="frontend-crash-actions">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>重新加载界面</button>
              {isDesktopRuntime() ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void projectSaveScheduler.flushAll().finally(() => void desktopWindowControl("close"))}
                >
                  安全退出
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    );
  }
}
