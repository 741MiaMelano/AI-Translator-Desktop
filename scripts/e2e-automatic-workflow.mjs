import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { createPhase7UserDataDir, stageVerifiedAsrAssets } from "./asr-phase7-e2e.mjs";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";
import { resolveVerifiedArtifactPaths } from "../backend/media/ffmpeg-artifact-manifest.mjs";
import { runManagedProcess } from "../backend/media/process-runner.mjs";

process.noDeprecation = true;

const materialRoot = process.env.AUTOMATIC_WORKFLOW_MATERIAL_ROOT;
assert.ok(materialRoot, "AUTOMATIC_WORKFLOW_MATERIAL_ROOT is required");
const videoPath = resolve(materialRoot, process.env.AUTOMATIC_WORKFLOW_VIDEO ?? "英语视频.mp4");
const audioPath = resolve(materialRoot, process.env.AUTOMATIC_WORKFLOW_AUDIO ?? "英语音频.m4a");
assert.equal(existsSync(videoPath), true, `missing video material: ${videoPath}`);
assert.equal(existsSync(audioPath), true, `missing audio material: ${audioPath}`);
const screenshotDir = process.env.AUTOMATIC_WORKFLOW_SCREENSHOT_DIR
  ? resolve(process.env.AUTOMATIC_WORKFLOW_SCREENSHOT_DIR)
  : null;
const packagedExecutable = process.env.AUTOMATIC_WORKFLOW_EXECUTABLE
  ? resolve(process.env.AUTOMATIC_WORKFLOW_EXECUTABLE)
  : null;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

const userDataDir = createPhase7UserDataDir("automatic-workflow");
const acceptanceAsrRoot = process.env.AUTOMATIC_WORKFLOW_ASR_ROOT;
const acceptanceRoot = resolve(process.env.LOCALAPPDATA, "AI Translator Phase7 Acceptance");
assert.ok(resolve(userDataDir).startsWith(`${acceptanceRoot}${sep}`));
let app;
const fixtureRoot = mkdtempSync(join(tmpdir(), "automatic-confirmation-"));

async function createMultiAudioFixture() {
  const tools = resolveVerifiedArtifactPaths(
    JSON.parse(readFileSync(resolve("docs/third-party/ffmpeg/manifest.json"), "utf8")),
    { artifactRootDir: resolve("resources/ffmpeg/win32-x64") },
  );
  const output = join(fixtureRoot, "多音轨确认.mkv");
  await runManagedProcess({
    absoluteExe: tools.ffmpegPath,
    argv: [
      "-hide_banner", "-nostdin", "-y", "-i", audioPath,
      "-map", "0:a:0", "-map", "0:a:0", "-c:a", "copy",
      "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=eng",
      "-disposition:a:0", "0", "-disposition:a:1", "0",
      output,
    ],
    timeoutMs: 60_000,
  });
  return output;
}

async function launch(materialPath) {
  const launchTimeout = packagedExecutable ? 180_000 : 60_000;
  const launched = await electron.launch({
    executablePath: packagedExecutable ?? electronPath,
    args: [...(packagedExecutable ? [] : ["."]), `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      TRANSLATION_FAKE_PROVIDER: "1",
      MEDIA_E2E_FIXTURE_PATH: materialPath,
    },
    timeout: launchTimeout,
  });
  const page = await launched.firstWindow({ timeout: launchTimeout });
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await launched.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await page.getByRole("heading", { name: "开始翻译" }).waitFor();
  return { app: launched, page };
}

async function configureFakeProvider(page) {
  await page.getByRole("link", { name: "模型与连接" }).click();
  await page.getByRole("button", { name: "DeepSeek api.deepseek.com", exact: true }).click();
  await page.getByLabel("API Key").fill("sk-automatic-workflow-local-fake");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("密钥已保存", { exact: true }).waitFor();
  await page.getByText("配置已保存；首次使用时会自动检查连接。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "拉取" }).click();
  await page.getByText("已拉取 2 个模型。", { exact: true }).waitFor();
  await page.getByLabel("模型").selectOption("fake-model-b");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("配置已保存；首次使用时会自动检查连接。", { exact: true }).waitFor();
  const settings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(settings.ok, true);
  assert.equal(settings.data.translationProvider, "DeepSeek");
  assert.equal(settings.data.translationModel, "fake-model-b");
  const providerStatus = page.locator(".top-status-pill");
  await expect(providerStatus).toContainText("DeepSeek · fake-model-b");
  await expect(providerStatus).toContainText("可用");
  await page.getByRole("link", { name: "开始翻译" }).click();
  await page.getByRole("link", { name: "模型与连接" }).click();
  assert.equal(
    await page.getByRole("button", { name: "DeepSeek api.deepseek.com", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await expect(page.getByLabel("模型")).toHaveValue("fake-model-b");
  assert.deepEqual(await page.getByLabel("模型").locator("option").allTextContents(), ["fake-model-a", "fake-model-b"]);
  await page.getByRole("link", { name: "开始翻译" }).click();
}

async function importFile(page, filePath) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-files").click();
  await (await chooser).setFiles(filePath);
}

async function runMaterial(page, { materialPath, title, screenshotPrefix }) {
  await importFile(page, materialPath);
  await page.getByRole("heading", { name: title }).waitFor({ timeout: 30_000 });
  const launchButton = page.getByRole("button", { name: "生成字幕并翻译" });
  await expect(launchButton).toBeEnabled();
  await launchButton.click();
  const banner = page.getByTestId("automatic-workflow-banner");
  await banner.waitFor({ timeout: 30_000 });
  await expect(banner).toContainText("正在自动处理");
  if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${screenshotPrefix}-running.png`), fullPage: true });
  try {
    await page.getByText("待校对").first().waitFor({ timeout: 300_000 });
  } catch (error) {
    console.error(`${title} automatic workflow page:`, (await page.locator("body").innerText()).slice(0, 4000));
    throw error;
  }
  const projectId = await page.evaluate(() => window.location.hash.split("/")[2]);
  assert.ok(projectId);
  const opened = await page.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
  assert.equal(opened.ok, true);
  const source = opened.data.sourceTracks.find((track) => track.id === opened.data.activeSourceTrackId);
  if (!source) {
    console.error("Automatic workflow source mismatch:", JSON.stringify({
      projectId,
      activeSourceTrackId: opened.data.activeSourceTrackId,
      sourceTracks: opened.data.sourceTracks.map((track) => ({ id: track.id, kind: track.kind, isActive: track.isActive })),
    }));
  }
  assert.equal(source?.kind, "asr");
  assert.ok(source.segments.length > 0);
  assert.ok(source.targetTracks.some((track) => track.isActive));
  if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${screenshotPrefix}-complete.png`), fullPage: true });
  return { projectId, segmentCount: source.segments.length };
}

async function runMultiTrackConfirmation(page, materialPath) {
  await importFile(page, materialPath);
  await page.getByRole("heading", { name: "多音轨确认" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "生成字幕并翻译" }).click();
  const banner = page.getByTestId("automatic-workflow-banner");
  await expect(banner).toContainText("只需要确认一件事");
  await expect(banner).toContainText("这段内容来自哪条音轨？");
  const radios = banner.getByRole("radio");
  await expect(radios).toHaveCount(2);
  const selectedStreamId = await radios.nth(1).getAttribute("value");
  assert.ok(selectedStreamId);
  await banner.getByText(/音轨 2/).click();
  await expect(radios.nth(1)).toBeChecked();
  if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, "automatic-audio-confirmation.png"), fullPage: true });
  await banner.getByRole("button", { name: "确认并继续" }).click();
  await expect(banner).toContainText("本地语音识别组件尚未就绪", { timeout: 30_000 });
  await stageVerifiedAsrAssets({
    userDataDir,
    ...(acceptanceAsrRoot ? {
      fixtureRoot: join(acceptanceAsrRoot, "models", "small"),
      runtimeFixtureRoot: join(acceptanceAsrRoot, "runtimes", "whisper-cpp-cpu-x64"),
    } : {}),
  });
  const retry = page.getByRole("button", { name: "重新检查并继续" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(banner).toContainText("正在自动处理", { timeout: 30_000 });
  const recent = await page.evaluate(() => window.desktop.listRecentProjects({ limit: 5 }));
  assert.equal(recent.ok, true);
  const opened = await page.evaluate(
    (projectId) => window.desktop.openProject({ projectId }),
    recent.data[0].id,
  );
  assert.equal(opened.ok, true);
  assert.equal(opened.data.mediaSource.confirmedAudioStreamId, selectedStreamId);
  await banner.getByRole("button", { name: "停止" }).click();
  console.log("Automatic multi-track confirmation E2E passed");
}

try {
  const multiAudioPath = await createMultiAudioFixture();
  let launched = await launch(multiAudioPath);
  app = launched.app;
  await configureFakeProvider(launched.page);
  await runMultiTrackConfirmation(launched.page, multiAudioPath);
  await closeElectronApp(app);
  app = undefined;

  launched = await launch(videoPath);
  app = launched.app;
  const restartedSettings = await launched.page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(restartedSettings.ok, true);
  assert.equal(restartedSettings.data.translationProvider, "DeepSeek");
  assert.equal(restartedSettings.data.translationModel, "fake-model-b");
  const video = await runMaterial(launched.page, { materialPath: videoPath, title: "英语视频", screenshotPrefix: "automatic-video" });
  await closeElectronApp(app);
  app = undefined;

  launched = await launch(audioPath);
  app = launched.app;
  const audio = await runMaterial(launched.page, { materialPath: audioPath, title: "英语音频", screenshotPrefix: "automatic-audio" });
  await closeElectronApp(app);
  app = undefined;
  console.log(`Automatic workflow E2E passed: video ${video.segmentCount} segments, audio ${audio.segmentCount} segments`);
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
