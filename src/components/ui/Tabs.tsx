import type { KeyboardEvent } from "react";

interface TabsProps {
  items: string[];
  value: string;
  onChange: (value: string) => void;
}

/**
 * 分段控件式标签页。
 *
 * 上一版是「12.5px 文字 + 2px 下划线」，放在页头右侧几乎看不见——
 * 用户反馈"很多时候都看不到"。现在改成带边框容器 + 选中项实心填充，
 * 无论放在页头还是内容区都能一眼认出这是可切换的。
 */
export default function Tabs({ items, value, onChange }: TabsProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : direction
          ? (index + direction + items.length) % items.length
          : index;
    if (nextIndex === index && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    onChange(items[nextIndex]);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
      ?.focus();
  };

  return (
    <div
      role="tablist"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-[6px] border border-line-strong bg-card-soft p-0.5"
    >
      {items.map((item, index) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={value === item}
          tabIndex={value === item ? 0 : -1}
          onClick={() => onChange(item)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          className={`whitespace-nowrap rounded-[4px] px-3 py-1 text-[12.5px] transition ${
            value === item
              ? "metal-gold font-medium shadow-soft"
              : "text-[var(--color-text-muted)] hover:bg-card hover:text-[var(--color-text-main)]"
          }`}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
