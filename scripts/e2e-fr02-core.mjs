import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(rootDir, "tests", "fixtures", "subtitles", "valid", "basic-utf8.srt");
const userDataDir = mkdtempSync(join(tmpdir(), "fr02-core-"));
const exportDir = join(userDataDir, "exports");
const screenshotDir = process.env.FR02_E2E_SCREENSHOT_DIR
  ? resolve(process.env.FR02_E2E_SCREENSHOT_DIR)
  : null;
mkdirSync(exportDir, { recursive: true });
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

let app;

async function capture(page, name) {
  if (!screenshotDir) return;
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    }, { width, height });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(screenshotDir, `${name}-${width}x${height}.png`) });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
}

async function configureLocalFakeProvider(page) {
  const seeded = await page.evaluate(async () => {
    const credential = await window.desktop.saveCredential({
      credentialId: "openai-default",
      providerId: "openai",
      label: "FR-02 local fake provider",
      secret: "sk-fr02-local-fixture-not-real",
    });
    if (!credential.ok) return { credential };
    const tested = await window.desktop.testProviderConnection({
      provider: "OpenAI",
      credentialId: "openai-default",
      model: "GPT-4.1",
    });
    if (!tested.ok) return { credential, tested };
    const current = await window.desktop.getAppSettings();
    if (!current.ok) return { credential, tested, current };
    const saved = await window.desktop.saveAppSettings({
      settings: {
        ...current.data,
        translationProvider: "OpenAI",
        translationModel: "GPT-4.1",
      },
    });
    return { credential, tested, current, saved };
  });
  assert.equal(seeded.credential.ok, true, JSON.stringify(seeded));
  assert.equal(seeded.tested?.ok, true, JSON.stringify(seeded));
  assert.equal(seeded.saved?.ok, true, JSON.stringify(seeded));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
}

async function pollProject(page, projectId) {
  let opened;
  await expect.poll(async () => {
    opened = await page.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
    if (!opened.ok) return false;
    const source = opened.data.sourceTracks.find((track) => track.id === opened.data.activeSourceTrackId);
    const targets = source?.targetTracks.filter((track) => track.isActive) ?? [];
    return Boolean(source?.segments.length)
      && targets.length > 0
      && source.segments.every((segment) => targets.every((target) => {
        const text = segment.targetTexts[target.languageCode];
        return Boolean(text?.manual ?? text?.postProcessed ?? text?.model);
      }));
  }, { timeout: 60_000, intervals: [100, 250, 500] }).toBe(true);
  return opened.data;
}

try {
  assert.equal(existsSync(fixturePath), true, `missing fixture: ${fixturePath}`);
  app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      TRANSLATION_FAKE_PROVIDER: "1",
      SUBTITLE_E2E_EXPORT_DIR: exportDir,
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));

  const isolation = await page.evaluate(() => ({
    processType: typeof window.process,
    requireType: typeof window.require,
    desktopType: typeof window.desktop,
  }));
  assert.deepEqual(isolation, { processType: "undefined", requireType: "undefined", desktopType: "object" });

  await configureLocalFakeProvider(page);
  await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor();
  await capture(page, "workbench-empty");

  await page.getByRole("button", { name: "选择文件" }).click();
  await page.getByRole("heading", { name: "先选择一个素材" }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await page.getByRole("heading", { name: "确认真实翻译方案" }).waitFor({ timeout: 30_000 });
  await page.locator(".production-choice-fields label").filter({ hasText: "原始语言" }).locator("select").selectOption({ label: "英语" });
  await expect(page.locator(".production-choice-fields label").filter({ hasText: "Provider" }).locator("select")).toHaveValue("OpenAI");
  await expect(page.locator(".production-choice-fields label").filter({ hasText: "模型" }).locator("select")).toHaveValue("GPT-4.1");
  await capture(page, "import-plan");
  await page.getByRole("button", { name: "确认方案" }).click();
  await page.getByRole("heading", { name: "项目可以创建了" }).waitFor();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  // 自动/半自动只在这一屏问一次。默认是手动确认翻译；这条用例走全自动，所以勾上它。
  const autoChoice = page.locator(".auto-translate-choice input[type=checkbox]");
  await expect(autoChoice).not.toBeChecked();
  await autoChoice.check();
  await page.getByRole("button", { name: /创建项目并进入工作区/ }).click();
  try {
    await page.locator('[data-fr02-view="project"]').waitFor({ timeout: 30_000 });
  } catch (error) {
    console.error("FR-02 create project page:", (await page.locator("body").innerText()).slice(-4_000));
    throw error;
  }
  assert.equal(await page.evaluate(() => window.scrollY), 0, "a route change must reset the inherited import scroll position");

  const projectId = await page.evaluate(() => window.location.hash.split("/")[2]);
  assert.ok(projectId, "project route must expose the persisted project id");
  const created = await page.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
  assert.equal(created.ok, true);
  assert.equal(created.data.noSourceMedia, true);
  assert.equal(created.data.config.provider, "OpenAI");
  assert.equal(created.data.config.model, "GPT-4.1");
  assert.equal("budgetUsd" in created.data.config, false);

  await page.locator(".next-action .btn-primary").click();
  const paidDialog = page.getByRole("dialog", { name: "确认开始真实处理" });
  await paidDialog.waitFor();
  await expect(paidDialog).toContainText("Provider 请求可能产生费用");
  await paidDialog.getByRole("button", { name: "确认并开始" }).click();

  // 创建时选了全自动，所以流水线一路跑到译完，中间不再停下来问第二次。
  const translated = await pollProject(page, projectId);
  const runtime = await page.evaluate((id) => window.desktop.getProjectRuntimeState({ projectId: id }), projectId);
  assert.equal(runtime.ok, true);
  assert.ok(runtime.data.tasks.some((task) => task.status === "completed" && task.stage === "translate"));
  assert.ok(runtime.data.runSnapshots.length >= 1);
  await page.getByRole("button", { name: "进入字幕编辑与校对" }).waitFor({ timeout: 30_000 });
  assert.equal(translated.lifecycle, "needs_review");
  await capture(page, "project-translated");

  // 翻译阶段读的是真实译文进度，而不是自己另存一份状态。
  await page.getByRole("button", { name: /^翻译 ·/ }).click();
  await page.locator('[data-fr02-view="translate"]').waitFor();
  await expect(page.locator(".translate-target-panel").getByText(/2 \/ 2 段有译文/)).toBeVisible();
  // 费用只确认一次（创建那一屏的开关 + "开始处理"的对话框），这里不再摆第三道勾选；
  // 但费用必须在点击之前就写在按钮旁边。
  await expect(page.locator(".paid-consent")).toHaveCount(0);
  await expect(page.locator(".translate-cost-note")).toContainText("可能产生费用");
  await expect(page.getByRole("button", { name: /开始翻译/ })).toBeEnabled();
  await capture(page, "translate-stage");

  // 批准前也必须看得见交付去处并写明原因：批准不可逆，不该在信息更少的时候做。
  await page.getByRole("button", { name: /^交付 ·/ }).click();
  await page.locator('[data-fr02-view="deliver"]').waitFor();
  const pendingOptions = page.locator(".delivery-options button");
  assert.equal(await pendingOptions.count(), 4, "export destinations must stay visible before approval");
  await expect(pendingOptions.nth(0)).toBeDisabled();
  await expect(pendingOptions.nth(0)).toContainText("需先批准当前字幕轨");
  // 打包项目不依赖批准，所以它必须仍然可点——否则"常显"就只是把所有按钮一起变灰。
  await expect(page.getByRole("button", { name: /打包项目/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: "明确批准当前字幕轨" })).toBeVisible();
  // "常显"要当真：批准按钮和第一个交付去处必须同屏，否则用户还是在信息更少时按下不可逆的批准。
  const approvalAndDestination = await page.evaluate(() => {
    const approve = [...document.querySelectorAll(".preflight-actions .btn-primary")][0];
    const destination = document.querySelector(".delivery-options button");
    return {
      approveBottom: approve?.getBoundingClientRect().bottom ?? -1,
      destinationTop: destination?.getBoundingClientRect().top ?? -1,
      destinationBottom: destination?.getBoundingClientRect().bottom ?? -1,
      viewportHeight: innerHeight,
    };
  });
  assert.ok(
    approvalAndDestination.approveBottom > 0
      && approvalAndDestination.destinationBottom <= approvalAndDestination.viewportHeight,
    JSON.stringify(approvalAndDestination),
  );
  await capture(page, "delivery-pending");

  await page.getByRole("button", { name: /^导入 ·/ }).click();
  await page.locator('[data-fr02-view="project"]').waitFor();

  await page.getByRole("button", { name: "进入字幕编辑与校对" }).click();
  await page.locator('[data-fr02-view="editor"]').waitFor();
  const rows = page.locator(".segment-row");
  assert.equal(await rows.count(), 2);
  const targetEditor = page.getByLabel("译文");

  await rows.nth(0).click();
  await targetEditor.fill("FR-02 人工校对稿");
  await expect(page.getByRole("button", { name: /撤销/ })).toBeEnabled();
  await page.getByRole("button", { name: /撤销/ }).click();
  await expect(targetEditor).not.toHaveValue("FR-02 人工校对稿");
  await page.getByRole("button", { name: /重做/ }).click();
  await expect(targetEditor).toHaveValue("FR-02 人工校对稿");

  await page.locator("details.editor-search summary").click();
  await page.getByLabel("查找").fill("人工校对稿");
  await page.getByLabel("替换为").fill("已校对字幕");
  await page.getByRole("button", { name: "替换全部" }).click();
  await expect(targetEditor).toHaveValue("FR-02 已校对字幕");
  await page.getByRole("button", { name: "锁定" }).click();
  await expect(page.getByRole("button", { name: "已锁定" })).toBeVisible();
  await expect(targetEditor).toBeDisabled();

  await rows.nth(1).click();
  // 按光标拆分：split_text 一直在 domain 里，但此前没有任何界面入口，长字幕切不开。
  await targetEditor.fill("FR-02 前半句，FR-02 后半句");
  await targetEditor.evaluate((element) => element.setSelectionRange(10, 10));
  await page.getByRole("button", { name: "按光标拆分" }).click();
  await expect(rows).toHaveCount(3);
  // 拆完必须停在左半段，而不是被弹回列表第一段。
  await expect(targetEditor).toHaveValue("FR-02 前半句");
  await rows.nth(2).click();
  await expect(targetEditor).toHaveValue("FR-02 后半句");
  await expect(page.locator(".segment-edit-card time")).not.toHaveText(/00:00:04,000 → 00:00:06,500/);
  await page.getByRole("button", { name: /撤销/ }).click();
  await expect(rows).toHaveCount(2);

  // ── 键位预设与焦点规则 ────────────────────────────────────────────
  // 第一段此前被锁定，译文框是禁用的，所以焦点规则要在可编辑的第二段上验。
  await rows.nth(1).click();
  await targetEditor.fill("FR-02 焦点规则");
  await targetEditor.focus();
  // 单字母键在译文框里必须让位给打字，否则连 J 都输不进去，参考栏也会被 I 误关。
  await page.keyboard.type("JKI");
  await expect(targetEditor).toHaveValue("FR-02 焦点规则JKI");
  await expect(page.locator(".editor-reference")).toBeVisible();

  // 焦点离开输入框后，同样的键才是命令。
  await page.locator(".segment-column").click({ position: { x: 10, y: 4 } });
  await page.keyboard.press("KeyI");
  await expect(page.locator(".editor-reference")).toBeHidden();
  await page.keyboard.press("KeyI");
  await expect(page.locator(".editor-reference")).toBeVisible();
  await page.keyboard.press("KeyF");
  await expect(page.locator(".editor-columns.is-focus-mode")).toHaveCount(1);
  await expect(page.locator(".segment-column")).toBeHidden();
  await page.keyboard.press("KeyF");
  await expect(page.locator(".editor-columns.is-focus-mode")).toHaveCount(0);

  // 换成剪辑师流后 J/K 不再是上下一段（那里它们是穿梭），↑/↓ 才是。
  await page.keyboard.press("?");
  await page.locator(".shortcuts-panel").waitFor();
  await page.getByRole("radio", { name: /剪辑师流/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".shortcuts-panel")).toHaveCount(0);
  await page.locator(".segment-column").click({ position: { x: 10, y: 4 } });
  await rows.nth(0).click();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveClass(/is-current|is-active|is-selected/);
  // 预设与主题同机制持久化到 localStorage；这里不重载页面，重载会丢掉尚未落盘的译文。
  assert.equal(await page.evaluate(() => localStorage.getItem("ai_translator_keymap")), "nle");
  await page.keyboard.press("?");
  await expect(page.getByRole("radio", { name: /剪辑师流/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("radio", { name: /现代效率流/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".shortcuts-panel")).toHaveCount(0);

  await rows.nth(1).click();
  await targetEditor.fill("FR-02 第二段人工译文");
  await page.getByRole("tab", { name: "时间轴" }).click();
  await page.getByRole("button", { name: "终点 +100" }).click();
  await page.getByRole("button", { name: "刷新 QA" }).click();
  await expect(page.getByRole("button", { name: "批准并前往交付" })).toBeEnabled();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
  await expect(targetEditor).toBeVisible();
  // 等侧栏收起过渡（240ms）结束后再测量布局
  await page.waitForTimeout(400);
  const compactEditorBounds = await targetEditor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: innerWidth };
  });
  assert.ok(compactEditorBounds.left >= 0 && compactEditorBounds.right <= compactEditorBounds.viewport + 1, JSON.stringify(compactEditorBounds));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await page.waitForTimeout(400);
  const wideLayoutBounds = await page.locator(".editor-columns").evaluate((element) => {
    const media = element.querySelector(".qa-media").getBoundingClientRect();
    const list = element.querySelector(".segment-column").getBoundingClientRect();
    const card = element.querySelector(".segment-edit-card")?.getBoundingClientRect();
    return { mediaLeft: media.left, mediaRight: media.right, listLeft: list.left, listRight: list.right, cardRight: card?.right ?? 0, viewport: innerWidth };
  });
  assert.ok(wideLayoutBounds.mediaLeft >= 0 && wideLayoutBounds.mediaRight <= wideLayoutBounds.viewport + 1, JSON.stringify(wideLayoutBounds));
  assert.ok(wideLayoutBounds.listLeft >= 0 && wideLayoutBounds.listRight <= wideLayoutBounds.viewport + 1, JSON.stringify(wideLayoutBounds));
  assert.ok(wideLayoutBounds.cardRight > 0 && wideLayoutBounds.cardRight <= wideLayoutBounds.viewport + 1, JSON.stringify(wideLayoutBounds));

  // 编辑器整体不得越过视口。这条必须查所有元素而不只是控件，也不能依赖
  // document.scrollWidth —— body 的 overflow-x:hidden 会把溢出静默裁掉，
  // 表现为右侧内容被切断却没有任何滚动条。宽窗口尤其要查：限宽外壳里套一个
  // 按 100vw 算宽度的子元素时，溢出量会随窗口变宽而变大。
  for (const [width, height] of [[1920, 1080], [1600, 900], [1440, 900], [1280, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    }, { width, height });
    await page.waitForTimeout(300);
    const escaped = await page.evaluate(() => [...document.querySelectorAll(".app-shell *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      })
      .slice(0, 5)
      .map((element) => `${element.tagName}.${String(element.className).slice(0, 40)}@${Math.round(element.getBoundingClientRect().right)}/${innerWidth}`));
    assert.deepEqual(escaped, [], `editor overflows viewport at ${width}x${height}`);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await page.waitForTimeout(300);

  // 收起参考栏必须真的把它移出栅格。类选择器的 display 会盖掉浏览器默认的
  // [hidden]{display:none}，那样参考栏还占着轨道，而收起态只声明三条轨道，
  // 结果段列表被挤进 6px 的分隔条轨道、编辑区掉到第二行，整个布局塌掉。
  // 用"栅格只有一行"来锁这件事——塌掉时它会变成 2。
  const gridRowCount = () => page.locator(".editor-columns").evaluate((element) => new Set(
    [...element.children]
      .filter((child) => child.getBoundingClientRect().height > 0)
      .map((child) => Math.round(child.getBoundingClientRect().top)),
  ).size);
  const referenceToggle = page.getByRole("button", { name: "参考栏" });
  const expandedEditor = await page.locator(".segment-editor").evaluate((element) => element.getBoundingClientRect().width);
  assert.equal(await gridRowCount(), 1, "editor columns must stay on one grid row while expanded");
  await referenceToggle.click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".editor-reference").isVisible(), false, "collapsing the reference column must remove it from layout");
  assert.equal(await gridRowCount(), 1, "collapsed editor columns must stay on one grid row");
  const collapsedEditor = await page.locator(".segment-editor").evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(collapsedEditor > expandedEditor + 100, `collapsing must widen the editor: ${expandedEditor} -> ${collapsedEditor}`);
  await referenceToggle.click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".editor-reference").isVisible(), true, "reference column must come back");
  assert.equal(await gridRowCount(), 1, "restored editor columns must stay on one grid row");

  await capture(page, "editor-reviewed");
  await page.getByRole("button", { name: "批准并前往交付" }).click();

  await page.locator('[data-fr02-view="deliver"]').waitFor();
  await expect(page.getByText("已批准，可导出", { exact: true })).toBeVisible();
  await capture(page, "delivery-approved");
  await page.getByRole("button", { name: /导出字幕文件/ }).click();
  await page.getByText(/已导出 .*\.srt/).waitFor({ timeout: 30_000 });

  const exportedFiles = readdirSync(exportDir).filter((name) => name.toLowerCase().endsWith(".srt"));
  assert.equal(exportedFiles.length, 1, JSON.stringify(exportedFiles));
  const exportedText = readFileSync(join(exportDir, exportedFiles[0]), "utf8");
  assert.match(exportedText, /FR-02 已校对字幕/);
  assert.match(exportedText, /FR-02 第二段人工译文/);

  const completed = await page.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
  assert.equal(completed.ok, true);
  const source = completed.data.sourceTracks.find((track) => track.id === completed.data.activeSourceTrackId);
  const target = source.targetTracks.find((track) => track.isActive && track.languageCode === "简体中文");
  assert.equal(target.status, "exported");
  assert.equal(source.segments[0].targetTexts["简体中文"].manual, "FR-02 已校对字幕");
  assert.equal(source.segments[0].targetTexts["简体中文"].locked, true);
  assert.equal(source.segments[1].targetTexts["简体中文"].manual, "FR-02 第二段人工译文");
  assert.ok(existsSync(join(userDataDir, "projects", projectId, "project.sqlite")));

  console.log(`FR-02 core E2E passed: ${projectId} -> ${exportedFiles[0]}`);
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
