import { LayoutDashboard, Subtitles } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface ProjectSectionNavProps {
  projectId: string;
  active: "overview" | "editor";
  targetLanguageCode?: string;
  editorAvailable?: boolean;
}

export default function ProjectSectionNav({
  projectId,
  active,
  targetLanguageCode,
  editorAvailable = true,
}: ProjectSectionNavProps) {
  const navigate = useNavigate();
  const editorPath = targetLanguageCode
    ? `/projects/${projectId}/editor/${targetLanguageCode}`
    : "";

  const items = [
    {
      id: "overview",
      label: "概览",
      icon: <LayoutDashboard size={16} />,
      disabled: false,
      title: undefined,
      onClick: () => navigate(`/projects/${projectId}`),
    },
    {
      id: "editor",
      label: "字幕编辑",
      icon: <Subtitles size={16} />,
      disabled: !editorAvailable || !targetLanguageCode,
      title: !editorAvailable ? "当前项目还没有可编辑字幕" : !targetLanguageCode ? "请先添加目标语言" : undefined,
      onClick: () => editorPath && navigate(editorPath),
    },
  ] as const;

  return (
    <nav className="mb-6 flex flex-wrap gap-2 rounded-[10px] border border-[var(--color-border)] bg-white/55 p-2 shadow-soft">
      {items.map((item) => {
        const isActive = item.id === active;

        return (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            title={item.title}
            aria-current={isActive ? "page" : undefined}
            onClick={item.onClick}
            className={`inline-flex min-h-10 items-center gap-2 rounded-[4px] border px-4 py-2 text-sm font-semibold transition ${
              isActive
                ? "metal-gold border-[#e8b975]/70 text-white shadow-gold"
                : "control-surface border-transparent bg-transparent text-[var(--color-text-muted)] hover:border-gold hover:text-[var(--color-text-main)]"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
