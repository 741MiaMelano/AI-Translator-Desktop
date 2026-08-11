import type { ReactNode } from "react";

interface MediaPreviewFrameProps {
  className?: string;
  children?: ReactNode;
  compact?: boolean;
}

export default function MediaPreviewFrame({ className = "", children, compact = false }: MediaPreviewFrameProps) {
  return (
    <div className={`relative overflow-hidden rounded-[10px] border border-[rgba(255,255,255,0.14)] bg-[#211f1b] text-[#f7f1e8] shadow-[0_18px_38px_rgba(29,22,16,0.24),inset_0_1px_0_rgba(255,255,255,0.12)] ${className}`}>
      <div
        aria-hidden="true"
        className={`absolute inset-0 bg-[radial-gradient(circle_at_28%_24%,rgba(216,170,103,0.3),transparent_24%),linear-gradient(135deg,#171613,#4d4031)] ${compact ? "opacity-90" : "opacity-100"}`}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(255,255,255,0.18),transparent_24%),linear-gradient(180deg,rgba(0,0,0,0.08),transparent_28%),linear-gradient(0deg,rgba(0,0,0,0.68),rgba(0,0,0,0.12))]" />
      <div className="absolute inset-[10px] rounded-[4px] border border-white/10" />
      {children}
    </div>
  );
}
