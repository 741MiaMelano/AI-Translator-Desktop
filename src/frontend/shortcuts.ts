// 三套键位预设的唯一事实来源：速查面板和编辑器绑定都读这里，改一处即可。
//
// 预设存在的理由是有真冲突：现代流的 J/K 是上/下一段，剪辑师流的 J/K/L 是穿梭播放，
// 没有预设只能二选一。
//
// 参考应用的键位一律照抄各自的真实默认值，不凭印象填：
//   · Aegisub —— src/libresrc/default_hotkey.json（随程序编译进去的那份默认配置）
//   · 剪辑师 —— Final Cut Pro 官方快捷键文档，外加 Adobe 明确记载的 J/K/L 穿梭
// 参考应用**根本没有**这个功能时（如 Aegisub 没有循环播放、没有全屏预览命令），
// 不编一个假键位冒充它，而是沿用本应用自己的键并在速查面板里标出来。

export type KeymapId = "modern" | "nle" | "aegisub";

export type ShortcutAction =
  | "playPause"
  | "prevSegment"
  | "nextSegment"
  | "shuttleBack"
  | "shuttleForward"
  | "shuttleStop"
  | "loopSegment"
  | "nudgeStartBack"
  | "nudgeStartForward"
  | "nudgeEndBack"
  | "nudgeEndForward"
  | "adopt"
  | "commitNext"
  | "toggleReference"
  | "toggleWaveform"
  | "previewMode"
  | "focusMode"
  | "undo"
  | "redo";

/** `origin: "app"` 表示参考应用没有对应默认键，这一行是本应用自己的补充。 */
export type Binding = { chord: string; label: string; origin?: "app" };

export type Keymap = {
  id: KeymapId;
  name: string;
  caption: string;
  /** Aegisub 的时间轴步进就是 10ms，不是 100ms；这也是预设该还原的细节。 */
  nudgeStepMs: number;
  bindings: Partial<Record<ShortcutAction, Binding>>;
};

export const ACTION_LABELS: Record<ShortcutAction, string> = {
  playPause: "播放 / 暂停",
  prevSegment: "上一段",
  nextSegment: "下一段",
  shuttleBack: "倒放穿梭",
  shuttleForward: "快放穿梭",
  shuttleStop: "停止穿梭",
  loopSegment: "循环本段",
  nudgeStartBack: "起点提前",
  nudgeStartForward: "起点延后",
  nudgeEndBack: "终点提前",
  nudgeEndForward: "终点延后",
  adopt: "采纳候选译文",
  commitNext: "提交并跳下一条",
  toggleReference: "收起 / 展开参考栏",
  toggleWaveform: "收起 / 展开波形条",
  previewMode: "预览模式",
  focusMode: "专注模式",
  undo: "撤销",
  redo: "重做",
};

export const ACTION_ORDER: ShortcutAction[] = [
  "playPause",
  "prevSegment",
  "nextSegment",
  "shuttleBack",
  "shuttleForward",
  "shuttleStop",
  "loopSegment",
  "nudgeStartBack",
  "nudgeStartForward",
  "nudgeEndBack",
  "nudgeEndForward",
  "commitNext",
  "adopt",
  "toggleReference",
  "toggleWaveform",
  "previewMode",
  "focusMode",
  "undo",
  "redo",
];

export const KEYMAPS: Keymap[] = [
  {
    id: "modern",
    name: "现代效率流",
    caption: "本应用默认。单手放在字母区，右手不离键盘。",
    nudgeStepMs: 100,
    bindings: {
      playPause: { chord: "Space", label: "Space" },
      prevSegment: { chord: "KeyJ", label: "J" },
      nextSegment: { chord: "KeyK", label: "K" },
      loopSegment: { chord: "KeyR", label: "R" },
      nudgeStartBack: { chord: "Alt+ArrowLeft", label: "Alt ←" },
      nudgeStartForward: { chord: "Alt+ArrowRight", label: "Alt →" },
      nudgeEndBack: { chord: "Alt+Shift+ArrowLeft", label: "Alt Shift ←" },
      nudgeEndForward: { chord: "Alt+Shift+ArrowRight", label: "Alt Shift →" },
      adopt: { chord: "Ctrl+Enter", label: "Ctrl Enter" },
      toggleReference: { chord: "KeyI", label: "I" },
      toggleWaveform: { chord: "KeyW", label: "W" },
      previewMode: { chord: "KeyV", label: "V" },
      focusMode: { chord: "KeyF", label: "F" },
      undo: { chord: "Ctrl+KeyZ", label: "Ctrl Z" },
      redo: { chord: "Ctrl+KeyY", label: "Ctrl Y" },
    },
  },
  {
    id: "nle",
    name: "剪辑师流",
    caption: "照 Final Cut Pro 官方默认键，外加 Adobe 记载的 J/K/L 穿梭。",
    nudgeStepMs: 100,
    bindings: {
      playPause: { chord: "Space", label: "Space" },
      shuttleBack: { chord: "KeyJ", label: "J" },
      shuttleStop: { chord: "KeyK", label: "K" },
      shuttleForward: { chord: "KeyL", label: "L" },
      prevSegment: { chord: "ArrowUp", label: "↑" },
      nextSegment: { chord: "ArrowDown", label: "↓" },
      loopSegment: { chord: "Ctrl+KeyL", label: "Ctrl L" },
      nudgeStartBack: { chord: "Alt+ArrowLeft", label: "Alt ←" },
      nudgeStartForward: { chord: "Alt+ArrowRight", label: "Alt →" },
      nudgeEndBack: { chord: "Alt+Shift+ArrowLeft", label: "Alt Shift ←" },
      nudgeEndForward: { chord: "Alt+Shift+ArrowRight", label: "Alt Shift →" },
      adopt: { chord: "Ctrl+Enter", label: "Ctrl Enter" },
      toggleReference: { chord: "KeyI", label: "I", origin: "app" },
      toggleWaveform: { chord: "KeyW", label: "W", origin: "app" },
      previewMode: { chord: "Ctrl+Shift+KeyF", label: "Ctrl Shift F" },
      undo: { chord: "Ctrl+KeyZ", label: "Ctrl Z" },
      redo: { chord: "Ctrl+Shift+KeyZ", label: "Ctrl Shift Z" },
    },
  },
  {
    id: "aegisub",
    name: "传统字幕流",
    caption: "照 Aegisub 随程序附带的默认配置。时间轴步进也跟它一样是 10ms。",
    nudgeStepMs: 10,
    bindings: {
      playPause: { chord: "Space", label: "Space" },
      loopSegment: { chord: "KeyR", label: "R" },
      shuttleStop: { chord: "KeyH", label: "H" },
      prevSegment: { chord: "KeyZ", label: "Z" },
      nextSegment: { chord: "KeyX", label: "X" },
      // Aegisub 的 Enter 就是要在编辑框里生效的——那是它的全部意义。
      commitNext: { chord: "Enter", label: "Enter" },
      nudgeStartBack: { chord: "Numpad4", label: "小键盘 4" },
      nudgeStartForward: { chord: "Numpad6", label: "小键盘 6" },
      nudgeEndBack: { chord: "Numpad7", label: "小键盘 7" },
      nudgeEndForward: { chord: "Numpad9", label: "小键盘 9" },
      adopt: { chord: "Ctrl+Enter", label: "Ctrl Enter", origin: "app" },
      toggleReference: { chord: "KeyI", label: "I", origin: "app" },
      toggleWaveform: { chord: "KeyW", label: "W", origin: "app" },
      previewMode: { chord: "KeyV", label: "V", origin: "app" },
      undo: { chord: "Ctrl+KeyZ", label: "Ctrl Z" },
      redo: { chord: "Ctrl+KeyY", label: "Ctrl Y" },
    },
  },
];

export const KEYMAP_BY_ID: Record<KeymapId, Keymap> = Object.fromEntries(
  KEYMAPS.map((keymap) => [keymap.id, keymap]),
) as Record<KeymapId, Keymap>;

/**
 * 用 `event.code` 而不是 `event.key` 归一：小键盘 4 和主键盘 4 必须区分得开，
 * 字母键也不该随输入法或键盘布局漂移。
 */
export function eventChord(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.code);
  return parts.join("+");
}

/** 无修饰键的单键（字母、小键盘、Enter）在文本输入里会和打字冲突。 */
export function isBareKey(chord: string) {
  return !chord.includes("+");
}

export function resolveAction(keymap: Keymap, chord: string): ShortcutAction | null {
  for (const action of ACTION_ORDER) {
    if (keymap.bindings[action]?.chord === chord) return action;
  }
  return null;
}
