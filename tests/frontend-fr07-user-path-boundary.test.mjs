import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * 只保留真实代码的读取器。doesNotMatch 这一类断言必须只看代码：解释性注释里
 * 提到被禁用的旧写法是正常的（那正是在说明为什么禁），不该让断言假失败。
 */
const readCode = (path) => read(path)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/)
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

test("FR-07 desktop shell exposes a safe drag region and the real native file-drop overlay", () => {
  const app = read("src/frontend/App.tsx");
  const css = read("src/frontend/styles/production.css");
  assert.match(css, /\.topbar[\s\S]*?-webkit-app-region:\s*drag/);
  assert.match(css, /\.topbar[\s\S]*?user-select:\s*none/);
  assert.match(css, /\.topbar[\s\S]*?-webkit-user-drag:\s*none/);
  assert.match(app, /onDragEnter=/);
  assert.match(app, /onDragOver=/);
  assert.match(app, /onDragLeave=/);
  assert.match(app, /onDrop=/);
  assert.match(app, /native-drop-overlay/);
  assert.match(app, /droppedFiles/);
  assert.match(app, /app\.play\("toggle"\)/);
});

test("FR-07 workbench drop reuses ImportPage batch intake instead of creating a second pipeline", () => {
  const workbench = read("src/frontend/pages.tsx");
  const importer = read("src/frontend/ImportPage.tsx");
  assert.match(workbench, /支持拖放/);
  assert.match(importer, /droppedFiles/);
  assert.match(importer, /workspace\.createBatchSession\(files\)/);
  assert.match(importer, /replace:\s*true/);
  assert.doesNotMatch(workbench, /createBatchSession|commitBatchSession/);
});

test("FR-07 user readiness excludes the unavailable public separation stub", () => {
  const app = read("src/frontend/App.tsx");
  const system = read("src/frontend/pages.tsx");
  const media = read("src/frontend/MediaPage.tsx");
  const capabilities = read("backend/capabilities/capability-service.mjs");
  assert.doesNotMatch(app, /\$\{readyCount\}\/\$\{capabilities\.length\}/);
  assert.doesNotMatch(system, /公共音频分离服务未安装/);
  assert.doesNotMatch(media, /desktopStartAudioSeparation|开始本机分离|separation-panel/);
  assert.doesNotMatch(capabilities, /capability\("audio_separation"/);
});

test("FR-07 capability status is tiered by when it is needed, and the sidebar only alarms on blockers", () => {
  const app = read("src/frontend/App.tsx");
  const tiers = read("src/frontend/capabilities.ts");
  const system = read("src/frontend/pages.tsx");

  // 侧栏不再做四项平权计数——纯字幕用户不该永远盯着一个与他无关的红点。
  assert.doesNotMatch(app, /readyCount/);
  assert.doesNotMatch(app, /项核心能力需处理/);
  assert.match(app, /blockingCapabilities\(capabilities, workspace\.projects\)/);
  assert.match(app, /blocking\.length === 0\s*\n?\s*\? "就绪"/);

  // 分级由真实项目状态推导：手头没有需要识别的项目时，ASR 属于"按需启用"。
  assert.match(tiers, /export function capabilityTier/);
  assert.match(tiers, /id === "asr"\) return projects\.some\(needsTranscription\)/);
  assert.match(tiers, /export const WHEN_NEEDED/);
  assert.match(tiers, /只在处理没有字幕的视频\/音频时需要/);
  // 后端契约里的四个能力 ID 不变，本节只改分组与文案。
  for (const id of ["translation", "asr", "subtitle_export", "video_export"]) {
    assert.match(tiers, new RegExp(`${id}:`));
  }

  // 系统页只渲染一次能力，且每一项都是可点的（旧实现第二遍是只读 div）。
  assert.match(system, /现在需要/);
  assert.match(system, /按需启用/);
  assert.match(system, /const MAINTENANCE/);
  assert.doesNotMatch(system, /capabilities\.map\(/);
  assert.equal((system.match(/now\.map\(/g) ?? []).length, 1);
  assert.equal((system.match(/onDemand\.map\(/g) ?? []).length, 1);
  assert.doesNotMatch(system, /production-system-cell/);
  // 后端没有应用更新器，版本条就不能摆一个点了没反应的更新按钮。断在渲染出来的
  // 按钮文字上，而不是整份源码——否则源码注释提一句就会让断言假失败。
  assert.match(system, /app-version-strip/);
  assert.doesNotMatch(system, />\s*检查更新\s*<|>\s*下载更新\s*</);
});

test("FR-07 eyebrow labels carry real words and the self-justifying copy is gone", () => {
  const pages = [
    "App.tsx", "pages.tsx", "ProjectPage.tsx", "ProjectSettingsPage.tsx", "MediaPage.tsx",
    "TranslatePage.tsx", "EditorPage.tsx", "DeliveryPage.tsx", "WorkspacePage.tsx",
    "LibraryPage.tsx", "CapabilitiesPage.tsx", "SettingsPage.tsx", "ImportPage.tsx",
  ];

  // 等宽小字标签的样式是九皮肤视觉身份的一部分，保留；内容必须是有信息量的词。
  // 只有产品字标 AI TRANSLATOR / LOCAL WORKSPACE 例外。
  const BRAND = new Set(["AI TRANSLATOR", "LOCAL WORKSPACE", "AI TRANSLATOR DESKTOP"]);
  for (const file of pages) {
    const source = read(`src/frontend/${file}`);
    for (const match of source.matchAll(/<span>([A-Z][A-Z0-9 &/]{4,})<\/span>/g)) {
      assert.ok(BRAND.has(match[1].trim()), `${file}: eyebrow "${match[1]}" must be a real word`);
    }
  }

  // 自证句是写给验收人的，不是写给用户的。真实空态、错误原因、恢复路径、费用提示、
  // 不可逆警告都保留——那些是产品行为。
  for (const file of pages) {
    const source = read(`src/frontend/${file}`);
    for (const line of source.split(/\r?\n/)) {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
      assert.doesNotMatch(line, /界面不会制造|不会伪造|不是模拟记录|阶段不会由 UI 任意改写|不把缺失资源显示为可用|来自本机持久化数据/, `${file}: ${line.trim().slice(0, 70)}`);
    }
  }
});

test("FR-07 the density switch only hides technical readouts, never a gate", () => {
  const state = read("src/frontend/state.tsx");
  const app = read("src/frontend/App.tsx");
  const css = read("src/frontend/styles/production.css");

  assert.match(state, /export type Density = "simple" \| "pro"/);
  assert.match(state, /ai_translator_density/);
  assert.match(state, /density-pro", density === "pro"/);
  assert.match(app, /density-toggle/);
  assert.match(css, /html:not\(\.density-pro\) \.pro-only \{ display: none; \}/);

  // 硬约束：同意勾选、QA 阻断、批准顺序、删除确认在两种模式下完全一致。
  // 任何一处"门"被标成 pro-only，小白就会因为用了简单模式而失去保护。
  const gates = [
    ["src/frontend/TranslatePage.tsx", /translate-cost-note/],
    ["src/frontend/DeliveryPage.tsx", /delivery-preflight/],
    ["src/frontend/DeliveryPage.tsx", /明确批准当前字幕轨/],
    ["src/frontend/ProjectSettingsPage.tsx", /production-dialog/],
  ];
  for (const [file, marker] of gates) {
    const source = read(file);
    assert.match(source, marker);
    // 门所在的那一行不得带 pro-only
    for (const line of source.split(/\r?\n/)) {
      if (marker.test(line)) assert.doesNotMatch(line, /pro-only/, `${file}: a gate must never be density-hidden`);
    }
  }
  // 更直接的一条：确认对话框、同意勾选、QA 门这些类名永远不和 pro-only 同现。
  for (const file of ["TranslatePage.tsx", "DeliveryPage.tsx", "EditorPage.tsx", "ProjectSettingsPage.tsx", "MediaPage.tsx"]) {
    for (const line of read(`src/frontend/${file}`).split(/\r?\n/)) {
      if (!/pro-only/.test(line)) continue;
      assert.doesNotMatch(line, /translate-cost-note|paid-consent|production-dialog|dialog-actions|preflight|确认|批准|删除/, `${file}: ${line.slice(0, 80)}`);
    }
  }
});

test("FR-07 makes real media and proofreading tasks explicit in the new UI", () => {
  const media = read("src/frontend/MediaPage.tsx");
  const editor = read("src/frontend/EditorPage.tsx");
  // 三项真实媒体任务仍须以用户任务名出现。转字幕不再叫"视频/音频转字幕"、也不再是
  // 一条指向别处的入口卡，而就是这个阶段本身的主操作"开始转写"；提取音频与提取内嵌
  // 字幕落在"媒体流"里各自的轨道上——那是选轨道的地方，也是唯一能选对轨道的地方。
  for (const label of ["提取音频", "提取内嵌字幕", "未检测到内嵌字幕", "开始转写"]) {
    assert.match(media, new RegExp(label));
  }
  // 主操作唯一：识别/分段/启用不再是三个同级按钮，而是串在一次转写里。
  assert.match(media, /asr-primary-action/);
  assert.match(media, /transcribe-steps/);
  assert.match(media, /分步执行/);
  assert.doesNotMatch(media, /media-task-rail/);
  // 主操作必须排在素材面板之前，且这个阶段的画面默认收起——不能再让播放器占掉首屏。
  const asrAt = media.indexOf("media-processing-grid");
  const materialAt = media.indexOf("media-tool-grid");
  assert.ok(asrAt >= 0 && materialAt > asrAt, `transcribe panel must precede the material panels: ${asrAt} / ${materialAt}`);
  assert.match(media, /details className="media-preview-fold"/);
  // 校对必须以用户任务名出现，不能只藏在 QA 术语里。编辑器本身已不再重复标题，
  // 这个名字现在由阶段导轨承担，所以断言改在导轨上——否则只要源码注释里出现这几个字
  // 断言就会假通过。
  const nav = read("src/frontend/ProjectWorkspaceNav.tsx");
  assert.match(nav, /label: "校对"/);
  assert.doesNotMatch(editor, /<h2>字幕编辑与校对<\/h2>/);
  assert.doesNotMatch(media, /导出音频|项目识别运行/);
});

test("FR-07 project stages share one workspace navigation and remove the three competing title actions", () => {
  const nav = read("src/frontend/ProjectWorkspaceNav.tsx");
  const shell = read("src/frontend/ProjectWorkspace.tsx");
  const project = read("src/frontend/ProjectPage.tsx");

  // 导航只由常驻外壳挂载一次；阶段体各自再渲染一条就是回到了被替换掉的重复导航。
  assert.match(shell, /<ProjectWorkspaceNav/);
  assert.match(shell, /<Outlet/);
  for (const stage of ["ProjectPage.tsx", "MediaPage.tsx", "TranslatePage.tsx", "EditorPage.tsx", "DeliveryPage.tsx", "ProjectSettingsPage.tsx"]) {
    assert.doesNotMatch(read(`src/frontend/${stage}`), /<ProjectWorkspaceNav/);
  }

  // 五个阶段用户任务名，且不再与旧的技术分区名并存。
  for (const label of ["导入", "转写", "翻译", "校对", "交付"]) assert.match(nav, new RegExp(label));
  assert.doesNotMatch(nav, /项目概览|素材与识别|字幕编辑与校对/);
  assert.match(nav, /aria-current/);

  // 概览不再出现与阶段导轨重复的第二条导轨或并列任务入口。
  assert.doesNotMatch(project, /project-title-actions|project-task-shortcuts/);
  assert.doesNotMatch(project, /className="stage-rail/);
  assert.doesNotMatch(project, />媒体与 ASR<|>项目设置与资产<|>交付</);
});

test("FR-07 the command palette is reachable by key and by pointer, and only offers real destinations", () => {
  const app = read("src/frontend/App.tsx");
  const palette = read("src/frontend/CommandPalette.tsx");

  // 顶栏那块空白原来什么都没有；键盘和鼠标必须各有一条路。
  assert.match(app, /command-trigger/);
  assert.match(app, /event\.code === "KeyK" && \(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(app, /<CommandPalette/);

  // 复用原型的命令层类名，九套皮肤才会自动跟上。
  assert.match(palette, /className="command-layer"/);
  assert.match(palette, /className="command-panel"/);

  for (const group of ["建议操作", "项目", "前往", "操作"]) assert.match(palette, new RegExp(group));
  // ① 由真实状态推导，不是固定菜单。
  assert.match(palette, /translationReady/);
  assert.match(palette, /countQaIssues/);
  assert.match(palette, /projectStageEntry/);
  // 键盘可用：上下选择、Enter 执行、Esc 关闭并归还焦点。
  assert.match(palette, /ArrowDown/);
  assert.match(palette, /restoreFocusRef\.current\?\.focus\(\)/);
  // 后端没有检查更新这条 IPC，就不能摆一个点了没反应的命令。
  assert.doesNotMatch(palette, /检查更新/);

  // "继续某项目"必须和阶段导轨给出同一个答案，所以两边共用同一份阶段推导。
  assert.match(read("src/frontend/ProjectWorkspaceNav.tsx"), /export function projectStageEntry/);
});

test("FR-07 keymap presets carry the reference apps' real defaults, not invented ones", () => {
  const shortcuts = read("src/frontend/shortcuts.ts");
  const panel = read("src/frontend/ShortcutsPanel.tsx");

  for (const preset of ["modern", "nle", "aegisub"]) assert.match(shortcuts, new RegExp(`id: "${preset}"`));

  // 这几条来自 Aegisub 随程序附带的 default_hotkey.json。设计文档里原先凭印象写的
  // F1 / PageDown / Shift+←→ 都不是它的真实默认键，不能退回去。
  const aegisub = shortcuts.slice(shortcuts.indexOf('id: "aegisub"'));
  assert.match(aegisub, /prevSegment: \{ chord: "KeyZ"/);
  assert.match(aegisub, /nextSegment: \{ chord: "KeyX"/);
  assert.match(aegisub, /loopSegment: \{ chord: "KeyR"/);
  assert.match(aegisub, /nudgeStartBack: \{ chord: "Numpad4"/);
  assert.match(aegisub, /nudgeEndForward: \{ chord: "Numpad9"/);
  assert.match(aegisub, /nudgeStepMs: 10/);
  assert.doesNotMatch(shortcuts, /chord: "F1"|chord: "PageDown"/);

  // 剪辑师流的 J/K/L 是穿梭，不是上下一段——这正是预设存在的理由。
  const nle = shortcuts.slice(shortcuts.indexOf('id: "nle"'), shortcuts.indexOf('id: "aegisub"'));
  assert.match(nle, /shuttleBack: \{ chord: "KeyJ"/);
  assert.match(nle, /shuttleStop: \{ chord: "KeyK"/);
  assert.match(nle, /shuttleForward: \{ chord: "KeyL"/);
  assert.match(nle, /prevSegment: \{ chord: "ArrowUp"/);

  // 参考应用没有这一项时照实标出来，而不是编一个假键位冒充它。
  assert.match(shortcuts, /origin\?: "app"/);
  assert.match(panel, /binding\?\.origin === "app"/);
  assert.match(panel, /在参考应用里没有对应默认键/);
  assert.match(panel, /app\.setKeymap/);
});

test("FR-07 editor keybindings follow the preset, including the Enter-inside-the-input exception", () => {
  const editor = read("src/frontend/EditorPage.tsx");

  assert.match(editor, /resolveAction\(keymap, eventChord\(event\)\)/);
  // 单字母键在文本输入里让位给打字；带修饰键的组合始终生效。
  assert.match(editor, /inText && isBareKey\(keymap\.bindings\[action\]\?\.chord/);
  // 例外：Aegisub 那套的 Enter 反过来只在输入框内生效，那是它的全部意义。
  assert.match(editor, /if \(action === "commitNext"\) \{\s*\n\s*if \(!inText\) return;/);
  // 键位表里有的动作都要真的接上，专注模式也不例外。
  assert.match(editor, /is-focus-mode/);
  assert.match(editor, /runShortcutRef\.current = /);
  for (const action of ["shuttleBack", "loopSegment", "nudgeStartBack", "previewMode", "focusMode", "undo"]) {
    assert.match(editor, new RegExp(`action === "${action}"`));
  }
});

test("FR-07 the caret split is finally wired to the split_text domain command", () => {
  const editor = read("src/frontend/EditorPage.tsx");

  // domain 一直有 split_text，此前没有任何界面入口，长字幕切不开。
  assert.match(editor, /kind: "split_text"/);
  assert.match(editor, /targetOffset: offset/);
  assert.match(editor, /selectionStart/);
  assert.match(editor, /按光标拆分/);
  // 拆分用两个新 id 替换当前段；不自己给 id 就无法在拆完后停在左半段。
  assert.match(editor, /idFactory: \(\) => ids\[handed\+\+\]/);
  assert.match(editor, /if \(ok\) setSelectedId\(ids\[0\]\)/);
  // 两种拆分语义不同，按钮名必须把区别说出来。
  assert.match(editor, /中点拆分（只切时间）/);
});

test("O6 the subtitle overlay clears between cues instead of holding the selected row", () => {
  const editor = read("src/frontend/EditorPage.tsx");

  // activeSegment 判定一直是对的：两端都比，播放头越过 end 就为空。
  assert.match(editor, /playheadMs >= range\.start && playheadMs < range\.end/);
  // 坏在下一行：为空就无条件回退到列表选中项，于是句子之间的空隙里上一句还挂在画面上。
  // 回退只能发生在暂停时——预览模式调样式需要有东西可看。
  assert.match(editor, /const overlayCandidate = activeSegment \?\? \(mediaPlaying \? null : selected\) \?\? null;/);
  assert.doesNotMatch(editor, /const overlayCandidate = activeSegment \?\? selected \?\? null;/);
});

test("FR-07 delivery keeps every export destination visible and spells out why one is locked", () => {
  const delivery = read("src/frontend/DeliveryPage.tsx");
  const editor = read("src/frontend/EditorPage.tsx");

  // 去处常显：不再用一个"交付选项保持锁定"的警告框替换掉整块导出区。
  assert.doesNotMatch(delivery, /delivery-locked|交付选项保持锁定/);
  assert.match(delivery, /const destinations = \[/);
  assert.match(delivery, /reason: approved \? null : "需先批准当前字幕轨"/);
  assert.match(delivery, /destination\.reason \?\? destination\.detail/);
  // 交付单是九套皮肤的签名元件，常显只改状态，不能换成普通面板。
  assert.match(delivery, /delivery-sheet/);
  assert.match(delivery, /delivery-seal/);

  // "建议 N"要能点开。错名那一栏改名要断在渲染出来的 <dt> 上，
  // 否则源码注释里出现这几个字就能让断言假通过或假失败。
  assert.match(delivery, /filter=issues/);
  assert.match(delivery, /<dt>来源<\/dt>/);
  assert.doesNotMatch(delivery, /<dt>人工操作<\/dt>/);
  // 预览最终效果与建议筛选都要能从 URL 直接落到编辑器的对应状态。
  assert.match(delivery, /\?preview=1/);
  assert.match(editor, /searchParams\.get\("preview"\) === "1"/);
  assert.match(editor, /searchParams\.get\("filter"\) === "issues"/);
});

test("FR-07 translation has one home: a reachable stage with affirmative paid consent", () => {
  const app = read("src/frontend/App.tsx");
  const nav = read("src/frontend/ProjectWorkspaceNav.tsx");
  const shell = read("src/frontend/ProjectWorkspace.tsx");
  const translate = read("src/frontend/TranslatePage.tsx");
  const settings = read("src/frontend/ProjectSettingsPage.tsx");

  // 阶段导轨第三格必须有真实目的地，不能再是一个只说"在导入阶段发起"的死格子。
  assert.match(app, /path="translate"\s+element=\{<TranslatePage\/>\}/);
  assert.match(nav, /id: "translate", label: "翻译", path:/);
  assert.doesNotMatch(nav, /在导入阶段发起/);
  assert.match(shell, /\\\/translate\$.*return "translate"/);

  // 费用在点击之前必须可见，但不再多加一道勾选：自动/半自动在创建项目那一屏选过，
  // 费用也在"开始处理"的对话框里确认过，这里点按钮本身就是那一次确认。
  assert.match(translate, /translate-cost-note/);
  assert.match(translate, /可能产生费用/);
  assert.doesNotMatch(translate, /paid-consent/, "the translate stage must not add a third consent checkbox");
  assert.match(translate, /workspace\.startProject\(project\.id\)/);
  assert.doesNotMatch(translate, /production-dialog/);
  // 任务在跑的时候主按钮只剩"停止"，不给第二个入口重复发起。
  assert.match(translate, /\{running[\s\S]{0,240}?停止当前任务/);
  assert.match(translate, /: <button[\s\S]{0,240}?开始翻译/);

  // 翻译方案只有一份实现，翻译阶段复用它；设置页不许再摆第二份。
  const plan = read("src/frontend/TranslationPlanFields.tsx");
  const overview = read("src/frontend/ProjectPage.tsx");
  for (const control of ["<span>Provider</span>", "<span>模型</span>", "<span>术语表</span>", "<span>风格指南</span>", "target-language-fieldset"]) {
    const pattern = new RegExp(control.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"));
    assert.match(plan, pattern);
    for (const [label, source] of [["settings", settings], ["translate", translate], ["overview", overview]]) {
      assert.doesNotMatch(source, pattern, `${label} must reuse TranslationPlanFields instead of duplicating ${control}`);
    }
  }
  assert.match(translate, /<TranslationPlanFields project=\{project\}/);

  // 自动/半自动只在创建项目那一屏问一次，之后流程是线性的。
  const context = read("src/state/WorkspaceContext.tsx");
  const importPage = read("src/frontend/ImportPage.tsx");
  assert.match(importPage, /auto-translate-choice/, "the create-project screen owns the automatic/manual choice");
  assert.match(importPage, /updateProjectConfig\(projectId, \{ autoTranslate: true \}\)/);
  assert.match(context, /project\.config\.autoTranslate !== true/, "the pipeline must honour the choice made at creation");
  assert.match(overview, /Provider 请求可能产生费用/);

  // 半自动停下来之后不再弹独立闸口块，"下一步"直接指向翻译阶段——多一道确认会把
  // 全自动流程截断在半路，而独立闸口块又会让半自动变成两处确认。
  assert.doesNotMatch(overview, /translation-gate/);
  assert.doesNotMatch(overview, /translationConsented/);
  // 主按钮位置和全自动完全一样，只是文案变成"开始翻译"，点一下就原地继续跑：
  // 既不另开一个框，也不把人挪到别的页面。
  assert.match(overview, /awaiting_translation" \? "开始翻译"/);
  assert.match(overview, /awaiting_translation"\) return void runWorkflow\(false, true\)/);
  assert.match(context, /options\.startTranslationNow !== true/);
  // 项目级开关只有一处：创建那一屏。翻译阶段不再摆第二个。
  assert.doesNotMatch(translate, /auto-translate-switch|autoTranslate: event\.target\.checked/);
});

test("G-batch: broken states offer a way out instead of only reporting themselves", () => {
  const app = read("src/frontend/App.tsx");
  const project = read("src/frontend/ProjectPage.tsx");
  const workspace = read("src/frontend/WorkspacePage.tsx");
  const capabilities = read("src/frontend/CapabilitiesPage.tsx");
  const errors = read("src/i18n/errors.ts");

  // 报了故障就必须能就地去修：侧栏状态与项目页都要有真出口。
  assert.match(app, /sidebar-status is-actionable/);
  assert.match(app, /repairPath\(blocking\[0\]\.repairAction\)/);
  assert.match(project, /capability-gate/);
  assert.match(project, /repairPath\(blocker\.repairAction\)/);

  // 通用码兜底不得把后端原文只塞进 debug——那是"该功能当前不可用"的成因。
  assert.match(errors, /detail: generic\.detail \?\? \(message \|\| undefined\)/);
  assert.match(errors, /A required ASR component is not installed/);

  // 任务历史可清理，且必须过确认框；只删终态。
  assert.match(workspace, /purgeFinishedTasks/);
  assert.match(workspace, /purge-tasks/);
  assert.match(workspace, /task-history-bar/);
  const barAt = workspace.indexOf("task-history-bar");
  const listAt = workspace.indexOf("task-history-scroll");
  assert.ok(barAt >= 0 && listAt > barAt, `purge and paging must sit above the list: ${barAt} / ${listAt}`);
  assert.match(workspace, /LIVE_TASKS\.has\(task\.status\)/);

  // 核心运行时不再用开发者黑话，也不摆一个点了没反应的下载按钮。
  assert.match(capabilities, /function coreRuntimeNote/);
  // 断在渲染出来的文字上，不是整份源码——注释里提一句不该让断言假失败。
  assert.doesNotMatch(capabilities, /<p>核心 CPU 运行时由应用受信清单管理/);
  assert.match(capabilities, /runtime\?\.bundled/);
});

test("H1: the workbench and the projects page read one live source", () => {
  const workbench = readCode("src/frontend/pages.tsx");
  // 主页此前读挂载时拉一次的索引缓存，项目页读活列表，于是删掉的项目还留在主页上。
  assert.match(workbench, /workspace\.projects\]\s*\n?\s*\.filter\(\(project\) => !project\.trashedAt/);
  assert.doesNotMatch(workbench, /app\.projects\.data/);
  assert.doesNotMatch(workbench, /app\.projects\.loading|app\.projects\.error/);
  assert.doesNotMatch(workbench, /latestRunSummary/);
});
