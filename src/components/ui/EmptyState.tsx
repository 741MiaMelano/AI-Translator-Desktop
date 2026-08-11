import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

/**
 * 空状态。旧版 min-h-52 会把空卡片撑到半屏高；
 * 现在只占内容需要的高度，由外层容器决定是否居中。
 */
export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 rounded-[6px] border border-dashed border-line px-4 py-7 text-center">
      <div className="text-[var(--color-text-muted)]">{icon}</div>
      <h3 className="text-[13px] font-medium text-[var(--color-text-main)]">{title}</h3>
      <p className="max-w-[46ch] text-[11.5px] leading-5 text-[var(--color-text-muted)]">{description}</p>
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
