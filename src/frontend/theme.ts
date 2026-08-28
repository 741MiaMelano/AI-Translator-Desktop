export const THEME_IDS = [
  "brass",
  "ticket",
  "proof",
  "fold",
  "strata",
  "signal",
  "celadon",
  "relay",
  "inkwhite",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemeDefinition {
  id: ThemeId;
  code: string;
  name: string;
  caption: string;
  prototypeFile: string;
  signature: string;
  colorScheme: "light" | "dark";
}

export const THEMES: readonly ThemeDefinition[] = [
  { id: "brass", code: "A", name: "黄铜机台", caption: "暖纸 · 石墨 · 拉丝黄铜机台声", prototypeFile: "A-brass.html", signature: "concentric", colorScheme: "light" },
  { id: "ticket", code: "B", name: "航线票夹", caption: "票券纸 · 航线 · 纸张打孔声", prototypeFile: "B-ticket.html", signature: "route", colorScheme: "light" },
  { id: "proof", code: "C", name: "套色校样", caption: "套印蓝红 · 校样纸 · 铅印校对声", prototypeFile: "C-proof.html", signature: "registration", colorScheme: "light" },
  { id: "fold", code: "D", name: "折页星图", caption: "折痕 · 山谷线 · 金箔折叠摩擦", prototypeFile: "D-fold.html", signature: "crease", colorScheme: "light" },
  { id: "strata", code: "E", name: "云层剖面", caption: "云白 · 深蓝切面 · 晶振电子脉冲", prototypeFile: "E-strata.html", signature: "sonar", colorScheme: "light" },
  { id: "signal", code: "F", name: "信号母带", caption: "炭黑 · 琥珀母线 · 广播总线继电器", prototypeFile: "F-signal.html", signature: "vu", colorScheme: "dark" },
  { id: "celadon", code: "G", name: "青瓷刻度", caption: "雨青釉 · 冰裂导线 · 瓷磬玉石钟声", prototypeFile: "G-celadon.html", signature: "ripple", colorScheme: "light" },
  { id: "relay", code: "H", name: "工业信号", caption: "冷钢板 · 橙色母线 · 工控干簧管跳动", prototypeFile: "H-relay.html", signature: "led", colorScheme: "dark" },
  { id: "inkwhite", code: "I", name: "墨白编校", caption: "宣纸白 · 墨线书口 · 朱批木刻印章", prototypeFile: "I-inkwhite.html", signature: "proofmark", colorScheme: "light" },
] as const;

export const THEME_BY_ID = Object.fromEntries(THEMES.map((theme) => [theme.id, theme])) as Record<ThemeId, ThemeDefinition>;

export function isThemeId(value: string | null): value is ThemeId {
  return THEME_IDS.includes(value as ThemeId);
}
