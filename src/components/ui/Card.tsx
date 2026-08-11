import type { HTMLAttributes, ReactNode } from "react";

type CardVariant = "default" | "elevated" | "inset" | "toolbar" | "dark";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  actions?: ReactNode;
  soft?: boolean;
  variant?: CardVariant;
  /** 紧凑内边距，用于嵌套卡片或密集列表 */
  dense?: boolean;
}

const variants: Record<CardVariant, string> = {
  default: "bg-card shadow-card",
  elevated: "bg-card shadow-pop",
  inset: "bg-card-soft",
  toolbar: "bg-card-soft",
  dark: "border-transparent bg-sidebar-soft text-[var(--color-text-light)]",
};

export default function Card({
  title,
  description,
  actions,
  soft = false,
  variant = "default",
  dense = false,
  className = "",
  children,
  ...props
}: CardProps) {
  const hasHead = Boolean(title || description || actions);

  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-line ${soft ? "bg-card-soft" : ""} ${variants[variant]} ${className}`}
      {...props}
    >
      {hasHead && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3.5 py-2.5">
          {title && (
            <h2 className="text-[12.5px] font-semibold text-[var(--color-text-main)]">{title}</h2>
          )}
          {description && (
            <p className="min-w-0 max-w-[70ch] text-[11.5px] leading-5 text-[var(--color-text-muted)]">
              {description}
            </p>
          )}
          {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={`min-h-0 ${dense ? "p-2.5" : "p-3.5"}`}>{children}</div>
    </section>
  );
}
