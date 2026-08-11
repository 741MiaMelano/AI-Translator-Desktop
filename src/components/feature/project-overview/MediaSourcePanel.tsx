import { Layers3 } from "lucide-react";
import { useState } from "react";
import { formatMediaKind, type Project } from "../../../domain/workspace";
import { useWorkspace } from "../../../state/WorkspaceContext";
import Badge from "../../ui/Badge";
import Button from "../../ui/Button";
import Card from "../../ui/Card";
import StatCard from "../../ui/StatCard";
import MediaPreviewFrame from "../MediaPreviewFrame";
import { formatDuration, formatUpdatedAt } from "./format";
import type { MediaProbeSummary } from "./types";

interface MediaSourcePanelProps {
  project: Project;
  mediaProbe?: MediaProbeSummary;
  mediaMissing: boolean;
}

type MediaResult = { ok: boolean; message?: string };

function MediaPreview({
  project,
  mediaMissing,
  previewUrl,
  busy,
  onRelink,
  onLoadPreview,
}: {
  project: Project;
  mediaMissing: boolean;
  previewUrl: string | null;
  busy: string | null;
  onRelink: () => void;
  onLoadPreview: () => void;
}) {
  const { isDesktop } = useWorkspace();

  if (project.noSourceMedia) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line bg-card-soft px-4 py-7 text-center text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        <Layers3 size={20} className="text-gold-dark" />
        <p className="text-[13px] font-medium text-[var(--color-text-main)]">无源媒体项目</p>
        <p>当前围绕字幕编辑和普通导出推进，不依赖媒体预览。</p>
      </div>
    );
  }

  if (mediaMissing) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line bg-card-soft px-4 py-7 text-center text-[11.5px] leading-5 text-[var(--color-text-muted)]"
        data-testid="media-missing-panel"
      >
        <p>媒体源不可用，字幕编辑仍可继续。</p>
        <Button
          variant="primary"
          disabled={Boolean(busy)}
          title={busy ? "已有媒体操作正在执行" : undefined}
          onClick={onRelink}
        >
          {busy === "relink" ? "正在重新关联…" : "重新关联媒体"}
        </Button>
      </div>
    );
  }

  if (previewUrl) {
    return (
      <div className="overflow-hidden rounded-[10px] border border-line bg-black" data-testid="media-preview-player">
        {project.mediaKind === "audio" ? (
          <audio className="w-full" controls src={previewUrl} />
        ) : (
          <video className="aspect-[4/3] w-full" controls src={previewUrl} />
        )}
      </div>
    );
  }

  return (
    <MediaPreviewFrame className="aspect-[4/3] rounded-[10px] border border-line">
      {/* max-h + line-clamp：长文件名和长中文标题不再把「加载预览」顶出画面 */}
      <div className="absolute bottom-3 left-3 right-3 max-h-[62%] overflow-hidden rounded-[6px] bg-black/55 px-3 py-2.5 text-left">
        <div className="line-clamp-2 break-all text-[13px] font-semibold text-white" title={project.title}>
          {project.title}
        </div>
        <div className="mt-0.5 line-clamp-2 break-all text-[11.5px] text-white/75" title={project.sourceFileName}>
          {project.sourceFileName}
        </div>
        {isDesktop ? (
          <Button
            className="mt-2"
            variant="primary"
            disabled={Boolean(busy)}
            title={busy ? "已有媒体操作正在执行" : undefined}
            onClick={onLoadPreview}
          >
            {busy === "preview" ? "正在加载…" : "加载预览"}
          </Button>
        ) : (
          <p className="mt-1.5 text-[11px] text-white/70">浏览器预览（基于扩展名，不含媒体探测）</p>
        )}
      </div>
    </MediaPreviewFrame>
  );
}

function ActiveSourceTrackBlock({
  project,
  mediaProbe,
  busy,
  message,
  runMediaAction,
}: {
  project: Project;
  mediaProbe?: MediaProbeSummary;
  busy: string | null;
  message: string | null;
  runMediaAction: (id: string, progress: string, action: () => Promise<MediaResult>, success: string) => void;
}) {
  const { isDesktop, probeProjectMedia, extractProjectSubtitle, activateProjectSourceTrack } = useWorkspace();
  const activeSourceTrack = project.sourceTracks.find((track) => track.id === project.activeSourceTrackId);
  const extractableStreams =
    mediaProbe?.streams?.filter((stream) => stream.kind === "subtitle" && stream.extractable) ?? [];
  const candidateTracks = project.sourceTracks.filter(
    (track) => !track.isActive && !track.trashedAt && track.kind !== "asr",
  );
  const busyTitle = busy ? "已有媒体操作正在执行" : undefined;

  return (
    <div className="rounded-[6px] border border-line bg-card-soft px-3 py-2.5">
      <p className="text-[11.5px] text-[var(--color-text-muted)]">当前活动源轨</p>
      <p className="mt-1 text-[15px] font-semibold leading-tight text-[var(--color-text-main)]">
        {activeSourceTrack?.label ?? "尚未提取字幕源轨"}
      </p>
      <p className="mt-1 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        {activeSourceTrack?.summary ?? "请先选择可提取文字字幕轨并确认切换。"}
      </p>
      {isDesktop && !project.noSourceMedia ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            data-testid="media-reprobe"
            disabled={Boolean(busy)}
            title={busyTitle}
            onClick={() =>
              runMediaAction("probe", "正在重新探测媒体…", () => probeProjectMedia(project.id), "已重新探测")
            }
          >
            {busy === "probe" ? "正在探测…" : "重新探测"}
          </Button>
          {extractableStreams.map((stream) => (
            <Button
              key={String(stream.streamId)}
              variant="primary"
              data-testid={`extract-stream-${String(stream.streamId)}`}
              disabled={Boolean(busy)}
              title={busyTitle}
              onClick={() =>
                runMediaAction(
                  `extract-${String(stream.streamId)}`,
                  "正在提取字幕轨…",
                  () => extractProjectSubtitle(project.id, String(stream.streamId)),
                  "已提取候选源轨",
                )
              }
            >
              {busy === `extract-${String(stream.streamId)}`
                ? "正在提取…"
                : `提取 ${String(stream.streamId)} · ${String(stream.language ?? "und")} · ${String(stream.codec)}`}
            </Button>
          ))}
          {candidateTracks.map((track) => (
            <Button
              key={track.id}
              variant="primary"
              data-testid={`activate-source-${track.id}`}
              disabled={Boolean(busy)}
              title={busyTitle}
              onClick={() =>
                runMediaAction(
                  `activate-${track.id}`,
                  "正在切换活动源轨…",
                  () => activateProjectSourceTrack(project.id, track.id),
                  "已切换活动源轨",
                )
              }
            >
              {busy === `activate-${track.id}` ? "正在切换…" : `确认切源 ${track.label}`}
            </Button>
          ))}
        </div>
      ) : null}
      {message ? (
        <p
          role="status"
          className="mt-2 text-[11.5px] text-[var(--color-text-muted)]"
          data-testid="media-message"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 媒体预览、探测摘要与活动源轨操作。
 *
 * 这一组按钮全部是 await IPC，长视频上 ffprobe / ffmpeg 抽字幕要数秒到数十秒，
 * 所以共用一个 busy 状态：执行期间整组禁用、当前按钮改文案，避免连点生成重复候选轨。
 */
export default function MediaSourcePanel({ project, mediaProbe, mediaMissing }: MediaSourcePanelProps) {
  const { relinkProjectMedia, getProjectMediaPreviewUrl } = useWorkspace();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const runMediaAction = (
    id: string,
    progress: string,
    action: () => Promise<MediaResult>,
    success: string,
  ) => {
    setBusy(id);
    setMessage(progress);
    void action()
      .then((result) => setMessage(result.ok ? success : result.message ?? "操作失败"))
      .catch(() => setMessage("操作失败，请重试"))
      .finally(() => setBusy(null));
  };

  const loadPreview = () => {
    setBusy("preview");
    setMessage("正在加载媒体预览…");
    void getProjectMediaPreviewUrl(project.id)
      .then((result) => {
        if (result.ok) {
          setPreviewUrl(result.url);
          setMessage(null);
        } else {
          setMessage(result.message);
        }
      })
      .catch(() => setMessage("加载预览失败，请重试"))
      .finally(() => setBusy(null));
  };

  return (
    <Card
      id="project-media-panel"
      title="媒体与源轨"
      description="先确认活动源轨，后面的目标语言交付卡才有时间轴基准。"
    >
      <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
        <MediaPreview
          project={project}
          mediaMissing={mediaMissing}
          previewUrl={previewUrl}
          busy={busy}
          onRelink={() =>
            runMediaAction("relink", "正在重新关联媒体…", () => relinkProjectMedia(project.id), "媒体已重新关联")
          }
          onLoadPreview={loadPreview}
        />

        <div className="min-w-0 space-y-2.5">
          <div className="grid gap-2 sm:grid-cols-3">
            <div data-testid="media-kind-label">
              <StatCard
                label="媒体类型"
                value={formatMediaKind((mediaProbe?.mediaKind as typeof project.mediaKind) || project.mediaKind)}
              />
            </div>
            <div data-testid="media-probe-summary">
              <StatCard
                label="时长 / 轨数"
                value={
                  mediaProbe
                    ? `${formatDuration(mediaProbe.format?.durationMs)} · ${mediaProbe.streams?.length ?? 0} 轨`
                    : "尚未探测"
                }
              />
            </div>
            <StatCard label="最近更新" value={formatUpdatedAt(project.updatedAt)} />
          </div>

          <ActiveSourceTrackBlock
            project={project}
            mediaProbe={mediaProbe}
            busy={busy}
            message={message}
            runMediaAction={runMediaAction}
          />

          <div className="rounded-[6px] border border-line bg-card-soft px-3 py-2.5">
            <p className="mb-1.5 text-[11.5px] text-[var(--color-text-muted)]">目标语言</p>
            <div className="flex flex-wrap gap-1.5">
              {project.config.targetLanguages.length > 0 ? (
                project.config.targetLanguages.map((language) => (
                  <Badge key={language} tone="gold">
                    {language}
                  </Badge>
                ))
              ) : (
                <span className="text-[11.5px] text-[var(--color-text-muted)]">还没有配置目标语言</span>
              )}
            </div>
            {project.notes[0] ? (
              <p className="mt-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">{project.notes[0]}</p>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
