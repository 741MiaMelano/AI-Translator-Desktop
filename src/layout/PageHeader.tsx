import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description: string;
  /** 右侧操作位：标签页、主按钮等。放在标题同一行，不再单独占一段高度 */
  actions?: ReactNode;
}

/**
 * 页面标题栏。
 *
 * 旧版是 54px font-black 标题 + 金色下划线 + 副标题，整块约 215px 高，
 * 在 720p 窗口上吃掉近三成竖直空间。现在压成一条约 46px 的横栏。
 */
export default function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-3">
      <h1 className="text-[15px] font-semibold tracking-[-0.005em] text-[var(--color-text-main)]">{title}</h1>
      <p className="min-w-0 text-xs text-[var(--color-text-muted)]">
        <span className="mr-2 text-line-strong">／</span>
        {description}
      </p>
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
