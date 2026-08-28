import { type RefObject, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaProbe, MediaProbeStream } from "../../shared/media-probe.mjs";
import type { AsrProjectStatusResponse } from "../contracts/desktop-api";
import { useWorkspace } from "../state/WorkspaceContext";
import { MediaTimeline, type TimelineWaveformState } from "./MediaTimeline";
import { useFrontend } from "./state";
import { formatUiDateTime } from "./format";
import { useProjectStage } from "./ProjectWorkspace";
import { Icon, ThemeVisualizer } from "./visuals";

type ConfirmAction = "run-asr" | null;
type Message = { text: string; error: boolean } | null;

function mediaProbe(project: ReturnType<typeof useWorkspace>["projects"][number]): MediaProbe | null {
  const value = project.sourceProbeSummary?.media;
  return value && typeof value === "object" ? value as unknown as MediaProbe : null;
}

function streamLabel(stream: MediaProbeStream) {
  const kind = ({ video: "视频", audio: "音频", subtitle: "字幕", data: "数据" } as Record<string, string>)[stream.kind] ?? "未知";
  return `${kind} #${stream.index}${stream.language ? ` · ${stream.language}` : ""}${stream.title ? ` · ${stream.title}` : ""}`;
}

function formatDuration(value: number | null | undefined) {
  if (!value && value !== 0) return "—";
  const seconds = Math.max(0, Math.round(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(rest).padStart(2, "0")}`;
}

function mediaAvailability(value: string | null | undefined) {
  return ({ available: "可用", missing: "缺失", relink_required: "需要重新关联", invalid: "无效" } as Record<string, string>)[value ?? ""] ?? "无引用";
}

function formatBytes(value: number | null | undefined) {
  if (!value) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

export function MediaPage() {
  const { project } = useProjectStage();
  const workspace = useWorkspace();
  const app = useFrontend();
  const [preview, setPreview] = useState<{ url: string; mediaKind: string } | null>(null);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [mediaDurationMs, setMediaDurationMs] = useState(0);
  const [videoRatio, setVideoRatio] = useState<number | null>(null);
  const [waveform, setWaveform] = useState<{ durationMs: number; peaks: number[] } | null>(null);
  const [waveformState, setWaveformState] = useState<TimelineWaveformState>("idle");
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [asrStatus, setAsrStatus] = useState<AsrProjectStatusResponse | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [selectedAudio, setSelectedAudio] = useState("");
  const [languageMode, setLanguageMode] = useState<"auto" | "fixed">("auto");
  const [languageHint, setLanguageHint] = useState("en");
  const [asrOperationId, setAsrOperationId] = useState<string | null>(null);
  const [transcribeStep, setTranscribeStep] = useState<"recognizing" | "segmenting" | "activating" | null>(null);
  // 专业模式下分步执行默认展开——进阶用户来这儿就是要单步跑。
  const [stepsOpen, setStepsOpen] = useState(app.density === "pro");
  const [pendingLanguageIds, setPendingLanguageIds] = useState<string[]>([]);
  const [languageDraft, setLanguageDraft] = useState<Record<string, string>>({});
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const streamLedgerRef = useRef<HTMLElement>(null);
  const asrPanelRef = useRef<HTMLElement>(null);

  const probe = project ? mediaProbe(project) : null;
  const streams = probe?.streams ?? [];
  const audioStreams = streams.filter((stream) => stream.kind === "audio");
  const subtitleStreams = streams.filter((stream) => stream.kind === "subtitle");
  const extractableSubtitleStreams = subtitleStreams.filter((stream) => stream.extractable);
  const runs = useMemo(() => [...(asrStatus?.runs ?? [])].sort((left, right) => right.completedAt.localeCompare(left.completedAt)), [asrStatus?.runs]);
  const latestRun = runs[0] ?? null;
  const latestTrack = project.sourceTracks.find((track) => track.asrRunId === latestRun?.id) ?? null;

  useEffect(() => {
    setSelectedAudio(project.mediaSource?.confirmedAudioStreamId ?? project.mediaSource?.selectedAudioStreamId ?? "");
  }, [project.id, project.mediaSource?.confirmedAudioStreamId, project.mediaSource?.selectedAudioStreamId]);

  const applyWaveformResult = (result: Awaited<ReturnType<typeof workspace.getProjectMediaWaveform>>) => {
    if (result.ok) {
      setWaveform({ durationMs: result.durationMs, peaks: result.peaks });
      setWaveformState("ready");
      setWaveformError(null);
    } else {
      setWaveform(null);
      setWaveformState("error");
      setWaveformError(result.message ?? "波形生成失败");
    }
  };

  const loadProjectTools = useCallback(async () => {
    setWaveformState("loading");
    const [previewResult, waveformResult, asrResult] = await Promise.all([
      workspace.getProjectMediaPreviewUrl(project.id),
      workspace.getProjectMediaWaveform(project.id),
      workspace.getProjectAsrStatus(project.id),
    ]);
    setPreview(previewResult.ok ? { url: previewResult.url, mediaKind: previewResult.mediaKind } : null);
    applyWaveformResult(waveformResult);
    setAsrStatus(asrResult.ok ? asrResult.data : null);
    const errors = [
      !previewResult.ok ? previewResult.message : "",
      !waveformResult.ok ? waveformResult.message : "",
      !asrResult.ok ? asrResult.message : "",
    ].filter(Boolean);
    if (errors.length === 3) setMessage({ text: errors.join("；"), error: true });
    return previewResult.ok;
  }, [project.id, app.readiness.loading]);

  useEffect(() => {
    let active = true;
    let attempts = 0;
    let timer: number | null = null;
    const tryLoad = async () => {
      const previewOk = await loadProjectTools();
      // 后端服务启动较慢时首次调用可能失败，做有限次自动重试
      if (!active || previewOk || ++attempts >= 6) return;
      timer = window.setTimeout(() => void tryLoad(), 3000);
    };
    void tryLoad();
    return () => { active = false; if (timer !== null) window.clearTimeout(timer); };
  }, [loadProjectTools]);

  const retryWaveform = async () => {
    setWaveformState("loading");
    applyWaveformResult(await workspace.getProjectMediaWaveform(project.id));
  };

  const run = async (key: string, action: () => Promise<{ ok: boolean; message?: string }>, success: string, refresh = false) => {
    setBusy(key);
    setMessage(null);
    const result = await action();
    setBusy("");
    setMessage({ text: result.ok ? success : result.message ?? "操作没有完成", error: !result.ok });
    if (result.ok && refresh) await loadProjectTools();
    if (result.ok) app.play("success");
  };

  const selectStream = async (stream: MediaProbeStream) => {
    const selection = stream.kind === "audio" ? { audioStreamId: stream.streamId } : { subtitleStreamId: stream.streamId };
    if (stream.kind === "audio") setSelectedAudio(stream.streamId);
    await run(`stream-${stream.streamId}`, () => workspace.selectProjectMediaStreams(project.id, selection), `已选择${streamLabel(stream)}。`);
  };

  const exportAudio = async () => {
    setBusy("audio-export");
    const result = await workspace.exportProjectAudio(project.id);
    setBusy("");
    if (!result.ok) return setMessage({ text: result.message ?? "音频提取没有完成", error: true });
    setMessage({ text: result.canceled ? "操作已结束，未产生新结果。" : `音频已提取：${result.fileName ?? "已保存"}`, error: false });
  };

  const runAsr = async () => {
    setConfirmAction(null);
    if (!selectedAudio) return;
    setBusy("asr");
    setMessage(null);
    const selected = await workspace.selectProjectMediaStreams(project.id, { audioStreamId: selectedAudio });
    if (!selected.ok) {
      setBusy("");
      return setMessage({ text: selected.message ?? "音轨没有保存", error: true });
    }
    const operationId = `asr-ui-${Date.now().toString(36)}`;
    setAsrOperationId(operationId);
    const result = await workspace.runProjectAsr({
      projectId: project.id,
      audioStreamId: selectedAudio,
      languageMode,
      languageHint: languageMode === "fixed" ? languageHint : null,
      requestedDevice: asrStatus?.device.requestedDevice ?? "auto",
      allowCudaFallback: asrStatus?.device.allowCudaFallback ?? true,
      operationId,
    });
    setBusy("");
    setAsrOperationId(null);
    setMessage({ text: result.ok ? "本机识别完成，原始识别运行已保存；下一步可生成候选源轨。" : result.message ?? "本机识别没有完成", error: !result.ok });
    if (result.ok) await loadProjectTools();
  };

  const segmentLatestRun = async () => {
    if (!latestRun) return;
    const operationId = `asr-segment-ui-${Date.now().toString(36)}`;
    setAsrOperationId(operationId);
    await run("segment", () => workspace.segmentProjectAsrRun({ projectId: project.id, asrRunId: latestRun.id, configVersion: "asr-segmentation-v3", operationId }), "候选 ASR 源轨已生成；已有人工内容不会被覆盖。", true);
    setAsrOperationId(null);
  };

  const detectLanguages = async () => {
    if (!latestTrack) return;
    const operationId = `asr-language-ui-${Date.now().toString(36)}`;
    setAsrOperationId(operationId);
    setBusy("languages");
    const result = await workspace.detectProjectAsrLanguages({ projectId: project.id, sourceTrackId: latestTrack.id, requestedDevice: asrStatus?.device.requestedDevice ?? "auto", allowCudaFallback: asrStatus?.device.allowCudaFallback ?? true, operationId });
    setBusy("");
    setAsrOperationId(null);
    if (!result.ok) return setMessage({ text: result.message ?? "语言区域检测失败", error: true });
    const ids = result.pendingSegmentIds ?? [];
    setPendingLanguageIds(ids);
    setLanguageDraft(Object.fromEntries(ids.map((id) => [id, latestTrack.segments.find((segment) => segment.id === id)?.detectedLanguage ?? ""] )));
    setMessage({ text: ids.length ? `有 ${ids.length} 个语言区域需要确认。` : "语言区域检测完成，没有待确认段。", error: false });
    await loadProjectTools();
  };

  const saveLanguages = async () => {
    if (!latestTrack) return;
    const changes = pendingLanguageIds.map((segmentId) => ({ segmentId, manualLanguage: languageDraft[segmentId] || null }));
    await run("language-save", () => workspace.updateProjectAsrLanguages({ projectId: project.id, sourceTrackId: latestTrack.id, changes, confirmTrackConvergence: true }), "语言区域已确认并写入候选源轨。", true);
    setPendingLanguageIds([]);
  };

  // 一个主操作串起 识别 → 生成字幕轨 → 启用为源轨。三个调用与参数和分步执行完全一致，
  // 只是按返回值顺序衔接（runId / sourceTrackId 都在返回值里，不必等 React 状态回流）。
  // 语言区域检测不放进来：它只在真的检出混合语言时才有意义，作为后续步骤单独出现。
  const transcribe = async () => {
    setConfirmAction(null);
    if (!selectedAudio) return;
    setMessage(null);
    setTranscribeStep("recognizing");
    const operationId = `asr-chain-${Date.now().toString(36)}`;
    setAsrOperationId(operationId);
    const finish = (text: string, error: boolean) => {
      setAsrOperationId(null);
      setTranscribeStep(null);
      setMessage({ text, error });
    };

    const selected = await workspace.selectProjectMediaStreams(project.id, { audioStreamId: selectedAudio });
    if (!selected.ok) return finish(selected.message ?? "音轨没有保存", true);

    const recognized = await workspace.runProjectAsr({
      projectId: project.id,
      audioStreamId: selectedAudio,
      languageMode,
      languageHint: languageMode === "fixed" ? languageHint : null,
      requestedDevice: asrStatus?.device.requestedDevice ?? "auto",
      allowCudaFallback: asrStatus?.device.allowCudaFallback ?? true,
      operationId,
    });
    if (!recognized.ok || !recognized.runId) return finish(recognized.message ?? "本机识别没有完成", true);

    setTranscribeStep("segmenting");
    const segmented = await workspace.segmentProjectAsrRun({ projectId: project.id, asrRunId: recognized.runId, configVersion: "asr-segmentation-v3", operationId });
    if (!segmented.ok || !segmented.sourceTrackId) {
      await loadProjectTools();
      return finish(segmented.message ?? "字幕轨生成没有完成；识别结果已保存，可在分步执行里重试这一步。", true);
    }

    setTranscribeStep("activating");
    const activated = await workspace.activateProjectSourceTrack(project.id, segmented.sourceTrackId);
    await loadProjectTools();
    if (!activated.ok) return finish(activated.message ?? "字幕轨已生成但没有启用；可在分步执行里手动启用。", true);
    app.play("success");
    finish("转写完成：已生成字幕并设为当前源轨，可以进入翻译。", false);
  };

  const mediaMissing = project.mediaSource?.availability !== "available";
  const durationMs = waveform?.durationMs ?? mediaDurationMs;

  const mediaEvents = {
    onPlay: () => setMediaPlaying(true),
    onPause: () => setMediaPlaying(false),
    onEnded: () => setMediaPlaying(false),
    onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => setPlayheadMs(event.currentTarget.currentTime * 1000),
    onSeeked: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => setPlayheadMs(event.currentTarget.currentTime * 1000),
    onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>) => {
      const element = event.currentTarget;
      setMediaDurationMs(element.duration * 1000);
      if (element instanceof HTMLVideoElement && element.videoWidth && element.videoHeight) {
        setVideoRatio(element.videoWidth / element.videoHeight);
      }
    },
  };

  const togglePlay = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play();
    else media.pause();
  };

  const seekToMs = (ms: number) => {
    if (!mediaRef.current || !durationMs) return;
    const clamped = Math.max(0, Math.min(durationMs, ms));
    mediaRef.current.currentTime = clamped / 1000;
    setPlayheadMs(clamped);
  };

  return (
    <div className="project-stage-body media-tools-page" data-fr03-view="media-tools">
      <header className="stage-header"><div><h2>转写</h2><p>把音频变成字幕。提取音频与提取内嵌字幕在下方"媒体流"里按轨道进行。</p></div><div className="page-actions"><button type="button" className="btn btn-secondary" onClick={() => void run("probe", () => workspace.probeProjectMedia(project.id), "媒体探测已刷新。", true)} disabled={Boolean(busy)}><Icon name="refresh"/>{busy === "probe" ? "探测中" : "重新探测"}</button><button type="button" className="btn btn-secondary" onClick={() => void run("relink", () => workspace.relinkProjectMedia(project.id), "媒体已重新关联。", true)} disabled={Boolean(busy)}>重新关联媒体</button></div></header>

      {message ? <div className={`runtime-alert ${message.error ? "" : "is-success"}`} role={message.error ? "alert" : "status"}><Icon name={message.error ? "warning" : "check"}/><div><strong>{message.error ? "操作没有完成" : "本机操作已完成"}</strong><p>{message.text}</p></div></div> : null}
      {mediaMissing ? <div className="runtime-alert" role="alert"><Icon name="warning"/><div><strong>源媒体当前不可用</strong><p>状态：{project.mediaSource?.availability ?? "没有媒体引用"}。请重新关联后再转写。</p></div></div> : null}

      <div className="media-processing-grid">
        <section ref={asrPanelRef} className="production-panel project-asr-panel" data-testid="asr-project-workflow"><header><div><span>下一步</span><h2>识别所选音轨</h2></div><span className={`state-tag ${asrStatus?.capability.ready ? "done" : "waiting"}`}>{asrStatus?.capability.ready ? "本机识别可用" : "本机识别未就绪"}</span></header><div className="asr-run-config"><label><span>音轨</span><select value={selectedAudio} onChange={(event) => { setSelectedAudio(event.target.value); const stream = audioStreams.find((item) => item.streamId === event.target.value); if (stream) void selectStream(stream); }}>{audioStreams.map((stream) => <option key={stream.streamId} value={stream.streamId}>{streamLabel(stream)}</option>)}</select></label><label><span>语言</span><select value={languageMode} onChange={(event) => setLanguageMode(event.target.value as "auto" | "fixed")}><option value="auto">自动检测</option><option value="fixed">指定语言</option></select></label>{languageMode === "fixed" ? <label><span>指定为</span><select value={languageHint} onChange={(event) => setLanguageHint(event.target.value)}><option value="zh">中文</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option></select></label> : null}<div className="asr-device-summary pro-only"><span>设备</span><strong>{asrStatus?.device.requestedDevice.toUpperCase() ?? "AUTO"}</strong><small>{asrStatus?.device.allowCudaFallback ? "允许回退 CPU" : "不允许设备回退"}</small></div></div>

          {/* 唯一主操作。三步内部按序执行，进度可见；分步执行留给排障和进阶用户。 */}
          <div className="asr-primary-action">
            <button type="button" className="btn btn-primary" onClick={() => setConfirmAction("run-asr")} disabled={!workspace.isDesktop || !selectedAudio || !asrStatus?.capability.ready || Boolean(busy) || Boolean(transcribeStep)}>
              {transcribeStep ? "正在转写…" : "开始转写"} <Icon name="arrow"/>
            </button>
            {asrOperationId ? <button type="button" className="btn btn-secondary" onClick={() => void workspace.cancelProjectAsrOperation({ projectId: project.id, operationId: asrOperationId })}>取消</button> : null}
            {!asrStatus?.capability.ready ? <span className="asr-blocked-hint">本机识别尚未就绪，先在系统页安装识别模型</span> : null}
          </div>

          {transcribeStep ? (
            <ol className="transcribe-steps" aria-label="转写进度">
              {([["recognizing", "识别语音"], ["segmenting", "生成字幕轨"], ["activating", "启用为源轨"]] as const).map(([id, label], index) => {
                const order = ["recognizing", "segmenting", "activating"].indexOf(transcribeStep);
                const state = index < order ? "done" : index === order ? "current" : "waiting";
                return <li key={id} className={state}><span>{state === "done" ? <Icon name="check"/> : index + 1}</span><strong>{label}</strong></li>;
              })}
            </ol>
          ) : null}

          <details className="asr-manual-steps" open={stepsOpen} onToggle={(event) => setStepsOpen(event.currentTarget.open)}>
            <summary>分步执行<small>排障或只想跑其中一步时使用</small></summary>
            <div className="asr-run-actions">
              <button type="button" className="btn btn-secondary" onClick={() => void runAsr()} disabled={!workspace.isDesktop || !selectedAudio || !asrStatus?.capability.ready || Boolean(busy) || Boolean(transcribeStep)}>只识别</button>
              <button type="button" className="btn btn-secondary" onClick={() => void segmentLatestRun()} disabled={!latestRun || Boolean(busy) || Boolean(transcribeStep)}>生成候选源轨</button>
              <button type="button" className="btn btn-secondary" onClick={() => void detectLanguages()} disabled={!latestTrack || Boolean(busy) || Boolean(transcribeStep)}>检测语言区域</button>
            </div>
          </details>
          <div className="asr-run-ledger">{runs.slice(0, 4).map((run) => <article key={run.id}><span>{run.actualDevice.toUpperCase()}</span><div><strong>{run.modelId} · {run.detectedLanguage || "未知语言"}</strong><p>{run.rawSegmentCount} 个原始段 · {run.wordCount} 词 · 媒体 {formatDuration(run.mediaDurationMs)} · 处理 {formatDuration(run.processingDurationMs)}</p></div><time>{formatUiDateTime(run.completedAt)}</time></article>)}{!runs.length ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>还没有识别运行</strong><p>转写完成后，这里会留下每次运行的模型、设备和耗时。</p></div></div> : null}</div>
          {pendingLanguageIds.length && latestTrack ? <div className="language-confirmation"><header><strong>确认语言区域</strong><span>{pendingLanguageIds.length} 段</span></header>{pendingLanguageIds.map((id) => { const segment = latestTrack.segments.find((item) => item.id === id); return <label key={id}><span><strong>{segment?.start} → {segment?.end}</strong><em>{segment?.sourceText.original || "空识别文本"}</em></span><select value={languageDraft[id] ?? ""} onChange={(event) => setLanguageDraft((current) => ({ ...current, [id]: event.target.value }))}><option value="">保持自动结果</option><option value="zh">中文</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option></select></label>; })}<button type="button" className="btn btn-primary" onClick={() => void saveLanguages()} disabled={Boolean(busy)}>确认并写入候选轨</button></div> : null}
          {latestTrack ? <footer><span>候选轨：{latestTrack.label} · {latestTrack.segments.length} 段 · {latestTrack.isActive ? "当前活动源轨" : "尚未启用"}</span>{!latestTrack.isActive ? <button type="button" className="btn btn-secondary" onClick={() => void run("activate-track", () => workspace.activateProjectSourceTrack(project.id, latestTrack.id), "ASR 候选轨已设为活动源轨。", true)}>使用这份识别字幕</button> : null}</footer> : null}</section>
      </div>

      <div className="media-tool-grid">
        <section ref={streamLedgerRef} className="production-panel stream-ledger"><header><div><span>媒体流</span><h2>选择轨道与提取</h2></div><span>{streams.length} 条流</span></header>{streams.map((stream) => { const selected = stream.kind === "audio" ? project.mediaSource?.selectedAudioStreamId === stream.streamId : project.mediaSource?.selectedSubtitleStreamId === stream.streamId; const params = stream.kind === "video" ? `${stream.width ?? "?"}×${stream.height ?? "?"}` : stream.kind === "audio" ? `${stream.channels ?? "?"} ch · ${stream.sampleRate ?? "?"} Hz` : stream.extractable ? "可提取文本" : "不可提取"; return <article key={stream.streamId}><div className="stream-info"><strong>{streamLabel(stream)}</strong><p>{stream.default ? "默认" : "非默认"}{stream.forced ? " · 强制字幕" : ""}<span className="pro-only"> · {stream.codec ?? "未知"} · {params}</span></p></div><div className="stream-ops">{stream.kind === "audio" || stream.kind === "subtitle" ? <label className="stream-radio"><input type="radio" name={`stream-${stream.kind}`} checked={selected} onChange={() => void selectStream(stream)}/>{selected ? "已选择" : "选择"}</label> : <span className="state-tag waiting">只读</span>}{stream.kind === "subtitle" && stream.extractable ? <button type="button" className="btn btn-secondary" onClick={() => void run(`extract-${stream.streamId}`, () => workspace.extractProjectSubtitle(project.id, stream.streamId), "内嵌字幕已提取为候选源轨。", true)} disabled={Boolean(busy)}>{busy === `extract-${stream.streamId}` ? "提取中" : "提取内嵌字幕"}</button> : stream.kind === "audio" && selected ? <button type="button" className="btn btn-secondary" onClick={() => void exportAudio()} disabled={Boolean(busy)}>{busy === "audio-export" ? "提取中" : "提取音频"}</button> : null}</div></article>; })}{streams.length && !extractableSubtitleStreams.length ? <div className="stream-subtitle-empty"><Icon name="file"/><span><strong>未检测到内嵌字幕</strong><small>这不是故障；可用上方的“开始转写”创建字幕轨。</small></span></div> : null}{!streams.length ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>没有媒体流</strong><p>重新探测或关联有效媒体后再选择。</p></div></div> : null}</section>

        <section className="production-panel media-preview-panel">
          <header><div><span>素材</span><h2>{project.mediaSource?.displayName ?? project.sourceFileName}</h2></div><span className={`state-tag ${mediaMissing ? "danger" : "done"}`}>{mediaAvailability(project.mediaSource?.availability)}</span></header>
          {preview ? (
            <>
              {/* 转写只依赖音轨，所以画面默认收起；要核对是不是这条素材时再展开。 */}
              <details className="media-preview-fold">
                <summary>{preview.mediaKind === "audio" ? "查看音频封面" : "查看画面"}<small>转写不需要看画面</small></summary>
                <div className={`media-stage media-page-stage ${preview.mediaKind === "audio" ? "is-audio" : ""}`} style={videoRatio && preview.mediaKind !== "audio" ? { aspectRatio: String(videoRatio) } : undefined}>
                  {preview.mediaKind === "audio"
                    ? <div className="media-stage-glyph" aria-hidden="true"><Icon name="file"/><span>{project.sourceFileName}</span></div>
                    : <video ref={mediaRef as RefObject<HTMLVideoElement>} className="production-media" src={preview.url} preload="metadata" onClick={togglePlay} {...mediaEvents}/>}
                </div>
              </details>
              {preview.mediaKind === "audio" ? <audio ref={mediaRef as RefObject<HTMLAudioElement>} src={preview.url} preload="metadata" {...mediaEvents}/> : null}
              {durationMs > 0 ? (
                <MediaTimeline
                  durationMs={durationMs}
                  playheadMs={playheadMs}
                  playing={mediaPlaying}
                  onTogglePlay={togglePlay}
                  onSeek={seekToMs}
                  peaks={waveform?.peaks ?? null}
                  waveformState={waveformState}
                  waveformError={waveformError}
                  onRetryWaveform={() => void retryWaveform()}
                  onScrubSound={() => app.play("trim")}
                />
              ) : null}
              <div className="media-meta-strip">
                <div><span>容器</span><strong>{probe?.format.formatName ?? "—"}</strong></div>
                <div><span>时长</span><strong>{formatDuration(probe?.format.durationMs)}</strong></div>
                <div><span>大小</span><strong>{formatBytes(probe?.format.sizeBytes)}</strong></div>
                <div className="pro-only"><span>探测器</span><strong>{probe?.artifact.upstreamVersion ?? "—"}</strong></div>
              </div>
              <ThemeVisualizer theme={app.theme} playing={mediaPlaying}/>
            </>
          ) : (
            <div className="media-preview-empty"><ThemeVisualizer theme={app.theme}/><strong>没有可用预览</strong><p>转写只依赖音轨，缺少预览画面不影响识别。</p></div>
          )}
        </section>
      </div>

      {confirmAction ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmAction(null); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="media-confirm-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="media-confirm-title">开始转写？</h2><p>{`将用 ${asrStatus?.capability.models.find((model) => model.id === project.config.asrModelId)?.displayName ?? project.config.asrModelId ?? "默认模型"} 在本机识别所选音轨，然后生成字幕轨并设为当前源轨。全程在本机完成，不调用翻译服务、不产生费用，但会占用本机算力。`}</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmAction(null)}>取消</button><button type="button" className="btn btn-primary" onClick={() => void transcribe()}>确认并开始</button></div></section></div> : null}
    </div>
  );
}
