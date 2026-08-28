import type { ThemeId } from "./theme";
import { disposePrototypeSound, playPrototypeSound } from "./sound-engine.mjs";

export type UiSound = "click" | "navigate" | "toggle" | "tab" | "trim" | "success" | "warning";

let lastStartedAt = 0;

export function playThemeSound(type: UiSound = "click", theme: ThemeId = "brass") {
  const now = performance.now();
  if (now - lastStartedAt < 36) return;
  lastStartedAt = now;
  playPrototypeSound(type, theme);
}

export function disposeThemeSound() {
  lastStartedAt = 0;
  disposePrototypeSound();
}
