import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  AssTextStyle,
  BilingualLayout,
  SubtitlePosition,
  SubtitleStylePayload,
} from "../../../domain/resource-library";
import Input from "../../ui/Input";

export const BILINGUAL_LABELS: Record<BilingualLayout, string> = {
  target_only: "仅译文",
  source_top_target_bottom: "原文上 + 译文下",
  target_top_source_bottom: "译文上 + 原文下",
};

export const POSITION_LABELS: Record<SubtitlePosition, string> = {
  top: "贴顶",
  center: "居中",
  bottom: "贴底",
};

export const RESOURCE_SELECT =
  "control-surface h-8 w-full rounded-[6px] border border-line-strong bg-card px-2.5 text-[13px] text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold";

const FONT_OPTIONS = [
  "Microsoft YaHei",
  "DengXian",
  "SimHei",
  "SimSun",
  "Segoe UI",
  "Arial",
  "Tahoma",
  "Times New Roman",
] as const;
const FONT_SIZE_OPTIONS = [16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64] as const;
const EFFECT_SIZE_OPTIONS = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10] as const;

function boundedNumber(value: string, current: number, min: number, max: number) {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : current;
}

function choicesWithCurrent(options: readonly (string | number)[], current: string | number) {
  return options.some((option) => String(option) === String(current)) ? options : [current, ...options];
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | number;
  options: readonly (string | number)[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">{label}</span>
      <select aria-label={label} value={String(value)} className={RESOURCE_SELECT} onChange={(event) => onChange(event.target.value)}>
        {choicesWithCurrent(options, value).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">{label}</span>
      <span className="control-surface flex h-8 items-center gap-2 rounded-[6px] border border-line-strong bg-card px-2.5">
        <input
          aria-label={`${label}选择器`}
          type="color"
          value={pickerValue}
          className="h-5 w-8 cursor-pointer border-0 bg-transparent p-0"
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
        <span className="tabular text-[12px] text-[var(--color-text-muted)]">{value.toUpperCase()}</span>
      </span>
    </label>
  );
}

function AssTextStyleEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: AssTextStyle;
  onChange: (next: AssTextStyle) => void;
}) {
  const patch = (next: Partial<AssTextStyle>) => onChange({ ...value, ...next });
  return (
    <fieldset className="rounded-[6px] border border-line bg-card-soft p-2.5">
      <legend className="px-1 text-[12.5px] font-medium text-[var(--color-text-main)]">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Choice label="字体" value={value.fontFamily} options={FONT_OPTIONS} onChange={(fontFamily) => patch({ fontFamily })} />
        <Choice
          label="字号（px）"
          value={value.fontSizePx}
          options={FONT_SIZE_OPTIONS}
          onChange={(fontSize) => patch({ fontSizePx: boundedNumber(fontSize, value.fontSizePx, 1, 400) })}
        />
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">位置</span>
          <select value={value.position} className={RESOURCE_SELECT} onChange={(event) => patch({ position: event.target.value as SubtitlePosition })}>
            {(Object.entries(POSITION_LABELS) as Array<[SubtitlePosition, string]>).map(([position, text]) => (
              <option key={position} value={position}>{text}</option>
            ))}
          </select>
        </label>
        <Color label="文字颜色" value={value.textColor} onChange={(textColor) => patch({ textColor })} />
        <Color label="描边颜色" value={value.outlineColor} onChange={(outlineColor) => patch({ outlineColor })} />
        <Choice
          label="描边宽度（px）"
          value={value.outlineWidthPx}
          options={EFFECT_SIZE_OPTIONS}
          onChange={(width) => patch({ outlineWidthPx: boundedNumber(width, value.outlineWidthPx, 0, 50) })}
        />
        <Color label="阴影颜色" value={value.shadowColor} onChange={(shadowColor) => patch({ shadowColor })} />
        <Choice
          label="阴影深度（px）"
          value={value.shadowDepthPx}
          options={EFFECT_SIZE_OPTIONS}
          onChange={(depth) => patch({ shadowDepthPx: boundedNumber(depth, value.shadowDepthPx, 0, 50) })}
        />
      </div>
    </fieldset>
  );
}

export function SubtitleStyleEditor({
  payload,
  onChange,
  showPreviewFields = true,
}: {
  payload: SubtitleStylePayload;
  onChange: (next: SubtitleStylePayload) => void;
  showPreviewFields?: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">样式适用格式</span>
          <select aria-label="字幕样式适用格式" value={payload.format} disabled className={RESOURCE_SELECT} title="只有 ASS 能保存字体、颜色、描边和位置">
            <option value="ass">ASS（保留字体、颜色和描边）</option>
          </select>
          <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">SRT / VTT 是纯文本格式，不保存这些视觉样式。</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">双语排布</span>
          <select
            value={payload.bilingualLayout}
            className={RESOURCE_SELECT}
            onChange={(event) => onChange({ ...payload, bilingualLayout: event.target.value as BilingualLayout })}
          >
            {(Object.entries(BILINGUAL_LABELS) as Array<[BilingualLayout, string]>).map(([layout, text]) => (
              <option key={layout} value={layout}>{text}</option>
            ))}
          </select>
        </label>
      </div>
      <AssTextStyleEditor label="主字幕（译文）" value={payload.primary} onChange={(primary) => onChange({ ...payload, primary })} />
      <AssTextStyleEditor label="次字幕（原文）" value={payload.secondary} onChange={(secondary) => onChange({ ...payload, secondary })} />
      {showPreviewFields ? (
        <fieldset className="rounded-[6px] border border-line bg-card-soft p-2.5">
          <legend className="px-1 text-[12.5px] font-medium text-[var(--color-text-main)]">实时预览内容</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input label="原文示例" value={payload.preview.sourceText} onChange={(event) => onChange({ ...payload, preview: { ...payload.preview, sourceText: event.target.value } })} />
            <Input label="译文示例" value={payload.preview.targetText} onChange={(event) => onChange({ ...payload, preview: { ...payload.preview, targetText: event.target.value } })} />
            <Color label="预览背景色" value={payload.preview.backgroundColor} onChange={(backgroundColor) => onChange({ ...payload, preview: { ...payload.preview, backgroundColor } })} />
            <label className="block">
              <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">文字方向</span>
              <select value={payload.preview.direction} className={RESOURCE_SELECT} onChange={(event) => onChange({ ...payload, preview: { ...payload.preview, direction: event.target.value as "auto" | "ltr" | "rtl" } })}>
                <option value="auto">自动</option>
                <option value="ltr">从左到右</option>
                <option value="rtl">从右到左</option>
              </select>
            </label>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function lineStyle(style: AssTextStyle, scale: number): CSSProperties {
  return {
    color: style.textColor,
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSizePx * scale}px`,
    lineHeight: 1.15,
    paintOrder: "stroke fill",
    WebkitTextStroke: `${style.outlineWidthPx * scale}px ${style.outlineColor}`,
    textShadow: `${style.shadowDepthPx * scale}px ${style.shadowDepthPx * scale}px 0 ${style.shadowColor}`,
  };
}

export function SubtitleStyleCanvas({
  payload,
  sourceText,
  targetText,
  renderLine,
  scaleX = 1,
  scaleY = 1,
  direction = payload.preview.direction,
}: {
  payload: SubtitleStylePayload;
  sourceText: string;
  targetText: string;
  renderLine?: (content: ReactNode, role: "source" | "target", style: CSSProperties) => ReactNode;
  scaleX?: number;
  scaleY?: number;
  direction?: "auto" | "ltr" | "rtl";
}) {
  const lines = payload.bilingualLayout === "target_top_source_bottom"
    ? [["target", targetText, payload.primary], ["source", sourceText, payload.secondary]] as const
    : [["source", sourceText, payload.secondary], ["target", targetText, payload.primary]] as const;
  const visible = payload.bilingualLayout === "target_only"
    ? lines.filter(([role]) => role === "target")
    : lines;
  const positionClass: Record<SubtitlePosition, string> = {
    top: "top-0",
    center: "top-1/2 -translate-y-1/2",
    bottom: "bottom-0",
  };

  return (
    <div className="relative h-full w-full" dir={direction}>
      <div className="absolute" style={{ inset: `${29 * scaleY}px ${40 * scaleX}px` }}>
        {(Object.keys(positionClass) as SubtitlePosition[]).map((position) => {
          const positioned = visible.filter(([, , style]) => style.position === position);
          if (positioned.length === 0) return null;
          return (
            <div
              key={position}
              className={`absolute inset-x-0 flex flex-col items-center text-center ${positionClass[position]}`}
              style={{ gap: `${4 * scaleY}px` }}
            >
              {positioned.map(([role, text, style], index) => {
                const css = lineStyle(style, scaleY);
                const content = <span className="block max-w-full whitespace-pre-wrap break-words" style={css}>{text}</span>;
                return <div key={`${role}-${index}`} className="max-w-full">{renderLine ? renderLine(content, role, css) : content}</div>;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SubtitleStylePreview({ payload }: { payload: SubtitleStylePayload }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState({ x: 0.25, y: 0.25 });
  const updateScale = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    setScale({
      x: Math.max(0.1, frame.clientWidth / 1_280),
      y: Math.max(0.1, frame.clientHeight / 720),
    });
  }, []);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScale);
    observer.observe(frame);
    updateScale();
    return () => observer.disconnect();
  }, [updateScale]);
  return (
    <div
      ref={frameRef}
      data-ass-preview="track-style"
      className="aspect-video overflow-hidden rounded-[6px] border border-line"
      style={{ backgroundColor: payload.preview.backgroundColor }}
    >
      <SubtitleStyleCanvas
        payload={payload}
        scaleX={scale.x}
        scaleY={scale.y}
        sourceText={payload.preview.sourceText}
        targetText={payload.preview.targetText}
      />
    </div>
  );
}
