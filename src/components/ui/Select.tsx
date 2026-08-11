import type { SelectHTMLAttributes } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: string[];
  /** 标签左置、控件右置 */
  inline?: boolean;
  labelWidth?: string;
}

const FIELD =
  "control-surface h-8 w-full rounded-[6px] border border-line-strong bg-card px-2.5 text-[13px] text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold disabled:opacity-50";

export default function Select({
  label,
  options,
  inline = false,
  labelWidth = "5.5rem",
  className = "",
  ...props
}: SelectProps) {
  const field = (
    <select className={`${FIELD} ${className}`} {...props}>
      {options.map((option) => (
        <option key={option}>{option}</option>
      ))}
    </select>
  );

  if (inline && label) {
    return (
      <label className="flex min-w-0 items-center gap-3">
        <span
          className="shrink-0 text-[12.5px] text-[var(--color-text-muted)]"
          style={{ width: labelWidth }}
        >
          {label}
        </span>
        {field}
      </label>
    );
  }

  return (
    <label className="block min-w-0">
      {label && <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">{label}</span>}
      {field}
    </label>
  );
}
