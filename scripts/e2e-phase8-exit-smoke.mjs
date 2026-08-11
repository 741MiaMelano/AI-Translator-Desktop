import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packaged = process.argv.includes("--packaged");
const executablePath = packaged
  ? join(rootDir, "release", "win-unpacked", "AI Translator Desktop.exe")
  : electronPath;

function exitProject(id) {
  return {
    id, title: `Phase 8 Exit ${id}`, sourceFileName: `${id}.srt`, mediaKind: "subtitle",
    noSourceMedia: true, lifecycle: "draft", createdAt: "2026-07-22 12:00", updatedAt: "2026-07-22 12:00",
    activeSourceTrackId: `source-${id}`, pendingConfirmations: [], notes: [],
    config: { sourceLanguage: "en", targetLanguages: ["zh-CN"], provider: "OpenAI", model: "GPT-4.1", glossary: "none", styleGuide: "none", outputFormat: "SRT", budgetUsd: 5, burnVideo: false, copyMediaIntoProject: false },
    sourceTracks: [{ id: `source-${id}`, label: "Main", kind: "external_subtitle", languageState: "known", defaultLanguage: "en", isActive: true, summary: "exit e2e",
      segments: [{ id: `segment-${id}`, start: "00:00:01,000", end: "00:00:02,000", sourceLanguage: "en", sourceText: { original: "Hello", normalized: "Hello" }, targetTexts: { "zh-CN": { model: "", postProcessed: "", qaFlags: [] } } }],
      targetTracks: [{ id: `target-${id}`, languageCode: "zh-CN", languageLabel: "Chinese", status: "draft", isActive: true, qaIssues: [], snapshotIds: [], deliveryLabel: "draft", lastHumanAction: "none" }],
    }], recentRunIds: [],
  };
}

async function launchApp(userDataDir, choice, delayMs = 6_000) {
  const app = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : ["."]), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", TRANSLATION_FAKE_PROVIDER: "1", TRANSLATION_FAKE_DELAY_MS: String(delayMs), PHASE8_E2E_EXIT_CHOICE: choice },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  return { app, page };
}

async function start(page, project) {
  await page.evaluate(async (value) => {
    await window.desktop.saveCredential({ credentialId: "openai-default", secret: "sk-phase8-exit-not-real", providerId: "openai", label: "OpenAI" });
    await window.desktop.testProviderConnection({ provider: "OpenAI", credentialId: "openai-default", model: "GPT-4.1" });
    await window.desktop.createProject({ project: value });
  }, project);
  return page.evaluate((projectId) => window.desktop.startTranslation({ projectId, userConfirmed: true, price: { inputPer1M: 2, outputPer1M: 8 } }), project.id);
}

async function task(page, projectId) {
  return page.evaluate(async (id) => {
    const result = await window.desktop.subscribeTasks({ projectId: id });
    return result.ok ? result.data.tasks[0] : null;
  }, projectId);
}

async function waitRunning(page, projectId) {
  await expect.poll(async () => (await task(page, projectId))?.status, { timeout: 10_000 }).toBe("running");
}

async function windowVisible(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
}

async function cleanup(app, userDataDir) {
  await closeElectronApp(app);
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch (error) { console.warn(`Phase 8 exit cleanup deferred: ${error.code ?? error}`); }
}

async function runBackground() {
  const userDataDir = mkdtempSync(`${tmpdir()}\\phase8-exit-background-`); let app;
  try {
    const launched = await launchApp(userDataDir, "background"); app = launched.app; const project = exitProject("exit-background"); const pending = start(launched.page, project);
    await waitRunning(launched.page, project.id); await launched.page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(() => windowVisible(app), { timeout: 10_000 }).toBe(false);
    assert.equal((await task(launched.page, project.id)).status, "running");
    const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
    await expect.poll(async () => (await task(launched.page, project.id)).status, { timeout: 10_000 }).toBe("completed");
    assert.equal(await windowVisible(app), false); console.log(`Phase 8 ${packaged ? "packaged" : "development"} background exit smoke passed`);
  } finally { await cleanup(app, userDataDir); }
}

async function runCancel() {
  const userDataDir = mkdtempSync(`${tmpdir()}\\phase8-exit-cancel-`); let app;
  try {
    const launched = await launchApp(userDataDir, "cancel"); app = launched.app; const project = exitProject("exit-cancel"); const pending = start(launched.page, project);
    await waitRunning(launched.page, project.id); await launched.page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(() => windowVisible(app), { timeout: 10_000 }).toBe(true);
    assert.equal((await task(launched.page, project.id)).status, "running");
    const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
    console.log(`Phase 8 ${packaged ? "packaged" : "development"} cancel-exit smoke passed`);
  } finally { await cleanup(app, userDataDir); }
}

async function runStop() {
  const userDataDir = mkdtempSync(`${tmpdir()}\\phase8-exit-stop-`); let app;
  try {
    let launched = await launchApp(userDataDir, "stop"); app = launched.app; const project = exitProject("exit-stop"); const pending = start(launched.page, project).catch(() => null);
    await waitRunning(launched.page, project.id); const closed = app.waitForEvent("close", { timeout: 20_000 }); await launched.page.getByRole("button", { name: "关闭", exact: true }).click(); await closed; await pending; app = undefined;
    launched = await launchApp(userDataDir, "cancel", 0); app = launched.app;
    await expect.poll(async () => (await task(launched.page, project.id))?.status, { timeout: 10_000 }).toBe("cancelled");
    console.log(`Phase 8 ${packaged ? "packaged" : "development"} stop-and-exit smoke passed`);
  } finally { await cleanup(app, userDataDir); }
}

await runBackground();
await runCancel();
await runStop();
