import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { createPhase7UserDataDir, resolvePhase7ModelId, stageVerifiedAsrAssets } from "./asr-phase7-e2e.mjs";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";
import { resolveVerifiedArtifactPaths } from "../backend/media/ffmpeg-artifact-manifest.mjs";
import { runManagedProcess } from "../backend/media/process-runner.mjs";

process.noDeprecation = true;

const materialRoot = process.env.AUTOMATIC_WORKFLOW_MATERIAL_ROOT;
assert.ok(materialRoot, "AUTOMATIC_WORKFLOW_MATERIAL_ROOT is required");
const videoPath = resolve(materialRoot, process.env.AUTOMATIC_WORKFLOW_VIDEO ?? "英语视频.mp4");
const audioPath = resolve(materialRoot, process.env.AUTOMATIC_WORKFLOW_AUDIO ?? "英语音频.m4a");
const videoTitle = basename(videoPath, extname(videoPath));
const audioTitle = basename(audioPath, extname(audioPath));
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
const acceptanceRoot = resolve(process.env.LOCALAPPDATA, "AI Translator Phase7 Acceptance");
assert.ok(resolve(userDataDir).startsWith(`${acceptanceRoot}${sep}`));
let app;
let primaryError;
const fixtureRoot = mkdtempSync(join(tmpdir(), "automatic-confirmation-"));

async function removeTemporaryTree(path, { maxRetries, retryDelay }) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries, retryDelay });
    return;
  } catch (firstError) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: maxRetries * 2, retryDelay });
      return;
    } catch (secondError) {
      throw new AggregateError([firstError, secondError], `failed to remove temporary tree: ${basename(path)}`);
    }
  }
}

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
  await page.locator(".app-shell").waitFor();
  return { app: launched, page };
}

async function configureFakeProvider(page) {
  await page.evaluate(() => { window.location.hash = "/system/providers"; });
  await page.getByRole("heading", { name: "翻译 Provider" }).waitFor();
  const deepSeek = page.locator(".capability-rail-list button").filter({ hasText: "DeepSeek" }).first();
  await deepSeek.click();
  await page.getByLabel("API Key").fill("sk-automatic-workflow-local-fake");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("配置已保存；首次使用时会自动检查连接。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "拉取真实模型", exact: true }).click();
  await page.getByRole("dialog", { name: "连接 Provider 拉取模型？" }).getByRole("button", { name: "确认并拉取", exact: true }).click();
  await page.getByText("已拉取 2 个模型。", { exact: true }).waitFor();
  await page.getByLabel("模型 ID").fill("fake-model-b");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("配置已保存；首次使用时会自动检查连接。", { exact: true }).waitFor();
  const settings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(settings.ok, true);
  assert.equal(settings.data.translationProvider, "DeepSeek");
  assert.equal(settings.data.translationModel, "fake-model-b");
  await page.evaluate(() => { window.location.hash = "/"; });
  await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor();
  await page.evaluate(() => { window.location.hash = "/system/providers"; });
  await page.getByRole("heading", { name: "翻译 Provider" }).waitFor();
  assert.equal(
    await page.locator(".capability-rail-list button").filter({ hasText: "DeepSeek" }).first().getAttribute("class"),
    "is-active",
  );
  await expect(page.getByLabel("模型 ID")).toHaveValue("fake-model-b");
  assert.deepEqual(
    await page.locator("#provider-model-options option").evaluateAll((options) => options.map((option) => option.value)),
    ["fake-model-a", "fake-model-b"],
  );
  await page.evaluate(() => { window.location.hash = "/"; });
  await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor();
}

async function importFile(page, filePath) {
  await page.evaluate(() => { window.location.hash = "/import"; });
  await page.getByRole("heading", { name: "先选择一个素材", exact: true }).waitFor();
  await page.locator('input[type="file"]').setInputFiles(filePath);
  await page.getByRole("heading", { name: "确认真实翻译方案", exact: true }).waitFor({ timeout: 30_000 });
}

async function commitSingleImport(page, title) {
  const provider = page.locator(".production-choice-fields label").filter({ hasText: "Provider" }).locator("select");
  const model = page.locator(".production-choice-fields label").filter({ hasText: "模型" }).locator("select");
  await expect(provider).toHaveValue("DeepSeek");
  await expect(model).toHaveValue("fake-model-b");
  await page.getByRole("button", { name: /确认方案/ }).click();
  await page.getByRole("heading", { name: "项目可以创建了", exact: true }).waitFor();
  await page.getByRole("button", { name: /创建项目并进入工作区/ }).click();
  await page.locator('[data-fr02-view="project"]').waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  const projectId = await page.evaluate(() => window.location.hash.split("/")[2]);
  assert.ok(projectId);
  return projectId;
}

async function startConfirmedWorkflow(page) {
  const action = page.locator(".next-action .btn-primary");
  await action.click();
  const dialog = page.getByRole("dialog", { name: "确认开始真实处理", exact: true });
  await dialog.waitFor();
  await expect(dialog).toContainText("Provider 请求可能产生费用");
  await dialog.getByRole("button", { name: "确认并开始", exact: true }).click();
}

async function runMaterial(page, { materialPath, title, screenshotPrefix }) {
  await importFile(page, materialPath);
  const projectId = await commitSingleImport(page, title);
  await startConfirmedWorkflow(page);
  await expect(page.locator(".progress-panel")).toContainText(/排队中|运行中|语音识别|翻译/, { timeout: 30_000 });
  if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${screenshotPrefix}-running.png`), fullPage: true });
  try {
    await page.getByText("待校对").first().waitFor({ timeout: 300_000 });
  } catch (error) {
    console.error(`${title} automatic workflow page:`, (await page.locator("body").innerText()).slice(0, 4000));
    throw error;
  }
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
  const projectId = await commitSingleImport(page, "多音轨确认");
  await startConfirmedWorkflow(page);
  const resolution = page.locator(".workflow-resolution");
  await expect(resolution).toContainText("这段内容来自哪条音轨？", { timeout: 30_000 });
  const choices = resolution.getByRole("button");
  await expect(choices).toHaveCount(2);
  const beforeChoice = await page.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
  assert.equal(beforeChoice.ok, true);
  const audioStreams = beforeChoice.data.sourceProbeSummary?.media?.streams?.filter((stream) => stream.kind === "audio") ?? [];
  assert.equal(audioStreams.length, 2);
  const selectedStreamId = audioStreams.find((stream) => stream.index === 1)?.streamId;
  assert.ok(selectedStreamId);
  await choices.filter({ hasText: /^音轨 2/ }).click();
  if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, "automatic-audio-confirmation.png"), fullPage: true });
  await page.getByRole("alert").getByText("本地语音识别组件尚未就绪。", { exact: true }).waitFor({ timeout: 30_000 });
  const afterChoice = await page.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
  assert.equal(afterChoice.ok, true);
  assert.equal(afterChoice.data.mediaSource.confirmedAudioStreamId, selectedStreamId);
  await stageVerifiedAsrAssets({ userDataDir });
  const selectedModel = resolvePhase7ModelId();
  const currentSettings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(currentSettings.ok, true);
  const selectedSettings = await page.evaluate(
    ({ settings, modelId }) => window.desktop.saveAppSettings({ settings: { ...settings, asrDefaultModelId: modelId } }),
    { settings: currentSettings.data, modelId: selectedModel },
  );
  assert.equal(selectedSettings.ok, true);
  assert.equal(selectedSettings.data.asrDefaultModelId, selectedModel);
  await startConfirmedWorkflow(page);
  const stopControl = page.locator(".next-action .btn-primary, .task-controls .danger-link")
    .filter({ hasText: /停止|取消任务/ }).first();
  try {
    await stopControl.waitFor({ timeout: 30_000 });
  } catch (error) {
    const [status, capability] = await Promise.all([
      page.evaluate((id) => window.desktop.getAsrProjectStatus({ projectId: id }), projectId),
      page.evaluate(() => window.desktop.getAsrCapabilityStatus({})),
    ]);
    console.error("Automatic retry state:", JSON.stringify({ status, capability, page: (await page.locator("body").innerText()).slice(0, 5_000) }));
    throw error;
  }
  await stopControl.click();
  await expect.poll(async () => {
    const runtime = await page.evaluate((id) => window.desktop.getProjectRuntimeState({ projectId: id }), projectId);
    return runtime.ok && runtime.data.tasks.every((task) => !["pending", "running", "pausing", "paused", "cancelling", "recoverable"].includes(task.status));
  }, { timeout: 30_000 }).toBe(true);
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
  const video = await runMaterial(launched.page, { materialPath: videoPath, title: videoTitle, screenshotPrefix: "automatic-video" });
  await closeElectronApp(app);
  app = undefined;

  launched = await launch(audioPath);
  app = launched.app;
  const audio = await runMaterial(launched.page, { materialPath: audioPath, title: audioTitle, screenshotPrefix: "automatic-audio" });
  await closeElectronApp(app);
  app = undefined;
  console.log(`Automatic workflow E2E passed: video ${video.segmentCount} segments, audio ${audio.segmentCount} segments`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  const cleanupErrors = [];
  for (const [path, options] of [
    [userDataDir, { maxRetries: 20, retryDelay: 250 }],
    [fixtureRoot, { maxRetries: 5, retryDelay: 200 }],
  ]) {
    try {
      await removeTemporaryTree(path, options);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length && !primaryError) throw new AggregateError(cleanupErrors, "automatic workflow cleanup failed");
  if (cleanupErrors.length) console.warn(`Automatic workflow cleanup also failed: ${cleanupErrors.map((error) => error.message).join(", ")}`);
}
