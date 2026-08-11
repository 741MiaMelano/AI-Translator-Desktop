import { useState } from "react";
import type { Project, SourceTrack } from "../../../domain/workspace";
import { useWorkspace } from "../../../state/WorkspaceContext";
import Badge from "../../ui/Badge";
import Button from "../../ui/Button";
import Card from "../../ui/Card";
import ConfirmDialog from "./ConfirmDialog";
import { describeReasonCode } from "./format";

interface TrackTrashPanelProps {
  project: Project;
}

type TrashMessage = { text: string; tone: "ok" | "error" };

type TrashedEntry = {
  key: string;
  kind: "source" | "target";
  id: string;
  label: string;
  /** 目标轨所属源轨也在回收站时不能单独恢复 */
  blockedBy?: string;
};

function LiveSourceRow({
  projectId,
  source,
  isActive,
  onResult,
}: {
  projectId: string;
  source: SourceTrack;
  isActive: boolean;
  onResult: (result: { ok: boolean; message?: string }, success: string) => void;
}) {
  const { trashProjectSourceTrack, trashProjectTargetTrack } = useWorkspace();
  const liveTargets = source.targetTracks.filter((track) => !track.trashedAt);

  return (
    <div className="rounded-[6px] border border-line bg-card-soft p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-[var(--color-text-main)]">
          源轨：{source.label}
        </span>
        <Button
          variant="secondary"
          disabled={isActive}
          title={isActive ? "当前主源轨必须先切换后才能删除" : "移入回收站后仍可恢复"}
          onClick={() => onResult(trashProjectSourceTrack(projectId, source.id), "源轨已移入回收站")}
        >
          移入回收站
        </Button>
      </div>
      {liveTargets.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {liveTargets.map((track) => (
            <Button
              key={track.id}
              variant="secondary"
              title="移入回收站后仍可恢复"
              onClick={() => onResult(trashProjectTargetTrack(projectId, track.id), "目标轨已移入回收站")}
            >
              删除目标轨 {track.languageLabel}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TrashedRow({
  entry,
  onRestore,
}: {
  entry: TrashedEntry;
  onRestore: (entry: TrashedEntry) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border border-line bg-card-soft p-2.5">
      <span className="min-w-0 text-[13px] text-[var(--color-text-main)]">
        {entry.kind === "source" ? "已删除源轨" : "已删除目标轨"}：{entry.label}
      </span>
      <Button
        variant="outline"
        disabled={Boolean(entry.blockedBy)}
        title={entry.blockedBy ? `请先恢复所属源轨「${entry.blockedBy}」` : undefined}
        onClick={() => onRestore(entry)}
      >
        恢复
      </Button>
    </div>
  );
}

/**
 * 轨道回收站。
 *
 * 「移入回收站 / 删除目标轨」可恢复，用 secondary；
 * 「永久清空」不可恢复，用 danger 并走应用内的二次确认，
 * 不再和「恢复」一样是同款 ghost。
 */
export default function TrackTrashPanel({ project }: TrackTrashPanelProps) {
  const { restoreProjectSourceTrack, restoreProjectTargetTrack, emptyProjectTrackTrash } = useWorkspace();
  const [message, setMessage] = useState<TrashMessage | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const liveSources = project.sourceTracks.filter((track) => !track.trashedAt);
  const trashedEntries: TrashedEntry[] = [
    ...project.sourceTracks
      .filter((track) => track.trashedAt)
      .map((track) => ({ key: `source-${track.id}`, kind: "source" as const, id: track.id, label: track.label })),
    ...project.sourceTracks.flatMap((source) =>
      source.targetTracks
        .filter((track) => track.trashedAt)
        .map((track) => ({
          key: `target-${track.id}`,
          kind: "target" as const,
          id: track.id,
          label: `${source.label} / ${track.languageLabel}`,
          blockedBy: source.trashedAt ? source.label : undefined,
        })),
    ),
  ];

  const handleResult = (result: { ok: boolean; message?: string }, success: string) => {
    setMessage(
      result.ok
        ? { text: success, tone: "ok" }
        : { text: describeReasonCode(result.message) ?? "操作失败", tone: "error" },
    );
  };

  const handleRestore = (entry: TrashedEntry) => {
    handleResult(
      entry.kind === "source"
        ? restoreProjectSourceTrack(project.id, entry.id)
        : restoreProjectTargetTrack(project.id, entry.id),
      "已从回收站恢复",
    );
  };

  return (
    <Card
      title="轨道回收站"
      description="当前主源轨和最后一条源轨受保护；删除非主源轨会连同其目标轨进入回收站。"
      actions={<Badge tone={trashedEntries.length > 0 ? "red" : "gray"}>{trashedEntries.length}</Badge>}
    >
      <div className="space-y-2">
        {liveSources.map((source) => (
          <LiveSourceRow
            key={source.id}
            projectId={project.id}
            source={source}
            isActive={source.id === project.activeSourceTrackId || source.isActive}
            onResult={handleResult}
          />
        ))}

        {trashedEntries.map((entry) => (
          <TrashedRow key={entry.key} entry={entry} onRestore={handleRestore} />
        ))}

        {message ? (
          <p
            role={message.tone === "error" ? "alert" : "status"}
            className={`text-[11.5px] leading-5 ${
              message.tone === "error" ? "text-stop" : "text-[var(--color-text-muted)]"
            }`}
          >
            {message.text}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            variant="danger"
            disabled={trashedEntries.length === 0}
            title={trashedEntries.length === 0 ? "回收站是空的" : "清空后无法恢复"}
            onClick={() => setConfirmOpen(true)}
          >
            永久清空轨道回收站
          </Button>
          <span className="text-[11.5px] text-[var(--color-text-muted)]">清空后这些轨道及其译文无法恢复。</span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title="永久清空轨道回收站"
        description={`将永久删除回收站里的 ${trashedEntries.length} 条轨道及其译文，且无法恢复。`}
        confirmLabel="永久删除"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          handleResult(emptyProjectTrackTrash(project.id), "轨道回收站已清空");
        }}
      />
    </Card>
  );
}
