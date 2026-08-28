import { Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { deriveProjectStatusSummary, type Project } from "../domain/workspace";
import { useWorkspace } from "../state/WorkspaceContext";
import { ProjectWorkspaceNav, type ProjectWorkspaceSection } from "./ProjectWorkspaceNav";
import { Icon } from "./visuals";

// 项目工作区外壳：项目头部与阶段导轨跨阶段常驻挂载，只有 Outlet 里的阶段体随路由变化。
// 因此阶段切换不再是"离开一个页面进入另一个页面"，各阶段也不再各自重复项目标题、返回按钮和导航。
function sectionFromPath(pathname: string): ProjectWorkspaceSection {
  if (/\/media$/.test(pathname)) return "transcribe";
  if (/\/translate$/.test(pathname)) return "translate";
  if (/\/editor\//.test(pathname)) return "review";
  if (/\/deliver$/.test(pathname)) return "delivery";
  if (/\/settings$/.test(pathname)) return "settings";
  return "intake";
}

function statusTone(tone: string | undefined) {
  if (tone === "green") return "done";
  if (tone === "red") return "danger";
  if (tone === "blue") return "running";
  return "waiting";
}

export function ProjectWorkspace() {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const project = workspace.projects.find((entry) => entry.id === projectId);

  if (workspace.loadState === "loading") {
    return (
      <div className="page-stage secondary-page">
        <div className="production-empty project-loading">
          <span className="empty-seal">··</span>
          <div><strong>正在读取本机项目</strong><p>项目、任务与运行快照都从桌面服务加载。</p></div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="page-stage secondary-page">
        <header className="page-header">
          <div><h1>找不到项目</h1><p>项目可能已被移入回收站、删除，或链接已经失效。</p></div>
        </header>
        <button type="button" className="btn btn-primary" onClick={() => navigate("/workspace")}>返回项目</button>
      </div>
    );
  }

  const status = deriveProjectStatusSummary(project);
  const section = sectionFromPath(location.pathname);

  return (
    <div className="page-stage project-workspace" data-project-stage={section}>
      <header className="project-header">
        <button type="button" className="back-button" onClick={() => navigate("/workspace")}><Icon name="arrow"/> 返回项目</button>
        <div className="project-title-line">
          <div>
            <h1>{project.title}</h1>
            <p>{project.sourceFileName} · {project.config.sourceLanguage} → {project.config.targetLanguages.join(" / ")}</p>
          </div>
          <div className="project-title-meta">
            <span className={`state-tag ${statusTone(status?.tone)}`}>{status?.label}</span>
            {/* 设置与资产是项目级辅助入口，不进阶段编号。 */}
            <button
              type="button"
              className={`project-settings-link ${section === "settings" ? "is-active" : ""}`}
              aria-current={section === "settings" ? "page" : undefined}
              onClick={() => navigate(`/projects/${project.id}/settings`)}
            >
              <Icon name="system"/><span>项目设置与资产</span>
            </button>
          </div>
        </div>
        <ProjectWorkspaceNav project={project} current={section} tasks={workspace.tasks}/>
      </header>
      <Outlet context={{ project } satisfies ProjectStageContext}/>
    </div>
  );
}

export type ProjectStageContext = { project: Project };

export function useProjectStage() {
  return useOutletContext<ProjectStageContext>();
}
