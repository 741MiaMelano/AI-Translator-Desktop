import {
  ArrowLeft,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  FileWarning,
  Maximize2,
  Minimize2,
  Palette,
  PlayCircle,
  RotateCcw,
  Save,
  Scissors,
  Search,
  VideoOff,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import MediaPreviewFrame from "../components/feature/MediaPreviewFrame";
import ProjectSectionNav from "../components/feature/ProjectSectionNav";
import {
  SubtitleStyleCanvas,
  SubtitleStyleEditor,
} from "../components/feature/resource-library/SubtitleStyleEditor";
import Badge from "../components/ui/Badge";
import BottomActionBar from "../components/ui/BottomActionBar";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Tabs from "../components/ui/Tabs";
import PageHeader from "../layout/PageHeader";
import { getSegmentPage, SEGMENTS_PER_PAGE } from "../domain/segment-page";
import {
  createDefaultSubtitleStyle,
  type ResourceWriteInput,
  type SubtitleStylePayload,
} from "../domain/resource-library";
import { findSegmentAtTime, formatDomainTimestamp, parseDomainTimestamp, timelinePointerMs } from "../domain/segment-timeline";
import {
  formatTargetTrackStatus,
  getActiveSourceTrack,
  getTargetSegmentText,
  getTargetTrack,
  isActionableQaIssue,
  type Project,
  type QaIssue,
  type Segment,
  type SourceTrack,
  type TargetTrack,
  type TargetTextLayers,
} from "../domain/workspace";
import { useWorkspace } from "../state/WorkspaceContext";
import { normalizeSubtitleStylePayload } from "../../shared/resource-library.mjs";

/* ------------------------------------------------------------------
   术语表：同一个概念只在这里定义一次，工具条 / 卡片 / 按钮 title 共用。
   旧稿里 hard error、warning、cues、previous manual、2e / 3w 是各写一套的。
   ------------------------------------------------------------------ */
const QA_SEVERITY_LABEL: Record<QaIssue["severity"], string> = {
  error: "必须修复",
  warning: "优化建议",
};

const QA_FLAG_LABELS: Record<string, string> = {
  "qa.max_lines": "行数超限",
  "qa.max_chars_per_line": "单行过长",
  "qa.max_cps": "阅读速度过快",
  "qa.min_duration": "时长过短",
  "qa.max_duration": "时长过长",
  "qa.overlap": "时间重叠",
  "qa.stale": "待同步",
  "qa.term_conflict": "术语冲突",
  "qa.invalid_range": "非法时间轴",
  "qa.empty_target": "目标为空",
  "term-consistency": "术语一致性",
  "cps-warning": "阅读速度偏高",
  "suspected-lyrics": "疑似唱词",
};

const QA_GUIDANCE: Record<string, string> = {
  "qa.max_lines": "精简文字或减少换行，尽量控制在两行内。此项不会阻止导出。",
  "qa.max_chars_per_line": "精简这一行，或在自然停顿处换行。此项不会阻止导出。",
  "qa.max_cps": "缩短译文，或适当延长显示时间，让观众来得及阅读。",
  "qa.min_duration": "适当延长显示时间，或与相邻短句合并。",
  "qa.max_duration": "如果画面中途已经换句，可缩短时间或拆分；否则可以保留，不影响导出。",
  "qa.overlap": "用下方时间轴工具调整前后字幕边界，避免两条字幕同时出现。",
  "qa.stale": "原文或时间轴改过，请确认当前译文仍匹配；不匹配时重新翻译该段。",
  "qa.term_conflict": "按术语库要求修改译文中的对应词语。",
  "qa.invalid_range": "修正开始和结束时间；结束时间必须晚于开始时间。",
  "qa.empty_target": "填写这一段的译文；如果是不需要显示的语气词，可在下方按原文查找并把对应译文留空。",
  "qa.suspected_lyrics": "系统无法确定这一段是对白还是唱词，请试听后决定保留、修改或删除。",
};

/** 停止输入多久之后把源字幕人工层落库。逐字符提交会把撤销栈冲干净。 */
const SOURCE_COMMIT_DELAY_MS = 500;

function qaFlagLabel(flag: string) {
  return QA_FLAG_LABELS[flag] ?? flag;
}

function qaIssueSegmentId(issue: QaIssue) {
  const value = issue.segmentId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function qaIssueGuidance(issue: QaIssue) {
  const ruleId = issue.ruleId ?? issue.id.split(":")[0];
  return QA_GUIDANCE[ruleId]
    ?? (issue.severity === "error"
      ? "这个问题会阻止批准和导出，请按上面的原因修复。"
      : "这是观看体验建议，不会阻止批准和导出。可按实际画面决定是否调整。");
}

/** 禁用原因既进 title 也进可见文案：浏览器对 disabled 元素通常不触发悬停提示。 */
function qaBlockReason(errorCount: number, action: string) {
  return errorCount > 0 ? `存在 ${errorCount} 个必须修复的问题，处理后才能${action}` : undefined;
}

const CELL = "px-2.5 py-2 align-top";
const TEXTAREA =
  "control-surface w-full rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[13px] text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold disabled:cursor-not-allowed disabled:opacity-60";

function SegmentStateBadges({ translation, dirty }: { translation?: TargetTextLayers; dirty: boolean }) {
  const hasManual = typeof translation?.manual === "string";
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {dirty ? <Badge tone="red">未保存</Badge> : null}
      {hasManual ? (
        <Badge tone="gold">{translation?.manual ? "人工稿" : "人工留空"}</Badge>
      ) : (
        <Badge tone="gray">模型稿</Badge>
      )}
      {translation?.locked ? <Badge tone="red">锁定</Badge> : null}
      {translation?.stale ? <Badge tone="gold">待同步</Badge> : null}
      {translation?.previousManual ? <Badge tone="blue">有历史人工稿</Badge> : null}
      {(translation?.qaFlags ?? []).map((flag) => (
        <Badge key={flag} tone="gold">
          {qaFlagLabel(flag)}
        </Badge>
      ))}
    </div>
  );
}

function TargetRowActions({
  hasManual,
  isDirty,
  locked,
  onClear,
  onRerun,
  onSave,
  onSplit,
  onToggleLock,
}: {
  hasManual: boolean;
  isDirty: boolean;
  locked: boolean;
  onClear: () => void;
  onRerun: () => void;
  onSave: () => void;
  onSplit: () => void;
  onToggleLock: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Button
        size="sm"
        variant="primary"
        disabled={!isDirty || locked}
        title={locked ? "锁定段不可保存覆盖" : isDirty ? undefined : "当前没有未保存的修改"}
        onClick={onSave}
      >
        保存
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!hasManual || locked}
        title={locked ? "锁定段不可清空人工稿" : hasManual ? undefined : "该段还没有人工稿"}
        onClick={onClear}
      >
        清空人工
      </Button>
      <Button
        size="sm"
        variant="outline"
        icon={<RotateCcw size={14} />}
        disabled={locked}
        title={locked ? "锁定段不可重跑" : undefined}
        onClick={onRerun}
      >
        重跑
      </Button>
      <Button
        size="sm"
        variant="outline"
        icon={<Scissors size={14} />}
        disabled={locked}
        title={locked ? "锁定段不可拆分" : "把光标放在译文切点；播放器未停在本段内时会按文字比例切分时间轴"}
        onClick={(event) => {
          event.stopPropagation();
          onSplit();
        }}
      >
        在此拆分
      </Button>
      <Button size="sm" variant="ghost" onClick={onToggleLock}>
        {locked ? "解锁" : "锁定"}
      </Button>
    </div>
  );
}

type SegmentEditorRowProps = {
  active: boolean;
  languageCode: string;
  onDirtyChange: (segmentId: string, dirty: boolean) => void;
  onFocusSelect: (segmentId: string) => void;
  onRerun: (projectId: string, languageCode: string, segmentId: string) => Promise<unknown>;
  onSave: (projectId: string, languageCode: string, segmentId: string, manualText: string) => void;
  onSelect: (segment: Segment) => void;
  onSplit: (segment: Segment, targetText: string, targetOffset: number) => void;
  onToggleLock: (projectId: string, languageCode: string, segmentId: string, locked: boolean) => void;
  projectId: string;
  segment: Segment;
  selected: boolean;
  translation?: TargetTextLayers;
};

const SegmentEditorRow = memo(function SegmentEditorRow({
  active,
  languageCode,
  onDirtyChange,
  onFocusSelect,
  onRerun,
  onSave,
  onSelect,
  onSplit,
  onToggleLock,
  projectId,
  segment,
  selected,
  translation,
}: SegmentEditorRowProps) {
  const baseText = translation?.manual ?? translation?.postProcessed ?? translation?.model ?? "";
  const [draftText, setDraftText] = useState(baseText);
  const [syncedText, setSyncedText] = useState(baseText);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isDirty = draftText !== syncedText;
  const locked = translation?.locked === true;
  const hasManual = typeof translation?.manual === "string";
  // 外部写回（自己的保存落库 / 撤销重做 / 后台重跑）只在没有本地草稿时接管输入框；
  // 有草稿时保留用户输入，改为在行内提示，让用户自己决定是否加载新版本。
  useEffect(() => {
    if (baseText === syncedText) return;
    if (!isDirty || baseText === draftText) {
      setSyncedText(baseText);
      setDraftText(baseText);
    }
  }, [baseText, draftText, isDirty, syncedText]);
  useEffect(() => {
    onDirtyChange(segment.id, isDirty);
    return () => onDirtyChange(segment.id, false);
  }, [isDirty, onDirtyChange, segment.id]);

  const overwritten = isDirty && baseText !== syncedText && baseText !== draftText;
  const save = () => onSave(projectId, languageCode, segment.id, draftText);

  return (
    <tr
      data-testid={`subtitle-row-${segment.id}`}
      data-selected={selected ? "true" : "false"}
      data-active={active ? "true" : "false"}
      className={`border-b border-line transition ${
        active ? "bg-gold-wash outline outline-1 -outline-offset-1 outline-gold" : selected ? "bg-card-soft" : "hover:bg-card-soft"
      }`}
      onClick={() => onSelect(segment)}
    >
      <td className={CELL}>
        <div className="break-all tabular text-[11px] text-[var(--color-text-muted)]">{segment.id}</div>
      </td>
      <td className={CELL}>
        <div className="tabular text-[11.5px] leading-5 text-[var(--color-text-main)]">
          <span className="block">{segment.start}</span><span className="block">→ {segment.end}</span>
        </div>
      </td>
      <td className={CELL}>
        <div className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-[var(--color-text-muted)] [overflow-wrap:anywhere]">
          {segment.sourceText.manual ?? segment.sourceText.normalized}
        </div>
      </td>
      <td className={CELL}>
        <div className="min-w-0">
          <textarea
            ref={textareaRef}
            data-testid={`subtitle-editor-${segment.id}`}
            value={draftText}
            disabled={locked}
            onFocus={() => onFocusSelect(segment.id)}
            onChange={(event) => setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (isDirty && !locked) save();
              }
            }}
            rows={3}
            className={TEXTAREA}
          />
          {overwritten ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-[var(--color-text-muted)]">该段已被后台更新，你的草稿仍保留。</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSyncedText(baseText);
                  setDraftText(baseText);
                }}
              >
                加载新版本
              </Button>
            </div>
          ) : null}
          <SegmentStateBadges dirty={isDirty} translation={translation} />
        </div>
      </td>
      <td className={CELL}>
        <TargetRowActions
          hasManual={hasManual}
          isDirty={isDirty}
          locked={locked}
          onClear={() => onSave(projectId, languageCode, segment.id, "")}
          onRerun={() => void onRerun(projectId, languageCode, segment.id)}
          onSave={save}
          onSplit={() => onSplit(segment, draftText, textareaRef.current?.selectionStart ?? 0)}
          onToggleLock={() => onToggleLock(projectId, languageCode, segment.id, !locked)}
        />
      </td>
    </tr>
  );
}, (previous, next) => (
  previous.active === next.active
  && previous.languageCode === next.languageCode
  && previous.projectId === next.projectId
  && previous.segment === next.segment
  && previous.selected === next.selected
  && previous.translation === next.translation
));

function SourceSegmentEditorRow({
  segment,
  onSave,
}: {
  segment: Segment;
  onSave: (segmentId: string, manualText: string | undefined) => void;
}) {
  const fallbackText = segment.sourceText.normalized ?? segment.sourceText.original;
  const baseText = segment.sourceText.manual ?? fallbackText;
  const [draftText, setDraftText] = useState(baseText);
  // expectedRef 记住「我们提交后期望 baseText 落到哪」。提交空串等于移除人工层、
  // baseText 会回落成规范化原文，不记这一笔的话删空的行会被原文立刻灌回来。
  const expectedRef = useRef(baseText);
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const commit = useCallback(
    (next: string) => {
      expectedRef.current = next.length > 0 ? next : fallbackText;
      onSave(segment.id, next);
    },
    [fallbackText, onSave, segment.id],
  );

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending !== null) commit(pending);
  }, [commit]);

  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  useEffect(() => {
    if (baseText === expectedRef.current || timerRef.current !== null) return;
    expectedRef.current = baseText;
    setDraftText(baseText);
  }, [baseText]);

  const hasManual = segment.sourceText.manual !== undefined;

  return (
    <tr className="border-b border-line transition hover:bg-card-soft">
      <td className={CELL}>
        <div className="break-all tabular text-[11px] text-[var(--color-text-muted)]">{segment.id}</div>
      </td>
      <td className={CELL}>
        <div className="tabular text-[11.5px] leading-5 text-[var(--color-text-main)]">
          <span className="block">{segment.start}</span>
          <span className="block">→ {segment.end}</span>
        </div>
      </td>
      <td className={CELL}>
        <div className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-[var(--color-text-muted)] [overflow-wrap:anywhere]">
          {segment.sourceText.original}
        </div>
      </td>
      <td className={CELL}>
        <textarea
          value={draftText}
          onChange={(event) => {
            const nextText = event.target.value;
            setDraftText(nextText);
            pendingRef.current = nextText;
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              timerRef.current = null;
              const pending = pendingRef.current;
              pendingRef.current = null;
              if (pending !== null) commit(pending);
            }, SOURCE_COMMIT_DELAY_MS);
          }}
          onBlur={flush}
          rows={3}
          className={TEXTAREA}
        />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {hasManual ? <Badge tone="gold">人工源稿</Badge> : <Badge tone="gray">规范化/原文</Badge>}
        </div>
      </td>
      <td className={CELL}>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasManual}
          title={hasManual ? undefined : "该段还没有人工源稿"}
          onClick={() => {
            if (timerRef.current !== null) {
              window.clearTimeout(timerRef.current);
              timerRef.current = null;
            }
            pendingRef.current = null;
            expectedRef.current = fallbackText;
            setDraftText(fallbackText);
            onSave(segment.id, undefined);
          }}
        >
          清空人工稿
        </Button>
      </td>
    </tr>
  );
}

/**
 * 路由永远带 :targetLanguage，所以首屏必须落在目标校对；
 * 源字幕模式改成 URL 上的 ?mode=source，刷新和前进后退都保持得住。
 */
function useEditorMode(isDesktop: boolean) {
  const [searchParams, setSearchParams] = useSearchParams();
  const editorMode: "source" | "target" =
    isDesktop && searchParams.get("mode") === "source" ? "source" : "target";
  const setEditorMode = useCallback(
    (mode: "source" | "target") => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (mode === "source") next.set("mode", "source");
          else next.delete("mode");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return { editorMode, setEditorMode };
}

/** 未保存的译文草稿集中登记在这里，翻页/切轨/关窗前才有东西可拦。 */
function useDirtyDrafts() {
  const [dirtyIds, setDirtyIds] = useState<string[]>([]);
  const markSegmentDirty = useCallback((segmentId: string, dirty: boolean) => {
    setDirtyIds((current) => {
      const has = current.includes(segmentId);
      if (dirty === has) return current;
      return dirty ? [...current, segmentId] : current.filter((id) => id !== segmentId);
    });
  }, []);
  const dirtyCount = dirtyIds.length;
  const confirmDiscardDrafts = useCallback(
    (action: string) =>
      dirtyCount === 0 ||
      window.confirm(`有 ${dirtyCount} 段译文尚未保存，${action}会丢弃这些草稿。确认继续？`),
    [dirtyCount],
  );
  useEffect(() => {
    if (dirtyCount === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);
  return { confirmDiscardDrafts, dirtyCount, markSegmentDirty };
}

/** 选中段、分页与跨轨跳转。任何会卸载当前这批行的动作都要先过一次未保存草稿确认。 */
function useSegmentNavigation(c: {
  confirmDiscardDrafts: (action: string) => boolean;
  initialSegmentId: string | null;
  navigate: ReturnType<typeof useNavigate>;
  projectId?: string;
  sourceTrack: SourceTrack | null;
}) {
  const { confirmDiscardDrafts, navigate, projectId, sourceTrack } = c;
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(c.initialSegmentId);
  const [segmentPage, setSegmentPage] = useState(0);
  const segmentPageRef = useRef(segmentPage);
  segmentPageRef.current = segmentPage;

  const selectSegment = useCallback(
    (segmentId: string) => {
      const index = sourceTrack?.segments.findIndex((segment) => segment.id === segmentId) ?? -1;
      const nextPage = index >= 0 ? Math.floor(index / SEGMENTS_PER_PAGE) : segmentPageRef.current;
      if (nextPage !== segmentPageRef.current && !confirmDiscardDrafts("跳到其它分页")) return false;
      setSelectedSegmentId(segmentId);
      setSegmentPage(nextPage);
      return true;
    },
    [confirmDiscardDrafts, sourceTrack],
  );

  const changeSegmentPage = useCallback(
    (page: number) => {
      if (confirmDiscardDrafts("翻页")) setSegmentPage(page);
    },
    [confirmDiscardDrafts],
  );

  const openTargetTrack = useCallback(
    (languageCode: string) => {
      if (!projectId || !confirmDiscardDrafts("切换目标语言轨")) return;
      navigate(`/projects/${projectId}/editor/${languageCode}`);
    },
    [confirmDiscardDrafts, navigate, projectId],
  );

  useEffect(() => {
    if (!sourceTrack?.segments.length) return;
    if (!selectedSegmentId || !sourceTrack.segments.some((segment) => segment.id === selectedSegmentId)) {
      selectSegment(sourceTrack.segments[0].id);
    }
  }, [selectSegment, selectedSegmentId, sourceTrack]);

  return { changeSegmentPage, openTargetTrack, segmentPage, selectSegment, selectedSegmentId };
}

function useEditorForms() {
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [replaceMatchField, setReplaceMatchField] = useState<"当前译文" | "原文">("当前译文");
  const [replaceScope, setReplaceScope] = useState("全部段");
  const [splitAt, setSplitAt] = useState("");
  const [segmentQuery, setSegmentQuery] = useState("");
  return {
    findText,
    replaceMatchField,
    replaceScope,
    replaceText,
    segmentQuery,
    setFindText,
    setReplaceMatchField,
    setReplaceScope,
    setReplaceText,
    setSegmentQuery,
    setSplitAt,
    splitAt,
  };
}

function useEditorTracks(projects: Project[], projectId?: string, targetLanguage?: string) {
  const project = projects.find((item) => item.id === projectId);
  const sourceTrack = project ? getActiveSourceTrack(project) : null;
  const availableTracks = sourceTrack?.targetTracks.filter((track) => track.isActive) ?? [];
  const currentTrack =
    project && targetLanguage ? getTargetTrack(project, targetLanguage) : availableTracks[0];
  const candidateTracks =
    sourceTrack && currentTrack
      ? sourceTrack.targetTracks.filter(
          (track) => track.role === "candidate" && track.languageCode === currentTrack.languageCode,
        )
      : [];
  return {
    availableTracks,
    candidateTracks,
    currentTrack,
    latestCandidate: candidateTracks[candidateTracks.length - 1],
    project,
    sourceTrack,
  };
}

function useSubtitleEditorController() {
  const navigate = useNavigate();
  const { projectId, targetLanguage } = useParams();
  const [searchParams] = useSearchParams();
  const workspace = useWorkspace();
  const { isDesktop, projects } = workspace;
  const { editorMode, setEditorMode } = useEditorMode(isDesktop);
  const tracks = useEditorTracks(projects, projectId, targetLanguage);
  const { currentTrack, project, sourceTrack } = tracks;
  const { confirmDiscardDrafts, dirtyCount, markSegmentDirty } = useDirtyDrafts();
  const forms = useEditorForms();
  const navigation = useSegmentNavigation({
    confirmDiscardDrafts,
    initialSegmentId: searchParams.get("segmentId"),
    navigate,
    projectId: project?.id,
    sourceTrack,
  });
  const { selectSegment, selectedSegmentId } = navigation;

  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);

  const requestRerun = useCallback(
    async (nextProjectId: string, languageCode: string, segmentId: string) => {
      if (isDesktop && !window.confirm("确认重跑选中段？这会向翻译服务发起真实请求，失败不会自动重试。")) {
        return { ok: false };
      }
      const result = await workspace.rerunSegment(nextProjectId, languageCode, segmentId);
      setEditorMessage(result.ok ? "选中段已开始重跑，可返回项目页查看进度" : result.message ?? "选中段重跑失败");
      return result;
    },
    [isDesktop, workspace],
  );

  const runTimelineEdit = (command: Parameters<typeof workspace.editTimeline>[1]) => {
    if (!project) return;
    const result = workspace.editTimeline(project.id, command);
    setEditorMessage(
      result.ok
        ? command.kind === "split_text"
          ? "字幕已按文字光标拆分，可使用撤销恢复。"
          : "时间轴修改已保存，受影响译文已标记待同步"
        : result.message ?? "时间轴修改失败",
    );
    return result;
  };

  useEditorKeyboard({
    currentTrack,
    editorMode,
    isDesktop,
    project,
    redoProjectEdit: workspace.redoProjectEdit,
    requestRerun,
    selectedSegmentId,
    setSelectedSegmentId: selectSegment,
    sourceTrack,
    undoProjectEdit: workspace.undoProjectEdit,
  });

  const selectedIndex = sourceTrack?.segments.findIndex((segment) => segment.id === selectedSegmentId) ?? -1;
  const manualSegmentCount =
    sourceTrack?.segments.filter((segment) =>
      editorMode === "source"
        ? segment.sourceText.manual !== undefined
        : currentTrack && getTargetSegmentText(segment, currentTrack.languageCode)?.manual !== undefined,
    ).length ?? 0;

  return {
    ...workspace,
    ...tracks,
    ...forms,
    ...navigation,
    canRedoEdit: (project?.editorHistory?.redoStack.length ?? 0) > 0,
    canUndoEdit: (project?.editorHistory?.undoStack.length ?? 0) > 0,
    confirmDiscardDrafts,
    dirtyCount,
    editorMessage,
    editorMode,
    exportMessage,
    lastSegment: sourceTrack ? sourceTrack.segments[sourceTrack.segments.length - 1] : null,
    manualSegmentCount,
    markSegmentDirty,
    navigate,
    nextSegment: selectedIndex >= 0 ? sourceTrack?.segments[selectedIndex + 1] : undefined,
    normalizedExportMayDegrade: ["vtt", "ass", "ssa"].includes(project?.sourceProbeSummary?.subtitleFormat ?? ""),
    qaErrorCount: currentTrack?.qaIssues.filter(
      (issue) => isActionableQaIssue(issue) && issue.severity === "error",
    ).length ?? 0,
    qaWarningCount: currentTrack?.qaIssues.filter(
      (issue) => isActionableQaIssue(issue) && issue.severity === "warning",
    ).length ?? 0,
    requestRerun,
    runTimelineEdit,
    selectedSegment: sourceTrack?.segments.find((segment) => segment.id === selectedSegmentId),
    setEditorMessage,
    setEditorMode,
    setExportMessage,
    setSelectedSegmentId: selectSegment,
  };
}

type EditorController = ReturnType<typeof useSubtitleEditorController>;
type SourceController = EditorController & { project: Project; sourceTrack: SourceTrack };
type TargetController = SourceController & { currentTrack: TargetTrack };

/**
 * 方向键守卫与自动聚焦原本互相打架：跳段后焦点进了 textarea，
 * 下一次 ↑/↓ 就被守卫拦掉。现在 Alt 组合键一律放行（并把焦点送进下一段），
 * 不带 Alt 的裸键只在焦点不在输入框时生效（只移动高亮、不抢焦点）。
 */
function useEditorKeyboard(c: {
  currentTrack?: TargetTrack;
  editorMode: "source" | "target";
  isDesktop: boolean;
  project?: Project;
  redoProjectEdit: (projectId: string) => void;
  requestRerun: (projectId: string, languageCode: string, segmentId: string) => Promise<unknown>;
  selectedSegmentId: string | null;
  setSelectedSegmentId: (segmentId: string) => boolean;
  sourceTrack: SourceTrack | null;
  undoProjectEdit: (projectId: string) => void;
}) {
  useEffect(() => {
    if (!c.isDesktop || c.editorMode !== "source" || !c.project) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z" && !event.shiftKey) {
        event.preventDefault();
        c.undoProjectEdit(c.project!.id);
      }
      if ((event.ctrlKey || event.metaKey) && (key === "y" || (key === "z" && event.shiftKey))) {
        event.preventDefault();
        c.redoProjectEdit(c.project!.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [c.editorMode, c.isDesktop, c.project, c.redoProjectEdit, c.undoProjectEdit]);

  useEffect(() => {
    if (c.editorMode !== "target" || !c.sourceTrack?.segments.length) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const node = event.target as HTMLElement | null;
      const inField = Boolean(
        node && (node.tagName === "TEXTAREA" || node.tagName === "INPUT" || node.isContentEditable),
      );
      const withAlt = event.altKey && !event.ctrlKey && !event.metaKey;
      if (inField && !withAlt) return;
      const key = event.key.toLowerCase();
      const segments = c.sourceTrack!.segments;
      const index = Math.max(0, segments.findIndex((segment) => segment.id === c.selectedSegmentId));
      const delta = event.key === "ArrowDown" || key === "j" ? 1 : event.key === "ArrowUp" || key === "k" ? -1 : 0;
      if (delta) {
        event.preventDefault();
        const next = segments[Math.max(0, Math.min(segments.length - 1, index + delta))];
        if (!c.setSelectedSegmentId(next.id)) return;
        window.requestAnimationFrame(() => {
          const row = document.querySelector<HTMLElement>(`[data-testid="subtitle-row-${next.id}"]`);
          row?.scrollIntoView({ block: "nearest" });
          if (withAlt) {
            document.querySelector<HTMLTextAreaElement>(`[data-testid="subtitle-editor-${next.id}"]`)?.focus();
          }
        });
      }
      if (key === "r" && c.selectedSegmentId && c.project && c.currentTrack) {
        event.preventDefault();
        void c.requestRerun(c.project.id, c.currentTrack.languageCode, c.selectedSegmentId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [c.currentTrack, c.editorMode, c.project, c.requestRerun, c.selectedSegmentId, c.setSelectedSegmentId, c.sourceTrack]);
}

function MissingEditor({ controller, sourceOnly = false }: { controller: EditorController; sourceOnly?: boolean }) {
  return (
    <>
      <PageHeader title="字幕编辑" description={sourceOnly ? "当前项目不存在。" : "当前项目或目标语言不存在。"} />
      <Card>
        <Button variant="primary" onClick={() => controller.navigate("/workspace")}>
          返回项目页
        </Button>
      </Card>
    </>
  );
}

/** 源字幕 / 目标校对提升成并排 Tab；旧稿把它藏在工具条中间的一个 outline 按钮里。 */
function EditorModeTabs({ c }: { c: EditorController }) {
  if (!c.isDesktop) return null;
  return (
    <Tabs
      items={["源字幕", "目标校对"]}
      value={c.editorMode === "source" ? "源字幕" : "目标校对"}
      onChange={(value) => c.setEditorMode(value === "源字幕" ? "source" : "target")}
    />
  );
}

function SourceToolbar({ c }: { c: SourceController }) {
  const exportFile = async (mode: "raw" | "normalized") => {
    const result = await c.exportSourceSubtitle(c.project.id, mode, mode === "normalized" ? "srt" : undefined);
    c.setExportMessage(
      result.ok
        ? result.canceled
          ? "已取消导出"
          : [mode === "raw" ? `已导出原始副本到你选择的位置：${result.fileName}` : `已导出到你选择的位置：${result.fileName}`, ...result.warnings].join("；")
        : result.message,
    );
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-card px-3 py-2 shadow-card">
      <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => c.navigate(`/projects/${c.project.id}`)}>
        返回概览
      </Button>
      <Badge tone="gold">{c.project.sourceFileName}</Badge>
      <Badge tone="gray">{c.sourceTrack.segments.length} 段</Badge>
      <Badge tone="blue">人工源稿 {c.manualSegmentCount}</Badge>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!c.canUndoEdit} title={c.canUndoEdit ? "撤销最近一次字幕修改" : "没有可撤销的编辑"} onClick={() => c.undoProjectEdit(c.project.id)}>
          撤销修改
        </Button>
        <Button variant="outline" disabled={!c.canRedoEdit} title={c.canRedoEdit ? "恢复刚刚撤销的字幕修改" : "没有可恢复的撤销"} onClick={() => c.redoProjectEdit(c.project.id)}>
          恢复撤销
        </Button>
        <Button variant="outline" onClick={() => void exportFile("raw")}>
          导出原始文件
        </Button>
        <Button variant="primary" onClick={() => void exportFile("normalized")}>
          导出规范化 SRT
        </Button>
      </div>
    </div>
  );
}

function SegmentPagination({
  range,
  onChange,
}: {
  range: ReturnType<typeof getSegmentPage>;
  onChange: (page: number) => void;
}) {
  const [pageInput, setPageInput] = useState(String(range.page + 1));
  useEffect(() => setPageInput(String(range.page + 1)), [range.page]);
  const commit = () => {
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(range.page + 1));
      return;
    }
    onChange(Math.max(0, Math.min(range.pageCount - 1, parsed - 1)));
  };
  const atStart = range.page === 0;
  const atEnd = range.page + 1 === range.pageCount;
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="ghost" icon={<ChevronsLeft size={14} />} disabled={atStart} title={atStart ? "已经在首页" : undefined} onClick={() => onChange(0)}>
        首页
      </Button>
      <Button size="sm" variant="ghost" disabled={atStart} title={atStart ? "已经在首页" : undefined} onClick={() => onChange(range.page - 1)}>
        上一页
      </Button>
      <div className="w-14">
        <Input
          aria-label="页码"
          className="tabular text-center"
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit();
          }}
        />
      </div>
      <span aria-live="polite" className="tabular whitespace-nowrap text-[11.5px] text-[var(--color-text-muted)]">
        / {range.pageCount}
      </span>
      <Button size="sm" variant="ghost" disabled={atEnd} title={atEnd ? "已经在末页" : undefined} onClick={() => onChange(range.page + 1)}>
        下一页
      </Button>
      <Button size="sm" variant="ghost" icon={<ChevronsRight size={14} />} disabled={atEnd} title={atEnd ? "已经在末页" : undefined} onClick={() => onChange(range.pageCount - 1)}>
        末页
      </Button>
    </div>
  );
}

function SourceTable({ c }: { c: SourceController }) {
  const range = getSegmentPage(c.sourceTrack.segments.length, c.segmentPage);
  const segments = c.sourceTrack.segments.slice(range.start, range.end);
  return (
    <Card title="源字幕表格" actions={<SegmentPagination range={range} onChange={c.changeSegmentPage} />}>
      <div className="overflow-hidden rounded-[6px] border border-line">
        <table className="w-full table-fixed border-collapse text-left text-[13px]">
          <colgroup>
            <col className="w-[9%]" />
            <col className="w-[22%]" />
            <col className="w-[25%]" />
            <col className="w-[31%]" />
            <col className="w-[13%]" />
          </colgroup>
          <thead className="bg-card-soft text-[11px] tracking-[0.08em] text-[var(--color-text-muted)]">
            <tr>
              <th className="px-2.5 py-2 font-medium">段</th>
              <th className="px-2.5 py-2 font-medium">时间轴</th>
              <th className="px-2.5 py-2 font-medium">原始层</th>
              <th className="px-2.5 py-2 font-medium">当前展示/人工层</th>
              <th className="px-2.5 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="bg-card">
            {segments.map((segment) => (
              <SourceSegmentEditorRow
                key={segment.id}
                segment={segment}
                onSave={(segmentId, manualText) => c.updateSourceSegmentManual(c.project.id, segmentId, manualText)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SourceEditor({ c }: { c: SourceController }) {
  const warnings = c.project.sourceProbeSummary?.warnings ?? [];
  return (
    <>
      <PageHeader
        title="源字幕编辑"
        description="只写人工层，原文与规范化层永不覆盖；停止输入约 0.5 秒自动保存，支持撤销修改与恢复撤销。"
        actions={<EditorModeTabs c={c} />}
      />
      <ProjectSectionNav
        projectId={c.project.id}
        active="editor"
        targetLanguageCode={c.currentTrack?.languageCode}
        editorAvailable
      />
      {c.normalizedExportMayDegrade ? (
        <p
          className="mb-3 rounded-[6px] border border-line bg-warn-wash px-3 py-2 text-[12.5px] text-[var(--color-text-main)]"
          data-testid="normalized-export-warning"
        >
          规范化导出可能降级仅保存在原始字幕中的结构；需要完整保真时请导出原始文件。
        </p>
      ) : null}
      <SourceToolbar c={c} />
      {c.saveError ? (
        <p role="alert" className="mb-3 rounded-[6px] border border-line bg-stop-wash px-3 py-2 text-[12.5px] text-stop">
          自动保存失败：{c.saveError}
        </p>
      ) : null}
      {c.exportMessage ? (
        <p
          role="status"
          className="mb-3 rounded-[6px] border border-line bg-card-soft px-3 py-2 text-[12.5px] text-[var(--color-text-muted)]"
          data-testid="export-message"
        >
          {c.exportMessage}
        </p>
      ) : null}
      {warnings.length ? (
        <Card className="mb-3" title="格式提示" actions={<FileWarning size={14} className="text-gold-dark" />}>
          <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-[var(--color-text-muted)]">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      <SourceTable c={c} />
    </>
  );
}

function approve(c: TargetController) {
  const result = c.markTargetTrackStatus(c.project.id, c.currentTrack.languageCode, "approved");
  c.setEditorMessage(result.ok ? "目标轨已人工批准" : result.message ?? "批准失败");
}

async function exportTrack(c: TargetController) {
  const result = await c.exportTargetTrack(c.project.id, c.currentTrack.languageCode);
  c.setExportMessage(
    result.canceled
      ? "已取消导出"
      : result.ok
        ? `已保存到你选择的文件夹：${result.summary?.succeeded[0]?.fileName ?? c.currentTrack.languageLabel}（已在资源管理器中定位）`
        : result.message ?? "导出失败",
  );
}

function TargetToolbar({ c }: { c: TargetController }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-card px-3 py-2 shadow-card">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-[var(--color-text-main)]">{c.project.sourceFileName}</p>
        <p className="truncate text-[11.5px] text-[var(--color-text-muted)]">
          {c.currentTrack.languageLabel} · <span className="tabular">{c.sourceTrack.segments.length}</span> 段 · 人工{" "}
          <span className="tabular">{c.manualSegmentCount}</span>
          {c.qaErrorCount ? <> · 必须修复 <span className="tabular">{c.qaErrorCount}</span></> : null}
          {c.qaWarningCount ? <> · 优化建议 <span className="tabular">{c.qaWarningCount}</span></> : null}
        </p>
      </div>
      <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => c.navigate(`/projects/${c.project.id}`)}>
        返回
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          const result = c.refreshTargetTrackQa(c.project.id, c.currentTrack.languageCode);
          c.setEditorMessage(result.ok ? "字幕检查已更新" : result.message ?? "字幕检查失败");
        }}
      >
        重新检查字幕
      </Button>
    </div>
  );
}

function SegmentJumpBox({ c, onLocate }: { c: TargetController; onLocate: (segment: Segment) => void }) {
  const query = c.segmentQuery.trim();
  const jump = () => {
    if (!query) return;
    const lower = query.toLowerCase();
    const segments = c.sourceTrack.segments;
    const match =
      segments.find((segment) => segment.id.toLowerCase() === lower) ??
      segments.find((segment) => segment.id.toLowerCase().includes(lower)) ??
      segments.find((segment) =>
        (segment.sourceText.manual ?? segment.sourceText.normalized).toLowerCase().includes(lower)
        || (getTargetSegmentText(segment, c.currentTrack.languageCode)?.manual
          ?? getTargetSegmentText(segment, c.currentTrack.languageCode)?.postProcessed
          ?? getTargetSegmentText(segment, c.currentTrack.languageCode)?.model
          ?? "").toLowerCase().includes(lower),
      );
    if (!match) {
      c.setEditorMessage(`没有找到匹配「${query}」的段。`);
      return;
    }
    onLocate(match);
    c.setEditorMessage(`已定位到段 ${match.id}。`);
  };
  return (
    <div className="flex items-end gap-2">
      <div className="w-52">
        <Input
          aria-label="跳到段"
          placeholder="段 ID 或原文关键字"
          value={c.segmentQuery}
          onChange={(event) => c.setSegmentQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            jump();
          }}
        />
      </div>
      <Button size="sm" variant="outline" icon={<Search size={14} />} disabled={!query} title={query ? undefined : "先输入段 ID 或原文关键字"} onClick={jump}>
        定位
      </Button>
    </div>
  );
}

function SearchReplaceCard({ c }: { c: TargetController }) {
  const replace = () => {
    const ids = c.replaceScope === "当前段" && c.selectedSegmentId ? [c.selectedSegmentId] : null;
    const matchField = c.replaceMatchField === "原文" ? "source" : "target";
    const result = c.replaceTargetTexts(
      c.project.id,
      c.currentTrack.languageCode,
      c.findText,
      c.replaceText,
      ids,
      matchField,
    );
    if (!result.ok) return c.setEditorMessage(result.message ?? "替换失败");
    const replaced = result.replacedCount ?? 0;
    const skipped = result.skippedLockedCount ?? 0;
    if (replaced > 0) {
      c.setEditorMessage(
        `${matchField === "source" ? "已修改对应译文" : "已替换译文"} ${replaced} 段；跳过锁定 ${skipped} 段`,
      );
      return;
    }
    const sourceMatches = matchField === "target"
      ? c.sourceTrack.segments.filter((segment) =>
          (segment.sourceText.manual ?? segment.sourceText.normalized ?? segment.sourceText.original).includes(c.findText),
        ).length
      : 0;
    c.setEditorMessage(
      skipped > 0
        ? `找到 ${skipped} 段，但这些段已锁定，未做修改。`
        : sourceMatches > 0
          ? `当前译文中没有找到“${c.findText}”，但原文中有 ${sourceMatches} 段。把“查找位置”切换为“原文”即可修改对应译文。`
        : `${matchField === "source" ? "原文" : "当前译文"}中没有找到“${c.findText}”。`,
    );
  };
  const blocked = !c.findText || (c.replaceScope === "当前段" && !c.selectedSegmentId);
  return (
    <Card
      title="批量修改译文"
      description="可直接查译文，也可按原文找到对应字幕；锁定段不会被修改。"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          label={c.replaceMatchField === "原文" ? "在原文中查找" : "在当前译文中查找"}
          value={c.findText}
          onChange={(event) => c.setFindText(event.target.value)}
        />
        <Input
          label={c.replaceMatchField === "原文" ? "把对应译文改为" : "替换为"}
          value={c.replaceText}
          onChange={(event) => c.setReplaceText(event.target.value)}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Select
          label="查找位置"
          options={["当前译文", "原文"]}
          value={c.replaceMatchField}
          onChange={(event) => c.setReplaceMatchField(event.target.value as "当前译文" | "原文")}
        />
        <Select
          label="作用域"
          options={["全部段", "当前段"]}
          value={c.replaceScope}
          onChange={(event) => c.setReplaceScope(event.target.value)}
        />
        <Button variant="primary" disabled={blocked} title={blocked ? "先填写查找内容并选中作用域内的段" : undefined} onClick={replace}>
          批量修改
        </Button>
      </div>
    </Card>
  );
}

function TimelineCard({ c }: { c: TargetController }) {
  const run = c.runTimelineEdit;
  const noSegment = !c.selectedSegmentId;
  return (
    <Card title="时间轴安全编辑" description="split/merge 生成新 ID；时间变化会标记待同步。">
      <Input
        label="拆分时间点"
        value={c.splitAt}
        onChange={(event) => c.setSplitAt(event.target.value)}
        placeholder={c.selectedSegment ? `${c.selectedSegment.start} 与 ${c.selectedSegment.end} 之间` : "先选择段"}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={noSegment || !c.splitAt}
          title={noSegment ? "先选中一段" : c.splitAt ? undefined : "先填写拆分时间点"}
          onClick={() => c.selectedSegmentId && run({ kind: "split", segmentId: c.selectedSegmentId, atTimestamp: c.splitAt })}
        >
          拆分
        </Button>
        <Button
          variant="outline"
          disabled={noSegment || !c.nextSegment}
          title={noSegment ? "先选中一段" : c.nextSegment ? undefined : "选中段之后没有可合并的段"}
          onClick={() =>
            c.selectedSegmentId &&
            c.nextSegment &&
            run({ kind: "merge", leftSegmentId: c.selectedSegmentId, rightSegmentId: c.nextSegment.id })
          }
        >
          与下一段合并
        </Button>
        {([-100, 100] as const).map((deltaMs) => (
          <Button
            key={deltaMs}
            variant="ghost"
            disabled={noSegment}
            title={noSegment ? "先选中一段" : undefined}
            onClick={() => c.selectedSegmentId && run({ kind: "shift", segmentId: c.selectedSegmentId, deltaMs })}
          >
            整段 {deltaMs > 0 ? "+" : ""}
            {deltaMs}ms
          </Button>
        ))}
        <Button
          variant="ghost"
          disabled={noSegment}
          title={noSegment ? "先选中一段" : undefined}
          onClick={() => c.selectedSegmentId && run({ kind: "nudge", segmentId: c.selectedSegmentId, edge: "start", deltaMs: 100 })}
        >
          起点 +100ms
        </Button>
        <Button
          variant="ghost"
          disabled={noSegment}
          title={noSegment ? "先选中一段" : undefined}
          onClick={() => c.selectedSegmentId && run({ kind: "nudge", segmentId: c.selectedSegmentId, edge: "end", deltaMs: -100 })}
        >
          终点 -100ms
        </Button>
      </div>
    </Card>
  );
}

type ReviewFilter = "全部" | "必须修复" | "优化建议" | "人工修改";

function issueSegmentIds(track: TargetTrack, severity?: QaIssue["severity"]) {
  return track.qaIssues
    .filter((issue) => isActionableQaIssue(issue) && (!severity || issue.severity === severity))
    .map(qaIssueSegmentId)
    .filter((segmentId): segmentId is string => Boolean(segmentId));
}

function filterReviewSegments(c: TargetController, filter: ReviewFilter) {
  if (filter === "全部") return c.sourceTrack.segments;
  if (filter === "人工修改") {
    return c.sourceTrack.segments.filter((segment) =>
      getTargetSegmentText(segment, c.currentTrack.languageCode)?.manual !== undefined,
    );
  }
  const severity = filter === "必须修复" ? "error" : "warning";
  const ids = new Set(issueSegmentIds(c.currentTrack, severity));
  return c.sourceTrack.segments.filter((segment) => ids.has(segment.id));
}

function ReviewFilterBar({
  c,
  filter,
  onChange,
}: {
  c: TargetController;
  filter: ReviewFilter;
  onChange: (filter: ReviewFilter) => void;
}) {
  const options: Array<{ label: ReviewFilter; count: number }> = [
    { label: "全部", count: c.sourceTrack.segments.length },
    { label: "必须修复", count: new Set(issueSegmentIds(c.currentTrack, "error")).size },
    { label: "优化建议", count: new Set(issueSegmentIds(c.currentTrack, "warning")).size },
    { label: "人工修改", count: c.manualSegmentCount },
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-[8px] border border-line bg-card px-2.5 py-2" role="group" aria-label="字幕筛选">
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          aria-pressed={filter === option.label}
          onClick={() => onChange(option.label)}
          className={`rounded-[6px] border px-2.5 py-1.5 text-[12.5px] transition ${
            filter === option.label
              ? "border-gold bg-gold-wash font-medium text-gold-dark"
              : "border-line bg-card-soft text-[var(--color-text-muted)] hover:border-gold"
          }`}
        >
          {option.label} <span className="tabular">{option.count}</span>
        </button>
      ))}
      <span className="ml-auto text-[11.5px] text-[var(--color-text-muted)]">滚动列表会暂停自动跟随，可在播放器中重新开启。</span>
    </div>
  );
}

function useTargetTableRows({
  autoFollow,
  c,
  playback,
  segments,
}: {
  autoFollow: boolean;
  c: TargetController;
  playback: ReviewPlayback;
  segments: Segment[];
}) {
  const [page, setPage] = useState(0);
  const [pendingRevealId, setPendingRevealId] = useState<string | null>(null);
  const range = getSegmentPage(segments.length, page);
  const visibleSegments = segments.slice(range.start, range.end);
  const changePage = (nextPage: number) => {
    if (c.confirmDiscardDrafts("翻页")) setPage(nextPage);
  };

  useEffect(() => {
    if (range.page !== page) setPage(range.page);
  }, [page, range.page]);

  const revealSegment = useCallback((segmentId: string) => {
    const index = segments.findIndex((segment) => segment.id === segmentId);
    if (index < 0) return;
    setPage(Math.floor(index / SEGMENTS_PER_PAGE));
    setPendingRevealId(segmentId);
  }, [segments]);

  useEffect(() => {
    if (c.selectedSegmentId) revealSegment(c.selectedSegmentId);
  }, [c.selectedSegmentId, revealSegment]);

  useEffect(() => {
    const request = playback.tableRevealRequest;
    if (request) revealSegment(request.segmentId);
  }, [playback.tableRevealRequest, revealSegment]);

  useEffect(() => {
    const activeId = playback.activeSegment?.id;
    if (!autoFollow || !activeId || c.dirtyCount > 0) return;
    const focused = document.activeElement as HTMLElement | null;
    if (focused && (focused.tagName === "TEXTAREA" || focused.tagName === "INPUT" || focused.isContentEditable)) return;
    revealSegment(activeId);
  }, [autoFollow, c.dirtyCount, playback.activeSegment?.id, revealSegment]);

  useEffect(() => {
    if (!pendingRevealId) return;
    const index = segments.findIndex((segment) => segment.id === pendingRevealId);
    if (index < range.start || index >= range.end) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector(`[data-testid="subtitle-row-${pendingRevealId}"]`)
        ?.scrollIntoView({ block: "nearest" });
      setPendingRevealId((current) => current === pendingRevealId ? null : current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingRevealId, range.end, range.start, segments]);

  return { changePage, range, visibleSegments };
}

function TargetTable({
  autoFollow,
  c,
  onManualBrowse,
  onOpenStyle,
  playback,
  segments,
}: {
  autoFollow: boolean;
  c: TargetController;
  onManualBrowse: () => void;
  onOpenStyle: () => void;
  playback: ReviewPlayback;
  segments: Segment[];
}) {
  const { changePage, range, visibleSegments } = useTargetTableRows({ autoFollow, c, playback, segments });
  const splitSegment = useCallback((segment: Segment, targetText: string, targetOffset: number) => {
    c.runTimelineEdit({
      kind: "split_text",
      segmentId: segment.id,
      atTimestamp: formatDomainTimestamp(playback.getCurrentTimeMs()),
      languageCode: c.currentTrack.languageCode,
      targetText,
      targetOffset,
    });
  }, [c.currentTrack.languageCode, c.runTimelineEdit, playback.getCurrentTimeMs]);

  return (
    <Card
      title="字幕表格"
      description="列表独立滚动；当前播放段与所选段分别高亮。"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="blue">{segments.length} 段</Badge>
          {c.dirtyCount ? <Badge tone="red">未保存 {c.dirtyCount}</Badge> : null}
          <Button size="sm" variant="outline" icon={<Palette size={14} />} onClick={onOpenStyle}>
            字幕样式
          </Button>
          <SegmentPagination range={range} onChange={changePage} />
        </div>
      }
    >
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <SegmentJumpBox c={c} onLocate={(segment) => playback.seekSegment(segment)} />
        <p className="text-[11px] text-[var(--color-text-muted)]" data-testid="subtitle-editor-shortcuts">
          键盘：Alt+↑/↓ 或 Alt+J/K 切换焦点段（焦点不在输入框时可省略 Alt）· Ctrl/Cmd+S 保存当前段 · Alt+R 重跑选中段
        </p>
      </div>
      <div
        className="max-h-[min(58vh,520px)] overflow-y-auto overflow-x-hidden rounded-[6px] border border-line"
        data-testid="subtitle-editor-table-scroll"
        onWheel={onManualBrowse}
      >
        <table className="w-full table-fixed border-collapse text-left text-[13px]" data-testid="subtitle-editor-table">
          <colgroup>
            <col className="w-[8%]" />
            <col className="w-[25%]" />
            <col className="w-[20%]" />
            <col className="w-[31%]" />
            <col className="w-[16%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card-soft text-[11px] tracking-[0.08em] text-[var(--color-text-muted)]">
            <tr>
              <th className="px-2.5 py-2 font-medium">段</th>
              <th className="px-2.5 py-2 font-medium">时间轴</th>
              <th className="px-2.5 py-2 font-medium">原文</th>
              <th className="px-2.5 py-2 font-medium">译文</th>
              <th className="px-2.5 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="bg-card">
            {visibleSegments.map((segment) => (
              <SegmentEditorRow
                key={segment.id}
                active={segment.id === playback.activeSegment?.id}
                projectId={c.project.id}
                languageCode={c.currentTrack.languageCode}
                segment={segment}
                translation={getTargetSegmentText(segment, c.currentTrack.languageCode)}
                selected={segment.id === c.selectedSegmentId}
                onDirtyChange={c.markSegmentDirty}
                onFocusSelect={c.setSelectedSegmentId}
                onSelect={playback.seekSegment}
                onSave={c.updateSegmentTranslation}
                onRerun={c.requestRerun}
                onSplit={splitSegment}
                onToggleLock={c.setTargetSegmentLocked}
              />
            ))}
            {visibleSegments.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-[12.5px] text-[var(--color-text-muted)]">当前筛选没有字幕。</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function stylePresetId() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `subtitle-style-${suffix}`;
}

function ProjectSubtitleStylePanel({
  appliedPayload,
  c,
  payload,
  onApply,
  onBack,
  onChange,
}: {
  appliedPayload: SubtitleStylePayload;
  c: TargetController;
  payload: SubtitleStylePayload;
  onApply: () => void;
  onBack: () => void;
  onChange: (next: SubtitleStylePayload) => void;
}) {
  const [presetName, setPresetName] = useState(`${c.project.title} 字幕样式`);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [message, setMessage] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const loadPreset = (resourceId: string) => {
    setSelectedPresetId(resourceId);
    if (resourceId === "__custom__") return;
    if (!resourceId) {
      onChange(structuredClone(appliedPayload));
      setMessage("已恢复当前项目已应用的样式。");
      return;
    }
    const preset = c.library.subtitleStyles.find((entry) => entry.id === resourceId);
    if (!preset) return;
    onChange(structuredClone(preset.payload));
    setMessage(`已载入预设「${preset.name}」，尚未应用到项目。`);
  };
  const savePreset = async () => {
    if (savingPreset) return;
    const name = presetName.trim();
    if (!name) return setMessage("请先填写预设名称。");
    const resource: ResourceWriteInput = {
      id: stylePresetId(),
      kind: "subtitle_style",
      name,
      description: `从项目「${c.project.title}」保存`,
      payload: structuredClone(payload),
    };
    setSavingPreset(true);
    try {
      const result = await c.saveLibraryResource(resource);
      if (!result.ok) return setMessage(result.message);
      setSelectedPresetId(result.resource.id);
      setMessage(`已保存预设「${result.resource.name}」，可在资源库继续修改。`);
    } catch {
      setMessage("保存预设失败，请重试。");
    } finally {
      setSavingPreset(false);
    }
  };

  return (
    <Card
      title="字幕样式"
      description="调整会立即显示在左侧视频；应用后，当前项目全部字幕统一使用这套样式。"
      actions={<Button size="sm" variant="outline" icon={<ArrowLeft size={14} />} onClick={onBack}>返回字幕表格</Button>}
    >
      <div className="mb-3 grid gap-2 rounded-[8px] border border-line bg-card-soft p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">载入已有预设</span>
          <select
            aria-label="载入字幕样式预设"
            value={selectedPresetId}
            className="control-surface h-8 w-full rounded-[6px] border border-line-strong bg-card px-2.5 text-[13px] outline-none hover:border-gold focus:border-gold"
            onChange={(event) => loadPreset(event.target.value)}
          >
            <option value="">当前项目已应用样式</option>
            <option value="__custom__">自定义修改（未应用）</option>
            {c.library.subtitleStyles.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}（第 {preset.revision} 版）</option>)}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input label="另存为预设" value={presetName} onChange={(event) => setPresetName(event.target.value)} />
          </div>
          <Button size="sm" variant="secondary" icon={<Save size={14} />} disabled={savingPreset} onClick={() => void savePreset()}>
            {savingPreset ? "保存中…" : "保存预设"}
          </Button>
        </div>
      </div>
      <SubtitleStyleEditor
        payload={payload}
        showPreviewFields={false}
        onChange={(next) => {
          setSelectedPresetId("__custom__");
          setMessage("样式已在视频中预览，尚未应用到项目。");
          onChange(next);
        }}
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p role="status" className="text-[12px] text-[var(--color-text-muted)]">{message || "当前修改只在预览中；点击应用后才会保存到项目和用于 ASS 导出。"}</p>
        <Button
          variant="primary"
          icon={<CheckCircle2 size={15} />}
          onClick={() => {
            onApply();
            setMessage("已应用到当前项目全部字幕，后续 ASS 导出和视频烧录会使用这套样式。");
          }}
        >
          应用到当前项目全部字幕
        </Button>
      </div>
    </Card>
  );
}

function useSubtitleOverlayGeometry({
  expanded,
  onMediaNode,
  previewUrl,
}: {
  expanded: boolean;
  onMediaNode: (node: HTMLMediaElement | null) => void;
  previewUrl: string | null;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const localMediaRef = useRef<HTMLMediaElement | null>(null);
  const [geometry, setGeometry] = useState({ left: 0, top: 0, width: 0, height: 0, scaleX: 1, scaleY: 1 });
  const update = useCallback(() => {
    const frame = frameRef.current;
    const media = localMediaRef.current;
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    const mediaRect = media?.getBoundingClientRect() ?? frameRect;
    let { width, height } = mediaRect;
    let left = mediaRect.left - frameRect.left;
    let top = mediaRect.top - frameRect.top;
    if (media instanceof HTMLVideoElement && media.videoWidth > 0 && media.videoHeight > 0) {
      const sourceRatio = media.videoWidth / media.videoHeight;
      if (width / Math.max(1, height) > sourceRatio) {
        const contentWidth = height * sourceRatio;
        left += (width - contentWidth) / 2;
        width = contentWidth;
      } else {
        const contentHeight = width / sourceRatio;
        top += (height - contentHeight) / 2;
        height = contentHeight;
      }
    }
    setGeometry({
      left,
      top,
      width: Math.max(0, width),
      height: Math.max(0, height),
      scaleX: Math.max(0.1, width / 1_280),
      scaleY: Math.max(0.1, height / 720),
    });
  }, []);
  const bindMediaNode = useCallback((node: HTMLMediaElement | null) => {
    localMediaRef.current = node;
    onMediaNode(node);
    window.requestAnimationFrame(update);
  }, [onMediaNode, update]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    if (localMediaRef.current) observer.observe(localMediaRef.current);
    update();
    return () => observer.disconnect();
  }, [expanded, previewUrl, update]);
  return { bindMediaNode, frameRef, geometry, update };
}

function SyncedMediaPlayer({
  c,
  expanded,
  previewUrl,
  previewMessage,
  sourceText,
  style,
  targetText,
  loadPreview,
  onMediaNode,
  onMediaTime,
  onOverlayClick,
}: {
  c: TargetController;
  expanded: boolean;
  previewUrl: string | null;
  previewMessage: string | null;
  sourceText: string;
  style: SubtitleStylePayload;
  targetText: string;
  loadPreview: () => void;
  onMediaNode: (node: HTMLMediaElement | null) => void;
  onMediaTime: (media: HTMLMediaElement, settled: boolean) => void;
  onOverlayClick: () => void;
}) {
  const overlay = useSubtitleOverlayGeometry({ expanded, onMediaNode, previewUrl });
  return (
    <div ref={overlay.frameRef} className={`relative flex items-center justify-center overflow-hidden rounded-[10px] border border-line bg-black text-center text-[12.5px] text-white/70 ${
      expanded ? "mx-auto h-[min(70vh,720px)] w-full max-w-[1280px]" : "min-h-48"
    }`}>
      {c.project.noSourceMedia ? (
        <div className="px-4">
          <VideoOff size={20} className="mx-auto mb-1.5 text-gold" />
          当前项目没有源媒体，时间轴仍可编辑，但不能试听同步效果。
        </div>
      ) : previewUrl ? (
        <>
          {c.project.mediaKind === "audio" ? (
            <audio
              ref={overlay.bindMediaNode}
              className="w-[calc(100%-2rem)]"
              controls
              preload="metadata"
              src={previewUrl}
              data-testid="subtitle-preview-player"
              onSeeking={(event) => onMediaTime(event.currentTarget, false)}
              onSeeked={(event) => onMediaTime(event.currentTarget, true)}
              onTimeUpdate={(event) => onMediaTime(event.currentTarget, !event.currentTarget.seeking)}
            />
          ) : (
            <video
              ref={overlay.bindMediaNode}
              className={expanded ? "h-full w-full object-contain" : "max-h-[440px] w-full"}
              controls
              controlsList="nofullscreen"
              playsInline
              preload="metadata"
              src={previewUrl}
              data-testid="subtitle-preview-player"
              onLoadedMetadata={overlay.update}
              onSeeking={(event) => onMediaTime(event.currentTarget, false)}
              onSeeked={(event) => onMediaTime(event.currentTarget, true)}
              onTimeUpdate={(event) => onMediaTime(event.currentTarget, !event.currentTarget.seeking)}
            />
          )}
          {c.project.mediaKind !== "audio" && (targetText || (style.bilingualLayout !== "target_only" && sourceText)) ? (
            <div
              className="pointer-events-none absolute"
              style={{
                left: overlay.geometry.left,
                top: overlay.geometry.top,
                width: overlay.geometry.width,
                height: overlay.geometry.height,
              }}
              aria-live="off"
              data-testid="subtitle-preview-overlay"
            >
              <SubtitleStyleCanvas
                payload={style}
                sourceText={sourceText}
                targetText={targetText}
                direction="auto"
                scaleX={overlay.geometry.scaleX}
                scaleY={overlay.geometry.scaleY}
                renderLine={(content) => (
                  <button
                    type="button"
                    className="pointer-events-auto rounded px-1 transition focus:outline-none focus:ring-2 focus:ring-gold"
                    title="在字幕表格中定位这一段"
                    onClick={onOverlayClick}
                  >
                    {content}
                  </button>
                )}
              />
            </div>
          ) : null}
        </>
      ) : (
        <MediaPreviewFrame className="flex h-full min-h-48 w-full items-center justify-center rounded-[10px]">
          <div className="relative z-10 px-4">
            <PlayCircle size={32} className="mx-auto mb-2 text-white/80" />
            <p>{previewMessage ?? "正在准备媒体预览…"}</p>
            {previewMessage && previewMessage !== "正在加载媒体…" ? (
              <Button className="mt-2" size="sm" variant="primary" onClick={loadPreview}>重试加载</Button>
            ) : null}
          </div>
        </MediaPreviewFrame>
      )}
    </div>
  );
}

type PlaybackClock = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
};

function usePlaybackTime(clock: PlaybackClock) {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}

function useReviewPlayback(c: TargetController) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const currentTimeRef = useRef(0);
  const timeListenersRef = useRef(new Set<() => void>());
  const pendingSeekRef = useRef<{ play: boolean; timeMs: number } | null>(null);
  const seekFrameRef = useRef<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [tableRevealRequest, setTableRevealRequest] = useState<{ segmentId: string; revision: number } | null>(null);
  const clock = useMemo<PlaybackClock>(() => ({
    getSnapshot: () => currentTimeRef.current,
    subscribe: (listener) => {
      timeListenersRef.current.add(listener);
      return () => timeListenersRef.current.delete(listener);
    },
  }), []);
  const activeSegment = useMemo(
    () => c.sourceTrack.segments.find((segment) => segment.id === activeSegmentId) ?? null,
    [activeSegmentId, c.sourceTrack.segments],
  );
  const publishTime = useCallback((timeMs: number, settleActive: boolean) => {
    const nextTimeMs = Math.max(0, Math.round(timeMs));
    if (nextTimeMs !== currentTimeRef.current) {
      currentTimeRef.current = nextTimeMs;
      for (const listener of timeListenersRef.current) listener();
    }
    if (settleActive) {
      const segment = findSegmentAtTime(c.sourceTrack.segments, nextTimeMs);
      setActiveSegmentId((current) => current === (segment?.id ?? null) ? current : segment?.id ?? null);
    }
  }, [c.sourceTrack.segments]);
  const getCurrentTimeMs = useCallback(() => currentTimeRef.current, []);
  const loadPreview = useCallback(() => {
    setPreviewMessage("正在加载媒体…");
    void c.getProjectMediaPreviewUrl(c.project.id)
      .then((result) => {
        if (result.ok) {
          setPreviewUrl(result.url);
          setPreviewMessage(null);
        } else {
          setPreviewMessage(result.message ?? "媒体加载失败");
        }
      })
      .catch(() => setPreviewMessage("媒体加载失败，请重试"));
  }, [c.getProjectMediaPreviewUrl, c.project.id]);

  useEffect(() => {
    if (!c.isDesktop || c.project.noSourceMedia || c.project.mediaSource?.availability !== "available") return;
    loadPreview();
  }, [c.isDesktop, c.project.mediaSource?.availability, c.project.noSourceMedia, loadPreview]);

  const scheduleMediaSeek = useCallback((timeMs: number, play: boolean) => {
    pendingSeekRef.current = { play, timeMs };
    if (seekFrameRef.current !== null) return;
    seekFrameRef.current = window.requestAnimationFrame(() => {
      seekFrameRef.current = null;
      const pending = pendingSeekRef.current;
      pendingSeekRef.current = null;
      const media = mediaRef.current;
      if (!pending || !media) return;
      const timeSeconds = pending.timeMs / 1_000;
      if (Math.abs(media.currentTime - timeSeconds) > 0.01) media.currentTime = timeSeconds;
      if (pending.play && media.paused) {
        void media.play().catch(() => setPreviewMessage("浏览器阻止了自动播放，请点击播放器中的播放按钮"));
      }
    });
  }, []);

  useEffect(() => () => {
    if (seekFrameRef.current !== null) window.cancelAnimationFrame(seekFrameRef.current);
  }, []);

  const seekSegment = useCallback((segment: Segment, play = false) => {
    const startMs = parseDomainTimestamp(segment.start);
    if (startMs === null) return;
    if (!c.setSelectedSegmentId(segment.id)) return;
    publishTime(startMs, true);
    setTableRevealRequest((current) => ({ segmentId: segment.id, revision: (current?.revision ?? 0) + 1 }));
    scheduleMediaSeek(startMs, play);
  }, [c.setSelectedSegmentId, publishTime, scheduleMediaSeek]);

  const seekTime = useCallback((timeMs: number) => {
    const nextTimeMs = Math.max(0, Math.round(timeMs));
    publishTime(nextTimeMs, true);
    const segment = findSegmentAtTime(c.sourceTrack.segments, nextTimeMs);
    if (segment) c.setSelectedSegmentId(segment.id);
    scheduleMediaSeek(nextTimeMs, false);
  }, [c.setSelectedSegmentId, c.sourceTrack.segments, publishTime, scheduleMediaSeek]);
  const onMediaNode = useCallback((node: HTMLMediaElement | null) => {
    mediaRef.current = node;
  }, []);
  const onMediaTime = useCallback((media: HTMLMediaElement, settled: boolean) => {
    publishTime(media.currentTime * 1_000, settled);
  }, [publishTime]);

  return {
    activeSegment,
    clock,
    getCurrentTimeMs,
    loadPreview,
    onMediaNode,
    onMediaTime,
    previewMessage,
    previewUrl,
    seekSegment,
    seekTime,
    tableRevealRequest,
  };
}

type ReviewPlayback = ReturnType<typeof useReviewPlayback>;

type WaveformData = { durationMs: number; peaks: number[] };
type WaveformDrag = { edge: "start" | "end"; previewMs: number; moved: boolean };

function WaveformSelection({
  endMs,
  onStart,
  position,
  startMs,
}: {
  endMs: number;
  onStart: (edge: "start" | "end", previewMs: number) => void;
  position: (timeMs: number) => number;
  startMs: number;
}) {
  return (
    <>
      <rect
        x={position(startMs)}
        y="0"
        width={Math.max(1, position(endMs) - position(startMs))}
        height="100"
        fill="var(--color-gold)"
        fillOpacity="0.12"
      />
      {(["start", "end"] as const).map((edge) => {
        const previewMs = edge === "start" ? startMs : endMs;
        const x = position(previewMs);
        return (
          <g
            key={edge}
            data-waveform-handle={edge}
            className="cursor-ew-resize"
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              onStart(edge, previewMs);
            }}
          >
            <rect x={x - 10} y="0" width="20" height="100" fill="transparent" />
            <line x1={x} y1="0" x2={x} y2="100" stroke="var(--color-gold)" strokeWidth="4" />
          </g>
        );
      })}
    </>
  );
}

const WaveformSegments = memo(function WaveformSegments({
  durationMs,
  peakCount,
  segments,
  selectedId,
}: {
  durationMs: number;
  peakCount: number;
  segments: Segment[];
  selectedId: string | null;
}) {
  const position = (timeMs: number) => durationMs > 0 ? timeMs / durationMs * peakCount : 0;
  return segments.map((segment) => {
    const segmentStart = parseDomainTimestamp(segment.start);
    const segmentEnd = parseDomainTimestamp(segment.end);
    if (segmentStart === null || segmentEnd === null) return null;
    const selected = segment.id === selectedId;
    return (
      <rect
        key={segment.id}
        x={position(segmentStart)}
        y="80"
        width={Math.max(1, position(segmentEnd) - position(segmentStart))}
        height="16"
        fill={selected ? "var(--color-gold)" : "currentColor"}
        fillOpacity={selected ? 0.8 : 0.18}
      />
    );
  });
});

function WaveformPlayhead({
  clock,
  durationMs,
  peakCount,
}: {
  clock: PlaybackClock;
  durationMs: number;
  peakCount: number;
}) {
  const currentTimeMs = usePlaybackTime(clock);
  const x = durationMs > 0 ? Math.min(durationMs, currentTimeMs) / durationMs * peakCount : 0;
  return (
    <line
      x1={x}
      y1="0"
      x2={x}
      y2="100"
      stroke="#ef4444"
      strokeWidth="2"
      pointerEvents="none"
    />
  );
}

function WaveformPlot({
  c,
  playback,
  waveform,
  zoom,
}: {
  c: TargetController;
  playback: ReviewPlayback;
  waveform: WaveformData;
  zoom: number;
}) {
  const [drag, setDrag] = useState<WaveformDrag | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const suppressClickRef = useRef(false);
  const selected = c.selectedSegment;
  const startMs = selected ? parseDomainTimestamp(selected.start) : null;
  const endMs = selected ? parseDomainTimestamp(selected.end) : null;
  const durationMs = waveform.durationMs;
  const peakCount = waveform.peaks.length;
  const position = (timeMs: number) => durationMs > 0 ? timeMs / durationMs * peakCount : 0;
  const displayedStart = drag?.edge === "start" ? drag.previewMs : startMs;
  const displayedEnd = drag?.edge === "end" ? drag.previewMs : endMs;
  const waveformPath = useMemo(() => waveform.peaks.map((peak, index) => {
    const height = Math.max(1, peak * 34);
    return `M${index} ${42 - height}V${42 + height}`;
  }).join(""), [waveform]);

  const pointerMs = (clientX: number) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    return bounds ? timelinePointerMs(clientX, bounds, durationMs) : 0;
  };
  const moveBoundary = (clientX: number) => {
    if (!drag || startMs === null || endMs === null) return;
    const raw = pointerMs(clientX);
    const previewMs = drag.edge === "start"
      ? Math.min(endMs - 1, raw)
      : Math.max(startMs + 1, Math.min(durationMs, raw));
    setDrag({ ...drag, previewMs, moved: drag.moved || previewMs !== (drag.edge === "start" ? startMs : endMs) });
  };
  const finishBoundary = () => {
    if (!drag || !selected || startMs === null || endMs === null) return;
    const originalMs = drag.edge === "start" ? startMs : endMs;
    const deltaMs = drag.previewMs - originalMs;
    suppressClickRef.current = drag.moved;
    setDrag(null);
    if (deltaMs !== 0) c.runTimelineEdit({ kind: "nudge", segmentId: selected.id, edge: drag.edge, deltaMs });
  };

  return (
    <div className="overflow-x-auto rounded border border-line bg-card" data-testid="subtitle-waveform-scroll">
      <svg
        ref={svgRef}
        role="img"
        aria-label="项目完整音频波形；点击定位，拖动金色起点和终点修改所选字幕"
        viewBox={`0 0 ${peakCount} 100`}
        preserveAspectRatio="none"
        className="block h-32 touch-none select-none"
        style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          playback.seekTime(pointerMs(event.clientX));
        }}
        onPointerMove={(event) => moveBoundary(event.clientX)}
        onPointerUp={finishBoundary}
        onPointerCancel={() => setDrag(null)}
      >
        <path d={waveformPath} stroke="currentColor" strokeOpacity="0.58" strokeWidth="0.7" fill="none" />
        <WaveformSegments
          durationMs={durationMs}
          peakCount={peakCount}
          segments={c.sourceTrack.segments}
          selectedId={selected?.id ?? null}
        />
        {displayedStart !== null && displayedEnd !== null ? (
          <WaveformSelection
            startMs={displayedStart}
            endMs={displayedEnd}
            position={position}
            onStart={(edge, previewMs) => setDrag({ edge, previewMs, moved: false })}
          />
        ) : null}
        <WaveformPlayhead clock={playback.clock} durationMs={durationMs} peakCount={peakCount} />
      </svg>
    </div>
  );
}

function WaveformTimeline({ c, playback }: { c: TargetController; playback: ReviewPlayback }) {
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [message, setMessage] = useState("正在生成波形…");
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let active = true;
    if (!c.isDesktop || c.project.noSourceMedia) return;
    setWaveform(null);
    setMessage("正在生成波形…");
    void c.getProjectMediaWaveform(c.project.id).then((result) => {
      if (!active) return;
      if (result.ok) {
        setWaveform({ durationMs: result.durationMs, peaks: result.peaks });
        setMessage("");
      } else setMessage(result.message ?? "波形加载失败");
    }).catch(() => active && setMessage("波形加载失败，可继续使用上方时间按钮编辑"));
    return () => { active = false; };
  }, [c.getProjectMediaWaveform, c.isDesktop, c.project.id, c.project.noSourceMedia]);

  if (!c.isDesktop || c.project.noSourceMedia) return null;
  return (
    <div className="mt-3 rounded-[8px] border border-line bg-card-soft p-2.5" data-testid="subtitle-waveform-timeline">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--color-text-muted)]">
        <span>{waveform ? `完整波形 · ${Math.round(waveform.durationMs / 1_000)} 秒` : message}</span>
        <label className="flex items-center gap-2">
          波形缩放 {zoom}×
          <input
            aria-label="波形缩放"
            type="range"
            min="1"
            max="12"
            step="1"
            value={zoom}
            disabled={!waveform}
            title={waveform ? undefined : "波形生成后才能缩放"}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>
      </div>
      {waveform
        ? <WaveformPlot c={c} playback={playback} waveform={waveform} zoom={zoom} />
        : <p className="py-4 text-center text-[11.5px] text-[var(--color-text-muted)]">{message}</p>}
    </div>
  );
}

function ReviewTimingControls({
  autoFollow,
  c,
  onToggleAutoFollow,
  playback,
}: {
  autoFollow: boolean;
  c: TargetController;
  onToggleAutoFollow: () => void;
  playback: ReviewPlayback;
}) {
  const currentTimeMs = usePlaybackTime(playback.clock);
  const selected = c.selectedSegment;
  const setBoundaryToCurrent = (edge: "start" | "end") => {
    if (!selected) return;
    const current = parseDomainTimestamp(edge === "start" ? selected.start : selected.end);
    if (current === null) return;
    const deltaMs = currentTimeMs - current;
    if (deltaMs === 0) return c.setEditorMessage("当前播放时间已经是所选边界。");
    c.runTimelineEdit({ kind: "nudge", segmentId: selected.id, edge, deltaMs });
  };
  return (
    <div className="mt-3 rounded-[8px] border border-line bg-card-soft p-2.5 text-[11.5px] text-[var(--color-text-muted)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="tabular text-[12px] font-semibold text-[var(--color-text-main)]">
          当前 {Math.floor(currentTimeMs / 60_000)}:{String(Math.floor(currentTimeMs / 1_000) % 60).padStart(2, "0")}.{String(currentTimeMs % 1_000).padStart(3, "0")}
        </p>
        <Button size="sm" variant="ghost" aria-pressed={autoFollow} onClick={onToggleAutoFollow}>
          自动跟随：{autoFollow ? "开" : "关"}
        </Button>
      </div>
      {selected ? (
        <>
          <p className="mt-2 tabular">所选：{selected.start} → {selected.end}</p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setBoundaryToCurrent("start")}>起点设为当前时间</Button>
            <Button size="sm" variant="outline" onClick={() => setBoundaryToCurrent("end")}>终点设为当前时间</Button>
            <Button size="sm" variant="ghost" onClick={() => c.runTimelineEdit({ kind: "nudge", segmentId: selected.id, edge: "start", deltaMs: -100 })}>起点 -100ms</Button>
            <Button size="sm" variant="ghost" onClick={() => c.runTimelineEdit({ kind: "nudge", segmentId: selected.id, edge: "start", deltaMs: 100 })}>起点 +100ms</Button>
            <Button size="sm" variant="ghost" onClick={() => c.runTimelineEdit({ kind: "nudge", segmentId: selected.id, edge: "end", deltaMs: -100 })}>终点 -100ms</Button>
            <Button size="sm" variant="ghost" onClick={() => c.runTimelineEdit({ kind: "nudge", segmentId: selected.id, edge: "end", deltaMs: 100 })}>终点 +100ms</Button>
          </div>
          <Button className="mt-2" size="sm" variant="outline" disabled={!c.canUndoEdit} onClick={() => c.undoProjectEdit(c.project.id)}>撤销时间修改</Button>
        </>
      ) : (
        <p className="mt-2">先在右侧选择一段字幕。</p>
      )}
    </div>
  );
}

function PreviewDetails({
  autoFollow,
  c,
  expanded,
  onToggleExpanded,
  onToggleAutoFollow,
  playback,
  subtitleStyle,
}: {
  autoFollow: boolean;
  c: TargetController;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleAutoFollow: () => void;
  playback: ReviewPlayback;
  subtitleStyle: SubtitleStylePayload;
}) {
  const selected = c.selectedSegment;
  const active = playback.activeSegment;
  const targetText = playback.activeSegment
    ? getTargetSegmentText(playback.activeSegment, c.currentTrack.languageCode)
    : undefined;
  const overlayTarget = targetText?.manual ?? targetText?.postProcessed ?? targetText?.model ?? "";
  const overlaySource = active?.sourceText.manual ?? active?.sourceText.normalized ?? active?.sourceText.original ?? "";

  return (
    <div className={expanded ? "" : "lg:sticky lg:top-3"} data-expanded={expanded ? "true" : "false"} data-testid="review-workbench-player">
      <Card
        title="固定播放器"
        description="点击表格字幕会定位视频；点击视频上的字幕会回到表格。放大预览时编辑工具会移到下方。"
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {selected ? (
              <Button size="sm" variant="primary" icon={<PlayCircle size={14} />} disabled={!playback.previewUrl} onClick={() => playback.seekSegment(selected, true)}>
                播放本段
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              aria-pressed={expanded}
              icon={expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              onClick={onToggleExpanded}
            >
              {expanded ? "恢复布局" : "放大预览"}
            </Button>
          </div>
        )}
      >
        <SyncedMediaPlayer
          c={c}
          expanded={expanded}
          previewUrl={playback.previewUrl}
          previewMessage={playback.previewMessage}
          sourceText={overlaySource}
          style={subtitleStyle}
          targetText={overlayTarget}
          loadPreview={playback.loadPreview}
          onMediaNode={playback.onMediaNode}
          onMediaTime={playback.onMediaTime}
          onOverlayClick={() => playback.activeSegment && playback.seekSegment(playback.activeSegment)}
        />
        <WaveformTimeline c={c} playback={playback} />
        <ReviewTimingControls autoFollow={autoFollow} c={c} onToggleAutoFollow={onToggleAutoFollow} playback={playback} />
      </Card>
    </div>
  );
}

function QaIssuesCard({ c, onLocate }: { c: TargetController; onLocate: (segment: Segment) => void }) {
  const [nextIssueByGroup, setNextIssueByGroup] = useState<Record<string, number>>({});
  const groupedIssues = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; severity: QaIssue["severity"]; issues: QaIssue[] }>();
    for (const issue of c.currentTrack.qaIssues.filter(isActionableQaIssue)) {
      const key = `${issue.severity}/${issue.ruleId ?? issue.label}`;
      const group = groups.get(key) ?? { key, label: issue.label, severity: issue.severity, issues: [] };
      group.issues.push(issue);
      groups.set(key, group);
    }
    return [...groups.values()].sort((left, right) =>
      left.severity === right.severity ? right.issues.length - left.issues.length : left.severity === "error" ? -1 : 1,
    );
  }, [c.currentTrack.qaIssues]);

  const locateNext = (key: string, segmentIds: string[]) => {
    if (segmentIds.length === 0) return;
    const index = (nextIssueByGroup[key] ?? 0) % segmentIds.length;
    const segmentId = segmentIds[index];
    const segment = c.sourceTrack.segments.find((item) => item.id === segmentId);
    if (!segment) return;
    onLocate(segment);
    setNextIssueByGroup((current) => ({ ...current, [key]: index + 1 }));
  };

  return (
    <Card
      title="字幕检查"
      actions={
        <Badge tone={c.qaErrorCount ? "red" : "gray"}>
          必须修复 {c.qaErrorCount} · 优化建议 {c.qaWarningCount}
        </Badge>
      }
    >
      <p className="mb-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        字幕问题按类型汇总，不再把几十条同类提醒全部铺开。点击“定位下一处”会自动翻页并回到对应字幕。
      </p>
      {groupedIssues.length === 0 ? (
        <p className="text-[11.5px] text-[var(--color-text-muted)]">当前没有需要处理的字幕问题。改动译文后可点击“重新检查字幕”。</p>
      ) : (
        <ul className="space-y-1.5">
          {groupedIssues.map((group) => {
            const segmentIds = group.issues
              .map(qaIssueSegmentId)
              .filter((segmentId): segmentId is string => Boolean(segmentId));
            const next = segmentIds.length ? (nextIssueByGroup[group.key] ?? 0) % segmentIds.length + 1 : 0;
            return (
              <li key={group.key} className="rounded-[6px] border border-line bg-card-soft px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={group.severity === "error" ? "red" : "gold"}>{QA_SEVERITY_LABEL[group.severity]}</Badge>
                  <span className="min-w-0 flex-1 text-[12.5px] font-medium text-[var(--color-text-main)]">{group.label}</span>
                  <span className="tabular text-[12.5px] font-semibold text-[var(--color-text-main)]">{group.issues.length} 处</span>
                </div>
                <p className="mt-1 rounded-[5px] bg-card px-2 py-1.5 text-[11.5px] leading-5 text-[var(--color-text-main)]">
                  <strong className="font-medium">怎么处理：</strong>{qaIssueGuidance(group.issues[0])}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5"
                  disabled={segmentIds.length === 0}
                  onClick={() => locateNext(group.key, segmentIds)}
                >
                  定位下一处{segmentIds.length ? `（${next}/${segmentIds.length}）` : ""}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function TrackCard({ c }: { c: TargetController }) {
  const tone =
    c.currentTrack.status === "approved" || c.currentTrack.status === "exported"
      ? "green"
      : c.currentTrack.status === "in_review"
        ? "gold"
        : "gray";
  return (
    <Card title="当前目标轨" actions={<Badge tone={tone}>{formatTargetTrackStatus(c.currentTrack.status)}</Badge>}>
      <dl className="space-y-1.5 text-[12.5px]">
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--color-text-muted)]">语言</dt>
          <dd className="font-medium">{c.currentTrack.languageLabel}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--color-text-muted)]">人工稿</dt>
          <dd className="tabular font-medium">{c.manualSegmentCount}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--color-text-muted)]">字幕检查</dt>
          <dd className="font-medium">
            必须修复 <span className="tabular">{c.qaErrorCount}</span> · 优化建议 <span className="tabular">{c.qaWarningCount}</span>
          </dd>
        </div>
      </dl>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {c.availableTracks.map((track) => {
          const active = track.languageCode === c.currentTrack.languageCode;
          return (
            <button
              key={track.id}
              type="button"
              aria-pressed={active}
              onClick={() => c.openTargetTrack(track.languageCode)}
              className={`rounded-[4px] border px-2 py-1 text-[11.5px] font-medium transition ${
                active
                  ? "border-gold bg-gold-wash text-gold-dark"
                  : "control-surface border-line-strong bg-card text-[var(--color-text-main)] hover:border-gold"
              }`}
            >
              {track.languageLabel}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function CandidateCard({ c }: { c: TargetController }) {
  const create = async () => {
    if (c.isDesktop && !window.confirm("确认生成一份新的候选翻译？当前译文不会被覆盖。")) return;
    const result = await c.createCandidateTranslation(c.project.id, c.currentTrack.languageCode);
    c.setEditorMessage(result.ok ? "候选翻译已生成，可逐段比较采用" : result.message ?? "候选翻译失败");
  };
  const candidate = c.latestCandidate;
  const segment = c.selectedSegment;
  const candidateText = candidate && segment ? candidate.candidateTexts?.[segment.id] : undefined;
  return (
    <Card title="候选翻译" actions={<Badge tone="gray">{c.candidateTracks.length}</Badge>}>
      <Button variant="primary" onClick={() => void create()}>
        新建候选翻译
      </Button>
      {candidate && segment ? (
        <div className="mt-2.5 space-y-2 text-[11.5px] text-[var(--color-text-muted)]">
          <div className="rounded-[6px] border border-line bg-card-soft p-2.5">
            <p>
              活动：
              {getTargetSegmentText(segment, c.currentTrack.languageCode)?.manual ??
                getTargetSegmentText(segment, c.currentTrack.languageCode)?.postProcessed ??
                ""}
            </p>
            <p className="mt-1.5">候选：{candidateText?.postProcessed ?? "等待生成"}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!candidateText}
            title={candidateText ? undefined : "该段还没有候选稿"}
            onClick={() => {
              const result = c.adoptCandidateText(c.project.id, candidate.id, segment.id);
              c.setEditorMessage(result.ok ? "已采用当前段候选稿" : result.message ?? "采用失败");
            }}
          >
            采用当前段
          </Button>
        </div>
      ) : (
        <p className="mt-2.5 text-[11.5px] text-[var(--color-text-muted)]">还没有候选翻译。</p>
      )}
    </Card>
  );
}

function BottomActions({
  c,
  issueCount,
  onNextIssue,
  onPreviousIssue,
  styleDirty,
}: {
  c: TargetController;
  issueCount: number;
  onNextIssue: () => void;
  onPreviousIssue: () => void;
  styleDirty: boolean;
}) {
  const approved = c.currentTrack.status === "approved" || c.currentTrack.status === "exported";
  const styleReason = styleDirty ? "字幕样式还有未应用的修改，请先应用或返回字幕表格放弃修改" : undefined;
  const approveReason = styleReason ?? qaBlockReason(c.qaErrorCount, "批准");
  const exportReason = styleReason ?? qaBlockReason(c.qaErrorCount, "导出") ?? (!approved ? "请先明确批准当前目标轨" : undefined);
  return (
    <BottomActionBar>
      <Button variant="dark" icon={<ArrowLeft size={16} />} onClick={() => c.navigate(`/projects/${c.project.id}`)}>
        返回项目概览
      </Button>
      <Button variant="outline" disabled={issueCount === 0} onClick={onPreviousIssue}>上一处问题</Button>
      <Button variant="outline" disabled={issueCount === 0} onClick={onNextIssue}>下一处问题</Button>
      <Button variant="outline" disabled={!c.canUndoEdit} title={c.canUndoEdit ? "撤销最近一次字幕修改" : "没有可撤销的编辑"} onClick={() => c.undoProjectEdit(c.project.id)}>撤销修改</Button>
      <Button variant="outline" disabled={!c.canRedoEdit} title={c.canRedoEdit ? "恢复刚刚撤销的字幕修改" : "没有可恢复的撤销"} onClick={() => c.redoProjectEdit(c.project.id)}>恢复撤销</Button>
      <span className="text-[11.5px] text-[var(--color-text-muted)]">
        {approveReason ?? (c.dirtyCount ? `有 ${c.dirtyCount} 段译文尚未保存` : "")}
      </span>
      <Button
        variant="dark"
        icon={<CheckCircle2 size={16} />}
        disabled={approved || c.qaErrorCount > 0 || styleDirty}
        title={approveReason ?? (approved ? "该目标轨已批准" : undefined)}
        onClick={() => approve(c)}
      >
        批准当前目标轨
      </Button>
      <Button variant="primary" icon={<Save size={16} />} disabled={!approved || c.qaErrorCount > 0 || styleDirty} title={exportReason} onClick={() => void exportTrack(c)}>
        {c.currentTrack.status === "exported" ? "再次导出字幕" : "导出字幕"}
      </Button>
    </BottomActionBar>
  );
}

function TargetEditorMessages({ c }: { c: TargetController }) {
  const blocked = qaBlockReason(c.qaErrorCount, "批准或导出");
  return (
    <>
      {blocked ? (
        <p role="alert" className="mb-3 rounded-[6px] border border-line bg-stop-wash px-3 py-2 text-[12.5px] text-[var(--color-text-main)]">
          {blocked}；“字幕检查”已按问题类型汇总，可逐个定位处理。
        </p>
      ) : null}
      {c.editorMessage ? (
        <p role="status" className="mb-3 rounded-[6px] border border-line bg-card-soft px-3 py-2 text-[12.5px] text-[var(--color-text-muted)]">
          {c.editorMessage}
        </p>
      ) : null}
      {c.exportMessage ? (
        <p
          role="status"
          data-testid="export-message"
          className="mb-3 rounded-[6px] border border-line bg-card-soft px-3 py-2 text-[12.5px] text-[var(--color-text-muted)]"
        >
          {c.exportMessage}
        </p>
      ) : null}
    </>
  );
}

function subtitleStyleDraftKey(projectId: string) {
  return `subtitle-style-draft:${projectId}`;
}

function readSubtitleStyleDraft(key: string, baseSignature: string) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (stored?.baseSignature !== baseSignature) return null;
    return normalizeSubtitleStylePayload(stored.draft) as SubtitleStylePayload;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

function useProjectSubtitleStyle(c: TargetController) {
  const saved = c.project.config.subtitleStyle ?? createDefaultSubtitleStyle();
  const savedSignature = JSON.stringify(saved);
  const storageKey = subtitleStyleDraftKey(c.project.id);
  const recovered = useMemo(() => readSubtitleStyleDraft(storageKey, savedSignature), [savedSignature, storageKey]);
  const [applied, setApplied] = useState<SubtitleStylePayload>(() => structuredClone(saved));
  const [draft, setDraft] = useState<SubtitleStylePayload>(() => structuredClone(recovered ?? saved));
  const [panelOpen, setPanelOpen] = useState(recovered !== null);
  const tablePanelRef = useRef<HTMLDivElement | null>(null);
  const stylePanelRef = useRef<HTMLDivElement | null>(null);
  const previousPanelOpen = useRef(panelOpen);
  const previousSavedSignature = useRef(savedSignature);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  useEffect(() => {
    if (previousSavedSignature.current === savedSignature) return;
    previousSavedSignature.current = savedSignature;
    const next = structuredClone(c.project.config.subtitleStyle ?? createDefaultSubtitleStyle());
    const wasDirty = JSON.stringify(draft) !== JSON.stringify(applied);
    setApplied(next);
    if (!wasDirty) setDraft(structuredClone(next));
  }, [applied, c.project.config.subtitleStyle, draft, savedSignature]);
  useEffect(() => {
    if (dirty) {
      window.localStorage.setItem(storageKey, JSON.stringify({ baseSignature: JSON.stringify(applied), draft }));
    } else {
      window.localStorage.removeItem(storageKey);
    }
  }, [applied, dirty, draft, storageKey]);
  useEffect(() => {
    if (previousPanelOpen.current === panelOpen) return;
    previousPanelOpen.current = panelOpen;
    window.requestAnimationFrame(() => (panelOpen ? stylePanelRef.current : tablePanelRef.current)?.focus());
  }, [panelOpen]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  const open = () => {
    setDraft(structuredClone(applied));
    setPanelOpen(true);
  };
  const close = () => {
    if (dirty && !window.confirm("还有未应用的字幕样式修改。返回字幕表格会放弃这些修改，是否继续？")) return;
    window.localStorage.removeItem(storageKey);
    setDraft(structuredClone(applied));
    setPanelOpen(false);
  };
  const apply = () => {
    const next = structuredClone(draft);
    window.localStorage.removeItem(storageKey);
    setApplied(next);
    c.updateProjectConfig(c.project.id, { subtitleStyle: next });
  };
  return { applied, apply, close, dirty, draft, open, panelOpen, setDraft, stylePanelRef, tablePanelRef };
}

function TargetEditor({ c }: { c: TargetController }) {
  const playback = useReviewPlayback(c);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("全部");
  const [autoFollow, setAutoFollow] = useState(true);
  const [expandedPreview, setExpandedPreview] = useState(false);
  const subtitleStyle = useProjectSubtitleStyle(c);
  const filteredSegments = useMemo(
    () => filterReviewSegments(c, reviewFilter),
    [c.currentTrack, c.sourceTrack.segments, reviewFilter],
  );
  const issueSegments = useMemo(() => {
    const ids = new Set(issueSegmentIds(c.currentTrack));
    return c.sourceTrack.segments.filter((segment) => ids.has(segment.id));
  }, [c.currentTrack, c.sourceTrack.segments]);
  const changeFilter = (next: ReviewFilter) => {
    if (next === reviewFilter || !c.confirmDiscardDrafts("切换筛选")) return;
    setReviewFilter(next);
  };
  const locateIssue = (direction: -1 | 1) => {
    if (issueSegments.length === 0) return;
    if (reviewFilter !== "全部" && !c.confirmDiscardDrafts("切换到全部字幕")) return;
    setReviewFilter("全部");
    const selectedIndex = issueSegments.findIndex((segment) => segment.id === c.selectedSegmentId);
    const nextIndex = selectedIndex < 0
      ? direction > 0 ? 0 : issueSegments.length - 1
      : (selectedIndex + direction + issueSegments.length) % issueSegments.length;
    playback.seekSegment(issueSegments[nextIndex]);
  };
  const locateFromTool = (segment: Segment) => {
    if (reviewFilter !== "全部" && !c.confirmDiscardDrafts("切换到全部字幕")) return;
    setReviewFilter("全部");
    playback.seekSegment(segment);
  };
  return (
    // subtitle-editor-workbench 是 scripts/e2e-electron-smoke.mjs 等脚本的选择器，不能改名。
    // 底部留白由 AppShell 的 pb-[72px] 统一负责，这里不再自己加。
    <div className="subtitle-editor-workbench" data-testid="subtitle-editor-workbench">
      <PageHeader
        title="字幕编辑"
        description="1280×720 以字幕表格为主。Alt+↑/↓ 切换段，Ctrl+S 保存当前段，Alt+R 重跑选中段。"
        actions={<EditorModeTabs c={c} />}
      />
      <ProjectSectionNav projectId={c.project.id} active="editor" targetLanguageCode={c.currentTrack.languageCode} />
      <TargetToolbar c={c} />
      <TargetEditorMessages c={c} />
      <ReviewFilterBar c={c} filter={reviewFilter} onChange={changeFilter} />
      <div
        className={expandedPreview
          ? "grid items-start gap-3"
          : "grid items-start gap-3 lg:grid-cols-[minmax(320px,0.72fr)_minmax(0,1.28fr)]"}
        data-expanded={expandedPreview ? "true" : "false"}
        data-testid="subtitle-review-workbench"
      >
        <PreviewDetails
          autoFollow={autoFollow}
          c={c}
          expanded={expandedPreview}
          onToggleExpanded={() => setExpandedPreview((current) => !current)}
          onToggleAutoFollow={() => setAutoFollow((current) => !current)}
          playback={playback}
          subtitleStyle={subtitleStyle.draft}
        />
        <div ref={subtitleStyle.tablePanelRef} hidden={subtitleStyle.panelOpen} tabIndex={-1} role="region" aria-label="字幕表格面板" className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold" data-testid="subtitle-table-panel">
          <TargetTable
            key={reviewFilter}
            autoFollow={autoFollow}
            c={c}
            onManualBrowse={() => setAutoFollow(false)}
            onOpenStyle={subtitleStyle.open}
            playback={playback}
            segments={filteredSegments}
          />
        </div>
        <div ref={subtitleStyle.stylePanelRef} hidden={!subtitleStyle.panelOpen} tabIndex={-1} role="region" aria-label="字幕样式面板" className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold" data-testid="subtitle-style-panel">
          <ProjectSubtitleStylePanel
            appliedPayload={subtitleStyle.applied}
            c={c}
            payload={subtitleStyle.draft}
            onApply={subtitleStyle.apply}
            onBack={subtitleStyle.close}
            onChange={subtitleStyle.setDraft}
          />
        </div>
      </div>
      <details className="mt-3 rounded-[10px] border border-line bg-card shadow-card">
        <summary className="cursor-pointer px-3.5 py-2.5 text-[12.5px] font-semibold text-[var(--color-text-main)]">
          次要工具：查找替换、候选翻译与边界说明
        </summary>
        <div className="grid gap-3 border-t border-line p-3.5 lg:grid-cols-2 2xl:grid-cols-3">
          <SearchReplaceCard c={c} />
          <TimelineCard c={c} />
          <QaIssuesCard c={c} onLocate={locateFromTool} />
          <TrackCard c={c} />
          <CandidateCard c={c} />
          <Card title="边界" actions={<FileWarning size={14} className="text-gold-dark" />}>
            <ul className="space-y-1.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
              <li>锁定段不会被自动重跑/替换覆盖。</li>
              <li>人工稿优先；显式重跑保留历史人工稿。</li>
              <li>“必须修复”会阻止批准与导出；“优化建议”不会。</li>
            </ul>
          </Card>
        </div>
      </details>
      <BottomActions
        c={c}
        issueCount={issueSegments.length}
        onPreviousIssue={() => locateIssue(-1)}
        onNextIssue={() => locateIssue(1)}
        styleDirty={subtitleStyle.dirty}
      />
    </div>
  );
}

export default function SubtitleEditorPage() {
  const c = useSubtitleEditorController();
  if (c.editorMode === "source") {
    return c.project && c.sourceTrack ? (
      <SourceEditor c={{ ...c, project: c.project, sourceTrack: c.sourceTrack }} />
    ) : (
      <MissingEditor controller={c} sourceOnly />
    );
  }
  return c.project && c.sourceTrack && c.currentTrack ? (
    <TargetEditor key={c.project.id} c={{ ...c, project: c.project, sourceTrack: c.sourceTrack, currentTrack: c.currentTrack }} />
  ) : (
    <MissingEditor controller={c} />
  );
}
