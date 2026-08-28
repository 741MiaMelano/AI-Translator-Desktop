import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from "react";

export type TimelineSegmentRange = { id: string; start: number; end: number };
export type TimelineWaveformState = "idle" | "loading" | "ready" | "error";

const BAR_COUNT = 160;
const ZOOM_STEPS = [1, 2, 4, 8];

function formatClock(milliseconds: number) {
  const safe = Math.max(0, milliseconds) / 1000;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, "0");
  const ss = seconds.toFixed(1).padStart(4, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 一体化时间轴：波形即进度条 + 段刻度带 + 播放头 + 倍率缩放。
 * 编辑器与素材页共用；媒体元素由调用方持有，本组件只通过 onSeek/onTogglePlay 操作。
 */
export function MediaTimeline(props: {
  durationMs: number;
  playheadMs: number;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (ms: number) => void;
  peaks: number[] | null;
  waveformState: TimelineWaveformState;
  waveformError?: string | null;
  onRetryWaveform?: () => void;
  segments?: TimelineSegmentRange[];
  selectedSegmentId?: string | null;
  selectedRange?: { start: number; end: number } | null;
  onScrubSound?: () => void;
  controls?: ReactNode;
}) {
  const { durationMs, playheadMs, peaks, waveformState, waveformError, onRetryWaveform, segments = [], selectedSegmentId = null, selectedRange = null, onScrubSound, controls } = props;
  const [zoom, setZoom] = useState(1);
  const [viewStartMs, setViewStartMs] = useState(0);
  const lastScrubSoundRef = useRef(0);

  const windowMs = durationMs ? durationMs / zoom : 0;
  const clampViewStart = (value: number, nextZoom = zoom) => {
    if (!durationMs || nextZoom <= 1) return 0;
    return Math.max(0, Math.min(durationMs - durationMs / nextZoom, value));
  };

  // 播放或跳转时，播放头一旦离开可视窗口就跟随平移
  useEffect(() => {
    if (!durationMs || zoom <= 1) {
      if (viewStartMs !== 0) setViewStartMs(0);
      return;
    }
    if (playheadMs < viewStartMs || playheadMs > viewStartMs + windowMs) {
      setViewStartMs(clampViewStart(playheadMs - windowMs * 0.12));
    }
  }, [playheadMs, zoom, durationMs]);

  const seek = (ms: number) => {
    if (!durationMs) return;
    props.onSeek(Math.max(0, Math.min(durationMs, ms)));
  };

  const scrubFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !windowMs) return;
    seek(viewStartMs + ((event.clientX - rect.left) / rect.width) * windowMs);
    const now = performance.now();
    if (onScrubSound && now - lastScrubSoundRef.current > 120) {
      lastScrubSoundRef.current = now;
      onScrubSound();
    }
  };

  const applyZoom = (nextZoom: number) => {
    setZoom(nextZoom);
    setViewStartMs(nextZoom <= 1 || !durationMs ? 0 : clampViewStart(playheadMs - durationMs / nextZoom / 2, nextZoom));
  };

  const fitSelectedSegment = () => {
    if (!selectedRange || !durationMs) return;
    const segmentLength = Math.max(200, selectedRange.end - selectedRange.start);
    const targetWindow = segmentLength * 1.5;
    const nextZoom = [...ZOOM_STEPS].reverse().find((step) => durationMs / step >= targetWindow) ?? 1;
    const nextWindowMs = durationMs / nextZoom;
    setZoom(nextZoom);
    setViewStartMs(clampViewStart(selectedRange.start - (nextWindowMs - segmentLength) / 2, nextZoom));
  };

  const toWindowPct = (ms: number) => (windowMs ? Math.max(0, Math.min(100, ((ms - viewStartMs) / windowMs) * 100)) : 0);
  const viewEndMs = viewStartMs + windowMs;
  const windowedPeaks = peaks?.length && windowMs
    ? Array.from({ length: BAR_COUNT }, (_, index) => {
        const atMs = viewStartMs + ((index + 0.5) / BAR_COUNT) * windowMs;
        return peaks[Math.min(peaks.length - 1, Math.floor((atMs / durationMs) * peaks.length))];
      })
    : [];
  const visibleTicks = windowMs
    ? segments.flatMap((segment) => {
        if (segment.end <= viewStartMs || segment.start >= viewEndMs) return [];
        const left = toWindowPct(Math.max(segment.start, viewStartMs));
        const right = toWindowPct(Math.min(segment.end, viewEndMs));
        return [{ id: segment.id, left, width: Math.max(0.3, right - left) }];
      })
    : [];
  const regionInView = selectedRange && windowMs && selectedRange.end > viewStartMs && selectedRange.start < viewEndMs
    ? { left: toWindowPct(Math.max(selectedRange.start, viewStartMs)), right: toWindowPct(Math.min(selectedRange.end, viewEndMs)) }
    : null;

  return (
    <div className="media-timeline">
      <div className="editor-timeline">
        <button type="button" className="timeline-play-btn" onClick={props.onTogglePlay} aria-label={props.playing ? "暂停" : "播放"}>{props.playing ? "‖" : "▶"}</button>
        <div
          className={`timeline-track ${windowedPeaks.length ? "" : "is-plain"}`}
          role="slider"
          aria-label="媒体进度；点击或拖动定位播放位置，Shift+方向键微调 100ms"
          aria-valuemin={Math.round(viewStartMs)}
          aria-valuemax={Math.round(viewEndMs)}
          aria-valuenow={Math.round(playheadMs)}
          aria-valuetext={formatClock(playheadMs)}
          tabIndex={0}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); scrubFromPointer(event); }}
          onPointerMove={(event) => { if (event.buttons === 1) scrubFromPointer(event); }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 100 : 2000;
            if (event.key === "ArrowLeft") { event.preventDefault(); seek(playheadMs - step); }
            if (event.key === "ArrowRight") { event.preventDefault(); seek(playheadMs + step); }
            if (event.key === "Home" && selectedRange) { event.preventDefault(); seek(selectedRange.start); }
          }}
        >
          {windowedPeaks.length ? <div className="timeline-bars">{windowedPeaks.map((peak, index) => <i key={index} style={{ height: `${Math.max(4, Math.min(100, Math.abs(peak) * 100))}%` }}/>)}</div> : null}
          {visibleTicks.length ? <div className="timeline-ticks" aria-hidden="true">{visibleTicks.map((tick) => <i key={tick.id} className={`timeline-tick ${selectedSegmentId === tick.id ? "is-current" : ""}`} style={{ left: `${tick.left}%`, width: `${tick.width}%` }}/>)}</div> : null}
          {regionInView ? <div className="timeline-region" style={{ left: `${regionInView.left}%`, width: `${Math.max(0.5, regionInView.right - regionInView.left)}%` }}/> : null}
          <div className="timeline-playhead" style={{ left: `${toWindowPct(playheadMs)}%` }}/>
          {waveformState === "loading" ? <div className="timeline-note"><span>正在生成波形…</span></div> : null}
          {waveformState === "error" ? (
            <div className="timeline-note">
              <span>波形不可用{waveformError ? `：${waveformError}` : ""}（进度与跳转不受影响）</span>
              {onRetryWaveform ? <button type="button" className="timeline-retry" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRetryWaveform(); }}>重试</button> : null}
            </div>
          ) : null}
        </div>
        <time className="timeline-time">{formatClock(playheadMs)} / {formatClock(durationMs)}</time>
      </div>
      <div className="editor-transport media-timeline-controls">
        <div className="timeline-zoom" role="group" aria-label="时间轴缩放">
          {ZOOM_STEPS.map((step) => <button key={step} type="button" className={zoom === step ? "is-active" : ""} aria-pressed={zoom === step} onClick={() => applyZoom(step)}>{step}×</button>)}
          {selectedRange ? <button type="button" onClick={fitSelectedSegment}>适配当前段</button> : null}
        </div>
        {controls}
      </div>
    </div>
  );
}
