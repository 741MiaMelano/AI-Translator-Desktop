import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { _electron as electron } from "@playwright/test";
import { stageVerifiedAsrAssets } from "./asr-phase7-e2e.mjs";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

const releaseRoot = process.env.PHASE14_PACKAGED_ROOT;
const userDataDir = process.env.PHASE14_USER_DATA_DIR;
const materialRoot = process.env.PHASE14_MATERIAL_ROOT;
for (const [label, path] of [["packaged root", releaseRoot], ["user data", userDataDir], ["material root", materialRoot]]) {
  assert.ok(path && isAbsolute(path), `${label} must be an absolute path`);
}

const executable = join(releaseRoot, "AI Translator Desktop.exe");
const resources = join(releaseRoot, "resources");
const exportDir = join(userDataDir, "批量导出");
const backupRestorePath = join(userDataDir, "backups", "ai-translator-app-backup.json");
const screenshotDir = process.env.PHASE14_SCREENSHOT_DIR ?? null;
const materialPaths = ["英语视频.mp4", "英语音频.m4a", "x.en.srt"].map((name) => join(materialRoot, name));
for (const path of [executable, ...materialPaths]) assert.equal(existsSync(path), true, `missing release-candidate input: ${path}`);
mkdirSync(userDataDir, { recursive: true });
mkdirSync(exportDir, { recursive: true });
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

await stageVerifiedAsrAssets({
  userDataDir,
  includeRuntime: false,
  manifestPath: join(resources, "asr", "manifest.json"),
  trustedNoticeRoot: join(resources, "asr", "licenses"),
});

async function launch() {
  const launched = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      TRANSLATION_FAKE_PROVIDER: "1",
      SUBTITLE_E2E_EXPORT_DIR: exportDir,
      PHASE14_E2E_BACKUP_RESTORE_PATH: backupRestorePath,
    },
    timeout: 60_000,
  });
  const page = await launched.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  return { launched, page };
}

let app;
try {
  let opened = await launch();
  app = opened.launched;
  let page = opened.page;
  await page.getByTestId("first-run-readiness").waitFor({ timeout: 30_000 });
  await page.getByText("FFmpeg 已内置并通过校验", { exact: true }).waitFor();
  await page.getByText("本地语音识别已经就绪", { exact: true }).waitFor();
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "first-run-readiness.png") });

  await page.getByRole("link", { name: "模型与连接" }).click();
  await page.getByLabel("API Key").fill("sk-release-candidate-local-fake");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("密钥已保存", { exact: true }).waitFor();
  await page.getByRole("button", { name: "测试连接" }).click();
  await page.getByText("连接测试通过", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("link", { name: "开始翻译" }).click();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入文件" }).click();
  await (await chooser).setFiles(materialPaths);
  await page.getByRole("heading", { name: "批量处理" }).waitFor({ timeout: 60_000 });

  const startButton = page.getByRole("button", { name: /开始处理 \d+ 个项目/ });
  await startButton.waitFor();
  const projectCount = Number.parseInt((await startButton.innerText()).match(/\d+/)?.[0] ?? "0", 10);
  assert.ok(projectCount >= 2 && projectCount <= 3, `unexpected batch grouping: ${projectCount}`);
  await startButton.click();

  await page.getByText("源字幕疑似损坏，需要先检查后才能安全翻译。", { exact: true }).waitFor({ timeout: 600_000 });
  const exportButton = page.getByRole("button", { name: /批准并导出 \d+ 个项目/ });
  await exportButton.waitFor({ timeout: 600_000 });
  const exportCount = Number.parseInt((await exportButton.innerText()).match(/\d+/)?.[0] ?? "0", 10);
  assert.ok(exportCount > 0 && exportCount < projectCount, `quality gate did not isolate the damaged subtitle: ${exportCount}/${projectCount}`);
  await exportButton.click();
  await page.getByText(`已导出 ${exportCount} 份字幕，保存文件夹只选择了一次。`, { exact: true }).waitFor({ timeout: 60_000 });
  assert.ok(readdirSync(exportDir).filter((name) => name.toLowerCase().endsWith(".srt")).length >= exportCount);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "installed-mixed-batch-delivered.png") });

  const settings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(settings.ok, true, JSON.stringify(settings));
  const beforeBackup = await page.evaluate((current) => window.desktop.saveAppSettings({ settings: {
    ...current,
    notifications: { ...current.notifications, release: false },
  } }), settings.data);
  assert.equal(beforeBackup.ok, true, JSON.stringify(beforeBackup));
  const backup = await page.evaluate(() => window.desktop.createAppBackup());
  assert.equal(backup.ok, true, JSON.stringify(backup));
  assert.equal(backup.data.fileName, "ai-translator-app-backup.json");
  assert.equal(readFileSync(backupRestorePath, "utf8").includes("sk-release-candidate-local-fake"), false);
  const changed = await page.evaluate((current) => window.desktop.saveAppSettings({ settings: {
    ...current,
    notifications: { ...current.notifications, release: true },
  } }), beforeBackup.data);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  const selected = await page.evaluate(() => window.desktop.selectBackupRestore({ kind: "app" }));
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const restored = await page.evaluate((token) => window.desktop.applyBackupRestore({ token, userConfirmed: true }), selected.data.token);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const restoredSettings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(restoredSettings.data.notifications.release, false);

  await closeElectronApp(app);
  app = undefined;
  opened = await launch();
  app = opened.launched;
  page = opened.page;
  await page.getByRole("link", { name: "项目" }).click();
  const reopenedProjects = await page.evaluate(() => window.desktop.listRecentProjects({ limit: 20 }));
  assert.equal(reopenedProjects.ok, true);
  assert.ok(reopenedProjects.data.length >= projectCount);
  const reopenedSettings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(reopenedSettings.data.notifications.release, false);

  console.log(`Phase 14 P0 mixed batch passed: 3 materials -> ${projectCount} projects -> ${exportCount} delivered + damaged timeline blocked -> backup restore`);
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
}
