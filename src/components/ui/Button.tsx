import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "dark" | "secondary" | "outline" | "danger" | "success" | "ghost";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

/**
 * 旧版每个按钮都有一层 before: 高光渐变、hover 位移和两到三层阴影。
 * 现在一律平涂：主操作实心黄铜，其余靠 1px 描边和底色区分。
 */
const variants: Record<ButtonVariant, string> = {
  primary:
    "metal-gold border-transparent font-medium hover:brightness-[1.07] disabled:opacity-45",
  dark: "border-transparent bg-sidebar-soft text-[var(--color-text-light)] hover:brightness-125 disabled:opacity-45",
  secondary:
    "border-line-strong bg-card text-[var(--color-text-main)] hover:border-gold hover:text-gold-dark disabled:opacity-45",
  outline:
    "border-line-strong bg-card text-[var(--color-text-main)] hover:border-gold hover:text-gold-dark disabled:opacity-45",
  danger: "border-transparent bg-stop text-white hover:brightness-110 disabled:opacity-45",
  success: "border-transparent bg-ok text-white hover:brightness-110 disabled:opacity-45",
  ghost:
    "border-line bg-card-soft text-[var(--color-text-main)] hover:border-gold hover:bg-card hover:text-gold-dark disabled:opacity-45",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-xs",
  md: "h-8 gap-2 px-3 text-[13px]",
};

export default function Button({
  variant = "outline",
  size = "md",
  icon,
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[6px] border transition enabled:cursor-pointer enabled:active:translate-y-px disabled:cursor-not-allowed ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
