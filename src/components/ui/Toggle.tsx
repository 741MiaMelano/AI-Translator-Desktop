interface ToggleProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  title?: string;
}

export default function Toggle({ checked, onChange, label, disabled, title }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (!disabled) onChange?.(!checked);
      }}
      className={`flex min-h-8 w-full items-center justify-between gap-3 rounded-[6px] px-2 text-left text-[13px] text-[var(--color-text-main)] transition ${
        disabled ? "cursor-not-allowed opacity-45" : "hover:bg-card-soft"
      }`}
    >
      {label && <span>{label}</span>}
      <span
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition ${
          checked ? "bg-gold" : "bg-line-strong"
        }`}
      >
        <span
          className={`absolute top-[3px] h-3 w-3 rounded-full bg-white transition-all ${
            checked ? "left-[17px]" : "left-[3px]"
          }`}
        />
      </span>
    </button>
  );
}
