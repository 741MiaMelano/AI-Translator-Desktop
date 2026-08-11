import type { ReactNode } from "react";
import { Children } from "react";

interface BottomActionBarProps {
  children: ReactNode;
  ariaLabel?: string;
}

/**
 * 底部操作条。
 *
 * 旧版是悬浮胶囊（bottom-5 / left-292 / 圆角 / 四层阴影），滚动时内容会从它底下穿过去。
 * 现在贴住主区底边、实底、上描边，配合 AppShell 的 pb-[72px] 占位，内容不会再被遮挡。
 * 类名 bottom-action-dock 是 e2e（scripts/e2e-phase13-usability.mjs）的选择器，不能改。
 */
export default function BottomActionBar({ children, ariaLabel = "页面操作" }: BottomActionBarProps) {
  const items = Children.toArray(children);

  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      className="bottom-action-dock fixed bottom-0 left-[224px] right-0 z-20 flex h-14 items-center gap-2 border-t border-line bg-card px-4"
    >
      {items.map((item, index) => (
        <div key={index} className={index === items.length - 1 ? "ml-auto" : ""}>
          {item}
        </div>
      ))}
    </div>
  );
}
