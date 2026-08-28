import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(rootDir, "tests", "fixtures", "subtitles", "valid", "basic-utf8.srt");
const fixtureBytes = [...readFileSync(fixturePath)];
const userDataDir = mkdtempSync(join(tmpdir(), "fr04-theme-matrix-"));
const screenshotDir = process.env.FR04_E2E_SCREENSHOT_DIR ? resolve(process.env.FR04_E2E_SCREENSHOT_DIR) : null;
const allThemes = [
  { id: "brass", code: "A", name: "黄铜机台", signature: "concentric" },
  { id: "ticket", code: "B", name: "航线票夹", signature: "route" },
  { id: "proof", code: "C", name: "套色校样", signature: "registration" },
  { id: "fold", code: "D", name: "折页星图", signature: "crease" },
  { id: "strata", code: "E", name: "云层剖面", signature: "sonar" },
  { id: "signal", code: "F", name: "信号母带", signature: "vu" },
  { id: "celadon", code: "G", name: "青瓷刻度", signature: "ripple" },
  { id: "relay", code: "H", name: "工业信号", signature: "led" },
  { id: "inkwhite", code: "I", name: "墨白编校", signature: "proofmark" },
];
const requestedIds = (process.env.FR04_THEME_IDS ?? allThemes.map((theme) => theme.id).join(","))
  .split(",").map((value) => value.trim()).filter(Boolean);
const screenshotThemes = requestedIds.map((id) => allThemes.find((theme) => theme.id === id)).filter(Boolean);
const matrixMetrics = [];
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
assert.equal(existsSync(fixturePath), true, `missing fixture: ${fixturePath}`);
assert.equal(screenshotThemes.length, requestedIds.length, `unknown FR04_THEME_IDS: ${requestedIds.join(",")}`);

let app;

async function setWindowSize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), { width, height });
}

// ready 可以是标题文字，也可以是选择器。编辑器不再有独立标题——阶段导轨上高亮的
// "校对"就是它的名字——所以那里改用稳定的结构标记，而不是靠标题文案。
async function go(page, path, ready) {
  await page.evaluate((next) => { window.location.hash = next; }, path);
  if (ready.startsWith(".") || ready.startsWith("[")) await page.locator(ready).waitFor({ timeout: 30_000 });
  else await page.getByRole("heading", { name: ready, exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(480);
}

async function assertNoHorizontalEscape(page, label) {
  const metrics = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button, input, select, textarea, a")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      escaped: controls.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).map((element) => element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 60) || element.tagName),
    };
  });
  assert.ok(metrics.documentWidth <= metrics.viewport + 1, JSON.stringify({ label, metrics }));
  assert.deepEqual(metrics.escaped, [], JSON.stringify({ label, metrics }));
}

async function capture(page, theme, name, prepare) {
  if (!screenshotDir) return;
  const themeDir = join(screenshotDir, `${theme.code}-${theme.id}`);
  mkdirSync(themeDir, { recursive: true });
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await setWindowSize(width, height);
    await page.evaluate(() => window.scrollTo(0, 0));
    if (prepare) await prepare();
    await page.waitForTimeout(180);
    await assertNoHorizontalEscape(page, `${theme.id}-${name}-${width}x${height}`);
    await page.screenshot({ path: join(themeDir, `${name}-${width}x${height}.png`) });
  }
  await setWindowSize(1440, 900);
}

async function selectTheme(page, theme) {
  if (await page.locator("html").getAttribute("data-theme") === theme.id) return;
  await page.locator(".theme-trigger").click();
  const option = page.locator(".theme-option").filter({ hasText: `${theme.code} · ${theme.name}` });
  await option.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
  await expect(page.locator("html")).toHaveAttribute("data-signature", theme.signature);
  await page.locator(".toast").waitFor({ state: "detached", timeout: 5_000 });
}

async function seedProject(page) {
  const seeded = await page.evaluate(async ({ bytes }) => {
    const credential = await window.desktop.saveCredential({
      credentialId: "openai-default",
      providerId: "openai",
      label: "FR-04 isolated fake provider",
      secret: "sk-fr04-local-fixture-not-real",
    });
    const tested = credential.ok ? await window.desktop.testProviderConnection({ provider: "OpenAI", credentialId: "openai-default", model: "GPT-4.1" }) : null;
    const current = await window.desktop.getAppSettings();
    const savedSettings = current.ok ? await window.desktop.saveAppSettings({ settings: { ...current.data, translationProvider: "OpenAI", translationModel: "GPT-4.1" } }) : null;
    const imported = await window.desktop.importSubtitle({
      fileName: "fr04-theme-matrix.srt",
      bytes: new Uint8Array(bytes),
      defaults: { sourceLanguage: "英语", targetLanguages: ["简体中文"], provider: "OpenAI", model: "GPT-4.1", outputFormat: "SRT" },
    });
    if (!imported.ok || !imported.data.project) return { credential, tested, current, savedSettings, imported };
    const project = { ...imported.data.project, title: "FR-04 九套皮肤状态锚点", updatedAt: new Date().toISOString() };
    const savedProject = await window.desktop.saveProject({ project });
    const translation = savedProject.ok ? await window.desktop.startTranslation({ projectId: project.id, userConfirmed: true }) : null;
    return { credential, tested, current, savedSettings, imported, savedProject, translation, projectId: project.id };
  }, { bytes: fixtureBytes });
  for (const key of ["credential", "tested", "savedSettings", "imported", "savedProject", "translation"]) {
    assert.equal(seeded[key]?.ok, true, `${key}: ${JSON.stringify(seeded[key])}`);
  }
  return seeded.projectId;
}

async function waitForTranslation(page, projectId) {
  let result;
  await expect.poll(async () => {
    result = await page.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
    if (!result.ok) return false;
    const source = result.data.sourceTracks.find((track) => track.id === result.data.activeSourceTrackId);
    const target = source?.targetTracks.find((track) => track.isActive);
    return Boolean(target) && source.segments.every((segment) => {
      const text = segment.targetTexts[target.languageCode];
      return Boolean(text?.manual ?? text?.postProcessed ?? text?.model);
    });
  }, { timeout: 60_000, intervals: [100, 250, 500] }).toBe(true);
  const source = result.data.sourceTracks.find((track) => track.id === result.data.activeSourceTrackId);
  return { project: result.data, targetLanguage: source.targetTracks.find((track) => track.isActive).languageCode };
}

async function installAudioProbe(page) {
  return page.evaluate(() => {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return false;
    window.__fr04AudioProbe = { oscillators: 0, buffers: 0, closes: 0 };
    const prototype = AudioCtor.prototype;
    const createOscillator = prototype.createOscillator;
    const createBufferSource = prototype.createBufferSource;
    const close = prototype.close;
    prototype.createOscillator = function (...args) {
      window.__fr04AudioProbe.oscillators += 1;
      return createOscillator.apply(this, args);
    };
    prototype.createBufferSource = function (...args) {
      window.__fr04AudioProbe.buffers += 1;
      return createBufferSource.apply(this, args);
    };
    prototype.close = function (...args) {
      window.__fr04AudioProbe.closes += 1;
      return close.apply(this, args);
    };
    return true;
  });
}

try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", TRANSLATION_FAKE_PROVIDER: "1" },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await setWindowSize(1440, 900);
  assert.deepEqual(await page.evaluate(() => ({ process: typeof window.process, require: typeof window.require, desktop: typeof window.desktop })), { process: "undefined", require: "undefined", desktop: "object" });
  assert.equal(await page.locator(".sound-toggle").getAttribute("aria-pressed"), "false", "a fresh profile must start muted");

  const projectId = await seedProject(page);
  const translated = await waitForTranslation(page, projectId);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await go(page, `/projects/${projectId}/editor/${encodeURIComponent(translated.targetLanguage)}`, '[data-fr02-view="editor"]');
  const rows = page.locator(".segment-row");
  await rows.nth(1).click();
  const targetEditor = page.getByLabel("译文");
  await targetEditor.fill("FR-04 主题切换保留稿 · العربية · 😀");
  await page.getByText("修改已进入自动保存", { exact: true }).waitFor();
  await targetEditor.evaluate((element) => { element.dataset.fr04Identity = "retained-node"; });
  const retainedSegment = await page.locator(".segment-row.is-selected").innerText();

  assert.equal(await installAudioProbe(page), true, "Web Audio must be locally available in Electron");
  await page.locator(".sound-toggle").click();
  await expect(page.locator(".sound-toggle")).toHaveAttribute("aria-pressed", "true");
  const fastOrder = [...allThemes.slice(1), allThemes[0], allThemes.at(-1)];
  let previousSoundCount = await page.evaluate(() => window.__fr04AudioProbe.oscillators + window.__fr04AudioProbe.buffers);
  for (const theme of fastOrder) {
    await selectTheme(page, theme);
    const nextSoundCount = await page.evaluate(() => window.__fr04AudioProbe.oscillators + window.__fr04AudioProbe.buffers);
    assert.ok(nextSoundCount > previousSoundCount, `${theme.id} must synthesize local feedback`);
    previousSoundCount = nextSoundCount;
  }
  assert.equal(await page.evaluate(() => window.location.hash), `#/projects/${projectId}/editor/${encodeURIComponent(translated.targetLanguage)}`);
  assert.equal(await targetEditor.getAttribute("data-fr04-identity"), "retained-node", "theme switching must not remount the business editor");
  assert.equal(await targetEditor.inputValue(), "FR-04 主题切换保留稿 · العربية · 😀");
  assert.equal(await page.locator(".segment-row.is-selected").innerText(), retainedSegment);
  await page.locator(".sound-toggle").click();
  await expect(page.locator(".sound-toggle")).toHaveAttribute("aria-pressed", "false");
  assert.ok(await page.evaluate(() => window.__fr04AudioProbe.closes) > 0, "muting must dispose the active AudioContext");

  await go(page, "/", "今天想翻译什么？");
  await page.locator(".theme-trigger").click();
  const effectsSwitch = page.locator(".theme-preference").filter({ hasText: "签名视觉动效" });
  await effectsSwitch.click();
  await expect(page.locator("html")).toHaveAttribute("data-effects", "off");
  assert.equal(await page.locator(".hero-visual-obj *").first().evaluate((element) => getComputedStyle(element).animationName), "none");
  await effectsSwitch.click();
  await expect(page.locator("html")).toHaveAttribute("data-effects", "on");
  await page.locator(".theme-preference").filter({ hasText: "减少动态" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
  assert.match(await page.locator(".theme-trigger").evaluate((element) => getComputedStyle(element).transitionDuration), /0\.00001s|1e-05s|0s/);
  await page.locator(".theme-preference").filter({ hasText: "减少动态" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "false");
  await page.keyboard.press("Escape");

  await go(page, `/projects/${projectId}/editor/${encodeURIComponent(translated.targetLanguage)}`, '[data-fr02-view="editor"]');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.locator('[data-fr02-view="editor"]').waitFor();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "inkwhite");
  await expect(page.locator(".sound-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.locator(".segment-row").nth(1).click();
  await expect(page.getByLabel("译文")).toHaveValue("FR-04 主题切换保留稿 · العربية · 😀");

  for (const theme of screenshotThemes) {
    await selectTheme(page, theme);
    await go(page, "/", "今天想翻译什么？");
    await capture(page, theme, "workbench");
    await go(page, `/projects/${projectId}`, "FR-04 九套皮肤状态锚点");
    await capture(page, theme, "project-overview");
    await go(page, `/projects/${projectId}/editor/${encodeURIComponent(translated.targetLanguage)}`, '[data-fr02-view="editor"]');
    await capture(page, theme, "subtitle-editor");
    await go(page, `/projects/${projectId}/translate`, '[data-fr02-view="translate"]');
    await assertNoHorizontalEscape(page, `${theme.id}-translate`);
    await capture(page, theme, "translate-stage");
    // 交付单是九套皮肤各自的签名元件（戳记、折痕、切角），常显后要逐皮肤看一遍。
    await go(page, `/projects/${projectId}/deliver`, '[data-fr02-view="deliver"]');
    await assertNoHorizontalEscape(page, `${theme.id}-deliver`);
    await capture(page, theme, "delivery-stage");
    // 系统页是 .secondary-page，四套皮肤的签名标记画在它首个 section 的上沿。
    // 这一页此前不在巡检里，签名压住"现在需要"标题的问题就一直看不见。
    await go(page, "/system", '[data-fr01-view="system"]');
    await assertNoHorizontalEscape(page, `${theme.id}-system`);
    await capture(page, theme, "system-capabilities");
    await go(page, "/system/settings", "设置与能力中心");
    await page.getByRole("tab", { name: /外观与声音/ }).click();
    await capture(page, theme, "appearance-settings");
    await go(page, "/", "今天想翻译什么？");
    await page.locator(".theme-trigger").click();
    await capture(page, theme, "theme-menu", async () => page.locator('.theme-option[aria-checked="true"]').scrollIntoViewIfNeeded());
    await page.keyboard.press("Escape");
    matrixMetrics.push(await page.evaluate(({ id, code, name }) => {
      const root = document.documentElement;
      const bodyStyle = getComputedStyle(document.body);
      const panelStyle = getComputedStyle(document.querySelector(".import-panel"));
      return {
        id, code, name,
        dataTheme: root.dataset.theme,
        dataSignature: root.dataset.signature,
        bodyFont: bodyStyle.fontFamily,
        canvas: bodyStyle.backgroundColor,
        panelRadius: panelStyle.borderRadius,
        brandSvg: Boolean(document.querySelector(".brand-mark .brand-svg")),
        heroClass: document.querySelector(".hero-visual-obj")?.className ?? null,
      };
    }, theme));
  }

  assert.deepEqual(pageErrors, []);
  assert.equal(matrixMetrics.length, screenshotThemes.length);
  if (screenshotDir) {
    const suffix = screenshotThemes.map((theme) => theme.code).join("");
    writeFileSync(join(screenshotDir, `matrix-metrics-${suffix}.json`), `${JSON.stringify(matrixMetrics, null, 2)}\n`, "utf8");
  }
  console.log(`FR-04 theme matrix passed: ${screenshotThemes.map((theme) => `${theme.code}-${theme.id}`).join(", ")}`);
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
