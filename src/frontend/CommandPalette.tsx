import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { countQaIssues, deriveProjectStatusSummary, getActiveTargetTracks, type Project } from "../domain/workspace";
import { useWorkspace } from "../state/WorkspaceContext";
import { projectStageEntry } from "./ProjectWorkspaceNav";
import { useFrontend } from "./state";
import { Icon, type IconName } from "./visuals";

type Command = {
  id: string;
  group: string;
  label: string;
  detail: string;
  icon: IconName;
  hint?: string;
  run: () => void;
};

function matches(query: string, ...fields: string[]) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  return fields.some((field) => field.toLowerCase().includes(needle));
}

export function CommandPalette({ open, onClose, onOpenShortcuts }: {
  open: boolean;
  onClose: () => void;
  onOpenShortcuts: () => void;
}) {
  const app = useFrontend();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const activeProjects = workspace.projects.filter((project) => !project.trashedAt && !project.archivedAt);
  const translationReady = app.readiness.data?.global.capabilities
    .find((item) => item.id === "translation")?.available ?? true;

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    const goTo = (path: string) => () => navigate(path);

    // ① 建议操作回答的是"我现在该干什么"，所以它只由真实状态推导，不摆固定菜单。
    if (!translationReady) {
      list.push({
        id: "suggest-provider",
        group: "建议操作",
        label: "配置翻译服务",
        detail: "还没有可用的翻译 Provider，翻译阶段无法开始",
        icon: "warning",
        run: goTo("/system/providers"),
      });
    }

    const withErrors = activeProjects
      .map((project) => ({ project, errors: countQaIssues(getActiveTargetTracks(project), "error") }))
      .filter((entry) => entry.errors > 0)
      .sort((left, right) => right.errors - left.errors)[0];
    if (withErrors) {
      const target = getActiveTargetTracks(withErrors.project)[0];
      list.push({
        id: "suggest-issues",
        group: "建议操作",
        label: "处理下一处必须问题",
        detail: `「${withErrors.project.title}」还有 ${withErrors.errors} 处必须修复才能交付`,
        icon: "warning",
        run: goTo(`/projects/${withErrors.project.id}/editor/${encodeURIComponent(target.languageCode)}?filter=issues`),
      });
    }

    for (const project of activeProjects.slice(0, 2)) {
      const stage = projectStageEntry(project, workspace.tasks);
      list.push({
        id: `suggest-continue-${project.id}`,
        group: "建议操作",
        label: `继续「${project.title}」`,
        detail: `停在${stage.label} · ${deriveProjectStatusSummary(project).label}`,
        icon: "arrow",
        run: goTo(stage.path),
      });
    }

    list.push({
      id: "suggest-new",
      group: "建议操作",
      label: "开始新翻译",
      detail: "回到工作台选择文件",
      icon: "upload",
      run: goTo("/"),
    });

    for (const project of activeProjects) {
      const stage = projectStageEntry(project, workspace.tasks);
      list.push({
        id: `project-${project.id}`,
        group: "项目",
        label: project.title,
        detail: `${project.sourceFileName} · 停在${stage.label}`,
        icon: "folder",
        run: goTo(stage.path),
      });
    }

    for (const [label, path, icon, detail] of [
      ["工作台", "/", "home", "导入新文件、看最近项目"],
      ["项目", "/workspace", "folder", "全部项目与运行中任务"],
      ["资源库", "/library", "library", "术语表、风格指南、字幕样式、导出预设"],
      ["系统", "/system", "system", "设置、能力与维护"],
      ["批量处理", "/batch/review", "folder", "当前批次的分组与默认值"],
      ["回收站", "/workspace/recycle", "folder", "已移入回收站的项目"],
    ] as Array<[string, string, IconName, string]>) {
      list.push({ id: `go-${path}`, group: "前往", label, detail, icon, run: goTo(path) });
    }

    // ④ 是把后端已有、但界面深处才能到达的能力接回来的最便宜方式。
    list.push(
      {
        id: "action-sound",
        group: "操作",
        label: app.soundEnabled ? "关闭操作音效" : "开启操作音效",
        detail: "只影响本机界面反馈",
        icon: "palette",
        run: app.toggleSound,
      },
      {
        id: "action-shortcuts",
        group: "操作",
        label: "快捷键速查",
        detail: "查看并切换三套键位预设",
        icon: "edit",
        hint: "?",
        run: onOpenShortcuts,
      },
      {
        id: "action-appearance",
        group: "操作",
        label: "外观与声音",
        detail: "皮肤、音效、动效与减少动态",
        icon: "palette",
        run: goTo("/system/settings?tab=appearance"),
      },
      {
        id: "action-provider",
        group: "操作",
        label: "翻译 Provider 与凭据",
        detail: "连接、测试与模型清单",
        icon: "system",
        run: goTo("/system/providers"),
      },
      {
        id: "action-asr",
        group: "操作",
        label: "本机语音识别维护",
        detail: "模型安装、运行时与设备检测",
        icon: "system",
        run: goTo("/system/asr"),
      },
      {
        id: "action-storage",
        group: "操作",
        label: "模型与文件位置",
        detail: "缓存、模型目录与整体转移",
        icon: "file",
        run: goTo("/system/settings?tab=storage"),
      },
      {
        id: "action-backup",
        group: "操作",
        label: "应用备份与脱敏诊断包",
        detail: "备份、预检恢复、导出诊断",
        icon: "file",
        run: goTo("/system/settings?tab=backup"),
      },
    );

    return list;
  }, [activeProjects, app.soundEnabled, app.toggleSound, navigate, onOpenShortcuts, translationReady, workspace.tasks]);

  const visible = useMemo(
    () => commands.filter((command) => matches(query, command.label, command.detail, command.group)),
    [commands, query],
  );

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-command-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, visible.length]);

  if (!open) return null;

  const close = () => {
    onClose();
    // Esc 关闭并归还焦点：从哪儿打开的就回哪儿去。
    restoreFocusRef.current?.focus();
  };

  const runCommand = (command: Command) => {
    close();
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      return close();
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!visible.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      return setActiveIndex((current) => (current + step + visible.length) % visible.length);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const command = visible[activeIndex];
      if (command) runCommand(command);
    }
  };

  let index = -1;
  const groups = ["建议操作", "项目", "前往", "操作"]
    .map((group) => ({ group, items: visible.filter((command) => command.group === group) }))
    .filter((entry) => entry.items.length);

  return (
    <div className="command-layer" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
      <div className="command-panel" role="dialog" aria-modal="true" aria-label="命令面板" onKeyDown={onKeyDown}>
        <div className="command-input">
          <Icon name="search"/>
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="搜索项目或命令"
            aria-label="搜索项目或命令"
            aria-controls="command-results"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="command-close-btn" onClick={close} aria-label="关闭命令面板" title="关闭 (Esc)"><Icon name="close"/></button>
        </div>
        <div id="command-results" ref={listRef} role="listbox" aria-label="命令结果">
          {groups.map((entry) => (
            <div className={`command-group ${entry.group === "前往" ? "command-pages" : ""}`} key={entry.group}>
              <small>{entry.group}</small>
              {entry.items.map((command) => {
                index += 1;
                const position = index;
                return (
                  <button
                    type="button"
                    key={command.id}
                    role="option"
                    aria-selected={position === activeIndex}
                    className={position === activeIndex ? "is-active" : ""}
                    data-command-index={position}
                    onMouseMove={() => setActiveIndex(position)}
                    onClick={() => runCommand(command)}
                  >
                    <Icon name={command.icon}/>
                    <span><strong>{command.label}</strong><em>{command.detail}</em></span>
                    {command.hint ? <kbd>{command.hint}</kbd> : null}
                  </button>
                );
              })}
            </div>
          ))}
          {!visible.length ? <div className="command-group"><small>没有匹配项</small></div> : null}
        </div>
        <footer>
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </footer>
      </div>
    </div>
  );
}
