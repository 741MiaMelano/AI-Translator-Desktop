import { FileOutput } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AudioSeparationCapabilityResponse } from "../../../contracts/desktop-api";
import type { Project } from "../../../domain/workspace";
import { localizeIpcError } from "../../../i18n/errors";
import {
  desktopGetAudioSeparationCapability,
  desktopStartAudioSeparation,
} from "../../../services/desktop-client";
import { useWorkspace } from "../../../state/WorkspaceContext";
import Badge from "../../ui/Badge";
import Button from "../../ui/Button";
import Card from "../../ui/Card";
import { describeReasonCode } from "./format";

function PanelMessage({ text, debug, testId }: { text: string; debug?: string; testId?: string }) {
  return (
    <p
      role="status"
      title={debug}
      className="mt-2.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]"
      data-testid={testId}
    >
      {text}
    </p>
  );
}

/** 源字幕导出（仅字幕类项目）。消息只属于这张卡，不再和打包 / 音频分离串味。 */
export function SourceSubtitleExportCard({ project }: { project: Project }) {
  const { exportSourceSubtitle } = useWorkspace();
  const [message, setMessage] = useState<string | null>(null);
  const mayDegrade = ["vtt", "ass", "ssa"].includes(project.sourceProbeSummary?.subtitleFormat ?? "");

  // 这里不写「正在导出…」这类中间态：export-message 是 e2e 的断言目标，
  // 它只应该出现最终结果。
  const runExport = async (mode: "raw" | "normalized", format?: "srt" | "vtt" | "ass") => {
    const result = await exportSourceSubtitle(project.id, mode, format);
    const prefix = mode === "raw" ? "已导出原始副本" : "已导出";
    setMessage(result.ok
      ? result.canceled
        ? "已取消导出"
        : [`${prefix}到你选择的位置：${result.fileName}（已在资源管理器中定位）`, ...result.warnings].join("；")
      : result.message);
  };

  return (
    <Card title="源字幕导出">
      {mayDegrade ? (
        <p
          className="mb-2.5 rounded-[6px] border border-line bg-warn-wash px-2.5 py-2 text-[11.5px] leading-5 text-[var(--color-text-main)]"
          data-testid="normalized-export-warning"
        >
          规范化导出可能降级仅保存在原始字幕中的结构；需要完整保真时请导出原始文件。
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<FileOutput size={16} />} onClick={() => runExport("normalized", "srt")}>
          导出 SRT
        </Button>
        <Button variant="outline" onClick={() => runExport("normalized", "vtt")}>
          导出 VTT
        </Button>
        <Button variant="outline" onClick={() => runExport("normalized", "ass")}>
          导出 ASS
        </Button>
        <Button variant="secondary" onClick={() => runExport("raw")}>
          导出原始文件
        </Button>
      </div>
      {message ? <PanelMessage text={message} testId="export-message" /> : null}
    </Card>
  );
}

/** 项目打包。 */
export function ProjectPackageCard({ project }: { project: Project }) {
  const { createProjectPackage } = useWorkspace();
  const [message, setMessage] = useState<string | null>(null);

  const runPackage = async (kind: "lightweight" | "archive", label: string) => {
    setMessage(`正在生成${label}…`);
    const result = await createProjectPackage(project.id, kind);
    setMessage(result.ok ? `${label}已导出：${result.fileName}` : result.message ?? `${label}导出失败`);
  };

  return (
    <Card
      title="项目打包"
      description="轻量包以无源媒体方式打开；归档包保留项目媒体。默认排除回收站、日志、缓存和凭据。"
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => runPackage("lightweight", "轻量包")}>
          导出轻量包
        </Button>
        <Button variant="secondary" onClick={() => runPackage("archive", "归档包")}>
          导出归档包
        </Button>
      </div>
      {message ? <PanelMessage text={message} /> : null}
    </Card>
  );
}

/**
 * 音频分离（可选）。
 *
 * worker 未安装时不再给一个「点了必定报错」的按钮，而是直接换成前往模型与连接的引导；
 * 失败也只展示中文释义，后端英文原文留在 title 里供排查。
 */
export function AudioSeparationCard({ project, mediaMissing }: { project: Project; mediaMissing: boolean }) {
  const navigate = useNavigate();
  const { setProjectArchived } = useWorkspace();
  const [capability, setCapability] = useState<AudioSeparationCapabilityResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ text: string; debug?: string } | null>(null);

  useEffect(() => {
    let active = true;
    void desktopGetAudioSeparationCapability().then((result) => {
      if (active) setCapability(result.ok ? result.data : null);
    });
    return () => {
      active = false;
    };
  }, [project.id]);

  const start = async () => {
    setRunning(true);
    setMessage({ text: "正在分离音轨，这一步不会阻塞字幕交付…" });
    const result = await desktopStartAudioSeparation({
      projectId: project.id,
      operationId: `audio-separation-${Date.now().toString(36)}`,
    });
    setRunning(false);
    if (result.ok) {
      // 分离产物写在项目目录里，刷新一次项目状态；已归档项目不因此被解除归档
      if (!project.archivedAt) setProjectArchived(project.id, false);
      setMessage({ text: `音频分离完成：${result.data.stems.join(" / ")}` });
      return;
    }
    const localized = localizeIpcError(result.error);
    setMessage({
      text: `音频分离未完成：${localized.title}；字幕交付不受影响`,
      debug: localized.debug,
    });
  };

  return (
    <Card
      title="音频分离（可选）"
      description="独立生成 vocals、accompaniment、background 三类项目产物；不做说话人识别、声纹或配音。失败不会阻塞字幕交付。"
      actions={<Badge tone={capability?.available ? "green" : "gray"}>{capability?.available ? "可用" : "未安装"}</Badge>}
    >
      {capability?.available ? (
        <Button
          variant="outline"
          disabled={running || mediaMissing}
          title={mediaMissing ? "请先重新链接源媒体" : running ? "分离正在进行中" : undefined}
          onClick={start}
        >
          {running ? "正在分离…" : "开始音频分离"}
        </Button>
      ) : (
        <div className="space-y-2">
          <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
            {describeReasonCode(capability?.reason) ?? "尚未安装音频分离组件。"}
          </p>
          <Button variant="outline" onClick={() => navigate("/capabilities")}>
            前往模型与连接安装
          </Button>
        </div>
      )}
      {message ? <PanelMessage text={message.text} debug={message.debug} /> : null}
    </Card>
  );
}
