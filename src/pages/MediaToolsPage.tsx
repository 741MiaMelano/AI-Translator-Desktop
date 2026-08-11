import { AudioLines, Captions, Mic, TimerReset, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import EmptyState from "../components/ui/EmptyState";
import { getActiveProjects, getActiveSourceTrack, type Project } from "../domain/workspace";
import PageHeader from "../layout/PageHeader";
import { useWorkspace } from "../state/WorkspaceContext";

type MediaTool = "audio" | "embedded" | "asr" | "timing";

const MEDIA_ACCEPT = ".mp4,.mkv,.mov,.avi,.webm,.mp3,.wav,.m4a,.flac,.aac,.ogg";
const SUBTITLE_ACCEPT = ".srt,.vtt,.ass,.ssa";

function hasMediaStream(project: Project, kind: "audio" | "subtitle") {
  const streams = project.sourceProbeSummary?.media?.streams;
  return Array.isArray(streams) && streams.some((stream) => (
    typeof stream === "object"
    && stream !== null
    && (stream as { kind?: unknown }).kind === kind
    && (kind !== "subtitle" || (stream as { extractable?: unknown }).extractable === true)
  ));
}

function timingTarget(project: Project) {
  const source = getActiveSourceTrack(project);
  if (!source?.segments.length) return null;
  return source.targetTracks.find((track) => track.isActive && !track.trashedAt) ?? null;
}

function ToolCard({
  testId,
  icon,
  title,
  description,
  actionLabel,
  disabled,
  disabledReason,
  busy,
  onRun,
  onImport,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  onRun: () => void;
  onImport: () => void;
}) {
  return (
    <Card data-testid={testId} className="h-full">
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="rounded-[7px] border border-line bg-card-soft p-2 text-gold-dark">{icon}</span>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-main)]">{title}</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{description}</p>
          </div>
        </div>
        {disabledReason ? <p className="text-[11.5px] text-[var(--color-text-muted)]">{disabledReason}</p> : null}
        <div className="mt-auto flex flex-wrap gap-2">
          <Button variant="primary" disabled={disabled || busy} onClick={onRun}>
            {busy ? "处理中…" : actionLabel}
          </Button>
          <Button icon={<Upload size={14} />} disabled={busy} onClick={onImport}>
            选择新文件
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function MediaToolsPage() {
  const navigate = useNavigate();
  const { projects, importFiles, exportProjectAudio, isDesktop } = useWorkspace();
  const activeProjects = getActiveProjects(projects);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [busyTool, setBusyTool] = useState<MediaTool | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [audioProjectId, setAudioProjectId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingImportTool = useRef<MediaTool>("audio");
  const selectedProject = activeProjects.find((project) => project.id === selectedProjectId)
    ?? activeProjects[0]
    ?? null;

  const runTool = async (tool: MediaTool, projectId: string, project: Project | null = selectedProject) => {
    if (tool === "audio") {
      setBusyTool(tool);
      setMessage("正在提取 WAV 音频…");
      const result = await exportProjectAudio(projectId);
      setBusyTool(null);
      if (!result.ok) return setMessage(result.message ?? "音频提取失败");
      if (result.canceled) return setMessage("已取消音频提取");
      setAudioProjectId(projectId);
      return setMessage(`已提取 ${result.fileName ?? "WAV 音频"}，并在资源管理器中定位。`);
    }
    if (tool === "embedded") return navigate(`/projects/${projectId}?focus=media`);
    if (tool === "asr") return navigate(`/projects/${projectId}?focus=asr`);
    const target = project && timingTarget(project);
    return navigate(target
      ? `/projects/${projectId}/editor/${target.languageCode}?mode=source`
      : `/projects/${projectId}`);
  };

  const chooseFile = (tool: MediaTool) => {
    pendingImportTool.current = tool;
    if (inputRef.current) {
      inputRef.current.accept = tool === "timing" ? `${SUBTITLE_ACCEPT},${MEDIA_ACCEPT}` : MEDIA_ACCEPT;
      inputRef.current.click();
    }
  };

  const importForTool = async (files: File[]) => {
    if (!files.length) return;
    const tool = pendingImportTool.current;
    setBusyTool(tool);
    setMessage("正在创建轻量项目…");
    const result = await importFiles(files);
    setBusyTool(null);
    if (result.status === "review") return navigate("/batch/review");
    if (result.status !== "imported" || !result.projectIds[0]) return setMessage("文件导入失败，请检查格式后重试。");
    const projectId = result.projectIds[0];
    setSelectedProjectId(projectId);
    await runTool(tool, projectId, null);
  };

  const audioReady = Boolean(selectedProject?.mediaSource?.confirmedAudioStreamId
    ?? selectedProject?.mediaSource?.selectedAudioStreamId);
  const embeddedReady = Boolean(selectedProject && hasMediaStream(selectedProject, "subtitle"));
  const asrReady = Boolean(selectedProject && hasMediaStream(selectedProject, "audio"));
  const timingReady = Boolean(selectedProject && timingTarget(selectedProject));

  return (
    <>
      <PageHeader
        title="媒体工具"
        description="复用项目里的媒体与字幕能力；新文件会先创建轻量项目，之后仍可继续翻译。"
      />

      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept={MEDIA_ACCEPT}
        onChange={(event) => {
          void importForTool(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      {activeProjects.length ? (
        <Card className="mb-4" dense>
          <label className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-muted)]">
            复用现有项目
            <select
              aria-label="媒体工具项目"
              className="h-8 min-w-[260px] rounded-[6px] border border-line bg-card px-2.5 text-[13px] text-[var(--color-text-main)]"
              value={selectedProject?.id ?? ""}
              onChange={(event) => {
                setSelectedProjectId(event.target.value);
                setMessage(null);
                setAudioProjectId(null);
              }}
            >
              {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
            </select>
            <span className="break-all">{selectedProject?.sourceFileName}</span>
          </label>
        </Card>
      ) : (
        <div className="mb-4">
          <EmptyState
            icon={<Upload size={20} />}
            title="还没有可复用的项目"
            description="直接在下面任一工具里选择文件，系统会先创建一个轻量项目。"
          />
        </div>
      )}

      {message ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[8px] border border-line bg-card-soft px-3 py-2 text-xs text-[var(--color-text-main)]" role="status">
          <span>{message}</span>
          {audioProjectId ? (
            <Button size="sm" variant="secondary" onClick={() => navigate(`/projects/${audioProjectId}`)}>
              继续翻译
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <ToolCard
          testId="media-tool-audio"
          icon={<AudioLines size={19} />}
          title="提取音频"
          description="从视频或音频的已选主音轨导出标准 WAV 文件。"
          actionLabel="提取音频"
          disabled={!isDesktop || !audioReady}
          disabledReason={!isDesktop ? "请在桌面应用中使用。" : !audioReady ? "当前项目没有可用音频流，也可以直接选择新文件。" : undefined}
          busy={busyTool === "audio"}
          onRun={() => selectedProject && void runTool("audio", selectedProject.id)}
          onImport={() => chooseFile("audio")}
        />
        <ToolCard
          testId="media-tool-embedded"
          icon={<Captions size={19} />}
          title="提取内嵌字幕"
          description="打开项目现有的字幕流选择与提取面板。"
          actionLabel="打开提取字幕"
          disabled={!selectedProject || !embeddedReady}
          disabledReason={!embeddedReady ? "当前项目没有可提取的内嵌字幕，也可以选择新视频。" : undefined}
          busy={busyTool === "embedded"}
          onRun={() => selectedProject && void runTool("embedded", selectedProject.id)}
          onImport={() => chooseFile("embedded")}
        />
        <ToolCard
          testId="media-tool-asr"
          icon={<Mic size={19} />}
          title="视频/音频转字幕"
          description="进入现有本地 ASR 流程，识别、分段后可直接继续翻译。"
          actionLabel="打开语音识别"
          disabled={!selectedProject || !asrReady}
          disabledReason={!asrReady ? "当前项目没有可识别的音频流，也可以选择新文件。" : undefined}
          busy={busyTool === "asr"}
          onRun={() => selectedProject && void runTool("asr", selectedProject.id)}
          onImport={() => chooseFile("asr")}
        />
        <ToolCard
          testId="media-tool-timing"
          icon={<TimerReset size={19} />}
          title="字幕校时"
          description="进入现有源字幕编辑模式，调整时间轴后可继续翻译。"
          actionLabel="打开字幕校时"
          disabled={!selectedProject || !timingReady}
          disabledReason={!timingReady ? "当前项目还没有可编辑字幕，也可以选择字幕文件。" : undefined}
          busy={busyTool === "timing"}
          onRun={() => selectedProject && void runTool("timing", selectedProject.id)}
          onImport={() => chooseFile("timing")}
        />
      </div>
    </>
  );
}
