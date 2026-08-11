import type { ReactNode } from "react";

type BadgeTone = "gold" | "green" | "red" | "blue" | "gray" | "dark";

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
}

/** whitespace-nowrap 是必需的：没有它「草稿」「查看」会被拆成两行 */
const tones: Record<BadgeTone, string> = {
  gold: "bg-gold-wash text-gold-dark",
  green: "bg-ok-wash text-ok",
  red: "bg-stop-wash text-stop",
  blue: "bg-card-soft text-[var(--color-info)]",
  gray: "bg-card-soft text-[var(--color-text-muted)]",
  dark: "bg-sidebar-soft text-[var(--color-text-light)]",
};

export default function Badge({ tone = "gray", children }: BadgeProps) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[4px] px-1.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
