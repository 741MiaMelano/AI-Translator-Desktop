import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

async function launch(userDataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
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
    const scroller = document.querySelector(".app-content-scroll");
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

async function assertP34DesktopFold(page) {
  await page.evaluate(() => {
    const scroller = document.querySelector(".app-content-scroll");
    if (scroller) scroller.scrollTop = 0;
  });
  const layout = await page.evaluate(() => {
    const rect = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.getBoundingClientRect();
    const foldBottom = document.querySelector(".app-content-scroll")?.getBoundingClientRect().bottom ?? innerHeight;
    return {
      foldBottom,
      current: rect("asr-current-config"),
      engine: rect("asr-engine"),
      models: rect("asr-model-selector"),
      components: rect("asr-component-status"),
      device: rect("asr-device-policy"),
      maintenance: rect("asr-maintenance-panel"),
      vad: rect("asr-vad-panel"),
    };
  });
  for (const name of ["current", "engine", "models", "components", "device", "maintenance", "vad"]) {
    assert.ok(layout[name], JSON.stringify({ missing: name, layout }));
  }
  assert.ok(layout.current.top < layout.engine.top && layout.engine.top < layout.models.top, JSON.stringify(layout));
  assert.ok(layout.models.top < layout.components.top && Math.abs(layout.components.top - layout.device.top) <= 1, JSON.stringify(layout));
  assert.ok(layout.components.top < layout.maintenance.top && layout.maintenance.top < layout.vad.top, JSON.stringify(layout));
  assert.ok(layout.current.bottom <= layout.foldBottom + 1, JSON.stringify(layout));
  assert.ok(layout.engine.bottom <= layout.foldBottom + 1, JSON.stringify(layout));
  assert.ok(layout.models.bottom <= layout.foldBottom + 1, JSON.stringify(layout));
  assert.ok(layout.components.top < layout.foldBottom, JSON.stringify(layout));
}

async function assertP34LegacyControls(page) {
  const root = page.getByTestId("asr-model-page");
  const buttonNames = [
    "自动选择", "官方源", "国内镜像",
    "开始下载 / 继续下载", "手动导入", "卸载模型", "暂停下载",
    "安装 CUDA runtime", "手动导入 CUDA runtime", "卸载 CUDA runtime",
    "引擎来源", "引擎许可证", "模型来源", "模型许可证",
    "Auto", "CPU", "CUDA", "检测设备", "取消检测",
    "VAD 来源", "VAD 许可证",
  ];
  for (const name of buttonNames) {
    const control = root.getByRole("button", { name, exact: true });
    assert.equal(await control.count(), 1, name);
    assert.equal(await control.isVisible(), true, name);
  }
  const vadPanel = root.getByTestId("asr-vad-panel");
  for (const name of ["关闭", "保守", "标准（推荐）", "强力"]) {
    const control = vadPanel.getByRole("button", { name, exact: true });
    assert.equal(await control.count(), 1, `VAD ${name}`);
    assert.equal(await control.isEnabled(), true, `VAD ${name}`);
  }
  const advanced = vadPanel.getByRole("button", { name: /^(?:收起)?高级参数$/ });
  assert.equal(await advanced.count(), 1, "VAD 高级参数");
  assert.equal(await advanced.isEnabled(), true, "VAD 高级参数");
  if ((await advanced.innerText()).trim() === "高级参数") await advanced.click();
  for (const name of ["保存自定义参数", "恢复推荐值"]) {
    const control = vadPanel.getByRole("button", { name, exact: true });
    assert.equal(await control.count(), 1, name);
    assert.equal(await control.isEnabled(), true, name);
  }
  const separationPanel = root.getByTestId("asr-vocal-separation-panel");
  for (const name of ["关闭", "开启"]) {
    const control = separationPanel.getByRole("button", { name, exact: true });
    assert.equal(await control.count(), 1, `人声分离 ${name}`);
    assert.equal(await control.isEnabled(), true, `人声分离 ${name}`);
  }
  const fallback = root.getByRole("checkbox", { name: "显式选择 CUDA 时，初始化失败后回退 CPU" });
  assert.equal(await fallback.count(), 1);
  assert.equal(await fallback.isEnabled(), true);
  assert.equal(await root.getByRole("combobox", { name: "维护目标模型" }).count(), 0);
  for (const name of [
    "自动选择", "官方源", "国内镜像", "开始下载 / 继续下载", "手动导入",
    "安装 CUDA runtime", "手动导入 CUDA runtime", "引擎来源", "引擎许可证", "模型来源", "模型许可证",
    "Auto", "CPU", "CUDA", "检测设备", "VAD 来源", "VAD 许可证",
  ]) {
    assert.equal(await root.getByRole("button", { name, exact: true }).isEnabled(), true, name);
  }
  for (const name of ["卸载模型", "暂停下载", "卸载 CUDA runtime", "取消检测"]) {
    assert.equal(await root.getByRole("button", { name, exact: true }).isEnabled(), false, name);
  }
}

async function settleLayout(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
  await page.evaluate(() => { window.location.hash = "/capabilities?tab=asr"; });
  await page.getByRole("heading", { name: "模型与连接" }).waitFor();
  const pageHeader = page.locator("header p");
  await pageHeader.waitFor();
  assert.ok((await pageHeader.innerText()).includes("管理本地识别引擎、模型、计算设备与语音活动检测。"));
  const smallModel = page.getByRole("radio", { name: "全局默认 ASR 模型：Small", exact: true });
  const q5Model = page.getByRole("radio", { name: "全局默认 ASR 模型：Large V3 Turbo Q5_0", exact: true });
  await q5Model.waitFor();
  assert.equal(await page.getByRole("group", { name: "Small 模型变体", exact: true }).getByRole("radio").count(), 1);
  assert.equal(await page.getByRole("group", { name: "Large V3 Turbo 模型变体", exact: true }).getByRole("radio").count(), 3);
  assert.equal(await page.getByRole("group", { name: "Large V3 模型变体", exact: true }).getByRole("radio").count(), 2);
  const pageCopy = await page.locator(".app-content-scroll").innerText();
  assert.equal(pageCopy.includes("API Key"), false);
  await assertP34DesktopFold(page);
  await assertNoHorizontalOverflow(page, "1440x900@100%");
  await assertP34LegacyControls(page);
  const root = page.getByTestId("asr-model-page");
  for (const state of ["selected", "installed", "actual"]) {
    assert.equal(await root.locator(`[data-state-kind="${state}"]`).count(), 1, state);
  }
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "p3-4-model-page-1440x900.png") });

  const officialSource = page.getByRole("button", { name: "官方源", exact: true });
  await officialSource.focus();
  assert.equal(await officialSource.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert.equal(await officialSource.getAttribute("aria-pressed"), "true");

  await smallModel.focus();
  assert.equal(await smallModel.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("ArrowRight");
  await page.getByText("已将 large-v3-turbo-q5_0 保存为全局默认模型。", { exact: true }).waitFor();
  assert.equal(await q5Model.isChecked(), true);
  assert.match(await root.locator('[data-state-kind="selected"]').innerText(), /Large V3 Turbo Q5_0/);
  assert.match(await root.locator('[data-state-kind="installed"]').innerText(), /未安装|尚不可用/);
  assert.match(await root.locator('[data-state-kind="actual"]').innerText(), /尚无运行记录/);

  for (const label of ["阈值", "最短语音（ms）", "最短静音（ms）", "最长语音（秒，0=无限制）", "语音填充（ms）", "样本重叠（秒）"]) {
    const field = page.getByLabel(`VAD ${label}`, { exact: true });
    assert.equal(await field.count(), 1, label);
    assert.equal(await field.getAttribute("aria-describedby"), "asr-vad-custom-help", label);
    assert.notEqual(await field.getAttribute("min"), null, label);
    assert.notEqual(await field.getAttribute("max"), null, label);
  }

  const threshold = page.getByLabel("VAD 阈值");
  await threshold.fill("2");
  assert.equal(await threshold.getAttribute("aria-invalid"), "true");
  const saveVad = page.getByRole("button", { name: "保存自定义参数", exact: true });
  await saveVad.focus();
  await page.keyboard.press("Enter");
  const vadError = page.getByText("VAD 参数超出允许范围，请检查后再保存。", { exact: true });
  await vadError.waitFor();
  assert.equal(await vadError.getAttribute("role"), "alert");
  const settingsAfterInvalidVad = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(settingsAfterInvalidVad.ok, true);
  assert.equal(settingsAfterInvalidVad.data.asrVad.customParameters.threshold, 0.7);

  await page.evaluate(() => {
    const model = document.querySelector('input[name="asr-default-model"][value="large-v3-turbo-q8_0"]');
    const vadOff = [...document.querySelectorAll('[data-testid="asr-vad-panel"] button')]
      .find((button) => button.textContent?.trim() === "关闭");
    if (!(model instanceof HTMLInputElement) || !(vadOff instanceof HTMLButtonElement)) throw new Error("Concurrent ASR controls are missing");
    model.click();
    vadOff.click();
  });
  await page.waitForFunction(async () => {
    const result = await window.desktop.getAppSettings();
    return result.ok && result.data.asrDefaultModelId === "large-v3-turbo-q8_0" && result.data.asrVad.mode === "off";
  });
  const concurrentSettings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(concurrentSettings.ok, true);
  assert.equal(concurrentSettings.data.asrDefaultModelId, "large-v3-turbo-q8_0");
  assert.equal(concurrentSettings.data.asrVad.mode, "off");

  await q5Model.evaluate((model) => model.click());
  await page.waitForFunction(async () => {
    const result = await window.desktop.getAppSettings();
    return result.ok && result.data.asrDefaultModelId === "large-v3-turbo-q5_0";
  });
  await threshold.fill("0.7");
  await saveVad.click();
  await page.waitForFunction(async () => {
    const result = await window.desktop.getAppSettings();
    return result.ok && result.data.asrVad.mode === "custom";
  });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
  for (const zoomFactor of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor), zoomFactor);
    await settleLayout(page);
    await assertNoHorizontalOverflow(page, `1280x720@${zoomFactor * 100}%`);
    if (screenshotDir && zoomFactor === 1) {
      await page.evaluate(() => {
        const scroller = document.querySelector(".app-content-scroll");
        if (scroller) scroller.scrollTop = 0;
      });
      await page.screenshot({ path: join(screenshotDir, "p3-4-model-page-1280x720.png") });
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1));

  await page.evaluate(() => { window.location.hash = "/settings"; });
  await page.getByRole("heading", { name: "设置与能力中心" }).waitFor();
  await page.getByRole("tab", { name: "环境能力" }).click();
  await page.getByText("全局环境就绪").waitFor();
  await closeElectronApp(app);
  app = undefined;

  launched = await launch(userDataDir);
  app = launched.app;
  page = launched.page;
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
  await page.evaluate(() => { window.location.hash = "/capabilities?tab=asr"; });
  const reopenedQ5Model = page.getByRole("radio", { name: "全局默认 ASR 模型：Large V3 Turbo Q5_0", exact: true });
  await reopenedQ5Model.waitFor();
  assert.equal(await reopenedQ5Model.isChecked(), true);
  const reopenedAdvanced = page.getByTestId("asr-vad-panel").getByRole("button", { name: /^(?:收起)?高级参数$/ });
  await reopenedAdvanced.waitFor();
  if ((await reopenedAdvanced.innerText()).trim() === "高级参数") await reopenedAdvanced.click();
  assert.equal(await page.getByLabel("VAD 阈值").inputValue(), "0.7");
  await closeElectronApp(app);
  app = undefined;
  console.log("Phase 12 settings/capability/credential/diagnostic/backup smoke passed");
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
