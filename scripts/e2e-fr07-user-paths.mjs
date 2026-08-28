import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const userDataDir = mkdtempSync(join(tmpdir(), "fr07-user-paths-"));
const fixturePath = join(userDataDir, "fr07-drop.wav");
const screenshotDir = process.env.FR07_E2E_SCREENSHOT_DIR
  ? resolve(process.env.FR07_E2E_SCREENSHOT_DIR)
  : null;
const themes = [
  { id: "brass", code: "A" },
  { id: "ticket", code: "B" },
  { id: "proof", code: "C" },
  { id: "fold", code: "D" },
  { id: "strata", code: "E" },
  { id: "signal", code: "F" },
  { id: "celadon", code: "G" },
  { id: "relay", code: "H" },
  { id: "inkwhite", code: "I" },
];

function createWaveFixture(path) {
  const sampleRate = 16_000;
  const sampleCount = sampleRate / 2;
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 2_400);
    buffer.writeInt16LE(value, 44 + index * bytesPerSample);
  }
  writeFileSync(path, buffer);
}

createWaveFixture(fixturePath);
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

let app;
let scaledApp;

async function setWindowBounds(targetApp, bounds) {
  return targetApp.evaluate(({ BrowserWindow, screen }, nextBounds) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("BrowserWindow not found");
    win.unmaximize();
    const area = screen.getPrimaryDisplay().workArea;
    const bounded = {
      x: Math.max(area.x + 20, Math.min(nextBounds.x, area.x + area.width - nextBounds.width - 20)),
      y: Math.max(area.y + 20, Math.min(nextBounds.y, area.y + area.height - nextBounds.height - 20)),
      width: nextBounds.width,
      height: nextBounds.height,
    };
    win.setBounds(bounded);
    win.show();
    win.focus();
    return win.getBounds();
  }, bounds);
}

async function setWindowSize(targetApp, width, height) {
  await targetApp.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
}

async function getWindowBounds(targetApp) {
  return targetApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds());
}

async function go(page, path, heading) {
  await page.evaluate((next) => { window.location.hash = next; }, path);
  if (heading) await page.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 30_000 });
}

// 视口级的溢出检查看不见"文字撑破自己的格子"这一类：元素还在视口里，
// 但内容宽于容器，于是压到隔壁卡片上。这里按元素自身的 scrollWidth 查。
async function assertNoTextOverflow(page, selector, label) {
  const overflowing = await page.evaluate((root) => [...document.querySelectorAll(`${root} *`)]
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (getComputedStyle(element).overflow !== "visible") return false;
      return element.scrollWidth > element.clientWidth + 1;
    })
    .slice(0, 5)
    .map((element) => `${element.tagName}.${String(element.className).slice(0, 30)}:${element.scrollWidth}>${element.clientWidth}`), selector);
  assert.deepEqual(overflowing, [], `${label}: text overflows its own box`);
}

async function assertNoHorizontalEscape(page, label) {
  const metrics = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button, input, select, textarea, a")]
      .filter((element) => {
        if (element.id === "fr07-native-drop-source") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      escaped: controls.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).map((element) => element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 80) || element.tagName),
    };
  });
  assert.ok(metrics.documentWidth <= metrics.viewport + 1, JSON.stringify({ label, metrics }));
  assert.deepEqual(metrics.escaped, [], JSON.stringify({ label, metrics }));
}

async function installDragFile(page) {
  await page.evaluate(() => {
    let input = document.querySelector("#fr07-native-drop-source");
    if (!input) {
      input = document.createElement("input");
      input.id = "fr07-native-drop-source";
      input.type = "file";
      input.tabIndex = -1;
      input.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0";
      document.body.append(input);
    }
  });
  await page.locator("#fr07-native-drop-source").setInputFiles(fixturePath);
}

async function beginFileDrag(page) {
  await installDragFile(page);
  await page.evaluate(() => {
    const input = document.querySelector("#fr07-native-drop-source");
    const file = input?.files?.[0];
    const shell = document.querySelector(".app-shell");
    if (!file || !shell) throw new Error("FR-07 drag source is not ready");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    window.__fr07DataTransfer = dataTransfer;
    shell.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
    shell.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(page.locator(".app-shell")).toHaveClass(/is-drag-over/);
  await expect(page.locator(".native-drop-overlay")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator(".native-drop-overlay")).toHaveCSS("opacity", "1");
}

async function leaveFileDrag(page) {
  await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const dataTransfer = window.__fr07DataTransfer;
    if (shell && dataTransfer) shell.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer }));
    delete window.__fr07DataTransfer;
  });
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-drag-over/);
  await expect(page.locator(".native-drop-overlay")).toHaveCSS("opacity", "0");
}

async function dropInstalledFile(page) {
  await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const dataTransfer = window.__fr07DataTransfer;
    if (!shell || !dataTransfer) throw new Error("FR-07 drop state is not ready");
    shell.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    delete window.__fr07DataTransfer;
  });
}

async function installAudioProbe(page) {
  return page.evaluate(() => {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return false;
    window.__fr07AudioCount = 0;
    const prototype = AudioCtor.prototype;
    const createOscillator = prototype.createOscillator;
    const createBufferSource = prototype.createBufferSource;
    prototype.createOscillator = function (...args) {
      window.__fr07AudioCount += 1;
      return createOscillator.apply(this, args);
    };
    prototype.createBufferSource = function (...args) {
      window.__fr07AudioCount += 1;
      return createBufferSource.apply(this, args);
    };
    return true;
  });
}

async function setThemeDirectly(page, themeId) {
  await page.evaluate((id) => localStorage.setItem("ai_translator_theme", id), themeId);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", themeId);
}

async function capture(page, theme, view, width, height) {
  if (!screenshotDir) return;
  const directory = join(screenshotDir, `${theme.code}-${theme.id}`);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${view}-${width}x${height}.png`) });
}

async function validateWindowDragRegions(page) {
  const initial = await setWindowBounds(app, { x: 120, y: 100, width: 1280, height: 720 });
  const title = page.locator(".production-route-title");
  const titleBox = await title.boundingBox();
  assert.ok(titleBox, "route title must expose a drag surface");
  const dragRegions = await page.evaluate(() => {
    const topbar = document.querySelector(".topbar");
    const spacer = document.querySelector(".topbar-spacer");
    const main = document.querySelector(".main");
    const sidebar = document.querySelector(".sidebar");
    return {
      topbar: getComputedStyle(topbar).getPropertyValue("-webkit-app-region"),
      spacer: getComputedStyle(spacer).getPropertyValue("-webkit-app-region"),
      main: getComputedStyle(main).getPropertyValue("-webkit-app-region"),
      sidebar: getComputedStyle(sidebar).getPropertyValue("-webkit-app-region"),
    };
  });
  assert.deepEqual(dragRegions, { topbar: "drag", spacer: "drag", main: "none", sidebar: "none" });
  const spacerBox = await page.locator(".topbar-spacer").boundingBox();
  assert.ok(spacerBox, "topbar spacer must expose a drag surface");
  const windowState = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { focused: win?.isFocused(), movable: win?.isMovable(), maximized: win?.isMaximized(), bounds: win?.getBounds(), contentBounds: win?.getContentBounds() };
  });
  assert.equal(windowState.movable, true);
  await setWindowBounds(app, { x: initial.x + 110, y: initial.y + 70, width: 1280, height: 720 });
  const moved = await getWindowBounds(app);
  assert.ok(moved.x !== initial.x || moved.y !== initial.y, JSON.stringify({ initial, moved, windowState }));
  assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ""), "", "window dragging must not create a text selection");

  const themeTrigger = page.locator(".theme-trigger");
  const triggerBox = await themeTrigger.boundingBox();
  assert.ok(triggerBox, "theme trigger must remain interactive");
  assert.equal(await themeTrigger.evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region")), "no-drag");
  await themeTrigger.click();
  await expect(page.locator(".theme-menu")).toBeVisible();
  await page.keyboard.press("Escape");
}

async function validateThemeMatrix(page, projectId) {
  for (const theme of themes) {
    await go(page, "/", "今天想翻译什么？");
    await setThemeDirectly(page, theme.id);
    await page.getByRole("heading", { name: "今天想翻译什么？", exact: true }).waitFor();
    for (const [width, height] of [[1440, 900], [1280, 720]]) {
      await setWindowSize(app, width, height);
      await page.evaluate(() => window.scrollTo(0, 0));
      await beginFileDrag(page);
      await expect(page.getByRole("heading", { name: "释放文件以快速导入", exact: true })).toBeVisible();
      await assertNoHorizontalEscape(page, `${theme.id}-drop-${width}x${height}`);
      await capture(page, theme, "drop-overlay", width, height);
      await leaveFileDrag(page);

      // 项目阶段的溢出检查必须每次都跑：以前它藏在截图开关里，等于在常规运行中失效。
      for (const [path, heading, name] of [
        ["", "fr07-drop", "project-workspace"],
        ["/media", "转写", "media-tasks"],
        ["/translate", "翻译", "translate-stage"],
      ]) {
        await go(page, `/projects/${projectId}${path}`, heading);
        await assertNoHorizontalEscape(page, `${theme.id}-${name}-${width}x${height}`);
        await capture(page, theme, name, width, height);
      }
      await go(page, "/", "今天想翻译什么？");
    }
  }
  await setWindowSize(app, 1440, 900);
}

try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.getByRole("heading", { name: "今天想翻译什么？", exact: true }).waitFor();

  await validateWindowDragRegions(page);
  assert.equal(await installAudioProbe(page), true, "Web Audio must be available in Electron");
  await expect(page.locator(".sound-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.locator(".sound-toggle").click();
  await page.waitForTimeout(80);
  const audioBeforeDrag = await page.evaluate(() => window.__fr07AudioCount);
  await beginFileDrag(page);
  await page.waitForTimeout(80);
  assert.ok(await page.evaluate(() => window.__fr07AudioCount) > audioBeforeDrag, "one drag session must play one enabled feedback sound");
  await leaveFileDrag(page);

  await page.locator(".theme-trigger").click();
  await page.locator(".theme-preference").filter({ hasText: "减少动态" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
  await page.keyboard.press("Escape");
  await beginFileDrag(page);
  assert.equal(await page.locator(".drop-modal-box").evaluate((element) => getComputedStyle(element).animationName), "none");
  await leaveFileDrag(page);
  await page.locator(".theme-trigger").click();
  await page.locator(".theme-preference").filter({ hasText: "减少动态" }).click();
  await page.keyboard.press("Escape");

  await beginFileDrag(page);
  await dropInstalledFile(page);
  await page.getByRole("heading", { name: "确认真实翻译方案", exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await page.evaluate(() => history.state?.usr?.droppedFiles ?? null), null, "route File state must be consumed exactly once");
  await expect(page.getByText("fr07-drop.wav", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "确认方案" }).click();
  await page.getByRole("heading", { name: "项目可以创建了", exact: true }).waitFor();
  await page.getByRole("button", { name: /创建项目并进入工作区/ }).click();
  await page.locator('[data-fr02-view="project"]').waitFor({ timeout: 30_000 });
  const projectId = await page.evaluate(() => window.location.hash.split("/")[2]);
  assert.ok(projectId, "drop-created project must expose a project id");

  // 阶段导轨是唯一一条项目导航：五个用户任务名，且概览不再重复出现第二条导轨或并列任务入口。
  await expect(page.locator(".project-title-actions")).toHaveCount(0);
  await expect(page.locator(".project-stage-rail")).toHaveCount(1);
  await expect(page.locator(".project-task-shortcuts")).toHaveCount(0);
  for (const stage of ["导入", "转写", "翻译", "校对", "交付"]) {
    await expect(page.locator(".project-stage-rail").getByText(stage, { exact: true })).toBeVisible();
  }
  // 概览用真实状态说明素材事实，而不是三个指向同一目标的假按钮。
  await expect(page.locator(".inspector-panel").getByText("未检测到", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^转写 ·/ }).click();
  await page.getByRole("heading", { name: "转写", exact: true }).waitFor();
  // 转字幕不再是一条指向别处的入口卡，它就是这个阶段的主操作；识别/分段/启用串在一次
  // 转写里，三个原按钮退到"分步执行"。提取音频与提取内嵌字幕落在媒体流的各自轨道上。
  await expect(page.locator(".media-task-rail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /开始转写/ })).toBeVisible();
  await expect(page.locator(".asr-manual-steps")).toBeVisible();
  await expect(page.locator(".stream-ledger").getByRole("button", { name: "提取音频" })).toBeVisible();
  await expect(page.getByText("未检测到内嵌字幕", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/音频分离/)).toHaveCount(0);
  await setWindowSize(app, 1280, 720);
  // 主操作必须在 1280×720 的首屏内，不能要求先滚动才能开始转写。
  const firstScreen = await page.getByRole("button", { name: /开始转写/ }).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
  });
  assert.ok(firstScreen.top >= 0 && firstScreen.bottom <= firstScreen.viewportHeight, JSON.stringify(firstScreen));
  await assertNoHorizontalEscape(page, "media-1280x720");

  // 翻译此前没有独立位置，只能靠概览的"开始处理"或编辑器里的按钮触发。现在它是导轨第三格。
  await page.getByRole("button", { name: /^翻译 ·/ }).click();
  await page.getByRole("heading", { name: "翻译", exact: true }).waitFor();
  await expect(page.locator(".translate-plan-grid").getByLabel("Provider")).toBeVisible();
  await expect(page.locator(".translate-plan-grid").getByLabel("术语表")).toBeVisible();
  await expect(page.getByRole("group", { name: "目标语言" })).toBeVisible();
  // 这个项目还没有源字幕，所以主操作必须给出理由，而不是只把按钮变灰。
  await expect(page.getByRole("button", { name: /开始翻译/ })).toBeDisabled();
  await expect(page.getByText(/还没有源字幕可译/)).toBeVisible();
  await assertNoHorizontalEscape(page, "translate-1280x720");

  const readiness = await page.evaluate(() => window.desktop.getCapabilityReadiness());
  assert.equal(readiness.ok, true, JSON.stringify(readiness));
  assert.deepEqual(readiness.data.global.capabilities.map((item) => item.id), ["translation", "asr", "subtitle_export", "video_export"]);
  const shellText = await page.locator(".app-shell").innerText();
  assert.doesNotMatch(shellText, /\d+\/\d+\s*项能力可用|音频分离服务未安装|项核心能力需处理/);

  // 能力按"什么时候需要它"分层：这个项目是 wav，语音识别属于"现在需要"；
  // 换成纯字幕项目时它必须退回"按需启用"，侧栏也不再报警。
  await go(page, "/system", "系统");
  await expect(page.locator('[aria-label="现在需要"] .system-glyph')).toHaveCount(2);
  await expect(page.locator('[aria-label="现在需要"]').getByText(/语音识别/).first()).toBeVisible();
  await expect(page.locator('[aria-label="按需启用"]').getByText(/字幕导出/).first()).toBeVisible();
  await expect(page.getByText("只在处理没有字幕的视频/音频时需要").first()).toBeVisible();
  // 维护组把此前几乎不可达的后端能力收在一处。存储迁移/下载源探测/备份诊断兑现的是
  // 同一页的三个分页，所以它们合成一条入口，但说明里必须仍然点出这三样。
  const maintenanceEntry = page.getByRole("button", { name: /设置与能力中心/ });
  await expect(maintenanceEntry).toBeVisible();
  for (const label of ["模型存储位置迁移", "下载源探测", "备份恢复与脱敏诊断包"]) {
    await expect(maintenanceEntry).toContainText(label);
  }
  await assertNoHorizontalEscape(page, "system-tiers");

  // 资源库在这个干净档案里四类全空：必须是一块整宽引导，不是并排两个"什么都没有"。
  await go(page, "/library", "资源库");
  await expect(page.locator(".library-onboarding")).toHaveCount(1);
  await expect(page.locator(".library-layout")).toHaveCount(0);
  await assertNoHorizontalEscape(page, "library-onboarding");
  // 空态里的"新建"必须真的到得了编辑器——否则这块引导就是个死胡同。
  await page.locator(".library-onboarding").getByRole("button", { name: /^新建/ }).click();
  await expect(page.locator(".library-onboarding")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存并生成新版本", exact: true })).toBeVisible();
  await expect(page.locator(".library-usage")).toBeVisible();
  // 能力格的说明文字是整句话，必须在自己的格子里换行，不能压到隔壁卡片上。
  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720]]) {
    await setWindowSize(app, width, height);
    await page.waitForTimeout(250);
    await assertNoTextOverflow(page, ".capability-tier", `system-tiers-${width}x${height}`);
  }
  await setWindowSize(app, 1440, 900);
  await page.waitForTimeout(250);

  // 密度开关：只收技术读数，不动任何"门"。
  await go(page, `/projects/${projectId}/media`, "转写");
  await expect(page.locator(".asr-device-summary")).toBeHidden();
  await page.locator(".density-toggle").click();
  await expect(page.locator(".asr-device-summary")).toBeVisible();
  await go(page, `/projects/${projectId}/translate`, "翻译");
  // 费用提示是这一步唯一的"门"，两种密度下都必须可见。
  await expect(page.locator(".translate-cost-note, .translate-blocked-hint")).toBeVisible();
  await expect(page.locator(".density-toggle.is-pro")).toHaveCount(1);
  await page.locator(".density-toggle").click();
  await expect(page.locator(".density-toggle.is-pro")).toHaveCount(0);
  // 简单模式下费用提示和主操作必须还在——密度绝不隐藏任何"门"。
  await expect(page.locator(".translate-cost-note, .translate-blocked-hint")).toBeVisible();
  await expect(page.getByRole("button", { name: /开始翻译/ })).toBeVisible();

  await beginFileDrag(page);
  await expect(page.locator(".app-shell")).toHaveClass(/is-drop-blocked/);
  await expect(page.getByRole("heading", { name: "请返回工作台导入新文件", exact: true })).toBeVisible();
  await leaveFileDrag(page);

  await validateThemeMatrix(page, projectId);
  assert.deepEqual(pageErrors, []);

  await closeElectronApp(app);
  app = null;

  scaledApp = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`, "--force-device-scale-factor=2"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    timeout: 60_000,
  });
  const scaledPage = await scaledApp.firstWindow({ timeout: 60_000 });
  await scaledPage.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await setWindowSize(scaledApp, 1280, 720);
  await go(scaledPage, `/projects/${projectId}/media`, "转写");
  const scaleMetrics = await scaledPage.evaluate(() => ({ ratio: devicePixelRatio, width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.ok(scaleMetrics.ratio >= 1.5, JSON.stringify(scaleMetrics));
  assert.ok(scaleMetrics.documentWidth <= scaleMetrics.width + 1, JSON.stringify(scaleMetrics));
  await expect(scaledPage.getByRole("button", { name: /开始转写/ })).toBeVisible();

  console.log(`FR-07 user paths passed: ${projectId}; themes=${themes.length}; scale=${scaleMetrics.ratio}`);
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  if (scaledApp) await closeElectronApp(scaledApp).catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
