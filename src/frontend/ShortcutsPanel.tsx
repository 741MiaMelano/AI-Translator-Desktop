import { useEffect, useRef } from "react";
import { ACTION_LABELS, ACTION_ORDER, KEYMAPS, KEYMAP_BY_ID } from "./shortcuts";
import { useFrontend } from "./state";
import { Icon } from "./visuals";

export function ShortcutsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useFrontend();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = () => {
    onClose();
    restoreFocusRef.current?.focus();
  };

  const keymap = KEYMAP_BY_ID[app.keymap];
  const rows = ACTION_ORDER.map((action) => ({ action, binding: keymap.bindings[action] }))
    .filter((row) => row.binding);
  const borrowed = rows.filter((row) => row.binding?.origin === "app").length;

  return (
    <div className="command-layer" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
      <div
        ref={panelRef}
        className="command-panel shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键速查"
        tabIndex={-1}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}
      >
        <div className="command-input">
          <Icon name="edit"/>
          <div><strong>快捷键速查</strong><span>面板始终显示当前生效的那一套</span></div>
          <button type="button" className="command-close-btn" onClick={close} aria-label="关闭快捷键速查" title="关闭 (Esc)"><Icon name="close"/></button>
        </div>

        <div className="keymap-picker" role="radiogroup" aria-label="键位预设">
          {KEYMAPS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              role="radio"
              aria-checked={preset.id === app.keymap}
              className={preset.id === app.keymap ? "is-current" : ""}
              onClick={() => app.setKeymap(preset.id)}
            >
              <strong>{preset.name}</strong>
              <small>{preset.caption}</small>
              {preset.id === app.keymap ? <Icon name="check"/> : null}
            </button>
          ))}
        </div>

        <table className="keymap-table">
          <caption>时间轴步进：一次 {keymap.nudgeStepMs}ms</caption>
          <tbody>
            {rows.map(({ action, binding }) => (
              <tr key={action} className={binding?.origin === "app" ? "is-borrowed" : ""}>
                <th scope="row">{ACTION_LABELS[action]}</th>
                <td><kbd>{binding?.label}</kbd></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 参考应用没有这个功能时不编一个假键位冒充它，而是照实说这一行是本应用自己的。 */}
        {borrowed ? <p className="keymap-note">带 · 的 {borrowed} 项在参考应用里没有对应默认键，用的是本应用自己的键位。</p> : null}

        <footer>
          <span><kbd>Ctrl</kbd><kbd>K</kbd> 命令面板</span>
          <span><kbd>?</kbd> 本面板</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </footer>
      </div>
    </div>
  );
}
