import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(rootDir, "tests", "fixtures", "subtitles", "valid", "basic-utf8.srt");
const userDataDir = mkdtempSync(join(tmpdir(), "fr03-capabilities-"));
const exportDir = join(userDataDir, "exports");
const screenshotDir = process.env.FR03_E2E_SCREENSHOT_DIR
  ? resolve(process.env.FR03_E2E_SCREENSHOT_DIR)
  : null;
const fixtureBytes = [...readFileSync(fixturePath)];
mkdirSync(exportDir, { recursive: true });
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

let app;

async function setWindowSize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
}

async function assertNoHorizontalEscape(page, label) {
  const metrics = await page.evaluate(() => {
    const visibleControls = [...document.querySelectorAll("button, input, select, textarea, a")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      escapedControls: visibleControls.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).map((element) => element.textContent?.trim() || element.getAttribute("aria-label") || element.tagName),
    };
  });
  assert.ok(metrics.documentWidth <= metrics.viewport + 1, JSON.stringify({ label, metrics }));
  assert.deepEqual(metrics.escapedControls, [], JSON.stringify({ label, metrics }));
}

async function capture(page, name) {
  if (!screenshotDir) return;
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await setWindowSize(width, height);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await assertNoHorizontalEscape(page, `${name}-${width}x${height}`);
    await page.screenshot({ path: join(screenshotDir, `${name}-${width}x${height}.png`) });
  }
  await setWindowSize(1440, 900);
}

async function go(page, path, heading) {
  await page.evaluate((next) => { window.location.hash = next; }, path);
  await page.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 30_000 });
}

async function seedWorkspace(page) {
  const seeded = await page.evaluate(async ({ bytes }) => {
    const resources = [
      {
        id: "fr03-glossary",
        kind: "glossary",
        name: "FR-03 术语表",
        description: "隔离 Electron 能力覆盖 fixture",
        payload: { languagePairs: [{ sourceLanguageCode: "en-US", targetLanguageCode: "zh-CN", entries: [{ id: "fr03-term", source: "workspace", target: "工作区", enabled: true }] }] },
      },
      {
        id: "fr03-style-guide",
        kind: "style_guide",
        name: "FR-03 风格指南",
        description: "隔离 Electron 能力覆盖 fixture",
        payload: { targetLanguageCode: "zh-CN", tags: ["e2e"], scenes: ["desktop"], rules: [{ id: "fr03-rule", title: "简洁", instruction: "保持字幕简洁。", enabled: true }] },
      },
      {
        id: "fr03-subtitle-style",
        kind: "subtitle_style",
        name: "FR-03 字幕样式",
        description: "隔离 Electron 能力覆盖 fixture",
        payload: {
          format: "ass",
          bilingualLayout: "target_only",
          primary: { fontFamily: "Microsoft YaHei", fontSizePx: 36, textColor: "#ffffff", outlineColor: "#111111", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
          secondary: { fontFamily: "Arial", fontSizePx: 22, textColor: "#dddddd", outlineColor: "#111111", outlineWidthPx: 1, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
          preview: { sourceText: "Workspace", targetText: "工作区", direction: "auto", backgroundColor: "#25211d" },
        },
      },
      {
        id: "fr03-export-preset",
        kind: "export_preset",
        name: "FR-03 导出预设",
        description: "隔离 Electron 能力覆盖 fixture",
        payload: { outputs: [{ content: "target", format: "srt" }], burnVideo: false, fileNameTemplate: "{project}-{language}", destination: { kind: "project_exports" } },
      },
    ];
    const resourceResults = [];
    for (const resource of resources) resourceResults.push(await window.desktop.saveResource({ resource }));

    const credential = await window.desktop.saveCredential({
      credentialId: "openai-default",
      providerId: "openai",
      label: "FR-03 local fake provider",
      secret: "sk-fr03-local-fixture-not-real",
    });
    const tested = credential.ok ? await window.desktop.testProviderConnection({
      provider: "OpenAI",
      credentialId: "openai-default",
      model: "GPT-4.1",
    }) : null;
    const currentSettings = await window.desktop.getAppSettings();
    const savedSettings = currentSettings.ok ? await window.desktop.saveAppSettings({ settings: {
      ...currentSettings.data,
      translationProvider: "OpenAI",
      translationModel: "GPT-4.1",
    } }) : null;
    const imported = await window.desktop.importSubtitle({
      fileName: "fr03-capability-fixture.srt",
      bytes: new Uint8Array(bytes),
      defaults: {
        sourceLanguage: "英语",
        targetLanguages: ["简体中文"],
        provider: "OpenAI",
        model: "GPT-4.1",
        glossary: "FR-03 术语表",
        styleGuide: "FR-03 风格指南",
        outputFormat: "SRT",
      },
    });
    if (!imported.ok || !imported.data.project) return { resources: resourceResults, credential, tested, currentSettings, savedSettings, imported };

    const base = imported.data.project;
    const active = { ...base, title: "FR-03 活动字幕项目", updatedAt: new Date().toISOString() };
    const activeSaved = await window.desktop.saveProject({ project: active });
    const clone = (id, title, patch) => {
      const project = structuredClone(active);
      project.id = id;
      project.title = title;
      project.createdAt = new Date().toISOString();
      project.updatedAt = project.createdAt;
      project.recentRunIds = [];
      delete project.sourceProjectRelativePath;
      return Object.assign(project, patch);
    };
    const archived = clone("fr03-archived", "FR-03 已归档项目", { archivedAt: new Date().toISOString() });
    const trashed = clone("fr03-trashed", "FR-03 回收站项目", { trashedAt: new Date().toISOString() });
    const media = clone("fr03-media-missing", "FR-03 缺失媒体项目", {
      mediaKind: "audio",
      noSourceMedia: false,
      sourceFileName: "fr03-offline-audio.wav",
      mediaSource: {
        assetId: "primary",
        displayName: "fr03-offline-audio.wav",
        availability: "missing",
        identity: null,
        selectedAudioStreamId: null,
        selectedSubtitleStreamId: null,
        confirmedAudioStreamId: null,
        confirmedSubtitleStreamId: null,
      },
    });
    const archivedCreated = await window.desktop.createProject({ project: archived });
    const trashedCreated = await window.desktop.createProject({ project: trashed });
    const mediaCreated = await window.desktop.createProject({ project: media });
    const translation = await window.desktop.startTranslation({ projectId: active.id, userConfirmed: true });
    return { resources: resourceResults, credential, tested, currentSettings, savedSettings, imported, activeSaved, archivedCreated, trashedCreated, mediaCreated, translation, activeProjectId: active.id };
  }, { bytes: fixtureBytes });

  assert.ok(seeded.resources.every((result) => result.ok), JSON.stringify(seeded.resources));
  for (const key of ["credential", "tested", "savedSettings", "imported", "activeSaved", "archivedCreated", "trashedCreated", "mediaCreated", "translation"]) {
    assert.equal(seeded[key]?.ok, true, `${key}: ${JSON.stringify(seeded[key])}`);
  }
  return seeded.activeProjectId;
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
  await setWindowSize(1440, 900);
  assert.deepEqual(await page.evaluate(() => ({ process: typeof window.process, require: typeof window.require, desktop: typeof window.desktop })), {
    process: "undefined",
    require: "undefined",
    desktop: "object",
  });

  const activeProjectId = await seedWorkspace(page);
  await expect.poll(async () => page.evaluate(async (projectId) => {
    const result = await window.desktop.subscribeTasks({ projectId });
    return result.ok ? result.data.tasks.some((task) => task.status === "completed") : false;
  }, activeProjectId), { timeout: 60_000, intervals: [100, 250, 500] }).toBe(true);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });

  await go(page, "/workspace", "项目与任务");
  await page.locator(".project-board").getByText("FR-03 活动字幕项目", { exact: true }).waitFor();
  await page.getByPlaceholder("标题或文件名").fill("活动字幕");
  assert.equal(await page.locator(".project-row").count(), 1);
  await page.getByPlaceholder("标题或文件名").fill("");
  await page.getByRole("button", { name: "选择项目", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择项目 FR-03 活动字幕项目", exact: true }).check();
  await page.locator('[aria-label="批量项目操作"]').waitFor();
  await page.getByRole("button", { name: "退出选择", exact: true }).click();
  await capture(page, "workspace-projects");

  await go(page, "/workspace/archive", "项目与任务");
  await page.locator(".project-board").getByText("FR-03 已归档项目", { exact: true }).waitFor();
  await go(page, "/workspace/recycle", "项目与任务");
  await page.locator(".project-board").getByText("FR-03 回收站项目", { exact: true }).waitFor();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await page.getByText("已恢复“FR-03 回收站项目”。", { exact: true }).waitFor();
  await expect.poll(async () => page.evaluate(async () => {
    const result = await window.desktop.openProject({ projectId: "fr03-trashed" });
    return result.ok && !result.data.trashedAt;
  })).toBe(true);

  await go(page, "/workspace/tasks", "项目与任务");
  await page.getByText("完成", { exact: true }).first().waitFor();

  await go(page, `/projects/${activeProjectId}/settings`, "项目设置与资产");
  await page.getByLabel("默认导出").selectOption("VTT");
  await page.getByRole("button", { name: "保存项目方案", exact: true }).click();
  await page.getByText(/项目方案已进入自动保存/).waitFor();
  await expect.poll(async () => page.evaluate(async (projectId) => {
    const result = await window.desktop.openProject({ projectId });
    return result.ok ? result.data.config.outputFormat : "";
  }, activeProjectId)).toBe("VTT");
  await page.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect.poll(async () => page.evaluate(async (projectId) => {
    const result = await window.desktop.openProject({ projectId });
    return result.ok && Boolean(result.data.archivedAt);
  }, activeProjectId)).toBe(true);
  await page.getByRole("button", { name: "取消归档", exact: true }).click();
  await capture(page, "project-settings");

  await go(page, "/batch/review", "批量处理");
  await page.getByText("没有活动批次", { exact: true }).waitFor();
  await capture(page, "batch-empty");

  await go(page, "/library", "资源库");
  await page.getByText("FR-03 术语表", { exact: true }).first().waitFor();
  const libraryTabs = page.locator('.library-kind-tabs [role="tab"]');
  assert.equal(await libraryTabs.count(), 4);
  for (let index = 0; index < 4; index += 1) await libraryTabs.nth(index).click();
  await libraryTabs.first().click();
  await page.getByPlaceholder("名称或说明").fill("FR-03");
  await page.getByText("FR-03 术语表", { exact: true }).first().waitFor();

  // 有数据时是三列，第三列回答"我能安全改它吗"：这份术语表已被项目快照捕获。
  await expect(page.locator(".library-usage")).toBeVisible();
  await expect(page.locator(".library-usage").getByText("关联项目")).toBeVisible();
  await expect(page.locator(".library-usage-verdict")).toContainText(/快照|影响/);
  await capture(page, "resource-library");


  await go(page, "/system/providers", "翻译 Provider");
  await page.getByText("凭据已保存", { exact: true }).waitFor();
  await page.getByRole("button", { name: "测试真实连接", exact: true }).click();
  const providerDialog = page.getByRole("dialog", { name: "测试真实 Provider 连接？" });
  await expect(providerDialog).toContainText("可能消耗服务商额度或产生少量费用");
  await providerDialog.getByRole("button", { name: "确认并测试", exact: true }).click();
  await page.getByText("连接测试通过", { exact: true }).waitFor({ timeout: 30_000 });
  await capture(page, "provider-ready");

  await go(page, "/system/asr", "本地语音识别");
  await page.getByRole("heading", { name: "识别模型", exact: true }).waitFor();
  const deviceGroup = page.getByRole("group", { name: "ASR 设备偏好", exact: true });
  await deviceGroup.getByRole("button", { name: "CPU", exact: true }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const result = await window.desktop.getAsrDeviceStatus();
    return result.ok ? result.data.requestedDevice : "";
  })).toBe("cpu");
  await capture(page, "asr-maintenance");

  // 转写是项目内阶段，只能从项目进入；原先那个"请先选个项目"的落地页已随侧栏收拢一并移除。
  await go(page, "/projects/fr03-media-missing/media", "转写");
  await page.getByText("源媒体当前不可用", { exact: true }).waitFor();
  // 媒体缺失时不会伪造播放器画面，也不会有时间轴可渲染，所以真实空态是"没有可用预览"。
  await page.getByText("没有可用预览", { exact: true }).waitFor();
  await capture(page, "media-missing");

  await go(page, "/system/settings", "设置与能力中心");
  await page.getByLabel("启动页面").selectOption("projects");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("系统设置已持久化；路径修改将在下次启动应用后生效。", { exact: true }).waitFor();
  await capture(page, "system-settings-general");
  await page.getByRole("tab", { name: /备份与诊断/ }).click();
  await page.getByRole("button", { name: "生成脱敏预览", exact: true }).click();
  await page.getByText("诊断包已脱敏并可预览；确认内容后再导出。", { exact: true }).waitFor();
  const diagnosticText = await page.locator(".diagnostic-entries").innerText();
  assert.equal(diagnosticText.includes(userDataDir), false);
  assert.equal(diagnosticText.includes("sk-fr03-local-fixture-not-real"), false);
  await page.getByRole("button", { name: "备份应用设置与资源", exact: true }).click();
  await page.getByText(/应用备份已创建：/).waitFor();
  await capture(page, "system-settings-backup");
  await page.getByRole("tab", { name: /关于/ }).click();
  assert.equal(await page.getByRole("button", { name: /检查更新/ }).count(), 0);

  const finalSettings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(finalSettings.ok, true);
  assert.equal(finalSettings.data.startupPage, "projects");
  console.log(`FR-03 capability E2E passed: ${activeProjectId}`);
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
