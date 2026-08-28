import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const themes = [
  ["brass", "A", "黄铜机台", "A-brass.html", "concentric"],
  ["ticket", "B", "航线票夹", "B-ticket.html", "route"],
  ["proof", "C", "套色校样", "C-proof.html", "registration"],
  ["fold", "D", "折页星图", "D-fold.html", "crease"],
  ["strata", "E", "云层剖面", "E-strata.html", "sonar"],
  ["signal", "F", "信号母带", "F-signal.html", "vu"],
  ["celadon", "G", "青瓷刻度", "G-celadon.html", "ripple"],
  ["relay", "H", "工业信号", "H-relay.html", "led"],
  ["inkwhite", "I", "墨白编校", "I-inkwhite.html", "proofmark"],
];

test("FR-04 preserves the approved nine-theme identity and source trace", () => {
  const source = read("src/frontend/theme.ts");
  for (const [id, code, name, file, signature] of themes) {
    assert.match(source, new RegExp(`id: "${id}"[\\s\\S]*?code: "${code}"[\\s\\S]*?name: "${name}"[\\s\\S]*?prototypeFile: "${file}"[\\s\\S]*?signature: "${signature}"`));
  }
  assert.match(source, /THEME_IDS\.includes/);
});

test("FR-04 theme menu switches appearance without replacing business routes or state", () => {
  const app = read("src/frontend/App.tsx");
  const state = read("src/frontend/state.tsx");
  assert.match(app, /THEMES\.map/);
  assert.match(app, /role="menuitemradio"/);
  assert.match(app, /app\.setTheme\(theme\.id\)/);
  assert.match(app, /toast-\$\{app\.theme\}/);
  assert.match(app, /业务数据、路由与操作状态不变/);
  for (const preference of ["app.toggleSound", "app.toggleEffects", "app.toggleReducedMotion"]) assert.match(app, new RegExp(preference.replace(".", "\\.")));
  assert.match(state, /localStorage\.getItem\(STORAGE\.sound\) === "true"/);
  assert.match(state, /localStorage\.getItem\(STORAGE\.effects\) !== "false"/);
  assert.match(state, /systemReducedMotion \|\| reducedMotionForced/);
  for (const attribute of ["dataset.theme", "dataset.signature", "dataset.effects", "dataset.reducedMotion"]) assert.match(state, new RegExp(attribute.replace(".", "\\.")));
  assert.doesNotMatch(`${app}\n${state}`, /window\.location\s*=|location\.reload\(|workspaceMock|data-demo-action/);
});

test("FR-04 ships each prototype brand, intake signature and media visualizer", () => {
  const visuals = read("src/frontend/visuals.tsx");
  const consumers = [read("src/frontend/pages.tsx"), read("src/frontend/EditorPage.tsx"), read("src/frontend/MediaPage.tsx")].join("\n");
  for (const [id] of themes) {
    assert.match(visuals, new RegExp(`hero-${id}-obj`));
    assert.match(visuals, new RegExp(`visualizer-${id}`));
  }
  for (const id of themes.slice(1).map(([theme]) => theme)) assert.match(visuals, new RegExp(`theme === "${id}"`));
  assert.match(consumers, /ThemeIntakeVisual theme=\{app\.theme\}/);
  assert.match(consumers, /ThemeVisualizer theme=\{app\.theme\}/);
  assert.match(consumers, /playing=\{mediaPlaying\}/);
  assert.doesNotMatch(consumers, /BrassBrandMark|BrassIntakeVisual|BrassVisualizer/);
});

test("FR-04 retains nine distinct procedural sound recipes and defaults to silence", () => {
  const engine = read("src/frontend/sound-engine.mjs");
  const wrapper = read("src/frontend/sound.ts");
  for (const [id] of themes) {
    assert.match(engine, new RegExp(`\\n      ${id}: \\(c, out, type\\) =>`));
    assert.match(engine, new RegExp(`playTrimSound\\(c, out, "${id}"\\)`));
  }
  for (const sound of ["click", "navigate", "toggle", "tab", "trim", "success", "warning"]) assert.match(wrapper, new RegExp(`\\b${sound}\\b`));
  assert.match(engine, /createDynamicsCompressor/);
  assert.match(engine, /ctx\.close\(\)/);
  assert.doesNotMatch(engine, /innerHTML|data-demo-action|localStorage|querySelector/);
});

test("FR-04 theme materials include scoped selection, scrollbars, motion controls and signature animation", () => {
  const prototypeCss = read("src/frontend/styles/prototype.css");
  const productionCss = read("src/frontend/styles/production.css");
  for (const [id] of themes) {
    assert.match(prototypeCss, new RegExp(`html\\[data-theme="${id}"\\] \\{`));
    assert.match(prototypeCss, new RegExp(`html\\[data-theme="${id}"\\] ::selection`));
    assert.match(prototypeCss, new RegExp(`html\\[data-theme="${id}"\\] ::-webkit-scrollbar-thumb`));
  }
  assert.match(prototypeCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(productionCss, /html\.effects-off \.hero-visual-obj/);
  assert.match(productionCss, /html\.reduce-motion \*/);
  assert.match(productionCss, /\.theme-preferences/);
});

test("rail-scoped components never reach for main-canvas tokens", () => {
  // 侧栏是独立的颜色作用域（--rail-*）。用 --surface-hover / --accent / --text
  // 这类主画布 token 会在深色侧栏上变成看不清的浅色块——九套皮肤里只有三套
  // 浅色侧栏碰巧没事，所以肉眼走查很容易漏掉。
  const css = readFileSync(new URL("../src/frontend/styles/production.css", import.meta.url), "utf8");
  const canvasOnly = /var\(--(surface|surface-2|surface-hover|text|heading|muted|line|line-strong|accent|accent-ink)\b/;
  const railSelector = /^\s*(html\.rail-compact\s+)?\.(sidebar|nav-item|rail|brand)[\w-]*[^{]*\{/;

  const lines = css.split(/\r?\n/);
  let inRailRule = false;
  const offenders = [];
  for (const line of lines) {
    if (/^\s*(\/\*|\*)/.test(line)) continue;
    if (railSelector.test(line)) inRailRule = true;
    if (inRailRule && canvasOnly.test(line)) offenders.push(line.trim().slice(0, 80));
    if (inRailRule && line.includes("}")) inRailRule = false;
  }
  assert.deepEqual(offenders, [], "rail components must use --rail-* tokens");
});

test("every referenced theme token is actually defined", () => {
  // 引用一个从没定义过的 token 时，CSS 会静默丢掉整条声明，元素就继续用上一层的颜色。
  // .settings-message.is-success 引用 --success-line（从未定义）就是这样一直挂着
  // danger 边框的——成功提示长得像报错，而且不会有任何报错告诉你。
  const production = read("src/frontend/styles/production.css");
  const prototype = read("src/frontend/styles/prototype.css");
  const defined = new Set(
    [...`${prototype}\n${production}`.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
  );
  // 带兜底值的引用（var(--x, 50%)）是有意为之，不算漏定义。
  const referenced = new Set(
    [...`${prototype}\n${production}`.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)].map((match) => match[1]),
  );
  // 这七个是原型阶段留下的旧账：引用它们的声明一直被静默丢弃，所以现在的观感其实是
  // "没有这条声明"的观感。补定义会真的改变九套皮肤的渲染，需要逐套走查后再动，不能
  // 靠猜。这里先冻住名单，保证不再新增同类问题。
  const knownDebt = [
    "--accent-hi",
    "--border-soft",
    "--font-body",
    "--progress-track",
    "--radius-sm",
    "--text-muted",
    "--value",
  ];
  const missing = [...referenced].filter((token) => !defined.has(token)).sort();
  assert.deepEqual(missing, knownDebt, "no new undefined theme tokens may be introduced");
});

test("alert variants that claim success do not keep the danger palette", () => {
  const css = read("src/frontend/styles/production.css");
  // runtime-alert 的底色就是 danger，所以每个 is-success 变体都必须显式换掉底色，
  // 否则"翻译已更新"会长成一条红色报错。
  for (const variant of [".runtime-alert.is-success", ".delivery-message.is-success", ".settings-message.is-success"]) {
    const at = css.indexOf(`${variant} {`);
    assert.notEqual(at, -1, `${variant} needs its own rule`);
    const body = css.slice(at, css.indexOf("}", at));
    assert.match(body, /background:\s*var\(--success-soft\)/, `${variant} must repaint the background`);
    assert.match(body, /border-color:\s*var\(--success\)/, `${variant} must repaint the border`);
  }
});
