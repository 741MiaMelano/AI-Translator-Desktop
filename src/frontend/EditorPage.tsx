import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  getActiveSourceTrack,
  isActionableQaIssue,
  type Segment,
  type TargetTextLayers,
} from "../domain/workspace";
import { createDefaultSubtitleStyle, type AssTextStyle, type BilingualLayout, type SubtitleStylePayload } from "../domain/resource-library";
import { useWorkspace } from "../state/WorkspaceContext";
import { MediaTimeline } from "./MediaTimeline";
import { useProjectStage } from "./ProjectWorkspace";
import { eventChord, isBareKey, KEYMAP_BY_ID, resolveAction, type ShortcutAction } from "./shortcuts";
import { useFrontend } from "./state";
import { Icon, ThemeVisualizer } from "./visuals";

function sourceText(segment: Segment) {
  return segment.sourceText.manual ?? segment.sourceText.normalized ?? segment.sourceText.original;
}

function targetText(value: TargetTextLayers | undefined) {
  return value?.manual ?? value?.postProcessed ?? value?.model ?? "";
}

function parseTimestamp(value: string) {
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

function segmentRange(segment: Segment) {
  const start = parseTimestamp(segment.start);
  const end = parseTimestamp(segment.end);
  return start === null || end === null ? null : { start, end };
}

function formatTimestamp(milliseconds: number) {
  const safe = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function formatClock(milliseconds: number) {
  const safe = Math.max(0, milliseconds) / 1000;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  const ss = seconds.toFixed(1).padStart(4, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function issueTone(issues: Array<{ severity: string }>) {
  if (issues.some((issue) => issue.severity === "error")) return "error";
  if (issues.some((issue) => issue.severity === "warning")) return "suggestion";
  return "pass";
}

function subtitleLineStyle(style: AssTextStyle): CSSProperties {
  const w = Math.max(0, style.outlineWidthPx);
  const shadows: string[] = [];
  if (w > 0) {
    for (const [x, y] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]] as const) {
      shadows.push(`${(x * w).toFixed(1)}px ${(y * w).toFixed(1)}px 0 ${style.outlineColor}`);
    }
  }
  if (style.shadowDepthPx > 0) shadows.push(`0 ${style.shadowDepthPx}px ${style.shadowDepthPx + 3}px ${style.shadowColor}`);
  return {
    fontFamily: style.fontFamily,
    fontSize: `calc(${(style.fontSizePx / 1920) * 100} * 1cqw)`,
    color: style.textColor,
    textShadow: shadows.join(", ") || undefined,
  };
}

// 段列表宽度可微调；媒体不再参与列宽竞争，所以这里限制的是列表而不是媒体。
const LIST_PANEL_LIMIT = { min: 220, max: 480, fallback: 290 } as const;
const REFERENCE_WIDTH = 260;
const SPEED_OPTIONS = [0.5, 1, 1.5, 2];
const FONT_OPTIONS = ["Arial", "Microsoft YaHei UI", "SimHei", "KaiTi", "Times New Roman", "Consolas"];
const POSITION_OPTIONS: Array<{ value: AssTextStyle["position"]; label: string }> = [
  { value: "top", label: "上" },
  { value: "center", label: "中" },
  { value: "bottom", label: "下" },
];
const LAYOUT_OPTIONS: Array<{ value: BilingualLayout; label: string }> = [
  { value: "target_only", label: "仅译文" },
  { value: "source_top_target_bottom", label: "原文在上" },
  { value: "target_top_source_bottom", label: "译文在上" },
];
const SEGMENT_TICK_CAP = 400;

type EditTab = "qa" | "timeline" | "candidate";
type WaveformState = "idle" | "loading" | "ready" | "error";

export function EditorPage() {
  const { targetLanguage = "" } = useParams();
  const { project } = useProjectStage();
  const workspace = useWorkspace();
  const app = useFrontend();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedSegmentId = searchParams.get("segmentId");
  const source = getActiveSourceTrack(project);
  const target = source?.targetTracks.find((track) => track.isActive && track.languageCode === targetLanguage);
  const candidate = source?.targetTracks.find((track) => track.role === "candidate" && track.baseTrackId === target?.id && !track.trashedAt);
  const issues = (target?.qaIssues ?? []).filter(isActionableQaIssue);
  const keymap = KEYMAP_BY_ID[app.keymap];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 交付阶段的"建议 N 去看"和"预览最终效果"要能直接落到编辑器的对应状态。
  const [filter, setFilter] = useState<"all" | "issues">(searchParams.get("filter") === "issues" ? "issues" : "all");
  const [editTab, setEditTab] = useState<EditTab>("qa");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"rerun" | "candidate" | null>(null);
  const [preview, setPreview] = useState<{ url: string; mediaKind: string } | null>(null);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [waveform, setWaveform] = useState<{ durationMs: number; peaks: number[] } | null>(null);
  const [waveformState, setWaveformState] = useState<WaveformState>("idle");
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [mediaDurationMs, setMediaDurationMs] = useState(0);
  const [videoRatio, setVideoRatio] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState(searchParams.get("preview") === "1");
  // 原文字幕默认跟随译文：绝大多数人只想调一次。解锁后才独立可调。
  // 这是界面偏好，不是项目数据，所以留在组件里。
  const [sourceStyleLinked, setSourceStyleLinked] = useState(true);
  const [referenceOpen, setReferenceOpen] = useState(true);
  const [waveformOpen, setWaveformOpen] = useState(true);
  // 专注模式：只留当前段编辑区，参考栏和段列表一起让开。
  const [focusMode, setFocusMode] = useState(false);
  const [loopSegment, setLoopSegment] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [listWidth, setListWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  const [columnsWidth, setColumnsWidth] = useState(0);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const targetTextRef = useRef<HTMLTextAreaElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const columnsWrapRef = useRef<HTMLDivElement>(null);
  const segmentListRef = useRef<HTMLDivElement>(null);
  const editorFocusRef = useRef(false);
  // 监听器挂一次即可；真正的动作在每次渲染后写进这个 ref，避免每次状态变化都重挂键盘监听。
  const runShortcutRef = useRef<(action: ShortcutAction) => void>(() => {});
  const waveformSeqRef = useRef(0);

  const seekToSegment = useCallback((segmentId: string | null) => {
    if (!segmentId || !source) return;
    const segment = source.segments.find((entry) => entry.id === segmentId);
    const range = segment ? segmentRange(segment) : null;
    if (range && mediaRef.current) mediaRef.current.currentTime = range.start / 1000;
  }, [source]);

  const selectSegment = useCallback((segmentId: string | null, seek: boolean) => {
    setSelectedId(segmentId);
    if (seek) seekToSegment(segmentId);
  }, [seekToSegment]);

  useEffect(() => {
    const requested = source?.segments.find((segment) => segment.id === requestedSegmentId)?.id;
    if (requested && requested !== selectedId) {
      selectSegment(requested, true);
      return;
    }
    if (!source?.segments.some((segment) => segment.id === selectedId)) setSelectedId(source?.segments[0]?.id ?? null);
  }, [requestedSegmentId, selectedId, source, selectSegment]);

  useEffect(() => {
    if (project.noSourceMedia || !workspace.isDesktop) {
      setPreview(null);
      return;
    }
    let active = true;
    let attempts = 0;
    let timer: number | null = null;
    const load = async () => {
      const result = await workspace.getProjectMediaPreviewUrl(project.id);
      if (!active) return;
      if (result.ok) {
        setPreview({ url: result.url, mediaKind: result.mediaKind });
        return;
      }
      // 后端服务启动较慢时首次调用可能失败，做有限次自动重试后再报错
      if (++attempts < 6) {
        timer = window.setTimeout(() => void load(), 3000);
        return;
      }
      setActionError(result.message);
    };
    void load();
    return () => { active = false; if (timer !== null) window.clearTimeout(timer); };
  }, [project.id, project.noSourceMedia, workspace.isDesktop, app.readiness.loading]);

  const loadWaveform = useCallback(async () => {
    if (project.noSourceMedia || !workspace.isDesktop) {
      setWaveform(null);
      setWaveformState("idle");
      return;
    }
    const seq = ++waveformSeqRef.current;
    setWaveformState("loading");
    setWaveformError(null);
    let result = await workspace.getProjectMediaWaveform(project.id);
    // 启动初期后端未就绪时自动重试几次，仍失败才展示错误与手动重试
    for (let attempt = 0; !result.ok && attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (seq !== waveformSeqRef.current) return;
      result = await workspace.getProjectMediaWaveform(project.id);
    }
    if (seq !== waveformSeqRef.current) return;
    if (result.ok) {
      setWaveform({ durationMs: result.durationMs, peaks: result.peaks });
      setWaveformState("ready");
    } else {
      setWaveform(null);
      setWaveformError(result.message ?? "波形生成失败");
      setWaveformState("error");
    }
  }, [project.id, project.noSourceMedia, workspace.isDesktop, app.readiness.loading]);

  useEffect(() => {
    void loadWaveform();
  }, [loadWaveform]);

  useEffect(() => {
    if (!previewMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewMode]);

  // 键位按当前预设走。焦点规则也必须按预设走，不能全局一套：
  //   · 无修饰键的单字母只在焦点不在文本输入里时生效，否则打不了字；
  //   · 带修饰键的组合始终生效；
  //   · 例外是 Aegisub 那套的 Enter——"提交并跳下一条"就是要在编辑框里按的，
  //     那是它的全部意义，所以它反过来只在输入框内生效。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = resolveAction(keymap, eventChord(event));
      if (!action) return;
      const inText = event.target instanceof HTMLElement
        && (event.target.isContentEditable || Boolean(event.target.closest("input, textarea, select")));
      if (action === "commitNext") {
        if (!inText) return;
      } else if (inText && isBareKey(keymap.bindings[action]?.chord ?? "")) {
        return;
      }
      event.preventDefault();
      runShortcutRef.current(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keymap]);

  useEffect(() => {
    if (!selectedId) return;
    const scroller = segmentListRef.current;
    const item = scroller?.querySelector(`[data-segment-id="${CSS.escape(selectedId)}"]`);
    if (!scroller || !item) return;
    const sRect = scroller.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    if (iRect.top < sRect.top) scroller.scrollTop -= sRect.top - iRect.top;
    else if (iRect.bottom > sRect.bottom) scroller.scrollTop += iRect.bottom - sRect.bottom;
  }, [selectedId]);

  useEffect(() => {
    const measure = () => {
      setViewportH(window.innerHeight);
      setColumnsWidth(columnsWrapRef.current?.getBoundingClientRect().width ?? 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [workspace.loadState, project.id]);

  const segments = useMemo(() => {
    const all = source?.segments ?? [];
    return filter === "issues" ? all.filter((segment) => issues.some((issue) => issue.segmentId === segment.id)) : all;
  }, [filter, issues, source]);
  const selected = source?.segments.find((segment) => segment.id === selectedId) ?? source?.segments[0];
  const selectedIndex = selected ? source?.segments.findIndex((segment) => segment.id === selected.id) ?? 0 : 0;
  const selectedIssues = selected ? issues.filter((issue) => issue.segmentId === selected.id) : [];
  const selectedTarget = selected && target ? selected.targetTexts[target.languageCode] : undefined;
  const candidateText = selected && candidate ? targetText(candidate.candidateTexts?.[selected.id]) : "";
  const undoCount = project.editorHistory?.undoStack.length ?? 0;
  const redoCount = project.editorHistory?.redoStack.length ?? 0;
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const activeTab: EditTab = editTab === "candidate" && !candidate ? "qa" : editTab;

  const durationMs = waveform?.durationMs ?? mediaDurationMs;
  const activeSegment = useMemo(() => {
    if (!source || !durationMs) return null;
    return source.segments.find((segment) => {
      const range = segmentRange(segment);
      return range && playheadMs >= range.start && playheadMs < range.end;
    }) ?? null;
  }, [source, playheadMs, durationMs]);
  // 参考栏的小画面只在有视频时叠字幕；预览模式则始终叠，否则没有东西可以对照判断样式。
  // 但回退到"选中那一条"只能在暂停时做：播放中无条件回退，等于字幕永远不消失——
  // 一句说完就该空屏，人不说话画面上不该还挂着上一句。
  const overlayCandidate = activeSegment ?? (mediaPlaying ? null : selected) ?? null;
  const overlaySegment = previewMode
    ? overlayCandidate
    : preview && preview.mediaKind !== "audio" ? overlayCandidate : null;

  const issueSegmentIds = useMemo(() => {
    if (!source) return [] as string[];
    const flagged = new Set(issues.map((issue) => issue.segmentId));
    return source.segments.filter((segment) => flagged.has(segment.id)).map((segment) => segment.id);
  }, [issues, source]);

  const segmentRanges = useMemo(() => {
    if (!source) return [] as Array<{ id: string; start: number; end: number }>;
    return source.segments.slice(0, SEGMENT_TICK_CAP).flatMap((segment) => {
      const range = segmentRange(segment);
      return range ? [{ id: segment.id, start: range.start, end: range.end }] : [];
    });
  }, [source]);

  const handleTimeUpdate = (element: HTMLVideoElement | HTMLAudioElement) => {
    const ms = element.currentTime * 1000;
    if (loopSegment && selected) {
      const range = segmentRange(selected);
      if (range && ms >= range.end) {
        element.currentTime = range.start / 1000;
        setPlayheadMs(range.start);
        return;
      }
    }
    setPlayheadMs(ms);
    if (editorFocusRef.current) return;
    const active = source?.segments.find((segment) => {
      const range = segmentRange(segment);
      return range && ms >= range.start && ms < range.end;
    });
    if (active && active.id !== selectedId) setSelectedId(active.id);
  };

  const seekToMs = (ms: number) => {
    if (!mediaRef.current || !durationMs) return;
    const clamped = Math.max(0, Math.min(durationMs, ms));
    mediaRef.current.currentTime = clamped / 1000;
    setPlayheadMs(clamped);
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const column = handle.previousElementSibling as HTMLElement | null;
    const startWidth = column?.getBoundingClientRect().width ?? 0;
    const startX = event.clientX;
    handle.setPointerCapture(event.pointerId);
    setResizing(true);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const next = Math.round(startWidth + (moveEvent.clientX - startX));
      setListWidth(Math.max(LIST_PANEL_LIMIT.min, Math.min(LIST_PANEL_LIMIT.max, next)));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setResizing(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 24 : -24;
    setListWidth((current) => Math.max(LIST_PANEL_LIMIT.min, Math.min(LIST_PANEL_LIMIT.max, (current ?? LIST_PANEL_LIMIT.fallback) + delta)));
  };

  if (workspace.loadState === "loading") return <div className="page-stage secondary-page"><div className="production-empty project-loading"><span className="empty-seal">··</span><div><strong>正在读取字幕编辑器</strong><p>等待项目和任务状态完成恢复。</p></div></div></div>;
  if (!source || !target) return <div className="project-stage-body"><div className="production-empty panel-empty"><span className="empty-seal">—</span><div><strong>无法打开目标字幕轨</strong><p>活动源轨或该目标语言不存在；没有自动改用其它轨道。</p></div></div></div>;

  const apply = (result: { ok: boolean; message?: string }, success: string) => {
    if (!result.ok) {
      setActionError(result.message ?? "操作没有完成");
      return false;
    }
    setActionError(null);
    setActionStatus(success);
    app.play("click");
    return true;
  };

  const goBack = async () => {
    if (workspace.isDesktop && !(await workspace.flushBeforeClose())) {
      setActionError("项目尚未保存，已留在编辑器中；请重试。");
      return;
    }
    navigate(`/projects/${project.id}`);
  };

  const runTimeline = (command: Parameters<typeof workspace.editTimeline>[1], success: string) => apply(workspace.editTimeline(project.id, command), success);

  const splitSelected = () => {
    if (!selected) return;
    const range = segmentRange(selected);
    if (!range) return setActionError("当前时间码无效，不能拆分。");
    runTimeline({ kind: "split", segmentId: selected.id, atTimestamp: formatTimestamp(range.start + (range.end - range.start) / 2) }, "已在当前段中点拆分");
  };

  // 拆分会用两个新 id 替换当前段，所以自己提供 idFactory：否则选中的 id 消失后
  // 编辑器会退回第一段，用户被弹到列表顶端。
  const splitAtCaret = () => {
    if (!selected) return;
    const element = targetTextRef.current;
    const text = targetText(selectedTarget);
    const offset = element?.selectionStart ?? 0;
    if (!element || offset <= 0 || offset >= text.length) {
      return setActionError("把光标放在译文中间再拆分：光标左右都要有文字。");
    }
    const stamp = Date.now().toString(36);
    const ids = [`segment-${stamp}-a`, `segment-${stamp}-b`];
    let handed = 0;
    const ok = runTimeline({
      kind: "split_text",
      segmentId: selected.id,
      atTimestamp: formatTimestamp(playheadMs),
      languageCode: target.languageCode,
      targetText: text,
      targetOffset: offset,
      idFactory: () => ids[handed++] ?? `segment-${stamp}-${handed}`,
    }, "已按光标拆成两段；译文与原文都已切开");
    if (ok) setSelectedId(ids[0]);
  };

  const mergeNext = () => {
    if (!selected) return;
    const index = source.segments.findIndex((segment) => segment.id === selected.id);
    const next = source.segments[index + 1];
    if (!next) return setActionError("当前已经是最后一段。");
    runTimeline({ kind: "merge", leftSegmentId: selected.id, rightSegmentId: next.id }, "已与下一段合并");
  };

  const replace = (event: FormEvent) => {
    event.preventDefault();
    if (!findText) return setActionError("先填写要查找的文字。");
    const result = workspace.replaceTargetTexts(project.id, target.languageCode, findText, replaceText);
    if (apply(result, `已替换 ${result.replacedCount ?? 0} 处；跳过 ${result.skippedLockedCount ?? 0} 个锁定段`)) setFindText("");
  };

  const paidAction = async () => {
    if (!selected || !confirmAction) return;
    const action = confirmAction;
    setConfirmAction(null);
    setActionStatus(action === "rerun" ? "已提交所选字幕重译任务" : "已提交完整候选翻译任务");
    const result = action === "rerun"
      ? await workspace.rerunSegment(project.id, target.languageCode, selected.id)
      : await workspace.createCandidateTranslation(project.id, target.languageCode);
    if (!result.ok) setActionError(result.message ?? "翻译任务没有开始");
    else app.play("success");
  };

  const approve = () => {
    const refreshed = workspace.refreshTargetTrackQa(project.id, target.languageCode);
    if (!refreshed.ok) return apply(refreshed, "");
    const approved = workspace.markTargetTrackStatus(project.id, target.languageCode, "approved");
    if (apply(approved, "已明确批准当前目标字幕轨")) navigate(`/projects/${project.id}/deliver`);
  };

  const stepSegment = (direction: -1 | 1) => {
    const index = source.segments.findIndex((segment) => segment.id === selected?.id);
    const next = source.segments[Math.max(0, Math.min(source.segments.length - 1, index + direction))];
    if (next) selectSegment(next.id, true);
  };

  const stepIssue = (direction: -1 | 1) => {
    if (!issueSegmentIds.length) return;
    const currentIndex = issueSegmentIds.indexOf(selected?.id ?? "");
    const nextIndex = currentIndex === -1
      ? (direction === 1 ? 0 : issueSegmentIds.length - 1)
      : (currentIndex + direction + issueSegmentIds.length) % issueSegmentIds.length;
    selectSegment(issueSegmentIds[nextIndex], true);
  };

  // 预览模式里 ◄► 默认按"有问题的段"步进：进预览的人在做整体验收，
  // 逐条走 200 段没意义，走 26 条建议才有意义。按住 Shift 走全部段。
  const stepPreview = (direction: -1 | 1, allSegments: boolean) => {
    if (allSegments || !issueSegmentIds.length) stepSegment(direction);
    else stepIssue(direction);
  };

  const togglePlay = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play();
    else media.pause();
  };

  const playFromSegment = () => {
    if (!selected || !mediaRef.current) return;
    seekToSegment(selected.id);
    void mediaRef.current.play();
  };

  const cycleSpeed = () => {
    const next = SPEED_OPTIONS[(SPEED_OPTIONS.indexOf(speed) + 1) % SPEED_OPTIONS.length];
    setSpeed(next);
    if (mediaRef.current) mediaRef.current.playbackRate = next;
    app.play("click");
  };

  // 穿梭：连按加速，反向即反向，K 归零——照 Final Cut Pro 的行为，不是播放/暂停开关。
  const shuttle = (direction: -1 | 1 | 0) => {
    const media = mediaRef.current;
    if (!media) return;
    if (direction === 0) return media.pause();
    const next = Math.min(8, media.paused || Math.sign(speed) !== direction ? 1 : speed * 2);
    setSpeed(next);
    media.playbackRate = next;
    if (direction === -1) media.currentTime = Math.max(0, media.currentTime - next);
    if (media.paused) void media.play();
  };

  const nudge = (edge: "start" | "end", deltaMs: number) => {
    if (!selected) return;
    runTimeline({ kind: "nudge", segmentId: selected.id, edge, deltaMs }, `${edge === "start" ? "开始" : "结束"}时间${deltaMs > 0 ? "后移" : "前移"} ${Math.abs(deltaMs)}ms`);
  };

  runShortcutRef.current = (action: ShortcutAction) => {
    const step = keymap.nudgeStepMs;
    if (action === "playPause") return togglePlay();
    if (action === "prevSegment") return stepSegment(-1);
    if (action === "nextSegment" || action === "commitNext") return stepSegment(1);
    if (action === "shuttleBack") return shuttle(-1);
    if (action === "shuttleForward") return shuttle(1);
    if (action === "shuttleStop") return shuttle(0);
    if (action === "loopSegment") return setLoopSegment((value) => !value);
    if (action === "nudgeStartBack") return nudge("start", -step);
    if (action === "nudgeStartForward") return nudge("start", step);
    if (action === "nudgeEndBack") return nudge("end", -step);
    if (action === "nudgeEndForward") return nudge("end", step);
    if (action === "adopt") {
      if (!candidate || !selected || !candidateText) return;
      return void apply(workspace.adoptCandidateText(project.id, candidate.id, selected.id), "已采纳当前候选");
    }
    if (action === "toggleReference") return setReferenceOpen((open) => !open);
    if (action === "toggleWaveform") return setWaveformOpen((open) => !open);
    if (action === "previewMode") return setPreviewMode((open) => !open);
    if (action === "focusMode") return setFocusMode((open) => !open);
    if (action === "undo") return void workspace.undoProjectEdit(project.id);
    if (action === "redo") return void workspace.redoProjectEdit(project.id);
  };

  const changeVolume = (value: number) => {
    setVolume(value);
    if (mediaRef.current) {
      mediaRef.current.volume = value;
      mediaRef.current.muted = value === 0;
    }
  };

  const toggleFullscreen = () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.requestFullscreen().catch(() => setActionError("无法进入全屏播放。"));
    app.play("toggle");
  };

  const pipSupported = typeof document !== "undefined" && document.pictureInPictureEnabled;
  const togglePictureInPicture = async () => {
    const media = mediaRef.current;
    if (!(media instanceof HTMLVideoElement)) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await media.requestPictureInPicture();
      app.play("toggle");
    } catch {
      setActionError("当前环境不支持画中画。");
    }
  };

  const subtitleStyle = project.config.subtitleStyle ?? createDefaultSubtitleStyle();
  const patchStyle = (mutate: (draft: SubtitleStylePayload) => void) => {
    const next = JSON.parse(JSON.stringify(subtitleStyle)) as SubtitleStylePayload;
    mutate(next);
    workspace.updateProjectConfig(project.id, { subtitleStyle: next });
  };

  const selectedRange = selected ? segmentRange(selected) : null;
  const overlayTarget = overlaySegment && target ? targetText(overlaySegment.targetTexts[target.languageCode]) : "";
  const overlaySource = overlaySegment ? sourceText(overlaySegment) : "";
  const overlayPrimary = overlayTarget || overlaySource;
  const overlaySecondary = subtitleStyle.bilingualLayout === "target_only" ? "" : overlaySource;
  const columnsStyle = {
    "--w-reference": referenceOpen ? `${REFERENCE_WIDTH}px` : "0px",
    "--w-list": `${listWidth ?? LIST_PANEL_LIMIT.fallback}px`,
  } as CSSProperties;

  // 当前段度量：紧贴译文输入框，取代原来那一整列检查器。
  const targetValue = targetText(selectedTarget);
  const segmentSeconds = selectedRange ? (selectedRange.end - selectedRange.start) / 1000 : 0;
  const readingSpeed = segmentSeconds > 0 ? targetValue.replace(/\s/g, "").length / segmentSeconds : null;
  const targetLineCount = targetValue ? targetValue.split("\n").length : 0;
  const stageStyle = videoRatio && preview?.mediaKind !== "audio" ? ({ aspectRatio: String(videoRatio) } as CSSProperties) : undefined;

  const mediaEvents = {
    onPlay: () => setMediaPlaying(true),
    onPause: () => setMediaPlaying(false),
    onEnded: () => setMediaPlaying(false),
    onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => handleTimeUpdate(event.currentTarget),
    onSeeked: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => handleTimeUpdate(event.currentTarget),
    onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => {
      const element = event.currentTarget;
      setMediaDurationMs(element.duration * 1000);
      element.playbackRate = speed;
      element.volume = volume;
      if (element instanceof HTMLVideoElement && element.videoWidth && element.videoHeight) {
        setVideoRatio(element.videoWidth / element.videoHeight);
      }
    },
  };

  const renderEditCard = () => {
    if (!selected) return null;
    return (
      <div className="segment-edit-card">
        <div className="segment-edit-card-head">
          <span title={`内部标识 ${selected.id}`}>字幕 #{String(selectedIndex + 1).padStart(3, "0")}</span>
          <time>{selected.start} → {selected.end}</time>
        </div>
        <div className="segment-edit-grid">
          <div className="source-block">
            <label htmlFor="source-text">原文</label>
            <textarea
              id="source-text"
              value={sourceText(selected)}
              onChange={(event) => workspace.updateSourceSegmentManual(project.id, selected.id, event.target.value || undefined)}
              onFocus={() => { editorFocusRef.current = true; }}
              onBlur={() => { editorFocusRef.current = false; }}
              disabled={!workspace.isDesktop}
            />
          </div>
          <div className="target-block">
            <div className="target-block-head">
              <label htmlFor="target-text">译文</label>
              <span className={`state-tag ${selectedTarget?.locked ? "waiting" : "done"}`}>{selectedTarget?.locked ? "已保护" : "可编辑"}</span>
              <button
                type="button"
                className={`lock-button ${selectedTarget?.locked ? "is-locked" : ""}`}
                onClick={() => apply(workspace.setTargetSegmentLocked(project.id, target.languageCode, selected.id, !selectedTarget?.locked), selectedTarget?.locked ? "已解锁当前段" : "已锁定当前段")}
                disabled={!workspace.isDesktop}
              >{selectedTarget?.locked ? "已锁定" : "锁定"}</button>
            </div>
            <textarea
              id="target-text"
              ref={targetTextRef}
              value={targetText(selectedTarget)}
              onChange={(event) => apply(workspace.updateSegmentTranslation(project.id, target.languageCode, selected.id, event.target.value), "修改已进入自动保存")}
              onFocus={() => { editorFocusRef.current = true; }}
              onBlur={() => { editorFocusRef.current = false; }}
              disabled={!workspace.isDesktop || selectedTarget?.locked}
            />
            {/* 当前段度量：原来这些数字在一整列检查器里，离编辑区两列远，而它们描述的正是你此刻在改的这一段。 */}
            <div className="segment-metrics" aria-label="当前段度量">
              <span><em>{readingSpeed === null ? "—" : readingSpeed.toFixed(1)}</em>字/秒</span>
              <span><em>{targetValue.length}</em>字符</span>
              <span><em>{targetLineCount}</em>行</span>
              <span><em>{segmentSeconds ? segmentSeconds.toFixed(1) : "—"}</em>秒</span>
              {candidate ? <span><em>{candidateText ? 1 : 0}</em>候选</span> : null}
            </div>
            <div className="target-footer-meta">
              <small>人工译文与锁定状态会覆盖模型结果</small>
              {/* 一句太长的字幕在这里就地切开——这是编辑译文时才知道该在哪切。 */}
              <button type="button" className="text-button" onClick={splitAtCaret} disabled={!workspace.isDesktop || selectedTarget?.locked} title="在光标处把这一段切成两段：译文、原文和时间轴一起切">按光标拆分</button>
              <button type="button" className="text-button" onClick={() => setConfirmAction("rerun")} disabled={!workspace.isDesktop || selectedTarget?.locked}>重译所选段</button>
            </div>
          </div>
        </div>
        <div className="segment-edit-tabs" role="tablist" aria-label="当前段工具">
          <button type="button" role="tab" aria-selected={activeTab === "qa"} onClick={() => setEditTab("qa")}>QA{selectedIssues.length ? `（${selectedIssues.length}）` : ""}</button>
          <button type="button" role="tab" aria-selected={activeTab === "timeline"} onClick={() => setEditTab("timeline")}>时间轴</button>
          {candidate ? <button type="button" role="tab" aria-selected={activeTab === "candidate"} onClick={() => setEditTab("candidate")}>候选</button> : null}
        </div>
        <div className="segment-edit-panel">
          {activeTab === "qa" ? (
            selectedIssues.length ? selectedIssues.map((issue, index) => (
              <div className="issue-callout" key={index}>
                <span><Icon name="warning"/></span>
                <div><strong>{issue.label}</strong><p>{issue.detail}</p></div>
              </div>
            )) : (
              <div className="issue-callout is-clear">
                <span><Icon name="check"/></span>
                <div><strong>当前段没有 QA 标记</strong><p>修改后可随时重新计算 QA。</p></div>
              </div>
            )
          ) : null}
          {activeTab === "timeline" ? (
            <section className="timeline-tools">
              <strong>时间轴微调（全部可撤销）</strong>
              <div>
                <button type="button" onClick={() => runTimeline({ kind: "nudge", segmentId: selected.id, edge: "start", deltaMs: -100 }, "开始时间前移 100ms")}>起点 −100</button>
                <button type="button" onClick={() => runTimeline({ kind: "nudge", segmentId: selected.id, edge: "end", deltaMs: 100 }, "结束时间后移 100ms")}>终点 +100</button>
                <button type="button" onClick={() => runTimeline({ kind: "shift", segmentId: selected.id, deltaMs: -500 }, "整段前移 500ms")}>整段 −500</button>
                <button type="button" onClick={() => runTimeline({ kind: "shift", segmentId: selected.id, deltaMs: 500 }, "整段后移 500ms")}>整段 +500</button>
                <button type="button" onClick={splitSelected} title="只切时间：后半段留空，用来给漏掉的台词腾出位置。要连文字一起切请用译文下方的“按光标拆分”。">中点拆分（只切时间）</button>
                <button type="button" onClick={mergeNext}>合并下一段</button>
              </div>
            </section>
          ) : null}
          {activeTab === "candidate" && candidate ? (
            <div className="candidate-callout">
              <div><strong>候选译文</strong><p>{candidateText || "候选任务尚未返回这一段"}</p></div>
              <button type="button" className="btn btn-secondary" disabled={!candidateText || selectedTarget?.locked} onClick={() => apply(workspace.adoptCandidateText(project.id, candidate.id, selected.id), "已采纳当前候选")}>采纳</button>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  // 预览模式是一个独立模式，不是"媒体列变宽"。放大时用户在做的事变了——他在看效果，
  // 不在改字，此时段列表和参考栏都是干扰。画面受高度约束，所以右侧样式面板不占画面尺寸。
  if (previewMode) {
    return (
      <div className="project-stage-body qa-page is-preview-mode" data-fr02-view="editor-preview">
        <header className="preview-header">
          <div><h2>预览与字幕样式</h2><p>{project.title} · {target.languageLabel}</p></div>
          <button type="button" className="btn btn-secondary" onClick={() => { setPreviewMode(false); app.play("navigate"); }}><Icon name="collapse"/> 退出预览（Esc）</button>
        </header>

        <div className="preview-body">
          <div className="preview-stage-wrap">
            <div className={`media-stage ${preview?.mediaKind === "audio" ? "is-audio" : ""}`} style={stageStyle}>
              {preview ? (preview.mediaKind === "audio"
                ? <>
                  <audio ref={mediaRef as RefObject<HTMLAudioElement>} src={preview.url} preload="metadata" {...mediaEvents}/>
                  <div className="media-stage-glyph" aria-hidden="true"><Icon name="file"/><span>{project.sourceFileName}</span></div>
                </>
                : <video ref={mediaRef as RefObject<HTMLVideoElement>} className="production-media" src={preview.url} preload="metadata" onClick={togglePlay} onDoubleClick={toggleFullscreen} {...mediaEvents}/>)
                : <div className="media-stage-glyph" aria-hidden="true"><Icon name="file"/><span>没有可用预览</span></div>}
              {overlaySegment && overlayPrimary ? (
                <div className={`subtitle-overlay at-${subtitleStyle.primary.position}`} aria-hidden="true">
                  {overlaySecondary && subtitleStyle.bilingualLayout === "source_top_target_bottom" ? <div className="subtitle-overlay-line" style={subtitleLineStyle(subtitleStyle.secondary)}>{overlaySecondary}</div> : null}
                  <div className="subtitle-overlay-line" style={subtitleLineStyle(subtitleStyle.primary)}>{overlayPrimary}</div>
                  {overlaySecondary && subtitleStyle.bilingualLayout === "target_top_source_bottom" ? <div className="subtitle-overlay-line" style={subtitleLineStyle(subtitleStyle.secondary)}>{overlaySecondary}</div> : null}
                </div>
              ) : null}
            </div>
          </div>

          <aside className="preview-style-panel" aria-label="项目字幕样式">
            {/* 样式写的是项目配置，导出 ASS 与烧录视频用同一份，所以必须说清作用范围。 */}
            <header><strong>项目字幕样式</strong><small>影响全部字幕与导出，不只是当前这一段</small></header>
            <label className="style-field"><span>字号 <output>{subtitleStyle.primary.fontSizePx}px</output></span><input type="range" min={24} max={96} step={1} value={subtitleStyle.primary.fontSizePx} onChange={(event) => patchStyle((draft) => { draft.primary.fontSizePx = Number(event.target.value); if (sourceStyleLinked) draft.secondary.fontSizePx = Math.round(draft.primary.fontSizePx * 0.62); })}/></label>
            <label className="style-field"><span>颜色</span><input type="color" value={subtitleStyle.primary.textColor} onChange={(event) => patchStyle((draft) => { draft.primary.textColor = event.target.value; if (sourceStyleLinked) draft.secondary.textColor = draft.primary.textColor; })}/></label>
            <label className="style-field"><span>描边 <output>{subtitleStyle.primary.outlineWidthPx}px</output></span><input type="range" min={0} max={6} step={0.5} value={subtitleStyle.primary.outlineWidthPx} onChange={(event) => patchStyle((draft) => { draft.primary.outlineWidthPx = Number(event.target.value); if (sourceStyleLinked) draft.secondary.outlineWidthPx = draft.primary.outlineWidthPx; })}/></label>
            <div className="style-field"><span>位置</span><div className="toolbar-segmented-group">{POSITION_OPTIONS.map((option) => <button key={option.value} type="button" className={`seg-btn ${subtitleStyle.primary.position === option.value ? "is-active" : ""}`} onClick={() => patchStyle((draft) => { draft.primary.position = option.value; draft.secondary.position = option.value; })}>{option.label}</button>)}</div></div>
            <div className="style-field"><span id="preview-layout-label">单双语排布</span><select aria-labelledby="preview-layout-label" value={subtitleStyle.bilingualLayout} onChange={(event) => patchStyle((draft) => { draft.bilingualLayout = event.target.value as BilingualLayout; })}>{LAYOUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
            <div className="style-field"><span id="preview-font-label">字体</span><select aria-labelledby="preview-font-label" value={subtitleStyle.primary.fontFamily} onChange={(event) => patchStyle((draft) => { draft.primary.fontFamily = event.target.value; draft.secondary.fontFamily = event.target.value; })}>{FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}</select></div>

            {/* 原文字幕（secondary）此前完全没有入口：样式资源里字段是齐的，界面只
                暴露了译文那一半。只有双语排布下画面上才有原文，所以这一组随之出现。 */}
            {subtitleStyle.bilingualLayout !== "target_only" ? (
              <div className="style-subgroup">
                <h3>
                  原文字幕
                  <button
                    type="button"
                    className={`style-lock ${sourceStyleLinked ? "" : "is-unlocked"}`}
                    aria-pressed={!sourceStyleLinked}
                    onClick={() => setSourceStyleLinked((linked) => !linked)}
                    title={sourceStyleLinked ? "解锁后可以单独调整原文字幕" : "锁回去，原文重新跟随译文"}
                  >
                    <Icon name={sourceStyleLinked ? "collapse" : "edit"}/>{sourceStyleLinked ? "跟随译文" : "已解锁"}
                  </button>
                </h3>
                {sourceStyleLinked ? (
                  <p className="style-linked-note">原文的颜色、描边和字体跟着译文走，字号按比例缩小。要单独调就点上面的「跟随译文」解锁。</p>
                ) : (
                  <>
                    <label className="style-field"><span>字号 <output>{subtitleStyle.secondary.fontSizePx}px</output></span><input type="range" min={16} max={72} step={1} value={subtitleStyle.secondary.fontSizePx} onChange={(event) => patchStyle((draft) => { draft.secondary.fontSizePx = Number(event.target.value); })}/></label>
                    <label className="style-field"><span>颜色</span><input type="color" value={subtitleStyle.secondary.textColor} onChange={(event) => patchStyle((draft) => { draft.secondary.textColor = event.target.value; })}/></label>
                    <label className="style-field"><span>描边 <output>{subtitleStyle.secondary.outlineWidthPx}px</output></span><input type="range" min={0} max={6} step={0.5} value={subtitleStyle.secondary.outlineWidthPx} onChange={(event) => patchStyle((draft) => { draft.secondary.outlineWidthPx = Number(event.target.value); })}/></label>
                    <label className="style-field"><span>描边颜色</span><input type="color" value={subtitleStyle.secondary.outlineColor} onChange={(event) => patchStyle((draft) => { draft.secondary.outlineColor = event.target.value; })}/></label>
                  </>
                )}
              </div>
            ) : null}
          </aside>
        </div>

        {preview && durationMs > 0 ? (
          <div className="editor-waveform-bar">
            <MediaTimeline
              durationMs={durationMs}
              playheadMs={playheadMs}
              playing={mediaPlaying}
              onTogglePlay={togglePlay}
              onSeek={seekToMs}
              peaks={waveform?.peaks ?? null}
              waveformState={waveformState}
              waveformError={waveformError}
              onRetryWaveform={() => void loadWaveform()}
              segments={segmentRanges}
              selectedSegmentId={selected?.id ?? null}
              selectedRange={selectedRange}
              onScrubSound={() => app.play("trim")}
              controls={<>
                <button type="button" onClick={playFromSegment} disabled={!selected}>从当前段播放</button>
                <button type="button" className={loopSegment ? "is-active" : ""} aria-pressed={loopSegment} onClick={() => { setLoopSegment((value) => !value); app.play("toggle"); }} disabled={!selected}>循环本段</button>
                <span className="transport-spacer"/>
                <button type="button" onClick={cycleSpeed} aria-label={`播放速度 ${speed} 倍`}>{speed}×</button>
                <label className="transport-volume">音量<input type="range" min={0} max={1} step={0.05} value={volume} onChange={(event) => changeVolume(Number(event.target.value))}/></label>
              </>}
            />
          </div>
        ) : null}

        {/* 保留单行当前段可原地改字，所以预览模式不是死胡同：可以一路 ► 走下去看效果，发现问题当场改。 */}
        {selected ? (
          <div className="preview-current-segment">
            <span className="segment-index">{String(selectedIndex + 1).padStart(3, "0")}</span>
            <time>{selected.start}</time>
            <input
              aria-label="当前段译文"
              value={targetText(selectedTarget)}
              onChange={(event) => apply(workspace.updateSegmentTranslation(project.id, target.languageCode, selected.id, event.target.value), "修改已进入自动保存")}
              onFocus={() => { editorFocusRef.current = true; }}
              onBlur={() => { editorFocusRef.current = false; }}
              disabled={!workspace.isDesktop || selectedTarget?.locked}
              placeholder={selectedTarget?.locked ? "本段已锁定" : "尚无译文"}
            />
            <div className="preview-step-nav">
              <button type="button" className="btn btn-toolbar" onClick={(event) => stepPreview(-1, event.shiftKey)} title="上一处问题（按住 Shift 走全部段）">◄</button>
              <button type="button" className="btn btn-toolbar" onClick={(event) => stepPreview(1, event.shiftKey)} title="下一处问题（按住 Shift 走全部段）">►</button>
            </div>
          </div>
        ) : null}

        <div className="action-dock editor-action-dock">
          <div className="dock-issue-nav">
            <button type="button" className="btn btn-toolbar" onClick={() => stepIssue(-1)} disabled={!issueSegmentIds.length}><Icon name="arrow"/> 上一问题</button>
            <button type="button" className="btn btn-toolbar" onClick={() => stepIssue(1)} disabled={!issueSegmentIds.length}>下一问题</button>
          </div>
          <span className="dock-summary">
            共 <em>{source.segments.length}</em> 段
            <b className={errorCount ? "is-blocking" : "is-clear"}><em>{errorCount}</em> 项必须修复</b>
            <b><em>{warningCount}</em> 条建议</b>
          </span>
          <button type="button" className="btn btn-primary" onClick={approve} disabled={!workspace.isDesktop || errorCount > 0}>批准并前往交付 <Icon name="arrow"/></button>
        </div>
      </div>
    );
  }

  return (
    <div className={`project-stage-body qa-page ${previewMode ? "is-preview-mode" : ""}`} data-fr02-view="editor">
      {/* 不再重复"字幕编辑与校对"这个标题——阶段导轨上高亮的"校对"已经说明了同一件事，
          项目名也已在项目条上。所有工具收进一行，省下的是整块首屏高度。 */}
      <div className="editor-trackbar" role="toolbar" aria-label="字幕轨道工具">
        <div className="toolbar-segmented-group">
          <button type="button" className={`seg-btn ${filter === "all" ? "is-active" : ""}`} onClick={() => setFilter("all")}>全部字幕</button>
          <button type="button" className={`seg-btn ${filter === "issues" ? "is-active" : ""}`} onClick={() => setFilter("issues")}>问题优先</button>
        </div>
        <span className="editor-track-label">{source.label} · {target.languageLabel}</span>
        <span className="trackbar-spacer"/>
        <span className={`save-state ${workspace.saveError ? "is-error" : ""}`}><i/> {workspace.saveError ? "保存失败" : "自动保存"}</span>
        <button type="button" className="btn btn-toolbar" onClick={() => workspace.undoProjectEdit(project.id)} disabled={!undoCount || !workspace.isDesktop} title="撤销">撤销 <span>{undoCount}</span></button>
        <button type="button" className="btn btn-toolbar" onClick={() => workspace.redoProjectEdit(project.id)} disabled={!redoCount || !workspace.isDesktop} title="重做">重做 <span>{redoCount}</span></button>
        <details className="editor-search">
          <summary>搜索替换</summary>
          <form onSubmit={replace}>
            <label>查找<input value={findText} onChange={(event) => setFindText(event.target.value)}/></label>
            <label>替换为<input value={replaceText} onChange={(event) => setReplaceText(event.target.value)}/></label>
            <button type="submit" className="btn btn-secondary" disabled={!workspace.isDesktop}>替换全部</button>
          </form>
        </details>
        <span className="trackbar-divider" aria-hidden="true"/>
        <button type="button" className="btn btn-toolbar" onClick={() => apply(workspace.refreshTargetTrackQa(project.id, target.languageCode), "QA 已重新计算")}>刷新 QA</button>
        <button type="button" className="btn btn-toolbar" onClick={() => setConfirmAction("candidate")} disabled={!workspace.isDesktop}>生成完整候选译文</button>
        <span className="trackbar-divider" aria-hidden="true"/>
        <button type="button" className={`btn btn-toolbar is-toggle ${referenceOpen ? "is-active" : ""}`} aria-pressed={referenceOpen} onClick={() => { setReferenceOpen((open) => !open); app.play("toggle"); }} title="收起或展开参考栏（I）">参考栏</button>
        <button type="button" className={`btn btn-toolbar is-toggle ${waveformOpen ? "is-active" : ""}`} aria-pressed={waveformOpen} onClick={() => { setWaveformOpen((open) => !open); app.play("toggle"); }} title="收起或展开波形条（W）" disabled={!preview || durationMs <= 0}>波形</button>
        <button type="button" className={`btn btn-toolbar is-toggle ${focusMode ? "is-active" : ""}`} aria-pressed={focusMode} onClick={() => { setFocusMode((open) => !open); app.play("toggle"); }} title={`只留当前段编辑区（${keymap.bindings.focusMode?.label ?? "F"}）`}>专注</button>
      </div>

      {actionError || workspace.saveError ? <div className="runtime-alert editor-runtime-alert" role="alert"><Icon name="warning"/><div><strong>修改尚未完成</strong><p>{actionError ?? workspace.saveError}</p></div></div> : actionStatus ? <div className="editor-status-line" role="status"><Icon name="check"/><span>{actionStatus}</span><button type="button" className="text-button" onClick={() => setActionStatus(null)}>关闭</button></div> : null}

      <div className={`editor-columns ${resizing ? "is-resizing" : ""} ${referenceOpen && !focusMode ? "" : "is-reference-collapsed"} ${focusMode ? "is-focus-mode" : ""}`} style={columnsStyle} ref={columnsWrapRef}>
        <aside className="qa-media editor-media editor-reference" hidden={!referenceOpen || focusMode}>
          {preview ? <>
            <div className={`media-stage ${preview.mediaKind === "audio" ? "is-audio" : ""}`} ref={stageRef} style={stageStyle}>
              {preview.mediaKind === "audio"
                ? <>
                  <audio ref={mediaRef as RefObject<HTMLAudioElement>} src={preview.url} preload="metadata" {...mediaEvents}/>
                  <div className="media-stage-glyph" aria-hidden="true"><Icon name="file"/><span>{project.sourceFileName}</span></div>
                </>
                : <video ref={mediaRef as RefObject<HTMLVideoElement>} className="production-media" src={preview.url} preload="metadata" onClick={togglePlay} onDoubleClick={toggleFullscreen} {...mediaEvents}/>}
              {overlaySegment && overlayPrimary ? (
                <div className={`subtitle-overlay at-${subtitleStyle.primary.position}`} aria-hidden="true">
                  {overlaySecondary && subtitleStyle.bilingualLayout === "source_top_target_bottom" ? <div className="subtitle-overlay-line" style={subtitleLineStyle(subtitleStyle.secondary)}>{overlaySecondary}</div> : null}
                  <div className="subtitle-overlay-line" style={subtitleLineStyle(subtitleStyle.primary)}>{overlayPrimary}</div>
                  {overlaySecondary && subtitleStyle.bilingualLayout === "target_top_source_bottom" ? <div className="subtitle-overlay-line" style={subtitleLineStyle(subtitleStyle.secondary)}>{overlaySecondary}</div> : null}
                </div>
              ) : null}
              {preview.mediaKind !== "audio" ? <button type="button" className="media-expand-toggle" onClick={() => { setPreviewMode(true); app.play("toggle"); }} aria-label="进入预览模式查看字幕效果"><Icon name="expand"/></button> : null}
            </div>
          </> : <div className="media-still large production-media-still"><span className="media-file-glyph"><Icon name="file"/></span><i/><b>{project.noSourceMedia ? "纯字幕项目" : "预览不可用"}</b></div>}
          {/* 字幕样式只有一个家：预览模式。在 260px 的画面上调字号看不出对不对。
              纯字幕与纯音频项目也必须能进——样式同样写进 ASS 导出，不能因为没有画面就失去入口。 */}
          <button type="button" className="reference-style-entry" onClick={() => { setPreviewMode(true); app.play("navigate"); }}>
            <Icon name="expand"/><span><strong>字幕样式与效果</strong><small>进入预览模式调整并查看</small></span><Icon name="chevron"/>
          </button>
          <ThemeVisualizer theme={app.theme} playing={mediaPlaying}/>
          <div className="media-caption"><span>{project.noSourceMedia ? "纯字幕项目" : "本机媒体预览"}</span><p>{project.sourceFileName}</p><small>{preview ? "点画面播放/暂停，点波形或字幕段跳转；播放时列表跟随高亮。" : "缺少预览时仍可编辑字幕"}</small></div>
        </aside>
        <section className="segment-column" aria-label="字幕段列表">
          <header>
            <strong>字幕段</strong><span>{segments.length}/{source.segments.length}</span>
            <div className="segment-nav">
              <button type="button" onClick={() => stepSegment(-1)} disabled={!selected || source.segments[0]?.id === selected.id}>上一条</button>
              <button type="button" onClick={() => stepSegment(1)} disabled={!selected || source.segments[source.segments.length - 1]?.id === selected.id}>下一条</button>
            </div>
          </header>
          <div className="segment-list-container">
            {/* 选中只切换右侧编辑栏，列表本身不再展开重排——2000 段时这是决定性的。 */}
            <div className="segment-list" ref={segmentListRef}>
              {segments.map((segment, index) => {
                const rowIssues = issues.filter((issue) => issue.segmentId === segment.id);
                const value = targetText(segment.targetTexts[target.languageCode]);
                const isSelected = segment.id === selected?.id;
                const isPlayingRow = mediaPlaying && activeSegment?.id === segment.id;
                return (
                  <button
                    type="button"
                    key={segment.id}
                    data-segment-id={segment.id}
                    className={`segment-row ${isSelected ? "is-selected" : ""} ${isPlayingRow ? "is-playing" : ""} is-${issueTone(rowIssues)}`}
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => { selectSegment(segment.id, true); app.play("click"); }}
                  >
                    <span className="segment-index">{String(index + 1).padStart(3, "0")}</span>
                    <time>{segment.start}</time>
                    <span className="segment-status"/>
                    <span className="segment-source">{sourceText(segment) || "空原文"}</span>
                    <strong>{value || "尚无译文"}</strong>
                  </button>
                );
              })}
              {segments.length === 0 ? <div className="segment-empty"><strong>当前筛选没有字幕段</strong><span>切换到“全部字幕”继续编辑。</span></div> : null}
            </div>
          </div>
        </section>
        <div
          className={`qa-splitter ${resizing ? "is-active" : ""}`}
          data-splitter="list"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整字幕段列表宽度"
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeWithKeyboard}
        ><i/></div>
        <section className="segment-editor" aria-label="当前段编辑">
          {renderEditCard()}
        </section>
      </div>

      {/* 波形拿全宽：30 秒窗口在 1176px 上可读，在 420px 的列里是一团糊。 */}
      {preview && durationMs > 0 && waveformOpen ? (
        <div className="editor-waveform-bar">
          <MediaTimeline
            durationMs={durationMs}
            playheadMs={playheadMs}
            playing={mediaPlaying}
            onTogglePlay={togglePlay}
            onSeek={seekToMs}
            peaks={waveform?.peaks ?? null}
            waveformState={waveformState}
            waveformError={waveformError}
            onRetryWaveform={() => void loadWaveform()}
            segments={segmentRanges}
            selectedSegmentId={selected?.id ?? null}
            selectedRange={selectedRange}
            onScrubSound={() => app.play("trim")}
            controls={<>
              <button type="button" onClick={playFromSegment} disabled={!selected}>从当前段播放</button>
              <button type="button" className={loopSegment ? "is-active" : ""} aria-pressed={loopSegment} onClick={() => { setLoopSegment((value) => !value); app.play("toggle"); }} disabled={!selected}>循环本段</button>
              <span className="transport-spacer"/>
              <button type="button" onClick={cycleSpeed} aria-label={`播放速度 ${speed} 倍`}>{speed}×</button>
              <label className="transport-volume">音量<input type="range" min={0} max={1} step={0.05} value={volume} onChange={(event) => changeVolume(Number(event.target.value))}/></label>
              {preview.mediaKind !== "audio" && pipSupported ? <button type="button" onClick={() => void togglePictureInPicture()}>画中画</button> : null}
              {preview.mediaKind !== "audio" ? <button type="button" onClick={toggleFullscreen}>全屏</button> : null}
            </>}
          />
        </div>
      ) : null}

      {/* Action Dock：问题导航 + 一句人话 QA 摘要 + 唯一批准动作，常驻在视线落点上。 */}
      <div className="action-dock editor-action-dock">
        <div className="dock-issue-nav">
          <button type="button" className="btn btn-toolbar" onClick={() => stepIssue(-1)} disabled={!issueSegmentIds.length}><Icon name="arrow"/> 上一问题</button>
          <button type="button" className="btn btn-toolbar" onClick={() => stepIssue(1)} disabled={!issueSegmentIds.length}>下一问题</button>
        </div>
        <p className="dock-summary">
          <span>共 <em>{source.segments.length}</em> 段</span>
          <span className={errorCount ? "is-blocking" : "is-clear"}><em>{errorCount}</em> 项必须修复</span>
          <span><em>{warningCount}</em> 条建议</span>
        </p>
        <button type="button" className="btn btn-primary" onClick={approve} disabled={!workspace.isDesktop || errorCount > 0} title={errorCount ? `还有 ${errorCount} 项必须修复的问题` : undefined}>
          批准并前往交付 <Icon name="arrow"/>
        </button>
      </div>

      {confirmAction ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmAction(null); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="paid-editor-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="paid-editor-title">确认调用翻译模型</h2><p>{confirmAction === "rerun" ? "只会重译当前选中的字幕段；锁定内容不会被覆盖。" : "会为当前目标语言创建一条独立候选轨，原译文与人工修改保持不变。"} Provider 请求可能产生费用。</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmAction(null)}>取消</button><button type="button" className="btn btn-primary" onClick={() => void paidAction()}>确认并提交</button></div></section></div> : null}
    </div>
  );
}
