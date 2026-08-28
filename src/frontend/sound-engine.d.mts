import type { ThemeId } from "./theme";

export type PrototypeUiSound = "click" | "navigate" | "toggle" | "tab" | "trim" | "success" | "warning";

export function playPrototypeSound(type?: PrototypeUiSound, theme?: ThemeId): void;
export function disposePrototypeSound(): void;
