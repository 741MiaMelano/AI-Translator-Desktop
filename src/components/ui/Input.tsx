import type { InputHTMLAttributes, Ref } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** 标签左置、控件右置。表单密度差不多能压到堆叠布局的三分之一 */
  inline?: boolean;
  /** inline 模式下标签列宽度 */
  labelWidth?: string;
  hint?: string;
}

const FIELD =
  "control-surface h-8 w-full rounded-[6px] border border-line-strong bg-card px-2.5 text-[13px] text-[var(--color-text-main)] outline-none transition placeholder:text-[var(--color-text-muted)] hover:border-gold focus:border-gold";

export default function Input({
  label,
  inputRef,
  inline = false,
  labelWidth = "5.5rem",
  hint,
  className = "",
  ...props
}: InputProps) {
  if (inline && label) {
    return (
      <label className="flex min-w-0 items-center gap-3">
        <span
          className="shrink-0 text-[12.5px] text-[var(--color-text-muted)]"
          style={{ width: labelWidth }}
        >
          {label}
        </span>
        <input ref={inputRef} className={`${FIELD} ${className}`} {...props} />
      </label>
    );
  }

  return (
    <label className="block min-w-0">
      {label && <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">{label}</span>}
      <input ref={inputRef} className={`${FIELD} ${className}`} {...props} />
      {hint && <span className="mt-1 block text-[11.5px] text-[var(--color-text-muted)]">{hint}</span>}
    </label>
  );
}
