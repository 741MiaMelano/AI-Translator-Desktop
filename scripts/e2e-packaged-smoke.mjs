import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "@playwright/test";
import { closeElectronApp, listWindowsProcessTreeNames } from "./electron-test-lifecycle.mjs";
import { resolveVerifiedArtifactPaths } from "../backend/media/ffmpeg-artifact-manifest.mjs";
import { runManagedProcess } from "../backend/media/process-runner.mjs";
import { validateAsrManifest } from "../backend/asr/runtime-registry.mjs";
import {
  createPhase7MediaFixtures,
  createPhase7UserDataDir,
  resolvePhase7ModelId,
  runPhase7AsrWorkflow,
  runPhase7AudioSmoke,
  stageVerifiedAsrAssets,
} from "./asr-phase7-e2e.mjs";

const packagedRoot = resolve(process.env.PHASE14_PACKAGED_ROOT ?? join(process.cwd(), "release", "win-unpacked"));
const executable = resolve(process.env.PHASE14_PACKAGED_EXECUTABLE ?? join(packagedRoot, "AI Translator Desktop.exe"));
const executableRelative = relative(packagedRoot, executable);
assert.ok(
  executableRelative && !isAbsolute(executableRelative) && executableRelative !== ".." && !executableRelative.startsWith(`..${sep}`),
  "packaged executable must stay inside packagedRoot",
);
assert.equal(existsSync(executable), true, "packaged executable is missing");
let app;

const packagedFfmpegRoot = join(packagedRoot, "resources", "ffmpeg", "win32-x64");
const packagedManifest = join(packagedRoot, "resources", "ffmpeg", "manifest.json");
assert.equal(existsSync(packagedManifest), true, "packaged ffmpeg manifest missing");
const packagedTools = resolveVerifiedArtifactPaths(JSON.parse(readFileSync(packagedManifest, "utf8")), {
  artifactRootDir: packagedFfmpegRoot,
});
const packagedAsrManifest = join(packagedRoot, "resources", "asr", "manifest.json");
assert.equal(existsSync(packagedAsrManifest), true, "packaged ASR manifest missing");
const asrManifest = validateAsrManifest(JSON.parse(readFileSync(packagedAsrManifest, "utf8")));
const modelId = resolvePhase7ModelId();
const acceptanceModel = asrManifest.models.find((model) => model.id === modelId);
assert.ok(acceptanceModel, `packaged acceptance model is not declared: ${modelId}`);
const modelFile = acceptanceModel.files.find((entry) => entry.role === "model");
assert.ok(modelFile, `packaged ${modelId} manifest entry missing`);
assert.equal(asrManifest.engine.id, "whisper.cpp");
assert.equal(
  existsSync(join(packagedRoot, "resources", "asr", "models", modelId, ...modelFile.relativePath.split("/"))),
  false,
  "base package must not bundle the optional ASR model",
);
assert.ok(packagedTools.ffmpegPath.includes("resources"), "packaged resolver must use resourcesPath tree");
const packagedFfmpegRelative = relative(packagedRoot, packagedTools.ffmpegPath);
assert.ok(
  packagedFfmpegRelative &&
  !isAbsolute(packagedFfmpegRelative) &&
  packagedFfmpegRelative !== ".." &&
  !packagedFfmpegRelative.startsWith(`..${sep}`) &&
  /^resources[\\/]ffmpeg[\\/]/i.test(packagedFfmpegRelative),
  "packaged resolver must stay inside the installed resources tree",
);
const userDataDir = mkdtempSync(join(tmpdir(), "phase5-package-smoke-"));

const phase5Project = {
  id: "phase5-package-project",
  title: "Phase 5 packaged editor",
  sourceFileName: "phase5-package.srt",
  mediaKind: "subtitle",
  noSourceMedia: true,
  lifecycle: "needs_review",
  createdAt: "2026-07-18 10:00",
  updatedAt: "2026-07-18 10:00",
  activeSourceTrackId: "source-package",
  pendingConfirmations: [],
  notes: [],
  config: {
    sourceLanguage: "英语",
    targetLanguages: ["简体中文"],
    provider: "OpenAI",
    model: "GPT-4.1",
    glossary: "关闭术语约束",
    styleGuide: "纪录片字幕风格",
    outputFormat: "SRT",
    budgetUsd: 1,
    burnVideo: false,
    copyMediaIntoProject: false,
  },
  sourceTracks: [{
    id: "source-package",
    label: "Main",
    kind: "external_subtitle",
    languageState: "known",
    defaultLanguage: "en",
    isActive: true,
    summary: "package smoke",
    segments: [{
      id: "segment-package",
      start: "00:00:01,000",
      end: "00:00:03,000",
      sourceLanguage: "en",
      sourceText: { original: "Hello", normalized: "Hello", manual: "Hello edited" },
      targetTexts: { 简体中文: { model: "你好", postProcessed: "你好", manual: "人工稿", qaFlags: [] } },
    }],
    targetTracks: [{
      id: "target-package",
      languageCode: "简体中文",
      languageLabel: "简体中文",
      status: "in_review",
      isActive: true,
      role: "active",
      qaIssues: [],
      snapshotIds: [],
      deliveryLabel: "待审核",
      lastHumanAction: "manual edit",
    }, {
      id: "candidate-package",
      languageCode: "简体中文",
      languageLabel: "简体中文候选",
      status: "in_review",
      isActive: false,
      role: "candidate",
      baseTrackId: "target-package",
      candidateTexts: { "segment-package": { model: "候选稿", postProcessed: "候选稿", qaFlags: [], origin: "candidate_full_track" } },
      qaIssues: [],
      snapshotIds: [],
      deliveryLabel: "候选待比较",
      lastHumanAction: "candidate created",
    }],
  }],
  recentRunIds: [],
  editorHistory: {
    undoStack: [{ kind: "source_manual", segmentId: "segment-package", beforeManual: null, afterManual: "Hello edited" }],
    redoStack: [],
  },
};

async function launchPackaged({ dataDir = userDataDir, mediaPath } = {}) {
  let launched;
  try {
    launched = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${dataDir}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        TRANSLATION_FAKE_PROVIDER: "1",
        ...(mediaPath ? { MEDIA_E2E_FIXTURE_PATH: mediaPath } : {}),
      },
      timeout: 60_000,
    });
    const page = await launched.firstWindow({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    return { app: launched, page };
  } catch (error) {
    await closeElectronApp(launched).catch(() => {});
    throw error;
  }
}

async function closePackagedForRestart(currentApp, page) {
  const child = currentApp.process();
  assert.equal(child.exitCode, null, `packaged app exited before the close request with code ${child.exitCode}`);
  assert.equal(child.signalCode, null, `packaged app was terminated before the close request by ${child.signalCode}`);
  const exited = new Promise((resolveExit) => child.once("exit", (exitCode, signalCode) => resolveExit({ exitCode, signalCode })));
  await page.evaluate(() => window.desktop.windowControl({ action: "close" })).catch(() => {});
  const result = await Promise.race([exited, delay(20_000).then(() => null)]);
  assert.ok(result, "packaged app did not exit after the close request");
  assert.equal(result.exitCode, 0, `packaged app exited with code ${result.exitCode}`);
  assert.equal(result.signalCode, null, `packaged app was terminated by ${result.signalCode}`);
}

function assertPackagedWorkersExited(currentApp) {
  assert.doesNotMatch(
    listWindowsProcessTreeNames(currentApp.process().pid).join(" "),
    /whisper(?:-cli)?|ffmpeg|ffprobe/i,
    "packaged app left an ASR or media worker running",
  );
}

try {
  let launched = await launchPackaged();
  app = launched.app;
  /** @type {import('@playwright/test').Page} */
  let page = launched.page;
  const asrCapability = await page.evaluate(() => window.desktop.getAsrCapabilityStatus({}));
  assert.equal(asrCapability.ok, true, JSON.stringify(asrCapability));
  assert.equal(asrCapability.data.runtime.installState, "ready");
  assert.equal(asrCapability.data.model.installState, "not_installed");
  assert.equal(asrCapability.data.ready, false);
  assert.equal(/path|url|argv|cwd/i.test(JSON.stringify(asrCapability)), false);
  await page.evaluate(() => { window.location.hash = "/system/asr"; });
  await page.locator('[data-fr03-view="asr-maintenance"]').waitFor();
  await page.getByRole("heading", { name: "本地语音识别", exact: true }).waitFor();
  await page.locator(".runtime-primary .state-tag").filter({ hasText: "可用" }).waitFor({ timeout: 30_000 });
  await page.locator(".asset-ledger article .state-tag").first().filter({ hasText: "未安装" }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => { window.location.hash = "/system/providers"; });
  await page.getByRole("heading", { name: "翻译 Provider", exact: true }).waitFor();
  await page.locator(".capability-rail-list button").filter({ hasText: "OpenAI" }).first().click();
  await page.getByLabel("API Key").fill("sk-package-fake-not-real");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("配置已保存；首次使用时会自动检查连接。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "测试真实连接", exact: true }).click();
  await page.getByRole("dialog", { name: "测试真实 Provider 连接？" }).getByRole("button", { name: "确认并测试", exact: true }).click();
  await page.getByText("连接测试通过", { exact: true }).waitFor({ timeout: 30_000 });
  const phase12Settings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(phase12Settings.ok, true);
  const savedPhase12Settings = await page.evaluate((settings) => window.desktop.saveAppSettings({ settings: {
    ...settings,
    startupPage: "projects",
    notifications: { ...settings.notifications, release: false },
  } }), phase12Settings.data);
  assert.equal(savedPhase12Settings.ok, true);
  const phase12Readiness = await page.evaluate(() => window.desktop.getCapabilityReadiness({}));
  assert.equal(phase12Readiness.ok, true);
  assert.ok(phase12Readiness.data.global.capabilities.some(({ id }) => id === "video_export"));
  const phase12Diagnostics = await page.evaluate(() => window.desktop.previewDiagnostics());
  assert.equal(phase12Diagnostics.ok, true);
  assert.equal(JSON.stringify(phase12Diagnostics).includes("sk-package-fake-not-real"), false);
  const phase12Backup = await page.evaluate(() => window.desktop.createAppBackup());
  assert.equal(phase12Backup.ok, true);
  assert.equal(existsSync(join(userDataDir, "backups", phase12Backup.data.fileName)), true);
  console.log("Packaged Phase 12 settings, readiness, diagnostics and backup smoke passed");
  const metrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map(({ name, type }) => ({ name, type })),
  );
  assert.equal(metrics.filter((metric) => metric.name === "Task Supervisor").length, 1);
  assert.ok(metrics.every((metric) => !/(?:ASR|Media|Translation) Worker/i.test(metric.name)));
  console.log("Packaged Phase 7 ASR registry capability smoke passed");
  const created = await page.evaluate((project) => window.desktop.createProject({ project }), phase5Project);
  assert.equal(created.ok, true, JSON.stringify(created));
  await closePackagedForRestart(app, page);
  app = undefined;

  launched = await launchPackaged();
  app = launched.app;
  page = launched.page;
  const reopened = await page.evaluate((projectId) => window.desktop.openProject({ projectId }), phase5Project.id);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.data.editorHistory.undoStack.length, 1);
  assert.equal(reopened.data.sourceTracks[0].targetTracks[1].candidateTexts["segment-package"].postProcessed, "候选稿");
  await page.evaluate((projectId) => { window.location.hash = `/projects/${projectId}/editor/${encodeURIComponent("简体中文")}`; }, phase5Project.id);
  // 带目标语言的路由直接落在目标校对，不用再手动切一次
  await page.locator('[data-fr02-view="editor"]').waitFor();
  await page.locator(".candidate-callout").getByText("候选稿", { exact: true }).waitFor();
  console.log("Packaged Phase 5 editor and worker smoke passed");

  const mediaWork = mkdtempSync(join(tmpdir(), "phase6-package-media-"));
  const srt = join(mediaWork, "cues.srt");
  writeFileSync(srt, "1\n00:00:00,000 --> 00:00:00,800\nPackaged hello\n\n");
  const mkv = join(mediaWork, "packaged.mkv");
  await runManagedProcess({
    absoluteExe: packagedTools.ffmpegPath,
    argv: [
      "-hide_banner", "-nostdin",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
      "-i", srt,
      "-c:a", "pcm_s16le", "-c:s", "srt",
      "-map", "0:a:0", "-map", "1:s:0",
      "-t", "1", mkv,
    ],
    timeoutMs: 30_000,
  });
  await closePackagedForRestart(app, page);
  app = undefined;

  const mediaUserData = mkdtempSync(join(tmpdir(), "phase6-package-user-"));
  try {
    const mediaLaunch = await launchPackaged({ dataDir: mediaUserData, mediaPath: mkv });
    app = mediaLaunch.app;
    page = mediaLaunch.page;
    const imported = await page.evaluate(() => window.desktop.selectMediaSource({ copyIntoProject: true }));
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const projectId = imported.data.project.id;
    const stream = imported.data.project.sourceProbeSummary.media.streams.find(
      (item) => item.kind === "subtitle" && item.extractable,
    );
    assert.ok(stream, "extractable subtitle stream required");
    const extracted = await page.evaluate(
      ({ projectId: id, streamId }) => window.desktop.extractMediaSubtitle({ projectId: id, streamId }),
      { projectId, streamId: stream.streamId },
    );
    assert.equal(extracted.ok, true, JSON.stringify(extracted));
    const activated = await page.evaluate(
      ({ projectId: id, sourceTrackId }) =>
        window.desktop.activateMediaSourceTrack({ projectId: id, sourceTrackId }),
      { projectId, sourceTrackId: extracted.data.candidateSourceTrackId },
    );
    assert.equal(activated.ok, true, JSON.stringify(activated));
    const preview = await page.evaluate((id) => window.desktop.getMediaPreviewUrl({ projectId: id }), projectId);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const waveform = await page.evaluate((id) => window.desktop.getMediaWaveform({ projectId: id }), projectId);
    assert.equal(waveform.ok, true, JSON.stringify(waveform));
    assert.ok(waveform.data.peaks.length > 0 && waveform.data.peaks.length <= 2_000);
    assert.ok(waveform.data.peaks.every((peak) => peak >= 0 && peak <= 1));
    const metrics2 = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map(({ name, type }) => ({ name, type })),
    );
    assert.ok(
      metrics2.every((metric) => metric.name !== "ffmpeg" && metric.name !== "ffprobe"),
      "main metrics should not list ffmpeg as direct child process name",
    );
    assert.equal(
      metrics2.filter((metric) => metric.name === "Task Supervisor").length,
      1,
      "packaged work must use exactly one utilityProcess supervisor",
    );
    assert.ok(metrics2.every((metric) => !/(?:ASR|Media|Translation) Worker/i.test(metric.name)));
    assertPackagedWorkersExited(app);
    console.log("Packaged Phase 6 media probe extract preview smoke passed");
    await closePackagedForRestart(app, page);
    app = undefined;
  } finally {
    await closeElectronApp(app);
    app = undefined;
    rmSync(mediaUserData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    rmSync(mediaWork, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const phase7UserData = createPhase7UserDataDir("packaged");
  const phase7Work = mkdtempSync(join(tmpdir(), "phase7-package-media-"));
  try {
    const fixtures = await createPhase7MediaFixtures({
      ffmpegPath: packagedTools.ffmpegPath,
      workDir: phase7Work,
    });
    await stageVerifiedAsrAssets({
      userDataDir: phase7UserData,
      includeRuntime: false,
      manifestPath: packagedAsrManifest,
      trustedNoticeRoot: join(packagedRoot, "resources", "asr", "licenses"),
    });
    let launched7 = await launchPackaged({ dataDir: phase7UserData, mediaPath: fixtures.videoPath });
    app = launched7.app;
    const workflow = await runPhase7AsrWorkflow({
      page: launched7.page,
      userDataDir: phase7UserData,
      restartPage: async () => {
        await closePackagedForRestart(app, launched7.page);
        app = undefined;
        launched7 = await launchPackaged({ dataDir: phase7UserData, mediaPath: fixtures.videoPath });
        app = launched7.app;
        return launched7.page;
      },
    });
    console.log("Packaged Phase 7 real video ASR workflow passed", workflow);
    assertPackagedWorkersExited(app);
    await closePackagedForRestart(app, launched7.page);
    app = undefined;

    launched7 = await launchPackaged({ dataDir: phase7UserData, mediaPath: fixtures.audioPath });
    app = launched7.app;
    const audioWorkflow = await runPhase7AudioSmoke({
      page: launched7.page,
      userDataDir: phase7UserData,
    });
    const phase7Metrics = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map(({ name, type }) => ({ name, type })),
    );
    assert.equal(phase7Metrics.filter((metric) => metric.name === "Task Supervisor").length, 1);
    assert.ok(phase7Metrics.every((metric) => !/(?:ASR|Media|Translation) Worker/i.test(metric.name)));
    assert.ok(phase7Metrics.every((metric) => !/whisper|ffmpeg|ffprobe/i.test(metric.name)));
    assertPackagedWorkersExited(app);
    console.log("Packaged Phase 7 pure-audio shortest path passed", audioWorkflow);
    await closePackagedForRestart(app, launched7.page);
    app = undefined;
  } finally {
    await closeElectronApp(app);
    app = undefined;
    rmSync(phase7UserData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    rmSync(phase7Work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} finally {
  await closeElectronApp(app);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
