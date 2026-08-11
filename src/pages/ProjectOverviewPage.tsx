import { ArrowLeft, CheckCircle2, FileOutput, Languages, Loader2, Play, Sparkles, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import MediaSourcePanel from "../components/feature/project-overview/MediaSourcePanel";
import ProjectConfigPanel from "../components/feature/project-overview/ProjectConfigPanel";
import {
  DeleteProjectButton,
  RetranslateButton,
} from "../components/feature/project-overview/ProjectLifecycleActions";
import { QaSummaryCard } from "../components/feature/project-overview/ProjectStatusPanels";
import RunProgressBanner from "../components/feature/project-overview/RunProgressBanner";
import AutomaticWorkflowBanner from "../components/feature/AutomaticWorkflowBanner";
import type { MediaProbeSummary } from "../components/feature/project-overview/types";
import Badge from "../components/ui/Badge";
import BottomActionBar from "../components/ui/BottomActionBar";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Select from "../components/ui/Select";
import PageHeader from "../layout/PageHeader";
import {
  deriveProjectStatusSummary,
  getActiveSourceTrack,
  getActiveTargetTracks,
  getLatestProjectTranslationTask,
  resolveAsrLanguageSelection,
  type Project,
  type ProjectStatusSummary,
  type SourceTrack,
  type Segment,
} from "../domain/workspace";
import type { AsrProjectStatusResponse } from "../contracts/desktop-api";
import { analyzeSourceQuality, describeSourceQuality } from "../domain/source-quality";
import { useWorkspace } from "../state/WorkspaceContext";

function operationId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}`;
}

const AUDIO_STREAM_PLACEHOLDER = "请选择并确认音频轨";

function audioStreamLabel(stream: Record<string, unknown>): string {
  return `${String(stream.streamId)} · ${String(stream.language ?? "und")} · ${String(stream.codec ?? "audio")}`;
}

/* --------------------------------------------------------------------------
   本地 ASR 工作流

   这一块必须留在本文件里：tests/ui-controls.test.mjs 只读 ProjectOverviewPage.tsx
   来断言「只做 ASR / 只做重切分 / 显式激活 / confirmedAudioStreamId」等一整套
   行为性字符串。文件内部按职责拆成了若干小组件。
   -------------------------------------------------------------------------- */

function LowConfidenceRow({
  track,
  segment,
  busy,
  draft,
  onDraftChange,
  onConfirm,
}: {
  track: SourceTrack;
  segment: Segment;
  busy: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onConfirm: (track: SourceTrack, segment: Segment, language: string) => void;
}) {
  const unset = !draft || draft === "请选择";

  return (
    <div className="grid gap-2 rounded-[6px] border border-line p-2.5 sm:grid-cols-[1fr_110px_auto] sm:items-end">
      <div className="min-w-0 text-[11.5px] text-[var(--color-text-muted)]">
        <p className="truncate font-medium text-[var(--color-text-main)]">
          {segment.id} · 置信度 <span className="tabular">{segment.languageConfidence?.toFixed(2) ?? "不可用"}</span>
        </p>
        <p className="mt-0.5 truncate">{segment.sourceText.normalized}</p>
      </div>
      <Select
        aria-label={`${segment.id} 人工语言`}
        options={["请选择", "en", "zh", "ja", "ko"]}
        value={draft || "请选择"}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <Button
        variant="outline"
        disabled={unset || busy}
        title={unset ? "请先选择这一段的人工语言" : busy ? "已有语音识别操作正在执行" : undefined}
        onClick={() => onConfirm(track, segment, draft)}
      >
        确认此段
      </Button>
    </div>
  );
}

function AsrCandidatePanel({
  asrCandidates,
  lowConfidence,
  busyOperationId,
  onDetectLanguages,
  onActivate,
  onConfirmDetectedLanguages,
  onConfirmSegmentLanguage,
}: {
  asrCandidates: SourceTrack[];
  lowConfidence: Array<{ track: SourceTrack; segment: Segment }>;
  busyOperationId: string | null;
  onDetectLanguages: (track: SourceTrack) => void;
  onActivate: (track: SourceTrack) => void;
  onConfirmDetectedLanguages: (track: SourceTrack, segments: Segment[]) => void;
  onConfirmSegmentLanguage: (track: SourceTrack, segment: Segment, language: string) => void;
}) {
  const [languageDrafts, setLanguageDrafts] = useState<Record<string, string>>({});
  // 历史识别轨仍保存在项目里供回滚，但工作流只呈现最近生成的一份，避免步骤 3 横向堆叠。
  const latestCandidates = asrCandidates.slice(-1);
  const track = latestCandidates[0] ?? null;
  const pending = track ? lowConfidence.filter((item) => item.track.id === track.id) : [];
  const suggested = pending
    .map((item) => item.segment)
    .filter((segment) =>
      Boolean(segment.detectedLanguage && segment.detectedLanguage !== "und")
      && segment.languageOverlapStatus !== "overlap_unsupported",
    );
  const visible = pending.slice(0, 20);
  const rest = pending.length - visible.length;
  const confirmedCount = track ? track.segments.length - pending.length : 0;

  return (
    <div className="rounded-[10px] border border-line bg-card-soft p-3">
      <p className="text-[13px] font-semibold text-[var(--color-text-main)]">原文语言自动检查</p>
      <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        这里判断每段原文说的是什么语言，不是选择翻译目标。点击一次会检查全部字幕段；高置信结果自动确认，只有低置信段才需要复核。不会发起翻译或扣费。
      </p>
      {track ? (
        <>
          <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
            <div className="min-w-0 rounded-[6px] border border-line bg-card px-2.5 py-2">
              <p className="text-[11px] text-[var(--color-text-muted)]">最近识别结果</p>
              <p className="mt-0.5 truncate text-[12.5px] font-medium text-[var(--color-text-main)]" title={track.summary}>{track.summary}</p>
            </div>
            <div className="rounded-[6px] border border-line bg-card px-2.5 py-2">
              <p className="text-[11px] text-[var(--color-text-muted)]">已自动确认</p>
              <p className="mt-0.5 tabular text-[16px] font-semibold text-[var(--color-text-main)]">{confirmedCount}</p>
            </div>
            <div className="rounded-[6px] border border-line bg-card px-2.5 py-2">
              <p className="text-[11px] text-[var(--color-text-muted)]">待复核</p>
              <p className="mt-0.5 tabular text-[16px] font-semibold text-[var(--color-text-main)]">{pending.length}</p>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={Boolean(busyOperationId)}
              title={busyOperationId ? "已有语音识别操作正在执行" : undefined}
              onClick={() => onDetectLanguages(track)}
            >
              自动识别全部段语言
            </Button>
            {suggested.length > 0 ? (
              <Button
                variant="secondary"
                disabled={Boolean(busyOperationId)}
                title="一次采用每段已有的自动检测建议，不需要逐段点击"
                onClick={() => onConfirmDetectedLanguages(track, suggested)}
              >
                采用自动检测建议（{suggested.length} 段）
              </Button>
            ) : null}
            <Button
              variant="primary"
              className="sm:ml-auto"
              disabled={Boolean(busyOperationId) || pending.length > 0}
              title={busyOperationId ? "已有语音识别操作正在执行" : pending.length > 0 ? `还有 ${pending.length} 段原文语言待确认` : undefined}
              onClick={() => onActivate(track)}
            >
              3. 使用这份字幕
            </Button>
          </div>
          {pending.length > 0 ? (
            <details className="mt-2.5 rounded-[6px] border border-line bg-card">
              <summary className="cursor-pointer px-2.5 py-2 text-[11.5px] font-medium text-[var(--color-text-main)]">
                手动复核仍不确定的段（{pending.length}）
              </summary>
              <div className="max-h-64 space-y-2 overflow-auto border-t border-line p-2.5">
                {visible.map(({ segment }) => (
                  <LowConfidenceRow
                    key={segment.id}
                    track={track}
                    segment={segment}
                    busy={Boolean(busyOperationId)}
                    draft={languageDrafts[segment.id] ?? ""}
                    onDraftChange={(value) => setLanguageDrafts((current) => ({ ...current, [segment.id]: value }))}
                    onConfirm={onConfirmSegmentLanguage}
                  />
                ))}
                {rest > 0 ? (
                  <p className="text-[11.5px] text-[var(--color-text-muted)]">其余 {rest} 段会在前面的段确认后继续显示。</p>
                ) : null}
              </div>
            </details>
          ) : (
            <p className="mt-2.5 rounded-[6px] border border-ok bg-ok-wash px-2.5 py-2 text-[11.5px] text-[var(--color-text-main)]">
              全部 {track.segments.length} 段的原文语言已确认，可以使用这份字幕。
            </p>
          )}
          <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">
            当前活动源轨、人工原文和已有译文会保留；使用这份字幕只会切换当前引用，不删除旧轨。
          </p>
        </>
      ) : (
        <p className="mt-2.5 rounded-[6px] border border-dashed border-line px-2.5 py-3 text-[11.5px] text-[var(--color-text-muted)]">
          先完成“2. 生成字幕段”，这里会显示自动语言检查和“3. 使用这份字幕”。
        </p>
      )}
    </div>
  );
}

function AsrRunControls({
  project,
  audioStreams,
  confirmedAudioStreamId,
  hasRuns,
  disabledReason,
  busyOperationId,
  onSelectStream,
  onRunAsr,
  onCancel,
}: {
  project: Project;
  audioStreams: Array<Record<string, unknown>>;
  confirmedAudioStreamId: string;
  hasRuns: boolean;
  disabledReason?: string;
  busyOperationId: string | null;
  onSelectStream: (streamId: string) => void;
  onRunAsr: () => void;
  onCancel: () => void;
}) {
  const { isDesktop } = useWorkspace();
  const selected = audioStreams.find((stream) => String(stream.streamId) === confirmedAudioStreamId);

  return (
    <div className="grid gap-2.5 md:grid-cols-[minmax(220px,1fr)_auto_auto] md:items-end">
      <Select
        label="用于语音识别的音频轨"
        options={[AUDIO_STREAM_PLACEHOLDER, ...audioStreams.map(audioStreamLabel)]}
        value={selected ? audioStreamLabel(selected) : AUDIO_STREAM_PLACEHOLDER}
        disabled={!isDesktop || Boolean(busyOperationId) || audioStreams.length === 0}
        title={audioStreams.length === 0 ? "尚未探测到音频轨，请先重新探测媒体" : undefined}
        onChange={(event) => {
          const match = audioStreams.find((stream) => audioStreamLabel(stream) === event.target.value);
          onSelectStream(match ? String(match.streamId) : "");
        }}
      />
      <Button variant="primary" disabled={Boolean(disabledReason)} title={disabledReason} onClick={onRunAsr}>
        {hasRuns ? "1. 重新语音识别" : "1. 开始语音识别"}
      </Button>
      <Button
        variant="secondary"
        disabled={!busyOperationId}
        title={busyOperationId ? "取消当前语音识别或字幕生成" : "当前没有可取消的操作"}
        onClick={onCancel}
      >
        取消
      </Button>
      <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)] md:col-span-3">
        {project.mediaSource?.selectedAudioStreamId && !confirmedAudioStreamId
          ? "之前确认过的音频轨在当前探测结果里不存在，请重新确认。"
          : "音频轨只在这里显式确认，不会静默切换。"}
      </p>
    </div>
  );
}

function AsrStatusNotice({ error, message, busy }: { error: string | null; message: string; busy: boolean }) {
  const complete = !error && !busy && /完成|已生成|已确认|已设为|已关联/.test(message);
  const title = error ? "语音识别未完成" : busy ? "语音识别处理中" : complete ? "步骤完成" : "语音识别状态";
  return (
    <div
      role={error ? "alert" : "status"}
      aria-live="polite"
      className={`flex items-start gap-2 rounded-[8px] border px-3 py-2.5 ${
        error ? "border-stop bg-stop-wash" : busy ? "border-gold bg-gold-wash" : complete ? "border-ok bg-ok-wash" : "border-line bg-card-soft"
      }`}
    >
      {error ? (
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-stop" />
      ) : busy ? (
        <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-gold-dark" />
      ) : (
        <CheckCircle2 size={18} className={`mt-0.5 shrink-0 ${complete ? "text-ok" : "text-[var(--color-text-muted)]"}`} />
      )}
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-[var(--color-text-main)]">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">{error ?? message}</p>
        {error ? (
          <p className="mt-1 text-[11.5px] leading-5 text-[var(--color-text-main)]">
            项目和已有字幕没有被删除。请检查模型状态、音频轨和错误说明后重试。
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AsrRunSection({
  project,
  mediaMissing,
  hasExtractableSubtitle,
  audioStreams,
  confirmedAudioStreamId,
  asrReady,
  disabledReason,
  busyOperationId,
  runs,
  onSelectStream,
  onRunAsr,
  onCancel,
  onSegmentRun,
  onRelink,
}: {
  project: Project;
  mediaMissing: boolean;
  hasExtractableSubtitle: boolean;
  audioStreams: Array<Record<string, unknown>>;
  confirmedAudioStreamId: string;
  asrReady: boolean | null;
  disabledReason?: string;
  busyOperationId: string | null;
  runs: AsrProjectStatusResponse["runs"];
  onSelectStream: (streamId: string) => void;
  onRunAsr: () => void;
  onCancel: () => void;
  onSegmentRun: (asrRunId: string) => void;
  onRelink: () => void;
}) {
  const navigate = useNavigate();
  const latestRun = runs[0];
  const latestCandidateExists = Boolean(
    latestRun && project.sourceTracks.some(
      (track) => track.kind === "asr" && track.asrRunId === latestRun.id && !track.trashedAt,
    ),
  );
  return (
    <div className="min-w-0">
      {asrReady === false ? (
        <div className="mb-2.5 rounded-[6px] border border-gold bg-gold-wash px-2.5 py-2">
          <p className="text-[12.5px] font-medium text-[var(--color-text-main)]">先安装本地语音识别模型</p>
          <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
            打开“语音识别模型”，安装 Whisper.cpp small。安装完成后回到这里，选择音频轨并开始识别；不用删除或重新导入项目。
          </p>
          <Button className="mt-2" variant="secondary" size="sm" onClick={() => navigate("/capabilities?tab=asr")}>
            安装或检查语音识别模型
          </Button>
        </div>
      ) : null}
      <AsrRunControls
        project={project}
        audioStreams={audioStreams}
        confirmedAudioStreamId={confirmedAudioStreamId}
        hasRuns={runs.length > 0}
        disabledReason={disabledReason}
        busyOperationId={busyOperationId}
        onSelectStream={onSelectStream}
        onRunAsr={onRunAsr}
        onCancel={onCancel}
      />
      <p className="mt-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        {hasExtractableSubtitle
          ? "检测到视频自带字幕，优先提取会更快更准；只有提取结果不可用时再做语音识别。"
          : "操作顺序：选择音频轨 → 开始语音识别 → 生成字幕段 → 使用这份字幕。"}
      </p>
      {mediaMissing ? (
        <Button className="mt-2.5" variant="outline" onClick={onRelink}>
          重新关联媒体
        </Button>
      ) : null}
      {latestRun ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[6px] border border-line bg-card-soft px-2.5 py-2">
          <Button
            variant={latestCandidateExists ? "secondary" : "primary"}
            disabled={Boolean(busyOperationId)}
            title={busyOperationId ? "已有语音识别操作正在执行" : undefined}
            onClick={() => onSegmentRun(latestRun.id)}
          >
            {latestCandidateExists ? "2. 重新生成字幕段" : "2. 生成字幕段"}
          </Button>
          <span className="text-[11.5px] text-[var(--color-text-muted)]">
            使用最近一次识别结果 · {latestRun.rawSegmentCount} 个原始片段 · {latestRun.detectedLanguage}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ProjectAsrWorkflow({
  project,
  mediaProbe,
  mediaMissing,
  expanded,
  onExpandedChange,
}: {
  project: Project;
  mediaProbe?: MediaProbeSummary;
  mediaMissing: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const {
    isDesktop,
    selectProjectMediaStreams,
    getProjectAsrStatus,
    runProjectAsr,
    segmentProjectAsrRun,
    detectProjectAsrLanguages,
    updateProjectAsrLanguages,
    cancelProjectAsrOperation,
    activateProjectSourceTrack,
    relinkProjectMedia,
  } = useWorkspace();
  const audioStreams = useMemo(
    () => mediaProbe?.streams?.filter((stream) => stream.kind === "audio") ?? [],
    [mediaProbe],
  );
  const hasExtractableSubtitle = Boolean(
    mediaProbe?.streams?.some((stream) => stream.kind === "subtitle" && stream.extractable),
  );
  // 从「开始翻译」页的「去做语音识别」跳进来时带 ?focus=asr：
  // 直接展开并滚到位，否则用户点进来只看到一个折叠标题，不知道该干什么。
  const [searchParams] = useSearchParams();
  const focusAsr = searchParams.get("focus") === "asr";
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const needsSource = project.sourceTracks.every((track) => track.segments.length === 0);
  useEffect(() => {
    if (!focusAsr) return;
    onExpandedChange(true);
    window.requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ block: "start" }));
  }, [focusAsr, onExpandedChange]);
  const [status, setStatus] = useState<AsrProjectStatusResponse | null>(null);
  const [confirmedAudioStreamId, setConfirmedAudioStreamId] = useState(project.mediaSource?.confirmedAudioStreamId ?? "");
  const [busyOperationId, setBusyOperationId] = useState<string | null>(null);
  const actionLockRef = useRef<string | null>(null);
  const [message, setMessage] = useState("正在检查本地语音识别是否可用。");
  const [error, setError] = useState<string | null>(null);
  const [affectedSegmentIds, setAffectedSegmentIds] = useState<string[]>([]);
  const asrCandidates = useMemo(
    () => project.sourceTracks.filter((track) => track.kind === "asr" && !track.isActive && !track.trashedAt),
    [project.sourceTracks],
  );
  // 低置信段以前每次 setState 都会全量重扫候选轨的全部 segment
  const lowConfidence = useMemo(
    () =>
      asrCandidates.flatMap((track) =>
        track.segments
          .filter(
            (segment) =>
              !segment.manualLanguage && (
                segment.sourceLanguage === "und" ||
                segment.languageOverlapStatus === "overlap_unsupported" ||
                (segment.languageConfidence ?? 0) < 0.8
              ),
          )
          .map((segment) => ({ track, segment })),
      ),
    [asrCandidates],
  );

  useEffect(() => {
    const persisted = project.mediaSource?.confirmedAudioStreamId ?? "";
    setConfirmedAudioStreamId(persisted && audioStreams.some((stream) => stream.streamId === persisted) ? persisted : "");
  }, [project.id, project.mediaSource?.confirmedAudioStreamId, mediaProbe]);

  useEffect(() => {
    let active = true;
    void getProjectAsrStatus(project.id).then((result) => {
      if (!active) return;
      if (!result.ok) return setError(result.message);
      setStatus(result.data);
      setMessage(result.data.runs.length ? "找到之前保存的语音识别结果，可继续生成字幕段。" : "还没有进行过语音识别。");
    });
    return () => {
      active = false;
    };
  }, [isDesktop, project.id]);

  const refreshStatus = async () => {
    const result = await getProjectAsrStatus(project.id);
    if (!result.ok) return setError(result.message);
    setStatus(result.data);
    setError(null);
  };

  const runAction = async (
    id: string,
    progress: string,
    action: () => Promise<{ ok: boolean; message?: string }>,
    success: string,
  ) => {
    if (actionLockRef.current) return;
    actionLockRef.current = id;
    setBusyOperationId(id);
    setMessage(progress);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.message ?? "语音识别操作失败，请重试。");
        setMessage("操作已结束，未产生新结果。");
      } else {
        setMessage(success);
        await refreshStatus();
      }
    } catch {
      setError("语音识别操作失败，请检查模型与音频轨后重试。");
      setMessage("操作已结束，未产生新结果。");
    } finally {
      if (actionLockRef.current === id) {
        actionLockRef.current = null;
        setBusyOperationId(null);
      }
    }
  };

  const disabledReason = mediaMissing
    ? "媒体源缺失，请先重新关联媒体"
    : !status
      ? "正在检查本地语音识别组件"
      : !status.capability.ready
      ? "语音识别模型尚未安装或校验失败，请先按上方提示处理"
      : !confirmedAudioStreamId
        ? "请先选择并确认音频轨"
        : busyOperationId
          ? "已有语音识别操作正在执行"
          : undefined;

  const selectAudioStream = async (streamId: string) => {
    if (!streamId) return setConfirmedAudioStreamId("");
    const result = await selectProjectMediaStreams(project.id, {
      audioStreamId: streamId,
    });
    if (!result.ok) return setError(result.message ?? "音频轨确认失败");
    setConfirmedAudioStreamId(streamId);
    setMessage(`已明确确认音频轨 ${streamId}，不会静默切换。`);
    setError(null);
  };

  const confirmLanguages = async (
    track: SourceTrack,
    changes: Array<{ segmentId: string; manualLanguage: string }>,
    success: string,
  ) => {
    const id = operationId("language-confirm");
    if (actionLockRef.current || changes.length === 0) return;
    actionLockRef.current = id;
    setBusyOperationId(id);
    setMessage("正在保存原文语言确认…");
    setError(null);
    try {
      const result = await updateProjectAsrLanguages({
        projectId: project.id,
        sourceTrackId: track.id,
        changes,
        confirmTrackConvergence: false,
      });
      if (!result.ok) return setError(result.message ?? "语言确认失败");
      setAffectedSegmentIds(result.affectedSegmentIds ?? []);
      setMessage(success);
    } catch {
      setError("语言确认失败，原有检测结果仍然保留。");
    } finally {
      if (actionLockRef.current === id) {
        actionLockRef.current = null;
        setBusyOperationId(null);
      }
    }
  };

  const confirmSegmentLanguage = (track: SourceTrack, segment: Segment, language: string) => {
    void confirmLanguages(
      track,
      [{ segmentId: segment.id, manualLanguage: language }],
      "已确认这一段的原文语言；不会自动发起付费翻译。",
    );
  };

  const confirmDetectedLanguages = (track: SourceTrack, segments: Segment[]) => {
    void confirmLanguages(
      track,
      segments.map((segment) => ({ segmentId: segment.id, manualLanguage: segment.detectedLanguage! })),
      `已一次采用 ${segments.length} 段自动检测建议；仍不确定的段会留在下方。`,
    );
  };

  const startAsr = () => {
    const id = operationId("asr");
    void runAction(
      id,
      "正在识别视频中的语音…",
      () =>
        runProjectAsr({
          projectId: project.id,
          audioStreamId: confirmedAudioStreamId,
          ...resolveAsrLanguageSelection(project.config.sourceLanguage),
          requestedDevice: status?.device.requestedDevice ?? "cpu",
          allowCudaFallback: status?.device.allowCudaFallback ?? false,
          operationId: id,
        }),
      "语音识别完成。下一步点击“2. 生成字幕段”。",
    );
  };

  const segmentRun = (asrRunId: string) => {
    const id = operationId("segment");
    void runAction(
      id,
      "正在把识别结果生成字幕段…",
      () =>
        segmentProjectAsrRun({
          projectId: project.id,
          asrRunId,
          configVersion: "asr-segmentation-v2",
          operationId: id,
        }),
      "字幕段已生成。检查右侧结果后，点击“3. 使用这份字幕”。",
    );
  };

  const detectLanguages = (track: SourceTrack) => {
    const id = operationId("language");
    void runAction(
      id,
      "正在检测段语言…",
      () =>
        detectProjectAsrLanguages({
          projectId: project.id,
          sourceTrackId: track.id,
          requestedDevice: status?.device.requestedDevice ?? "cpu",
          allowCudaFallback: status?.device.allowCudaFallback ?? false,
          operationId: id,
        }),
      "段语言检测完成；低置信段等待人工确认。",
    );
  };

  const activateCandidate = async (track: SourceTrack) => {
    const result = await activateProjectSourceTrack(project.id, track.id);
    if (!result.ok) return setError(result.message ?? "候选轨激活失败");
    setMessage("这份识别字幕已设为当前原文；现在可以开始翻译。旧字幕和译文仍然保留。");
    setError(null);
  };

  const cancelCurrentOperation = async () => {
    if (!busyOperationId) return;
    const result = await cancelProjectAsrOperation({ projectId: project.id, operationId: busyOperationId });
    setMessage(result.cancelled ? "取消请求已发送，正在清理子进程与临时文件。" : "操作已结束，无需取消。");
  };

  const relinkMedia = async () => {
    const result = await relinkProjectMedia(project.id);
    if (!result.ok) return setError(result.message ?? "重新关联媒体失败");
    setMessage("媒体已重新关联；请重新选择并确认音频轨。");
    setError(null);
  };

  return (
    <div id="project-asr-section" ref={sectionRef}>
    <Card
      title={needsSource ? "第一步：把视频里的话转成文字" : "语音识别"}
      description={
        needsSource
          ? "翻译需要「一句话 + 它出现的时间」。这个项目还没有文字，先在这里做一次语音识别。"
          : "识别只生成新的原文轨，不会覆盖当前正在用的那一条。"
      }
      actions={
        <>
          <Badge tone={status?.capability.ready ? "green" : "gold"}>
            {status ? status.capability.ready ? "语音识别已就绪" : "需要安装模型" : "正在检查"}
          </Badge>
          <Button variant="ghost" onClick={() => onExpandedChange(!expanded)}>
            {expanded ? "收起" : hasExtractableSubtitle ? "展开（已检测到可提取字幕）" : "展开"}
          </Button>
        </>
      }
    >
      {expanded ? (
        <div data-testid="asr-project-workflow" className="space-y-3">
          <AsrStatusNotice error={error} message={message} busy={Boolean(busyOperationId)} />
          <AsrRunSection
            project={project}
            mediaMissing={mediaMissing}
            hasExtractableSubtitle={hasExtractableSubtitle}
            audioStreams={audioStreams}
            confirmedAudioStreamId={confirmedAudioStreamId}
            asrReady={status ? status.capability.ready : null}
            disabledReason={disabledReason}
            busyOperationId={busyOperationId}
            runs={status?.runs ?? []}
            onSelectStream={(streamId) => void selectAudioStream(streamId)}
            onRunAsr={startAsr}
            onCancel={() => void cancelCurrentOperation()}
            onSegmentRun={segmentRun}
            onRelink={() => void relinkMedia()}
          />

          <div className="min-w-0 space-y-2.5">
            <AsrCandidatePanel
              asrCandidates={asrCandidates}
              lowConfidence={lowConfidence}
              busyOperationId={busyOperationId}
              onDetectLanguages={detectLanguages}
              onActivate={(track) => void activateCandidate(track)}
              onConfirmDetectedLanguages={confirmDetectedLanguages}
              onConfirmSegmentLanguage={(track, segment, language) =>
                confirmSegmentLanguage(track, segment, language)
              }
            />
            <AsrRerunEntry project={project} affectedSegmentIds={affectedSegmentIds} />
          </div>
        </div>
      ) : (
        <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          {hasExtractableSubtitle
            ? "这个视频自带字幕，直接提取比语音识别更快也更准；需要时再展开语音识别。"
            : "展开后按顺序完成：安装模型（如需要）→ 选择音频轨 → 识别 → 使用结果。"}
        </p>
      )}
    </Card>
    </div>
  );
}

function AsrRerunEntry({ project, affectedSegmentIds }: { project: Project; affectedSegmentIds: string[] }) {
  const navigate = useNavigate();
  const activeSource = project.sourceTracks.find((track) => track.id === project.activeSourceTrackId);
  const target = activeSource?.targetTracks.find((track) => track.isActive);

  if (!affectedSegmentIds.length || activeSource?.kind !== "asr" || !target) return null;

  return (
    <Button
      className="mt-2.5"
      variant="ghost"
      onClick={() =>
        navigate(
          `/projects/${project.id}/editor/${target.languageCode}?segmentId=${encodeURIComponent(affectedSegmentIds[0])}`,
        )
      }
    >
      进入编辑器的选中段重跑入口（不会自动付费）
    </Button>
  );
}

/* -------------------------------------------------------------------------- */

function ProjectTopBar({
  project,
  summary,
  onOpenConfig,
}: {
  project: Project;
  summary: ProjectStatusSummary;
  onOpenConfig: () => void;
}) {
  const navigate = useNavigate();
  const { setProjectArchived } = useWorkspace();

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-3">
      <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => navigate("/workspace")}>
        返回项目
      </Button>
      <Badge tone={summary.tone}>{summary.label}</Badge>
      {project.archivedAt ? <Badge tone="gray">已归档</Badge> : null}
      <span className="min-w-[220px] flex-1 text-[11.5px] text-[var(--color-text-muted)]">{summary.helperText}</span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5" aria-label="项目操作">
        <Button variant="ghost" size="sm" onClick={onOpenConfig}>修改配置</Button>
        <Button variant="secondary" size="sm" onClick={() => setProjectArchived(project.id, !project.archivedAt)}>
          {project.archivedAt ? "取消归档" : "归档项目"}
        </Button>
        <RetranslateButton project={project} size="sm" />
        <DeleteProjectButton project={project} size="sm" onDeleted={() => navigate("/workspace")} />
      </div>
    </div>
  );
}

const PROJECT_WORKFLOW_STEPS = ["已导入", "生成字幕", "翻译", "检查", "导出"];

function resolveProjectWorkflowStep(project: Project, needsSourceText: boolean) {
  const targets = getActiveTargetTracks(project);
  if (needsSourceText) return 1;
  if (project.lifecycle === "draft" || project.lifecycle === "processing" || targets.length === 0) return 2;
  if (targets.some((track) => track.status === "exported")) return 5;
  if (targets.some((track) => track.status === "approved")) return 4;
  return 3;
}

function ProjectWorkflowSteps({ currentStep }: { currentStep: number }) {
  return (
    <ol aria-label="项目处理进度" className="mb-4 grid grid-cols-5 border-y border-line py-3">
      {PROJECT_WORKFLOW_STEPS.map((label, index) => {
        const complete = index < currentStep;
        const current = index === currentStep;
        return (
          <li key={label} aria-current={current ? "step" : undefined} className="relative text-center">
            <span
              className={`relative z-[1] mx-auto mb-1.5 block h-3 w-3 rounded-full border-2 ${
                complete
                  ? "border-ok bg-ok"
                  : current
                    ? "border-gold bg-gold shadow-[0_0_0_4px_var(--color-gold-wash)]"
                    : "border-line-strong bg-[var(--color-bg)]"
              }`}
            />
            <span className={`text-[11.5px] ${current ? "font-semibold text-gold-dark" : "text-[var(--color-text-muted)]"}`}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ProjectNextAction({ label, helper, running }: { label: string; helper: string; running: boolean }) {
  return (
    <section className="mb-3 flex items-center gap-3 rounded-[10px] border border-line bg-card px-4 py-3 shadow-card">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-gold-wash text-gold-dark">
        <CheckCircle2 size={20} />
      </span>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold">{running ? "任务正在处理" : `下一步：${label}`}</h2>
        <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          {running ? "可以在上方进度条暂停、继续或取消；完成后这里会自动更新。" : helper}
        </p>
      </div>
    </section>
  );
}

function SubtitleSnapshot({ source, project }: { source: SourceTrack; project: Project }) {
  const target = getActiveTargetTracks(project)[0];
  return (
    <section className="min-w-0">
      <div className="flex items-center gap-3 border-b border-line py-2.5">
        <h2 className="text-[13px] font-semibold">字幕预览</h2>
        <span className="ml-auto text-[11.5px] text-[var(--color-text-muted)]">共 {source.segments.length} 段</span>
      </div>
      <div className="divide-y divide-line">
        {source.segments.slice(0, 3).map((segment) => {
          const translated = target ? segment.targetTexts[target.languageCode] : undefined;
          return (
            <div key={segment.id} className="grid gap-2 py-3 text-[12px] sm:grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)]">
              <span className="tabular text-[11px] italic text-[var(--color-text-muted)]">{segment.start}</span>
              <span className="min-w-0 break-words">{segment.sourceText.manual || segment.sourceText.normalized || segment.sourceText.original}</span>
              <span className="min-w-0 break-words text-[var(--color-text-main)]">
                {translated?.manual || translated?.postProcessed || translated?.model || "—"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PendingConfirmationsCard({ project }: { project: Project }) {
  const { resolvePendingConfirmations } = useWorkspace();

  return (
    <Card title="待确认事项" description="歧义确认直接在项目概览里完成，不拉长向导。" actions={<Badge tone="red">需要处理</Badge>}>
      <div className="space-y-2">
        {project.pendingConfirmations.map((item) => (
          <div
            key={item}
            className="flex items-start gap-2 rounded-[6px] border border-line bg-stop-wash px-2.5 py-2 text-[12.5px] leading-5 text-[var(--color-text-main)]"
          >
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-stop" />
            <span>{item}</span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => resolvePendingConfirmations(project.id)}>
          沿用当前主源轨
        </Button>
        <span className="text-[11.5px] text-[var(--color-text-muted)]">
          确认后会把这条源轨作为当前项目的统一时间轴。
        </span>
      </div>
    </Card>
  );
}

export default function ProjectOverviewPage() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();
  const {
    projects,
    tasks,
    isDesktop,
    startProject,
    automaticWorkflows,
    runAutomaticProjectWorkflow,
    resolveAutomaticWorkflowBlock,
    cancelAutomaticProjectWorkflow,
    resolvePendingConfirmations,
    approveAndExportProjectTargets,
  } = useWorkspace();
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [showAsrWorkflow, setShowAsrWorkflow] = useState(false);
  const [matrixMessage, setMatrixMessage] = useState<string | null>(null);
  const focusAsr = searchParams.get("focus") === "asr";
  const focusMedia = focusAsr || searchParams.get("focus") === "media";
  useEffect(() => {
    if (!focusAsr) return;
    setShowAsrWorkflow(true);
  }, [focusAsr]);
  const project = projects.find((item) => item.id === projectId);
  const summary = useMemo(() => (project ? deriveProjectStatusSummary(project) : null), [project]);

  if (!project || !summary) {
    return (
      <>
        <PageHeader title="项目概览" description="项目不存在，或者已经被移出当前工作区。" />
        <Card>
          <Button variant="primary" onClick={() => navigate("/workspace")}>
            返回项目页
          </Button>
        </Card>
      </>
    );
  }

  const activeSourceTrack = getActiveSourceTrack(project);
  const automaticWorkflow = automaticWorkflows[project.id];
  const recognitionProgress = tasks
    .filter((task) => task.projectId === project.id && task.kind === "asr" && task.stage === "asr"
      && ["pending", "running", "pausing", "cancelling"].includes(task.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.progress;
  const activeTargets = getActiveTargetTracks(project);
  const firstTarget = activeTargets[0];
  const sourceQuality = analyzeSourceQuality(activeSourceTrack?.segments ?? []);
  const mediaProbe = project.sourceProbeSummary?.media as MediaProbeSummary | undefined;
  const mediaMissing =
    project.mediaSource?.availability === "missing" || project.mediaSource?.availability === "relink_required";
  const canOpenEditor = Boolean(activeSourceTrack && firstTarget);
  const needsSourceText = project.sourceTracks.every((track) => track.segments.length === 0);
  const needsAsrPreparation = !project.noSourceMedia && needsSourceText;
  /*
   * 「开始翻译」是入队语义，点完立刻就跳到这里，此时 lifecycle 还是 draft，
   * 主操作按钮会继续显示「开始翻译」——再点一次就是又排一轮付费任务。
   * 有活任务时统一让位给上面的进度横幅。
   */
  const latestTranslationTask = getLatestProjectTranslationTask(tasks, project.id);
  const runningTask = latestTranslationTask
    && ["running", "pending", "pausing", "paused", "cancelling"].includes(latestTranslationTask.status)
    ? latestTranslationTask
    : undefined;
  const runningLabel = runningTask ? "这个项目还有任务在跑，进度和暂停在上方横幅里" : null;
  const runBannerOwnsNextAction = Boolean(
    latestTranslationTask
    && ["running", "pending", "pausing", "paused", "cancelling", "recoverable", "failed", "completed"]
      .includes(latestTranslationTask.status),
  ) || Boolean(automaticWorkflow && ["running", "blocked", "failed", "cancelled"].includes(automaticWorkflow.status));
  const workflowStep = resolveProjectWorkflowStep(project, needsSourceText);
  const hasApprovedTargets = activeTargets.some(
    (track) => track.status === "approved" || track.status === "exported",
  );
  const primaryLabel = hasApprovedTargets
    ? "导出字幕"
    : project.lifecycle === "draft" && isDesktop && needsAsrPreparation
      ? "生成字幕并翻译"
      : summary.actionLabel;
  const primaryDisabled = automaticWorkflow?.status === "running" || Boolean(runningLabel) || (
    !hasApprovedTargets
    && project.lifecycle !== "draft"
    && project.pendingConfirmations.length === 0
    && !firstTarget
  );

  const handlePrimaryAction = () => {
    if (project.lifecycle === "draft") {
      if (isDesktop) {
        if (project.config.provider === "OpenAI Compatible") {
          navigate(`/?projectId=${encodeURIComponent(project.id)}`);
          return;
        }
        void runAutomaticProjectWorkflow(project.id);
        return;
      }
      void startProject(project.id);
      return;
    }

    if (project.pendingConfirmations.length > 0) {
      resolvePendingConfirmations(project.id);
      return;
    }

    if (firstTarget) {
      navigate(`/projects/${project.id}/editor/${firstTarget.languageCode}`);
    }
  };

  const handleDelivery = async () => {
    const result = await approveAndExportProjectTargets(project.id);
    const succeeded = result.summary?.succeeded.length ?? 0;
    const failed = result.summary?.failed.length ?? 0;
    setMatrixMessage(
      result.canceled || result.summary?.canceled
        ? "已取消导出"
        : result.ok || succeeded > 0
          ? `字幕已保存到你选择的文件夹：成功 ${succeeded}，失败 ${failed}（已在资源管理器中定位）`
          : result.message ?? "批准或导出没有完成",
    );
  };

  return (
    <>
      <PageHeader
        title={project.title}
        description="查看当前状态并继续下一步；只有需要你确认的内容才会出现。"
      />

      <ProjectTopBar project={project} summary={summary} onOpenConfig={() => setShowConfigEditor(true)} />
      <ProjectWorkflowSteps currentStep={workflowStep} />

      <RunProgressBanner project={project} />
      <AutomaticWorkflowBanner
        state={automaticWorkflow}
        recognitionProgress={recognitionProgress}
        onAction={() => automaticWorkflow?.actionRoute && navigate(automaticWorkflow.actionRoute)}
        onResolve={async (answer) => {
          const result = await resolveAutomaticWorkflowBlock(project.id, answer);
          if (result.ok) void runAutomaticProjectWorkflow(project.id);
          return result;
        }}
        onCancel={() => void cancelAutomaticProjectWorkflow(project.id)}
        onRetry={() => void runAutomaticProjectWorkflow(project.id)}
      />
      {!runBannerOwnsNextAction ? (
        <ProjectNextAction label={primaryLabel} helper={summary.helperText} running={Boolean(runningLabel)} />
      ) : null}

      {sourceQuality ? (
        <div role="alert" className="mb-3 flex flex-wrap items-start gap-2 rounded-[10px] border border-stop bg-stop-wash px-3 py-2.5">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-stop" />
          <div className="min-w-[260px] flex-1">
            <p className="text-[13px] font-semibold text-[var(--color-text-main)]">源字幕质量异常，不是项目重复</p>
            <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
              {describeSourceQuality(sourceQuality)}
            </p>
          </div>
          {firstTarget ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate(`/projects/${project.id}/editor/${firstTarget.languageCode}?mode=source&segmentId=${encodeURIComponent(sourceQuality.longestSegmentId)}`)}
            >
              检查源字幕
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        {needsAsrPreparation || focusMedia ? (
          <div className="space-y-3">
          <MediaSourcePanel project={project} mediaProbe={mediaProbe} mediaMissing={mediaMissing} />
          {isDesktop ? (
            <ProjectAsrWorkflow
              project={project}
              mediaProbe={mediaProbe}
              mediaMissing={mediaMissing}
              expanded={showAsrWorkflow}
              onExpandedChange={setShowAsrWorkflow}
            />
          ) : null}
          </div>
        ) : null}

        {project.pendingConfirmations.length > 0 ? <PendingConfirmationsCard project={project} /> : null}

        {showConfigEditor ? (
          <ProjectConfigPanel
            project={project}
            open
            onToggle={() => setShowConfigEditor(false)}
          />
        ) : null}

        {activeSourceTrack ? (
          <div className={`grid gap-5 ${activeTargets.length ? "xl:grid-cols-[minmax(0,1fr)_340px]" : ""}`}>
            <SubtitleSnapshot source={activeSourceTrack} project={project} />
            {activeTargets.length ? <QaSummaryCard activeTargets={activeTargets} /> : null}
          </div>
        ) : null}

        {matrixMessage ? (
          <p role="status" className="text-[11.5px] text-[var(--color-text-muted)]" data-testid="matrix-export-message">
            {matrixMessage}
          </p>
        ) : null}
      </div>

      <BottomActionBar>
        <Button variant="dark" icon={<ArrowLeft size={16} />} onClick={() => navigate("/workspace")}>
          返回项目页
        </Button>
        {!runBannerOwnsNextAction ? (
          <>
            <Button
              variant="dark"
              icon={<Languages size={16} />}
              disabled={!canOpenEditor}
              title={
                !activeSourceTrack ? "请先提取并确认字幕源轨" : !firstTarget ? "请先配置目标语言" : undefined
              }
              onClick={() => firstTarget && navigate(`/projects/${project.id}/editor/${firstTarget.languageCode}`)}
            >
              进入字幕编辑
            </Button>
            <Button
              variant="primary"
              icon={hasApprovedTargets ? <FileOutput size={16} /> : project.lifecycle === "draft" ? <Play size={16} /> : <Sparkles size={16} />}
              disabled={primaryDisabled}
              title={
                runningLabel
                  ?? (isDesktop && project.lifecycle === "draft"
                    ? needsAsrPreparation
                      ? "自动把声音转成字幕并开始翻译"
                      : "自动检查字幕并开始翻译"
                    : undefined)
              }
              onClick={() => hasApprovedTargets ? void handleDelivery() : handlePrimaryAction()}
            >
              {primaryLabel}
            </Button>
          </>
        ) : null}
      </BottomActionBar>
    </>
  );
}
