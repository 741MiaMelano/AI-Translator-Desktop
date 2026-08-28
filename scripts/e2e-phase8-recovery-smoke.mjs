import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

function recoveryProject(id) {
  return {
    id,
    title: `Phase 8 Recovery ${id}`,
    sourceFileName: `${id}.srt`,
    mediaKind: "subtitle",
    noSourceMedia: true,
    lifecycle: "draft",
    createdAt: "2026-07-22 12:00",
    updatedAt: "2026-07-22 12:00",
    activeSourceTrackId: `source-${id}`,
    pendingConfirmations: [],
    notes: [],
    config: {
      sourceLanguage: "en",
      targetLanguages: ["zh-CN"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "none",
      styleGuide: "none",
      outputFormat: "SRT",
      budgetUsd: 5,
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [{
      id: `source-${id}`,
      label: "Main",
      kind: "external_subtitle",
      languageState: "known",
      defaultLanguage: "en",
      isActive: true,
      summary: "recovery e2e",
      segments: [{
        id: `segment-${id}`,
        start: "00:00:01,000",
        end: "00:00:02,000",
        sourceLanguage: "en",
        sourceText: { original: "Hello", normalized: "Hello" },
        targetTexts: { "zh-CN": { model: "", postProcessed: "", qaFlags: [] } },
      }],
      targetTracks: [{
        id: `target-${id}`,
        languageCode: "zh-CN",
        languageLabel: "Chinese",
        status: "draft",
        isActive: true,
        qaIssues: [],
        snapshotIds: [],
        deliveryLabel: "draft",
        lastHumanAction: "none",
      }],
    }],
    recentRunIds: [],
  };
}

async function launchApp(userDataDir, delayMs = 0) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      TRANSLATION_FAKE_PROVIDER: "1",
      TRANSLATION_FAKE_DELAY_MS: String(delayMs),
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  return { app, page };
}

async function seedProject(page, project) {
  await page.evaluate(async (value) => {
    await window.desktop.saveCredential({
      credentialId: "openai-default",
      secret: "sk-phase8-recovery-not-real",
      providerId: "openai",
      label: "OpenAI",
    });
    await window.desktop.testProviderConnection({
      provider: "OpenAI",
      credentialId: "openai-default",
      model: "GPT-4.1",
    });
    await window.desktop.createProject({ project: value });
  }, project);
}

function startTranslation(page, projectId) {
  return page.evaluate((projectId) => window.desktop.startTranslation({
    projectId,
    userConfirmed: true,
    price: { inputPer1M: 2, outputPer1M: 8 },
  }), projectId);
}

async function seedAndStart(page, project) {
  await seedProject(page, project);
  return startTranslation(page, project.id);
}

async function publicTask(page, projectId) {
  return page.evaluate(async (id) => {
    const result = await window.desktop.subscribeTasks({ projectId: id });
    return result.ok ? result.data.tasks[0] : null;
  }, projectId);
}

async function translatedText(page, projectId) {
  return page.evaluate(async (id) => {
    const result = await window.desktop.openProject({ projectId: id });
    return result.ok ? result.data?.sourceTracks[0]?.segments[0]?.targetTexts["zh-CN"]?.model ?? "" : "";
  }, projectId);
}

async function supervisorPid(app) {
  await expect.poll(() => app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()
    .filter((metric) => metric.name === "Task Supervisor").length), {
    timeout: 10_000,
  }).toBe(1);
  const pids = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()
    .filter((metric) => metric.name === "Task Supervisor")
    .map((metric) => metric.pid));
  assert.equal(pids.length, 1, "one Task Supervisor must own active work");
  return pids[0];
}

async function explicitlyResume(page, task) {
  const result = await page.evaluate((request) => window.desktop.controlTask(request), {
    taskId: task.id,
    projectId: task.projectId,
    action: "resume",
    userConfirmed: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
}

async function waitForCompletedText(page, projectId) {
  await expect.poll(async () => (await publicTask(page, projectId))?.status, {
    timeout: 30_000,
  }).toMatch(/^(?:completed|failed)$/);
  const terminal = await publicTask(page, projectId);
  assert.equal(terminal.status, "completed", JSON.stringify(terminal));
  await expect.poll(async () => Boolean(await translatedText(page, projectId)), {
    timeout: 10_000,
  }).toBe(true);
}

async function workerCrashScenario() {
  const userDataDir = mkdtempSync(`${tmpdir()}\\phase8-worker-crash-`);
  let app;
  try {
    const launched = await launchApp(userDataDir, 5_000);
    app = launched.app;
    const project = recoveryProject("worker-crash");
    const pending = seedAndStart(launched.page, project);
    await expect.poll(async () => (await publicTask(launched.page, project.id))?.status, {
      timeout: 10_000,
    }).toBe("running");
    const pid = await supervisorPid(app);
    process.kill(pid);
    // startTranslation 只负责入队，成功与否由任务状态回答，不由这次调用的返回值回答。
    const queued = await pending;
    assert.equal(queued.ok, true, JSON.stringify(queued));
    await expect.poll(async () => (await publicTask(launched.page, project.id))?.status, {
      timeout: 10_000,
    }).toBe("recoverable");
    assert.equal(await translatedText(launched.page, project.id), "");
    await launched.page.waitForTimeout(750);
    assert.equal((await publicTask(launched.page, project.id)).status, "recoverable");
    await explicitlyResume(launched.page, await publicTask(launched.page, project.id));
    await waitForCompletedText(launched.page, project.id);
    await launched.page.waitForTimeout(500);
    console.log("Phase 8 worker crash recovery smoke passed");
  } finally {
    await closeElectronApp(app);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      console.warn(`Phase 8 worker recovery cleanup deferred: ${error.code ?? error}`);
    }
  }
}

async function appHardKillScenario() {
  const userDataDir = mkdtempSync(`${tmpdir()}\\phase8-app-hard-kill-`);
  let app;
  try {
    let launched = await launchApp(userDataDir);
    app = launched.app;
    const project = recoveryProject("app-hard-kill");
    await seedProject(launched.page, project);
    await closeElectronApp(app);
    app = undefined;

    launched = await launchApp(userDataDir, 5_000);
    app = launched.app;
    const pending = startTranslation(launched.page, project.id).catch(() => null);
    await expect.poll(async () => (await publicTask(launched.page, project.id))?.status, {
      timeout: 10_000,
    }).toBe("running");
    const childPid = await supervisorPid(app);
    console.log("Phase 8 app hard-kill: terminating main process");
    const closed = app.waitForEvent("close", { timeout: 15_000 });
    execFileSync("taskkill.exe", ["/PID", String(app.process().pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await closed;
    await pending;
    app = undefined;
    await expect.poll(() => {
      try {
        process.kill(childPid, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 10_000 }).toBe(false);

    launched = await launchApp(userDataDir);
    app = launched.app;
    console.log("Phase 8 app hard-kill: relaunched persisted userData");
    await expect.poll(async () => (await publicTask(launched.page, project.id))?.status, {
      timeout: 10_000,
    }).toBe("recoverable");
    assert.equal(await translatedText(launched.page, project.id), "");
    await launched.page.waitForTimeout(750);
    const recoverable = await publicTask(launched.page, project.id);
    assert.equal(recoverable.status, "recoverable");
    await explicitlyResume(launched.page, recoverable);
    await waitForCompletedText(launched.page, project.id);
    await launched.page.waitForTimeout(500);
    console.log("Phase 8 app hard-kill recovery smoke passed");
  } finally {
    await closeElectronApp(app);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      console.warn(`Phase 8 app recovery cleanup deferred: ${error.code ?? error}`);
    }
  }
}

const requestedScenarios = new Set(process.argv.slice(2));
if (requestedScenarios.size === 0 || requestedScenarios.has("worker")) await workerCrashScenario();
if (requestedScenarios.size === 0 || requestedScenarios.has("app")) await appHardKillScenario();
