import { useEffect, useId, useRef } from "react";
import Button from "../../ui/Button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  /** 语义化确认按钮文案，例如「永久删除」，不要再用系统的「确定」 */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 破坏性操作的二次确认。
 *
 * 用原生 <dialog>.showModal()：焦点陷阱、Esc 关闭、关闭后把焦点还给触发按钮
 * 都由浏览器负责，不需要自己实现。相比 window.confirm，它能套用应用自己的视觉语言，
 * 并且能按风险给出语义化的按钮文案。
 *
 * 这个组件是通用的，后续应当由组件库维护者提升到 src/components/ui/ 供各页共用。
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "我再想想",
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onCancel();
      }}
      className="w-[min(28rem,calc(100vw-2rem))] rounded-[10px] border border-line bg-card p-0 text-[var(--color-text-main)] shadow-pop backdrop:bg-black/45"
    >
      <div className="border-b border-line px-3.5 py-2.5">
        <h2 id={titleId} className="text-[12.5px] font-semibold">
          {title}
        </h2>
      </div>
      <p id={descriptionId} className="px-3.5 py-3 text-[13px] leading-6 text-[var(--color-text-muted)]">
        {description}
      </p>
      <div className="flex justify-end gap-2 border-t border-line px-3.5 py-2.5">
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
