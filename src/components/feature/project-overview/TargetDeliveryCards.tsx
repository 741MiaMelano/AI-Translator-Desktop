import { CheckCircle2, FileOutput, Languages, Layers3, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  formatTargetTrackStatus,
  isActionableQaIssue,
  type Project,
  type SourceTrack,
  type TargetTrack,
} from "../../../domain/workspace";
import { useWorkspace } from "../../../state/WorkspaceContext";
import Badge from "../../ui/Badge";
import Button from "../../ui/Button";
import Card from "../../ui/Card";
import EmptyState from "../../ui/EmptyState";
import StatCard from "../../ui/StatCard";
import { RetranslateButton } from "./ProjectLifecycleActions";

interface TargetDeliveryCardsProps {
  project: Project;
  activeTargets: TargetTrack[];
  activeSourceTrack: SourceTrack | null;
  mediaMissing: boolean;
  /** 展开右侧「项目配置」卡的编辑区，供空状态直接引导 */
  onOpenConfig: () => void;
}

function trackTone(status: string): "green" | "gold" | "gray" {
  if (status === "approved" || status === "exported") return "green";
  if (status === "in_review") return "gold";
  return "gray";
}

function DeliveryCard({
  project,
  track,
  activeSourceTrack,
  mediaMissing,
  onMessage,
}: {
  project: Project;
  track: TargetTrack;
  activeSourceTrack: SourceTrack | null;
  mediaMissing: boolean;
  onMessage: (message: string) => void;
}) {
  const navigate = useNavigate();
  const { isDesktop, markTargetTrackStatus, exportTargetTrack, exportSubtitleMatrix, exportSubtitleVideo } = useWorkspace();
  const visibleIssues = track.qaIssues.filter(isActionableQaIssue);
  const warnings = visibleIssues.filter((issue) => issue.severity === "warning").length;
  const errors = visibleIssues.filter((issue) => issue.severity === "error").length;
  const approved = track.status === "approved" || track.status === "exported";
  const canExport = approved && errors === 0;

  return (
    <div className="min-w-0 rounded-[10px] border border-line bg-card-soft p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold leading-tight text-[var(--color-text-main)]">
            {track.languageLabel}
          </p>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">{track.deliveryLabel}</p>
        </div>
        <Badge tone={trackTone(track.status)}>{formatTargetTrackStatus(track.status)}</Badge>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <StatCard label="优化建议" value={String(warnings)} tone={warnings > 0 ? "text-warn" : undefined} />
        <StatCard label="必须修复" value={String(errors)} tone={errors > 0 ? "text-stop" : undefined} />
      </div>

      {/* flex-wrap 而不是 sm:grid-cols-3：1280 最小窗口下这张卡只有 244px 宽，
          三等分会把「编辑 / 批准 / 导出」的图标和文字左右各裁掉一截。 */}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          variant="outline"
          icon={<Languages size={16} />}
          disabled={!activeSourceTrack}
          title={!activeSourceTrack ? "请先提取并确认字幕源轨" : undefined}
          onClick={() => navigate(`/projects/${project.id}/editor/${track.languageCode}`)}
        >
          编辑
        </Button>
        {/*
          两个重跑入口是两件事，用户两种都要过：
          「重新翻译」= 就用现在这套配置再来一遍（配置没问题、只是想要另一版译文）；
          「换模型重译」= 先去换服务商或模型（对当前模型的结果不满意）。
          旧版只有后者，于是「我就想重做一次」得先绕去开始翻译页。
        */}
        <RetranslateButton project={project} size="md" />
        <Button
          variant="outline"
          icon={<RefreshCw size={16} />}
          title="回到开始翻译，换服务商或模型后重新翻译这个项目"
          onClick={() => navigate(`/?projectId=${encodeURIComponent(project.id)}`)}
        >
          换模型重译
        </Button>
        <Button
          variant={approved ? "secondary" : "primary"}
          icon={<CheckCircle2 size={16} />}
          disabled={approved || errors > 0}
          title={errors > 0 ? `存在 ${errors} 个必须修复的问题，处理后才能批准` : approved ? "该目标轨已批准" : undefined}
          onClick={() => {
            const result = markTargetTrackStatus(project.id, track.languageCode, "approved");
            if (!result.ok) onMessage(result.message ?? "批准失败");
          }}
        >
          {approved ? "已批准" : "批准"}
        </Button>
        <Button
          variant="dark"
          icon={<FileOutput size={16} />}
          disabled={!canExport}
          title={errors > 0 ? `存在 ${errors} 个必须修复的问题，处理后才能导出` : !approved ? "请先明确批准译文" : undefined}
          onClick={async () => {
            const result = await exportTargetTrack(project.id, track.languageCode);
            onMessage(
              result.canceled
                ? "已取消导出"
                : result.ok
                ? `已保存到你选择的文件夹：${result.summary?.succeeded[0]?.fileName ?? track.languageLabel}（已在资源管理器中定位）`
                : result.message ?? "导出失败",
            );
          }}
        >
          {track.status === "exported" ? "再次导出" : "导出"}
        </Button>
        <Button
          variant="outline"
          disabled={!canExport}
          title={errors > 0 ? `存在 ${errors} 个必须修复的问题，处理后才能导出` : !approved ? "请先明确批准译文" : undefined}
          onClick={async () => {
            const result = await exportSubtitleMatrix(project.id, [{
              id: `bilingual-${track.languageCode}`,
              exportKind: "bilingual",
              targetLanguageCode: track.languageCode,
              format: "srt",
            }]);
            const succeeded = result.ok ? result.summary.succeeded[0] : undefined;
            onMessage(
              result.ok && result.summary.canceled
                ? "已取消导出"
                : succeeded
                  ? `双语字幕已保存到你选择的位置：${succeeded.fileName}`
                  : result.ok ? "双语字幕导出失败" : result.message,
            );
          }}
        >
          导出双语字幕
        </Button>
        {isDesktop && project.mediaKind === "video" ? (
          <>
            <Button
              variant="outline"
              disabled={!canExport || mediaMissing}
              title={mediaMissing ? "请先重新链接源媒体" : errors > 0 ? "存在必须修复的问题，处理后才能导出" : !approved ? "请先明确批准译文" : undefined}
              onClick={async () => {
                const result = await exportSubtitleVideo(project.id, track.languageCode, "soft_subtitle");
                onMessage(result.canceled
                  ? "已取消导出"
                  : result.ok
                    ? `软字幕视频已保存到你选择的位置：${result.fileName}（已在资源管理器中定位）`
                    : result.message ?? "软字幕封装失败");
              }}
            >
              软字幕封装
            </Button>
            <Button
              variant="outline"
              disabled={!canExport || mediaMissing}
              title={mediaMissing ? "请先重新链接源媒体" : errors > 0 ? "存在必须修复的问题，处理后才能导出" : !approved ? "请先明确批准译文" : undefined}
              onClick={async () => {
                const result = await exportSubtitleVideo(project.id, track.languageCode, "burn_ass");
                onMessage(
                  result.canceled
                    ? "已取消导出"
                    : result.ok
                      ? `ASS 烧录视频已保存到你选择的位置：${result.fileName}（已在资源管理器中定位）`
                      : result.message ?? "ASS 烧录失败；字幕文件仍保留",
                );
              }}
            >
              ASS 烧录
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function DeliveryEmptyState({
  hasSourceTrack,
  onOpenConfig,
}: {
  hasSourceTrack: boolean;
  onOpenConfig: () => void;
}) {
  if (!hasSourceTrack) {
    return (
      <EmptyState
        icon={<Layers3 size={20} />}
        title="还没有活动源轨"
        description="交付卡以活动源轨的时间轴为基准。请先在上面的「媒体与源轨」里重新探测、提取并确认一条字幕源轨。"
        action={
          <Button
            variant="secondary"
            onClick={() =>
              document.getElementById("project-media-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            前往源轨设置
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={<Languages size={20} />}
      title="还没有目标语言"
      description="源轨已就位，但项目配置里还没有勾选任何目标语言，所以没有可交付对象。"
      action={
        <Button variant="primary" onClick={onOpenConfig}>
          打开项目配置
        </Button>
      }
    />
  );
}

/** 目标语言交付卡矩阵。每个目标语言是独立交付对象，各自有状态、QA 摘要和导出入口。 */
export default function TargetDeliveryCards({
  project,
  activeTargets,
  activeSourceTrack,
  mediaMissing,
  onOpenConfig,
}: TargetDeliveryCardsProps) {
  const [message, setMessage] = useState<string | null>(null);

  return (
    <Card
      title="目标语言交付卡"
      description="每种语言可分别检查、批准和导出；优化建议不会阻止交付。"
    >
      {activeTargets.length > 0 ? (
        <div className="grid gap-3 2xl:grid-cols-2">
          {activeTargets.map((track) => (
            <DeliveryCard
              key={track.id}
              project={project}
              track={track}
              activeSourceTrack={activeSourceTrack}
              mediaMissing={mediaMissing}
              onMessage={setMessage}
            />
          ))}
        </div>
      ) : (
        <DeliveryEmptyState hasSourceTrack={Boolean(activeSourceTrack)} onOpenConfig={onOpenConfig} />
      )}
      {message ? (
        <p
          role="status"
          className="mt-2.5 text-[11.5px] text-[var(--color-text-muted)]"
          data-testid="target-delivery-message"
        >
          {message}
        </p>
      ) : null}
    </Card>
  );
}
