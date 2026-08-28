import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

async function launch(userDataDir, { deviceScaleFactor = null } = {}) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [...(deviceScaleFactor ? [`--force-device-scale-factor=${deviceScaleFactor}`] : []), ".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  return { app, page };
}

const userDataDir = mkdtempSync(join(tmpdir(), "phase12-e2e-"));
const paths = {
  cachePath: join(userDataDir, "custom-cache"),
  modelPath: join(userDataDir, "custom-models"),
  backupPath: join(userDataDir, "custom-backups"),
};
const screenshotDir = process.env.P3_4_SCREENSHOT_DIR || null;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
Object.values(paths).forEach((path) => mkdirSync(path));
let app;

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const scroller = document.querySelector(".main");
    const visibleControls = [...document.querySelectorAll("button, input, select, textarea, a")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    return {
      hasScroller: Boolean(scroller),
      innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      contentWidth: scroller?.scrollWidth ?? 0,
      contentClientWidth: scroller?.clientWidth ?? 0,
      sidebarWidth: getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w").trim(),
      matchesCompactRail: matchMedia("(max-width: 1300px)").matches,
      stage: (() => {
        const element = document.querySelector(".page-stage");
        const rect = element?.getBoundingClientRect();
        return element && rect ? { left: rect.left, right: rect.right, width: rect.width, scrollWidth: element.scrollWidth } : null;
      })(),
      overflowingElements: [...document.querySelectorAll("*")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { element, rect, overflow: Math.max(rect.right - innerWidth, element.scrollWidth - element.clientWidth) };
        })
        .filter(({ rect, overflow }) => rect.width > 0 && overflow > 1)
        .sort((left, right) => right.overflow - left.overflow)
        .slice(0, 8)
        .map(({ element, rect, overflow }) => ({
          tag: element.tagName,
          className: element.getAttribute("class") ?? "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          overflow: Math.round(overflow),
        })),
      escapedControls: visibleControls
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > innerWidth + 1;
        })
        .map((element) => element.textContent?.trim() || element.getAttribute("aria-label") || element.tagName),
    };
  });
  assert.equal(metrics.hasScroller, true, JSON.stringify({ label, metrics }));
  assert.ok(metrics.documentWidth <= metrics.innerWidth + 1, JSON.stringify({ label, metrics }));
  assert.ok(metrics.bodyWidth <= metrics.innerWidth + 1, JSON.stringify({ label, metrics }));
  assert.ok(metrics.contentWidth <= metrics.contentClientWidth + 1, JSON.stringify({ label, metrics }));
  assert.deepEqual(metrics.escapedControls, [], JSON.stringify({ label, metrics }));
}

function asrModelRow(page, modelId) {
  return page.locator(".asset-ledger > article").filter({ hasText: `${modelId} ·` }).first();
}

function vadField(page, label) {
  return page.locator(".vad-fields label").filter({ hasText: label }).locator('input[type="number"]');
}

function vadModeButton(page, name) {
  return page.locator(".vad-mode-row").getByRole("button", { name, exact: true });
}

async function assertAsrMaintenanceControls(page) {
  const root = page.locator('[data-fr03-view="asr-maintenance"]');
  await root.getByRole("heading", { name: "本地语音识别", exact: true }).waitFor();
  for (const heading of ["识别模型", "运行时与设备", "人声与唱词", "VAD 语音分段"]) {
    assert.equal(await root.getByRole("heading", { name: heading, exact: true }).count(), 1, heading);
  }
  assert.equal(await root.locator(".asset-ledger > article").count(), 8);
  assert.equal(await root.getByRole("button", { name: "检测设备", exact: true }).count(), 1);
  assert.equal(await root.getByRole("group", { name: "ASR 设备偏好", exact: true }).getByRole("button").count(), 3);
  assert.equal(await root.getByRole("button", { name: "保存 VAD 策略", exact: true }).count(), 1);
  assert.equal(await root.getByRole("button", { name: "来源", exact: true }).count() >= 7, true);
  assert.equal(await root.getByRole("button", { name: /许可证/ }).count() >= 7, true);
}

async function settleLayout(page) {
  await page.waitForTimeout(320);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitForAppSettings(page, predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  while (Date.now() < deadline) {
    lastResult = await page.evaluate(() => window.desktop.getAppSettings());
    if (lastResult.ok && predicate(lastResult.data)) return lastResult.data;
    await page.waitForTimeout(50);
  }
  assert.fail(`${label}: ${JSON.stringify(lastResult)}`);
}

try {
  let launched = await launch(userDataDir);
  app = launched.app;
  let page = launched.page;
  const initial = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(initial.ok, true);
  const writablePaths = { ...paths, modelPath: initial.data.modelPath };
  const saved = await page.evaluate((customPaths) => window.desktop.saveAppSettings({ settings: {
    schemaVersion: 1,
    startupPage: "projects",
    translationProvider: null,
    translationModel: null,
    asrDefaultModelId: "small",
    asrVad: {
      mode: "custom",
      customParameters: {
        threshold: 0.7,
        minSpeechDurationMs: 90,
        minSilenceDurationMs: 500,
        maxSpeechDurationSeconds: 20,
        speechPadMs: 80,
        samplesOverlapSeconds: 0.2,
      },
    },
    asrVocalSeparation: "on",
    asrSongHandling: "filter",
    ...customPaths,
    downloadSource: "mirror",
    customDownloadUrl: "",
    notifications: { taskDone: false, error: true, release: false, system: true },
  } }), writablePaths);
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const secret = "sk-phase12-e2e-secret";
  const credential = await page.evaluate((value) => window.desktop.saveCredential({ credentialId: "phase12-e2e", providerId: "openai", label: "E2E", secret: value }), secret);
  assert.equal(credential.ok, true);
  assert.equal(JSON.stringify(credential).includes(secret), false);
  const status = await page.evaluate(() => window.desktop.getCredentialStatus({ credentialId: "phase12-e2e" }));
  assert.equal(status.ok, true);
  assert.equal(status.data.configured, true);
  const removed = await page.evaluate(() => window.desktop.deleteCredential({ credentialId: "phase12-e2e" }));
  assert.equal(removed.ok, true);

  const capabilities = await page.evaluate(() => window.desktop.getCapabilityReadiness({}));
  assert.equal(capabilities.ok, true);
  assert.ok(capabilities.data.global.capabilities.some(({ id }) => id === "asr"));
  const preview = await page.evaluate(() => window.desktop.previewDiagnostics());
  assert.equal(preview.ok, true);
  assert.equal(JSON.stringify(preview).includes(secret), false);
  assert.equal(JSON.stringify(preview).includes(userDataDir), false);
  const backup = await page.evaluate(() => window.desktop.createAppBackup());
  assert.equal(backup.ok, true);
  assert.equal(existsSync(join(paths.backupPath, backup.data.fileName)), true);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await page.locator(".app-shell").waitFor();
  await page.evaluate(() => { window.location.hash = "/system/asr"; });
  await assertAsrMaintenanceControls(page);
  const asrRoot = page.locator('[data-fr03-view="asr-maintenance"]');
  assert.equal((await asrRoot.innerText()).includes("API Key"), false);
  await assertNoHorizontalOverflow(page, "1440x900@100%");
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "p3-4-model-page-1440x900.png") });

  const smallModel = asrModelRow(page, "small");
  const q5Model = asrModelRow(page, "large-v3-turbo-q5_0");
  const q8Model = asrModelRow(page, "large-v3-turbo-q8_0");
  await smallModel.waitFor();
  assert.match(await smallModel.getAttribute("class") ?? "", /is-selected/);

  const q5Default = q5Model.getByRole("button", { name: "设为默认", exact: true });
  await q5Default.focus();
  assert.equal(await q5Default.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  await page.getByText("已将 large-v3-turbo-q5_0 保存为全局默认模型。", { exact: true }).waitFor();
  assert.match(await q5Model.getAttribute("class") ?? "", /is-selected/);
  assert.match(await q5Model.innerText(), /未安装|尚不可用/);

  const vadLabels = ["检测阈值", "最短语音", "最短静音", "最长语音", "语音边距", "分片重叠"];
  for (const label of vadLabels) {
    const field = vadField(page, label);
    assert.equal(await field.count(), 1, label);
    assert.notEqual(await field.getAttribute("min"), null, label);
    assert.notEqual(await field.getAttribute("max"), null, label);
  }

  const threshold = vadField(page, "检测阈值");
  await threshold.fill("2");
  const saveVad = asrRoot.getByRole("button", { name: "保存 VAD 策略", exact: true });
  await saveVad.focus();
  await page.keyboard.press("Enter");
  const vadError = page.getByText("VAD 参数超出允许范围，请检查后再保存。", { exact: true });
  await vadError.waitFor();
  assert.equal(await vadError.locator("xpath=..").getAttribute("role"), "alert");
  const settingsAfterInvalidVad = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(settingsAfterInvalidVad.ok, true);
  assert.equal(settingsAfterInvalidVad.data.asrVad.customParameters.threshold, 0.7);

  await page.evaluate(() => {
    const q8Row = [...document.querySelectorAll(".asset-ledger > article")]
      .find((element) => element.textContent?.includes("large-v3-turbo-q8_0 ·"));
    const modelButton = q8Row
      ? [...q8Row.querySelectorAll("button")].find((button) => button.textContent?.trim() === "设为默认")
      : null;
    const vadOff = [...document.querySelectorAll(".vad-mode-row button")]
      .find((button) => button.textContent?.trim() === "关闭");
    if (!(modelButton instanceof HTMLButtonElement) || !(vadOff instanceof HTMLButtonElement)) throw new Error("Concurrent ASR controls are missing");
    modelButton.click();
    vadOff.click();
  });
  await page.waitForFunction(() => document.querySelector(".vad-mode-row button.is-active")?.textContent?.trim() === "关闭");
  await saveVad.click();
  await waitForAppSettings(
    page,
    (value) => value.asrDefaultModelId === "large-v3-turbo-q8_0" && value.asrVad.mode === "off",
    "concurrent model/VAD settings did not persist",
  );
  const concurrentSettings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(concurrentSettings.ok, true);
  assert.equal(concurrentSettings.data.asrDefaultModelId, "large-v3-turbo-q8_0");
  assert.equal(concurrentSettings.data.asrVad.mode, "off");
  assert.match(await q8Model.getAttribute("class") ?? "", /is-selected/);

  await q5Model.getByRole("button", { name: "设为默认", exact: true }).click();
  await vadModeButton(page, "自定义").click();
  const restoredVad = new Map([
    ["检测阈值", "0.7"],
    ["最短语音", "90"],
    ["最短静音", "500"],
    ["最长语音", "20"],
    ["语音边距", "80"],
    ["分片重叠", "0.2"],
  ]);
  for (const [label, value] of restoredVad) await vadField(page, label).fill(value);
  await saveVad.click();
  await waitForAppSettings(
    page,
    (value) => value.asrDefaultModelId === "large-v3-turbo-q5_0" && value.asrVad.mode === "custom",
    "restored model/VAD settings did not persist",
  );

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
  for (const zoomFactor of [1]) {
    await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor), zoomFactor);
    await settleLayout(page);
    await assertNoHorizontalOverflow(page, `1280x720@${zoomFactor * 100}%`);
    if (screenshotDir && zoomFactor === 1) {
      await page.evaluate(() => {
        const scroller = document.querySelector(".main");
        if (scroller) scroller.scrollTop = 0;
      });
      await page.screenshot({ path: join(screenshotDir, "p3-4-model-page-1280x720.png") });
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1));

  await page.evaluate(() => { window.location.hash = "/system/settings"; });
  const settingsRoot = page.locator('[data-fr03-view="system-settings"]');
  await settingsRoot.getByRole("heading", { name: "设置与能力中心", exact: true }).waitFor();
  assert.equal(await settingsRoot.getByRole("tab").count(), 7);
  const startupSelect = settingsRoot.locator(".settings-control-list label").filter({ hasText: "启动页面" }).locator("select");
  assert.equal(await startupSelect.inputValue(), "projects");

  await settingsRoot.getByRole("tab", { name: /文件与模型/ }).click();
  await settingsRoot.getByRole("heading", { name: "缓存与备份目录", exact: true }).waitFor();
  const cacheInput = settingsRoot.locator(".path-settings-list label").filter({ hasText: "缓存目录" }).locator("input");
  const backupInput = settingsRoot.locator(".path-settings-list label").filter({ hasText: "备份目录" }).locator("input");
  assert.equal(await cacheInput.inputValue(), paths.cachePath);
  assert.equal(await backupInput.inputValue(), paths.backupPath);
  assert.equal(await settingsRoot.locator(".model-transfer-paths input").first().inputValue(), initial.data.modelPath);

  await settingsRoot.getByRole("tab", { name: /环境能力/ }).click();
  await settingsRoot.getByRole("heading", { name: "全局环境", exact: true }).waitFor();
  await settingsRoot.getByRole("heading", { name: "当前项目", exact: true }).waitFor();

  await settingsRoot.getByRole("tab", { name: /备份与诊断/ }).click();
  await settingsRoot.getByRole("heading", { name: "应用与项目备份", exact: true }).waitFor();
  await settingsRoot.getByRole("button", { name: "生成脱敏预览", exact: true }).click();
  const diagnosticEntries = settingsRoot.locator(".diagnostic-entries");
  await diagnosticEntries.waitFor();
  const diagnosticCopy = await diagnosticEntries.evaluate((element) => element.textContent ?? "");
  assert.equal(diagnosticCopy.includes(secret), false);
  assert.equal(diagnosticCopy.includes(userDataDir), false);
  await assertNoHorizontalOverflow(page, "settings-1280x720@100%");
  await closeElectronApp(app);
  app = undefined;

  launched = await launch(userDataDir, { deviceScaleFactor: 2 });
  app = launched.app;
  page = launched.page;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
  await settleLayout(page);
  const highDpiMetrics = await page.evaluate(() => ({ devicePixelRatio, innerWidth, innerHeight }));
  assert.ok(highDpiMetrics.devicePixelRatio >= 1.9, JSON.stringify(highDpiMetrics));
  const reopened = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(reopened.ok, true);
  assert.equal(reopened.data.startupPage, "projects");
  assert.equal(reopened.data.asrDefaultModelId, "large-v3-turbo-q5_0");
  assert.equal(reopened.data.asrVocalSeparation, "on");
  assert.equal(reopened.data.asrSongHandling, "filter");
  assert.deepEqual(reopened.data.asrVad, {
    mode: "custom",
    customParameters: {
      threshold: 0.7,
      minSpeechDurationMs: 90,
      minSilenceDurationMs: 500,
      maxSpeechDurationSeconds: 20,
      speechPadMs: 80,
      samplesOverlapSeconds: 0.2,
    },
  });
  assert.equal(reopened.data.cachePath, paths.cachePath);
  assert.equal(reopened.data.notifications.taskDone, false);
  await page.locator(".app-shell").waitFor();
  await page.evaluate(() => { window.location.hash = "/system/asr"; });
  await assertAsrMaintenanceControls(page);
  await assertNoHorizontalOverflow(page, "1280x720@Windows-200%-scale");
  const reopenedQ5Model = asrModelRow(page, "large-v3-turbo-q5_0");
  assert.match(await reopenedQ5Model.getAttribute("class") ?? "", /is-selected/);
  for (const [label, value] of new Map([
    ["检测阈值", "0.7"],
    ["最短语音", "90"],
    ["最短静音", "500"],
    ["最长语音", "20"],
    ["语音边距", "80"],
    ["分片重叠", "0.2"],
  ])) assert.equal(await vadField(page, label).inputValue(), value, label);
  await closeElectronApp(app);
  app = undefined;
  console.log("Phase 12 settings/capability/credential/diagnostic/backup smoke passed");
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
