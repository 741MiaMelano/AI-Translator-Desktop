import {
  getActiveSourceTrack,
  resolveAsrLanguageSelection,
  type Project,
  type Segment,
  type SourceTrack,
} from "./workspace.ts";
import { analyzeSourceQuality } from "./source-quality.ts";

export type WorkflowBlockReason =
  | "task_running"
  | "connect_provider"
  | "choose_target_language"
  | "inspect_source"
  | "relink_media"
  | "choose_subtitle"
  | "choose_audio"
  | "no_audio"
  | "install_asr"
  | "confirm_languages"
  | "missing_source";

export type AutomaticWorkflowStage =
  | "checking"
  | "extracting"
  | "recognizing"
  | "segmenting"
  | "detecting_language"
  | "activating"
  | "starting_translation";

export interface AutomaticWorkflowState {
  status: "running" | "blocked" | "queued" | "failed" | "cancelled" | "awaiting_translation";
  message: string;
  stage?: AutomaticWorkflowStage;
  operationId?: string;
  reason?: WorkflowBlockReason;
  actionLabel?: string;
  actionRoute?: string;
  startedAt?: number;
  resolution?: AutomaticWorkflowResolution;
}

export interface AutomaticWorkflowChoice {
  value: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

export type AutomaticWorkflowResolution =
  | {
      kind: "stream";
      streamKind: "audio" | "subtitle";
      prompt: string;
      choices: AutomaticWorkflowChoice[];
    }
  | {
      kind: "language";
      sourceTrackId: string;
      segmentIds: string[];
      prompt: string;
      choices: AutomaticWorkflowChoice[];
      samples: string[];
    };

export type AutomaticWorkflowAnswer =
  | { kind: "stream"; streamKind: "audio" | "subtitle"; value: string }
  | { kind: "language"; sourceTrackId: string; value: string };

export type AutomaticWorkflowStep =
  | { kind: "translate" }
  | { kind: "extract_subtitle"; streamId: string }
  | { kind: "check_asr" }
  | { kind: "run_asr"; audioStreamId: string }
  | { kind: "segment_asr"; asrRunId: string }
  | { kind: "detect_languages"; sourceTrackId: string }
  | { kind: "activate_source"; sourceTrackId: string }
  | {
      kind: "blocked";
      reason: WorkflowBlockReason;
      message: string;
      actionLabel: string;
      actionRoute: string;
      resolution?: AutomaticWorkflowResolution;
    };

export interface AutomaticWorkflowFacts {
  providerConfigured: boolean;
  hasLiveTask: boolean;
  asrChecked: boolean;
  asrReady: boolean;
  latestAsrRunId: string | null;
  allowUnsafeSource?: boolean;
}

type MediaStream = {
  streamId: string;
  kind: "audio" | "subtitle";
  extractable: boolean;
  default: boolean;
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  channels: number | null;
};

function mediaStreams(project: Project): MediaStream[] {
  const streams = project.sourceProbeSummary?.media?.streams;
  if (!Array.isArray(streams)) return [];
  return streams.flatMap((stream, fallbackIndex) => {
    if (!stream || typeof stream !== "object") return [];
    const value = stream as Record<string, unknown>;
    if (typeof value.streamId !== "string" || (value.kind !== "audio" && value.kind !== "subtitle")) return [];
    return [{
      streamId: value.streamId,
      kind: value.kind,
      extractable: value.extractable === true,
      default: value.default === true,
      index: Number.isSafeInteger(value.index) ? Number(value.index) : fallbackIndex,
      codec: typeof value.codec === "string" ? value.codec : null,
      language: typeof value.language === "string" ? value.language : null,
      title: typeof value.title === "string" ? value.title : null,
      channels: Number.isSafeInteger(value.channels) ? Number(value.channels) : null,
    }];
  });
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: "英语",
  eng: "英语",
  zh: "中文",
  zho: "中文",
  chi: "中文",
  ja: "日语",
  jpn: "日语",
  ko: "韩语",
  kor: "韩语",
};

function languageLabel(code: string | null) {
  if (!code || code === "und") return "未标注语言";
  return LANGUAGE_LABELS[code.toLowerCase()] ?? code;
}

function streamResolution(kind: "audio" | "subtitle", streams: MediaStream[]): AutomaticWorkflowResolution {
  return {
    kind: "stream",
    streamKind: kind,
    prompt: kind === "audio" ? "这段内容来自哪条音轨？" : "使用哪条字幕？",
    choices: streams.map((stream) => ({
      value: stream.streamId,
      label: `${kind === "audio" ? "音轨" : "字幕"} ${stream.index + 1} · ${languageLabel(stream.language)}`,
      detail: [
        stream.title,
        stream.codec?.toUpperCase(),
        kind === "audio" && stream.channels
          ? stream.channels === 1 ? "单声道" : stream.channels === 2 ? "双声道" : `${stream.channels} 声道`
          : null,
      ].filter(Boolean).join(" · ") || "没有更多说明",
    })),
  };
}

function unambiguousStream(
  project: Project,
  kind: "audio" | "subtitle",
): { state: "none" | "ambiguous" | "selected"; streamId?: string; candidates?: MediaStream[] } {
  const candidates = mediaStreams(project).filter(
    (stream) => stream.kind === kind && (kind !== "subtitle" || stream.extractable),
  );
  if (candidates.length === 0) return { state: "none" };
  if (candidates.length === 1) return { state: "selected", streamId: candidates[0].streamId };
  const confirmedId = kind === "audio"
    ? project.mediaSource?.confirmedAudioStreamId
    : project.mediaSource?.confirmedSubtitleStreamId;
  if (confirmedId && candidates.some((stream) => stream.streamId === confirmedId)) {
    return { state: "selected", streamId: confirmedId };
  }
  const defaults = candidates.filter((stream) => stream.default);
  if (defaults.length === 1) return { state: "selected", streamId: defaults[0].streamId };
  return { state: "ambiguous", candidates };
}

function latestAsrCandidate(project: Project, asrRunId: string | null): SourceTrack | undefined {
  const candidates = project.sourceTracks.filter(
    (track) => track.kind === "asr" && track.asrRunId === asrRunId
      && !track.isActive && !track.trashedAt && track.segments.length > 0,
  );
  return candidates[candidates.length - 1];
}

function latestEmbeddedSubtitleCandidate(project: Project): SourceTrack | undefined {
  const candidates = project.sourceTracks.filter(
    (track) => track.kind === "embedded_subtitle" && !track.isActive && !track.trashedAt && track.segments.length > 0,
  );
  return candidates[candidates.length - 1];
}

function block(
  project: Project,
  reason: WorkflowBlockReason,
  resolution?: AutomaticWorkflowResolution,
): AutomaticWorkflowStep {
  const copy: Record<WorkflowBlockReason, [string, string, string]> = {
    task_running: ["这个项目已有任务在运行，完成或取消后再继续。", "查看进度", `/projects/${project.id}`],
    connect_provider: ["先连接当前翻译 Provider，系统才会开始后续处理。", "配置翻译 Provider", "/system/providers"],
    choose_target_language: ["至少选择一个目标语言。", "设置语言", `/?projectId=${encodeURIComponent(project.id)}`],
    inspect_source: ["源字幕疑似损坏，需要先检查后才能安全翻译。", "检查源字幕", `/projects/${project.id}`],
    relink_media: ["媒体文件已移动或不可读取。", "重新关联媒体", `/projects/${project.id}`],
    choose_subtitle: ["检测到多条同等可用的字幕轨，需要你选择一条。", "选择字幕轨", `/projects/${project.id}`],
    choose_audio: ["检测到多条同等可用的音轨，需要你确认说话内容所在的音轨。", "选择音频轨", `/projects/${project.id}?focus=asr`],
    no_audio: ["媒体里没有可用于语音识别的音轨。", "检查媒体", `/projects/${project.id}`],
    install_asr: ["本地语音识别组件尚未就绪。", "安装语音识别模型", "/system/asr"],
    confirm_languages: ["有些字幕段的语言置信度不足，需要你确认后再翻译。", "确认原文语言", `/projects/${project.id}?focus=asr`],
    missing_source: ["没有找到可翻译的字幕内容。", "重新导入", "/"],
  };
  const [message, actionLabel, actionRoute] = copy[reason];
  return { kind: "blocked", reason, message, actionLabel, actionRoute, ...(resolution ? { resolution } : {}) };
}

function uncertainLanguageSegments(track: SourceTrack): Segment[] {
  return track.segments.filter((segment) =>
    !segment.manualLanguage && Boolean(segment.detectedLanguage) && (
      segment.sourceLanguage === "und"
      || segment.languageOverlapStatus === "overlap_unsupported"
      || (segment.languageConfidence ?? 0) < 0.8
    ),
  );
}

function languageResolution(project: Project, track: SourceTrack, segments: Segment[]): AutomaticWorkflowResolution {
  const usableSuggestions = segments.filter((segment) =>
    segment.detectedLanguage && segment.detectedLanguage !== "und"
    && segment.languageOverlapStatus !== "overlap_unsupported",
  );
  const detected = new Set(usableSuggestions.map((segment) => segment.detectedLanguage!.toLowerCase()));
  const fixed = resolveAsrLanguageSelection(project.config.sourceLanguage).languageHint;
  const suggested = fixed ?? (usableSuggestions.length === segments.length && detected.size === 1
    ? [...detected][0]
    : null);
  const codes = [suggested, "en", "zh", "ja", "ko"]
    .filter((code): code is string => Boolean(code))
    .filter((code, index, all) => all.indexOf(code) === index);
  return {
    kind: "language",
    sourceTrackId: track.id,
    segmentIds: segments.map((segment) => segment.id),
    prompt: "这些不确定的片段主要是什么语言？",
    choices: codes.map((code) => ({
      value: code,
      label: languageLabel(code),
      recommended: code === suggested,
    })),
    samples: segments.slice(0, 3).map((segment) => segment.sourceText.normalized || segment.sourceText.original),
  };
}

/** Decide exactly one resumable step; every completed step is persisted before planning again. */
export function planAutomaticWorkflow(project: Project, facts: AutomaticWorkflowFacts): AutomaticWorkflowStep {
  if (facts.hasLiveTask) return block(project, "task_running");
  if (!facts.providerConfigured) return block(project, "connect_provider");
  if (project.config.targetLanguages.length === 0) return block(project, "choose_target_language");

  const source = getActiveSourceTrack(project);
  if (source?.segments.length) {
    if (analyzeSourceQuality(source.segments) && !facts.allowUnsafeSource) {
      return block(project, "inspect_source");
    }
    return { kind: "translate" };
  }
  if (project.noSourceMedia) return block(project, "missing_source");
  if (project.mediaSource?.availability !== "available") return block(project, "relink_media");

  const embeddedCandidate = latestEmbeddedSubtitleCandidate(project);
  if (embeddedCandidate) return { kind: "activate_source", sourceTrackId: embeddedCandidate.id };

  const subtitle = unambiguousStream(project, "subtitle");
  if (subtitle.state === "selected") return { kind: "extract_subtitle", streamId: subtitle.streamId! };
  if (subtitle.state === "ambiguous") {
    return block(project, "choose_subtitle", streamResolution("subtitle", subtitle.candidates!));
  }

  const candidate = latestAsrCandidate(project, facts.latestAsrRunId);
  if (candidate) {
    const needsDetection = candidate.segments.some(
      (segment) => segment.sourceLanguage === "und" && !segment.detectedLanguage,
    );
    if (needsDetection) {
      if (!facts.asrChecked) return { kind: "check_asr" };
      if (!facts.asrReady) return block(project, "install_asr");
      return { kind: "detect_languages", sourceTrackId: candidate.id };
    }
    const uncertain = uncertainLanguageSegments(candidate);
    if (uncertain.length) {
      return block(project, "confirm_languages", languageResolution(project, candidate, uncertain));
    }
    return { kind: "activate_source", sourceTrackId: candidate.id };
  }

  if (facts.latestAsrRunId) return { kind: "segment_asr", asrRunId: facts.latestAsrRunId };
  const audio = unambiguousStream(project, "audio");
  if (audio.state === "ambiguous") {
    return block(project, "choose_audio", streamResolution("audio", audio.candidates!));
  }
  if (audio.state === "none") return block(project, "no_audio");
  if (!facts.asrChecked) return { kind: "check_asr" };
  if (!facts.asrReady) return block(project, "install_asr");
  return { kind: "run_asr", audioStreamId: audio.streamId! };
}
