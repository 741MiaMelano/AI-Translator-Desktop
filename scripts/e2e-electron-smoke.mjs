import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp as closeApp } from "./electron-test-lifecycle.mjs";
import {
  createPhase7MediaFixtures,
  createPhase7UserDataDir,
  runPhase7AsrWorkflow,
  runPhase7AudioSmoke,
  stageVerifiedAsrAssets,
} from "./asr-phase7-e2e.mjs";

// Playwright 1.52 triggers DEP0190 on Node 24; this test passes only fixed local arguments.
process.noDeprecation = true;

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(rootDir, "tests", "fixtures", "subtitles");

async function launchApp(userDataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      SUBTITLE_E2E_EXPORT_DIR: join(userDataDir, "e2e-exports"),
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  return { app, page };
}

async function importSubtitle(page, filePath) {
  await page.evaluate(() => { window.location.hash = "/import"; });
  await page.getByRole("heading", { name: "先选择一个素材" }).waitFor();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /把文件拖到这里/ }).click();
  await (await chooser).setFiles(filePath);
}

async function commitCurrentImport(page) {
  await page.getByRole("button", { name: /确认方案/ }).click();
  await page.getByRole("heading", { name: "项目可以创建了" }).waitFor();
  await page.getByRole("button", { name: /创建项目并进入工作区/ }).click();
}

function draftProject(id, title) {
  return {
    id,
    title,
    sourceFileName: `${id}.srt`,
    mediaKind: "subtitle",
    noSourceMedia: true,
    lifecycle: "draft",
    createdAt: "2026-07-13 15:00",
    updatedAt: "2026-07-13 15:00",
    activeSourceTrackId: `source-${id}`,
    pendingConfirmations: [],
    notes: ["e2e draft"],
    config: {
      sourceLanguage: "自动检测",
      targetLanguages: ["简体中文"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "视频字幕术语库",
      styleGuide: "纪录片字幕风格",
      outputFormat: "双语 SRT",
      budgetUsd: 12,
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [
      {
        id: `source-${id}`,
        label: "导入字幕主源轨",
        kind: "external_subtitle",
        languageState: "pending",
        defaultLanguage: "auto",
        isActive: true,
        summary: "e2e",
        segments: [
          {
            id: `segment-${id}`,
            start: "00:00:01,000",
            end: "00:00:03,000",
            sourceLanguage: "auto",
            sourceText: { original: "Hello, fixture test.", normalized: "Hello, fixture test." },
            targetTexts: {
              简体中文: { model: "", postProcessed: "", qaFlags: [] },
            },
          },
        ],
        targetTracks: [
          {
            id: `target-${id}`,
            languageCode: "简体中文",
            languageLabel: "简体中文",
            status: "draft",
            isActive: true,
            qaIssues: [],
            snapshotIds: [],
            deliveryLabel: "draft",
            lastHumanAction: "none",
          },
        ],
      },
    ],
    recentRunIds: [],
  };
}

const userDataDir = mkdtempSync(join(tmpdir(), "p03-e2e-"));
const project = draftProject("project-e2e-draft-1", "Phase 2 E2E Draft");
const missingProject = draftProject("project-e2e-missing", "Missing Project");
let app;

try {
  console.log("E2E seed project");
  let launched = await launchApp(userDataDir);
  app = launched.app;
  let page = launched.page;

  const isolation = await page.evaluate(() => ({
    processType: typeof window.process,
    requireType: typeof window.require,
    electronType: typeof window.electron,
    desktopKeys: Object.keys(window.desktop ?? {}),
  }));
  assert.equal(isolation.processType, "undefined");
  assert.equal(isolation.requireType, "undefined");
  assert.equal(isolation.electronType, "undefined");
  assert.deepEqual(isolation.desktopKeys.sort(), [
    "activateMediaSourceTrack",
    "applyBackupRestore",
    "cancelAsrDeviceDetection",
    "cancelAsrModelOperation",
    "cancelAsrProjectOperation",
    "cancelAsrRuntimeOperation",
    "cancelAsrSongClassifierOperation",
    "cancelMediaOperation",
    "commitBatchSession",
    "controlTask",
    "createAppBackup",
    "createBatchSession",
    "createProject",
    "createProjectPackage",
    "deleteCredential",
    "deleteProjectPermanently",
    "deleteResource",
    "detectAsrDevices",
    "detectAsrSegmentLanguages",
    "discardBatchSession",
    "exportApprovedBatch",
    "exportDiagnostics",
    "exportSourceSubtitle",
    "exportSubtitleMatrix",
    "exportSubtitleVideo",
    "extractMediaAudio",
    "extractMediaSubtitle",
    "getAppSettings",
    "getAsrCapabilityStatus",
    "getAsrDeviceStatus",
    "getAsrProjectStatus",
    "getAudioSeparationCapability",
    "getCapabilityReadiness",
    "getCredentialStatus",
    "getDownloadStatus",
    "getMediaPreviewUrl",
    "getMediaWaveform",
    "getProjectRuntimeState",
    "getProviderRuntimeState",
    "importAsrModel",
    "importAsrRuntime",
    "importSubtitle",
    "installAsrModel",
    "installAsrRuntime",
    "installAsrSongClassifier",
    "listProjectResourceSnapshots",
    "listProviderModels",
    "listRecentProjects",
    "listResources",
    "onBeforeClose",
    "onModelStorageTransferProgress",
    "onWorkerEvent",
    "openAsrInfo",
    "openProject",
    "previewDiagnostics",
    "probeDownloadSources",
    "probeMedia",
    "purgeTasks",
    "refreshProjectResourceSnapshot",
    "relinkMedia",
    "resetAppSettings",
    "runAsrTranscription",
    "saveAppSettings",
    "saveCredential",
    "saveProject",
    "saveResource",
    "segmentAsrRun",
    "selectBackupRestore",
    "selectMediaSource",
    "selectMediaStreams",
    "selectModelStorageDestination",
    "selectSettingsDirectory",
    "setAsrDevicePreference",
    "startAudioSeparation",
    "startBatch",
    "startTranslation",
    "subscribeTasks",
    "testProviderConnection",
    "transferModelStorage",
    "uninstallAsrModel",
    "uninstallAsrRuntime",
    "uninstallAsrSongClassifier",
    "updateAsrSegmentLanguages",
    "windowControl",
  ]);
  const created = await page.evaluate((value) => window.desktop.createProject({ project: value }), project);
  assert.equal(created.ok, true);
  await closeApp(app);
  app = undefined;

  console.log("E2E UI autosave and close flush");
  launched = await launchApp(userDataDir);
  app = launched.app;
  page = launched.page;
  await page.evaluate((projectId) => { window.location.hash = `/projects/${projectId}`; }, project.id);
  await page.getByRole("heading", { name: project.title }).waitFor();
  const startButtons = page.getByRole("button", { name: "开始处理" });
  assert.equal(await startButtons.count(), 1);
  assert.equal(await startButtons.first().isDisabled(), false);
  await page.getByRole("button", { name: "项目设置与资产", exact: true }).click();
  await page.getByRole("heading", { name: "项目设置与资产" }).waitFor();
  await page.getByLabel("源语言").selectOption("英语");
  await page.getByLabel("本地 ASR 模型").selectOption("large-v3-turbo-q8_0");
  await page.getByRole("button", { name: "保存项目方案", exact: true }).click();
  await page.getByText(/项目方案已进入自动保存/).waitFor();
  await page.evaluate((projectId) => { window.location.hash = `/projects/${projectId}`; }, project.id);
  await page.getByRole("heading", { name: project.title }).waitFor();
  await page.getByText(/英语 → 简体中文/).waitFor();
  await expect.poll(async () => page.evaluate(async (projectId) => {
    const result = await window.desktop.openProject({ projectId });
    return result.ok ? [result.data.config.sourceLanguage, result.data.config.asrModelId] : [];
  }, project.id)).toEqual(["英语", "large-v3-turbo-q8_0"]);
  await Promise.all([
    app.waitForEvent("close", { timeout: 15_000 }),
    page.getByRole("button", { name: "关闭窗口", exact: true }).click(),
  ]);
  app = undefined;

  console.log("E2E restart and partial-load recovery");
  launched = await launchApp(userDataDir);
  app = launched.app;
  page = launched.page;
  const reopened = await page.evaluate((projectId) => window.desktop.openProject({ projectId }), project.id);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.data.config.sourceLanguage, "英语");
  assert.equal(reopened.data.config.asrModelId, "large-v3-turbo-q8_0");
  const missingCreated = await page.evaluate(
    (value) => window.desktop.createProject({ project: value }),
    missingProject,
  );
  assert.equal(missingCreated.ok, true);
  await closeApp(app);
  app = undefined;
  rmSync(join(userDataDir, "projects", missingProject.id), { recursive: true, force: true });

  launched = await launchApp(userDataDir);
  app = launched.app;
  page = launched.page;
  await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor();
  const partialIndex = await page.evaluate(() => window.desktop.listRecentProjects({ limit: 20 }));
  assert.equal(partialIndex.ok, true, JSON.stringify(partialIndex));
  assert.equal(partialIndex.data.some((entry) => entry.id === project.id), true);

  console.log("E2E failed save keeps window open");
  await page.evaluate((projectId) => { window.location.hash = `/projects/${projectId}`; }, project.id);
  await page.getByRole("heading", { name: project.title }).waitFor();
  await page.getByRole("button", { name: "项目设置与资产", exact: true }).click();
  await page.getByRole("heading", { name: "项目设置与资产" }).waitFor();
  const projectDir = join(userDataDir, "projects", project.id);
  rmSync(projectDir, { recursive: true, force: true });
  writeFileSync(projectDir, "block project directory recreation");
  await page.getByLabel("源语言").selectOption("日语");
  await page.getByRole("button", { name: "保存项目方案", exact: true }).click();
  await page.getByText(/操作没有完成/).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await page.waitForTimeout(700);
  assert.equal(page.isClosed(), false);
  await page.getByText(/操作没有完成/).waitFor();
  await closeApp(app);
  app = undefined;

  console.log("E2E Phase 3 subtitle file loop");
  const phase3UserData = mkdtempSync(join(tmpdir(), "p03-subtitle-e2e-"));
  try {
    const contentFirstPath = join(phase3UserData, "subtitle-content.txt");
    writeFileSync(
      contentFirstPath,
      readFileSync(join(fixturesDir, "valid", "basic-utf8.srt")),
    );
    const ambiguousEncodingPath = join(phase3UserData, "ambiguous-encoding.srt");
    writeFileSync(
      ambiguousEncodingPath,
      Buffer.concat([
        Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n", "ascii"),
        Buffer.from([0x82, 0xa0]),
        Buffer.from("\n", "ascii"),
      ]),
    );

    launched = await launchApp(phase3UserData);
    app = launched.app;
    page = launched.page;

    await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor();
    await importSubtitle(page, contentFirstPath);
    await page.getByRole("heading", { name: "确认真实翻译方案" }).waitFor({ timeout: 15_000 });
    await page.getByText("subtitle-content.txt", { exact: true }).waitFor();
    await commitCurrentImport(page);
    await page.getByRole("heading", { name: "subtitle-content" }).waitFor({ timeout: 15_000 });
    await page.getByText("2 段").first().waitFor();

    await importSubtitle(page, ambiguousEncodingPath);
    await page.getByRole("heading", { name: "确认真实翻译方案" }).waitFor({ timeout: 15_000 });
    await page.getByText("后端无法安全自动判断；选择错误会使字幕文字损坏。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "GBK" }).click();
    await commitCurrentImport(page);
    await page.getByRole("heading", { name: "ambiguous-encoding" }).waitFor({ timeout: 15_000 });
    await page.getByText("1 段").first().waitFor();

    const srtPath = join(fixturesDir, "valid", "basic-utf8.srt");
    await importSubtitle(page, srtPath);
    await page.getByRole("heading", { name: "确认真实翻译方案" }).waitFor({ timeout: 15_000 });
    await commitCurrentImport(page);
    await page.getByRole("heading", { name: "basic-utf8" }).waitFor({ timeout: 15_000 });
    await page.getByText("2 段").first().waitFor();
    const bodyText = await page.locator("body").innerText();
    assert.equal(bodyText.includes("这里会在接入真实后端后替换成实际识别结果"), false);

    const overviewId = await page.evaluate(async () => {
      const rows = await window.desktop.listRecentProjects({});
      const match = rows.data.find((row) => row.sourceFileName === "basic-utf8.srt");
      return match?.id || rows.data[0]?.id || null;
    });
    assert.ok(overviewId);
    await page.evaluate((projectId) => { window.location.hash = `/projects/${projectId}`; }, overviewId);
    await page.getByRole("heading", { name: "basic-utf8" }).waitFor();
    await page.evaluate((projectId) => {
      // 编辑器默认落在目标校对（路由本身就带目标语言）；源字幕模式是 URL 上的 ?mode=source
      window.location.hash = `/projects/${projectId}/editor/${encodeURIComponent("简体中文")}?mode=source`;
    }, overviewId);
    await page.locator('[data-fr02-view="editor"]').waitFor({ timeout: 30_000 });
    assert.match(await page.locator("body").innerText(), /Hello, fixture test/);
    const textareas = page.locator("textarea");
    await textareas.first().fill("Edited source cue one");
    await expect(textareas.first()).toHaveValue("Edited source cue one");
    await page.getByRole("button", { name: /^撤销/ }).click();
    await expect(textareas.first()).toHaveValue("Hello, fixture test.");
    assert.equal(await textareas.first().inputValue(), "Hello, fixture test.");
    await page.getByRole("button", { name: /^重做/ }).click();
    await expect(textareas.first()).toHaveValue("Edited source cue one");
    assert.equal(await textareas.first().inputValue(), "Edited source cue one");

    await Promise.all([
      app.waitForEvent("close", { timeout: 15_000 }),
      page.getByRole("button", { name: "关闭窗口", exact: true }).click(),
    ]);
    app = undefined;

    launched = await launchApp(phase3UserData);
    app = launched.app;
    page = launched.page;
    try {
      await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor({ timeout: 15_000 });
    } catch (error) {
      console.error("Phase 3 restart page:", (await page.locator("body").innerText()).slice(0, 2000));
      throw error;
    }
    const listed = await page.evaluate(async () => window.desktop.listRecentProjects({}));
    assert.equal(listed.ok, true);
    assert.ok(listed.data.length >= 1);
    const importedId = listed.data.find((row) => row.sourceFileName === "basic-utf8.srt")?.id
      || listed.data[0].id;
    const opened = await page.evaluate(
      (projectId) => window.desktop.openProject({ projectId }),
      importedId,
    );
    assert.equal(opened.ok, true);
    assert.equal(opened.data.sourceTracks[0].segments.length, 2);
    assert.equal(opened.data.sourceTracks[0].segments[0].sourceText.manual, "Edited source cue one");
    assert.equal(opened.data.sourceTracks[0].segments[0].start, "00:00:01,000");
    assert.ok(opened.data.sourceProjectRelativePath);
    const rawPath = join(phase3UserData, "projects", importedId, ...opened.data.sourceProjectRelativePath.split("/"));
    assert.ok(existsSync(rawPath));
    assert.deepEqual(readFileSync(rawPath), readFileSync(srtPath));

    await page.evaluate((projectId) => {
      window.location.hash = `/projects/${projectId}`;
    }, importedId);
    await page.getByRole("heading", { name: "basic-utf8" }).waitFor();
    const exportResult = await page.evaluate((projectId) => window.desktop.exportSourceSubtitle({
      projectId,
      mode: "normalized",
      format: "srt",
      destination: "user",
    }), importedId);
    assert.equal(exportResult.ok, true, JSON.stringify(exportResult));

    const exportsDir = join(phase3UserData, "e2e-exports");
    const exportedFileName = readdirSync(exportsDir).find((fileName) => fileName.endsWith(".srt"));
    assert.ok(exportedFileName);
    const exportFile = join(exportsDir, exportedFileName);
    assert.ok(existsSync(exportFile));

    await page.evaluate(() => {
      window.location.hash = "/";
    });
    await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor();
    await importSubtitle(page, exportFile);
    await page.getByText("检测到重复导入").waitFor();
    await page.getByRole("button", { name: "创建独立副本" }).click();
    await page.getByRole("heading", { name: "确认真实翻译方案" }).waitFor();
    await commitCurrentImport(page);
    await page.getByRole("heading", { name: "basic-utf8 副本" }).waitFor({ timeout: 15_000 });
    await expect
      .poll(async () => {
        const rows = await page.evaluate(async () => window.desktop.listRecentProjects({}));
        return rows.data.some((row) => row.title === "basic-utf8 副本");
      })
      .toBe(true);
    const reimported = await page.evaluate(async () => window.desktop.listRecentProjects({}));
    const reimportedId = reimported.data.find((row) => row.title === "basic-utf8 副本")?.id;
    assert.ok(reimportedId);
    await page.evaluate((projectId) => {
      window.location.hash = `/projects/${projectId}/editor/${encodeURIComponent("简体中文")}?mode=source`;
    }, reimportedId);
    await page.locator('[data-fr02-view="editor"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator("textarea").first().inputValue(), "Edited source cue one");

    const vttPath = join(fixturesDir, "valid", "中文 空格.vtt");
    await page.evaluate(() => {
      window.location.hash = "/";
    });
    await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor();
    await importSubtitle(page, vttPath);
    await page.getByRole("heading", { name: "确认真实翻译方案" }).waitFor({ timeout: 15_000 });
    await commitCurrentImport(page);
    await page.getByRole("heading", { name: "中文 空格" }).waitFor({ timeout: 15_000 });
    await page.getByText("2 段").first().waitFor();
    const vttId = await page.evaluate(async () => {
      const rows = await window.desktop.listRecentProjects({});
      return rows.data.find((row) => row.sourceFileName === "中文 空格.vtt")?.id ?? null;
    });
    assert.ok(vttId);
    await page.evaluate((projectId) => { window.location.hash = `/projects/${projectId}`; }, vttId);
    await page.getByRole("heading", { name: "中文 空格" }).first().waitFor();
    const vttExport = await page.evaluate((projectId) => window.desktop.exportSourceSubtitle({
      projectId,
      mode: "normalized",
      format: "vtt",
    }), vttId);
    assert.equal(vttExport.ok, true, JSON.stringify(vttExport));
    assert.match(vttExport.data.warnings.join(" "), /degrade|降级|原始/i);

    await page.evaluate(() => {
      window.location.hash = "/";
    });
    await page.getByRole("heading", { name: "今天想翻译什么？" }).waitFor();
    const projectCountBeforeInvalid = (await page.evaluate(async () => window.desktop.listRecentProjects({}))).data.length;
    await importSubtitle(page, join(fixturesDir, "invalid", "invalid-timestamp.srt"));
    await page.getByRole("alert").first().waitFor();
    assert.match(await page.getByRole("alert").first().innerText(), /自动保存失败|timestamp|字幕|文件已损坏或无法解析/i);
    const projectCountAfterInvalid = (await page.evaluate(async () => window.desktop.listRecentProjects({}))).data.length;
    assert.equal(projectCountAfterInvalid, projectCountBeforeInvalid);

    console.log("E2E Phase 3 subtitle loop passed");
    await closeApp(app);
    app = undefined;
  } finally {
    await closeApp(app);
    app = undefined;
    rmSync(phase3UserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  // Phase 4: credential + multi-language translation via in-process fake provider (no public network).
  const phase4UserData = mkdtempSync(join(tmpdir(), "p04-e2e-"));
  let phase4App;
  try {
    phase4App = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${phase4UserData}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        TRANSLATION_FAKE_PROVIDER: "1",
      },
      timeout: 60_000,
    });
    const page = await phase4App.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });

    await page.evaluate(() => { window.location.hash = "/system/providers"; });
    await page.getByRole("heading", { name: "翻译 Provider" }).waitFor();
    await page.locator(".capability-rail-list button").filter({ hasText: "OpenAI" }).first().click();
    await page.getByLabel("API Key").fill("sk-e2e-fake-not-real");
    await page.getByRole("button", { name: "保存配置" }).click();
    await page.getByText("配置已保存；首次使用时会自动检查连接。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "测试真实连接", exact: true }).click();
    await page.getByRole("dialog", { name: "测试真实 Provider 连接？" }).getByRole("button", { name: "确认并测试", exact: true }).click();
    await page.getByText("连接测试通过", { exact: true }).waitFor();

    const created = await page.evaluate(async () => {
      const project = {
        id: "p04-translate-1",
        title: "Phase4 Translate",
        sourceFileName: "p04.srt",
        mediaKind: "subtitle",
        noSourceMedia: true,
        lifecycle: "draft",
        createdAt: "2026-07-16 12:00",
        updatedAt: "2026-07-16 12:00",
        activeSourceTrackId: "source-p04",
        pendingConfirmations: [],
        notes: [],
        config: {
          sourceLanguage: "en",
          targetLanguages: ["zh-CN", "ja-JP"],
          provider: "OpenAI",
          model: "GPT-4.1",
          glossary: "none",
          styleGuide: "none",
          outputFormat: "SRT",
          budgetUsd: 5,
          burnVideo: false,
          copyMediaIntoProject: false,
          autoTranslate: true,
        },
        sourceTracks: [
          {
            id: "source-p04",
            label: "Main",
            kind: "external_subtitle",
            languageState: "known",
            defaultLanguage: "en",
            isActive: true,
            summary: "e2e",
            segments: [
              {
                id: "seg-1",
                start: "00:00:01,000",
                end: "00:00:02,000",
                sourceLanguage: "en",
                sourceText: { original: "Hello", normalized: "Hello" },
                targetTexts: {
                  "zh-CN": { model: "", postProcessed: "", qaFlags: [] },
                  "ja-JP": { model: "", postProcessed: "", qaFlags: [] },
                },
              },
              {
                id: "seg-2",
                start: "00:00:02,000",
                end: "00:00:03,000",
                sourceLanguage: "en",
                sourceText: { original: "World", normalized: "World" },
                targetTexts: {
                  "zh-CN": { model: "", postProcessed: "", qaFlags: [] },
                  "ja-JP": { model: "", postProcessed: "", qaFlags: [] },
                },
              },
            ],
            targetTracks: [
              {
                id: "target-zh",
                languageCode: "zh-CN",
                languageLabel: "Chinese",
                status: "draft",
                isActive: true,
                qaIssues: [],
                snapshotIds: [],
                deliveryLabel: "draft",
                lastHumanAction: "none",
              },
              {
                id: "target-ja",
                languageCode: "ja-JP",
                languageLabel: "Japanese",
                status: "draft",
                isActive: true,
                qaIssues: [],
                snapshotIds: [],
                deliveryLabel: "draft",
                lastHumanAction: "none",
              },
            ],
          },
        ],
        recentRunIds: [],
      };
      return window.desktop.createProject({ project });
    });
    assert.equal(created.ok, true);

    await page.reload();
    await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    await page.evaluate(() => { window.location.hash = "/projects/p04-translate-1"; });
    await page.getByRole("heading", { name: "Phase4 Translate" }).waitFor();
    await page.getByRole("button", { name: "开始处理", exact: true }).click();
    await page.getByRole("dialog", { name: "确认开始真实处理" }).getByRole("button", { name: "确认并开始", exact: true }).click();
    await page.getByText("待校对").first().waitFor({ timeout: 60_000 });

    const opened = await page.evaluate(async () =>
      window.desktop.openProject({ projectId: "p04-translate-1" }),
    );
    assert.equal(opened.ok, true);
    assert.match(opened.data.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, /Hello/);
    assert.match(opened.data.sourceTracks[0].segments[0].targetTexts["ja-JP"].model, /Hello/);
    assert.ok(opened.data.recentRunIds.length >= 2);
    const runtime = await page.evaluate(async () =>
      window.desktop.getProjectRuntimeState({ projectId: "p04-translate-1" }),
    );
    assert.equal(runtime.ok, true);
    assert.equal(runtime.data.runSnapshots.length, 2);
    assert.ok(runtime.data.tasks.some((task) => task.status === "completed"));
    assert.equal(runtime.data.tasks.some((task) => ["pending", "running"].includes(task.status)), false);
    assert.ok(runtime.data.runSnapshots.every((snapshot) => snapshot.model === "gpt-4.1"));
    assert.ok(runtime.data.runSnapshots.every((snapshot) => snapshot.inputTokens > 0));

    // Restart must not auto-spend; project remains readable with target text.
    await closeApp(phase4App);
    phase4App = undefined;
    phase4App = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${phase4UserData}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        TRANSLATION_FAKE_PROVIDER: "1",
      },
      timeout: 60_000,
    });
    const page2 = await phase4App.firstWindow({ timeout: 60_000 });
    await page2.waitForLoadState("domcontentloaded");
    await page2.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    const reopened = await page2.evaluate(async () =>
      window.desktop.openProject({ projectId: "p04-translate-1" }),
    );
    assert.equal(reopened.ok, true);
    assert.match(reopened.data.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, /Hello/);
    assert.equal(reopened.data.lifecycle === "processing", false);
    const runtimeAfterRestart = await page2.evaluate(async () =>
      window.desktop.getProjectRuntimeState({ projectId: "p04-translate-1" }),
    );
    assert.equal(runtimeAfterRestart.ok, true);
    assert.deepEqual(runtimeAfterRestart.data.runSnapshots, runtime.data.runSnapshots);
    assert.deepEqual(runtimeAfterRestart.data.tasks, runtime.data.tasks);

    const providerAfterRestart = await page2.evaluate(async () =>
      window.desktop.getProviderRuntimeState({ provider: "OpenAI" }),
    );
    assert.equal(providerAfterRestart.ok, true);
    assert.equal(providerAfterRestart.data.status, "ready");

    console.log("E2E Phase 5 editor QA candidate loop");
    await page2.evaluate(() => {
      window.location.hash = "/projects/p04-translate-1/editor/zh-CN";
    });
    await page2.locator('[data-fr02-view="editor"]').waitFor({ timeout: 30_000 });
    const editor = page2.getByLabel("译文");
    const currentModelText = await editor.inputValue();
    await page2.getByText("搜索替换", { exact: true }).click();
    await page2.getByLabel("查找").fill("Hello");
    await page2.getByLabel("替换为").fill("Hi");
    await page2.getByRole("button", { name: "替换全部", exact: true }).click();
    await page2.getByText(/已替换 1 处/).waitFor();
    await page2.getByRole("button", { name: /^撤销/ }).click();

    await page2.getByLabel("查找").fill(currentModelText);
    await page2.getByLabel("替换为").fill("");
    await page2.getByRole("button", { name: "替换全部", exact: true }).click();
    await page2.getByRole("button", { name: "刷新 QA", exact: true }).click();
    await expect(page2.getByRole("button", { name: "批准并前往交付" })).toBeDisabled();
    await page2.getByRole("button", { name: /^撤销/ }).click();
    await expect(editor).toHaveValue(currentModelText);
    await editor.fill("人工校对稿");
    await expect(editor).toHaveValue("人工校对稿");
    await page2.getByRole("button", { name: "锁定", exact: true }).click();
    // 时间轴微调在当前段编辑栏的「时间轴」标签下，默认标签是 QA，所以要先切过去。
    await page2.getByRole("tab", { name: "时间轴", exact: true }).click();
    await page2.getByRole("button", { name: "整段 +500", exact: true }).click();
    await page2.getByText("整段后移 500ms", { exact: true }).waitFor();

    const beforeLockedRerun = await page2.evaluate(async () =>
      window.desktop.getProjectRuntimeState({ projectId: "p04-translate-1" }),
    );
    await expect(page2.getByRole("button", { name: "重译所选段", exact: true })).toBeDisabled();
    const afterLockedRerun = await page2.evaluate(async () =>
      window.desktop.getProjectRuntimeState({ projectId: "p04-translate-1" }),
    );
    assert.equal(
      afterLockedRerun.data.runSnapshots.length,
      beforeLockedRerun.data.runSnapshots.length,
      "locked keyboard rerun must not create a paid snapshot",
    );

    await page2.getByRole("button", { name: "已锁定", exact: true }).click();
    await page2.getByRole("button", { name: "重译所选段", exact: true }).click();
    await page2.getByRole("dialog", { name: "确认调用翻译模型" }).getByRole("button", { name: "确认并提交", exact: true }).click();
    await page2.getByText("已提交所选字幕重译任务", { exact: true }).waitFor();
    let selectedSnapshot;
    await expect.poll(async () => {
      const focusedRuntime = await page2.evaluate(async () =>
        window.desktop.getProjectRuntimeState({ projectId: "p04-translate-1" }),
      );
      selectedSnapshot = focusedRuntime.data.runSnapshots.find(
        (snapshot) => snapshot.parameters?.coverage?.mode === "selected_segments",
      );
      return Boolean(selectedSnapshot);
    }, { timeout: 30_000 }).toBe(true);
    assert.deepEqual(selectedSnapshot?.parameters.coverage, {
      mode: "selected_segments",
      segmentIds: ["seg-1"],
    });

    await page2.getByRole("button", { name: "生成完整候选译文", exact: true }).click();
    await page2.getByRole("dialog", { name: "确认调用翻译模型" }).getByRole("button", { name: "确认并提交", exact: true }).click();
    await page2.getByText("已提交完整候选翻译任务", { exact: true }).waitFor();
    await expect.poll(async () => page2.evaluate(async () => {
      const result = await window.desktop.openProject({ projectId: "p04-translate-1" });
      return result.ok && result.data.sourceTracks[0].targetTracks.some((track) => track.role === "candidate" && Object.keys(track.candidateTexts ?? {}).length > 0);
    }), { timeout: 30_000 }).toBe(true);
    // 候选译文在当前段编辑栏的「候选」标签下，只有候选轨存在时才出现。
    await page2.getByRole("tab", { name: "候选", exact: true }).click();
    await page2.getByText("候选译文", { exact: true }).waitFor({ timeout: 30_000 });
    await page2.getByRole("button", { name: "采纳", exact: true }).click();
    await page2.getByText("已采纳当前候选", { exact: true }).waitFor();
    await page2.getByRole("button", { name: "刷新 QA", exact: true }).click();
    await page2.getByText("QA 已重新计算", { exact: true }).waitFor();
    await page2.getByRole("button", { name: "批准并前往交付", exact: true }).click();
    await page2.getByRole("heading", { name: "交付", exact: true }).waitFor();
    await page2.evaluate(() => { window.location.hash = "/projects/p04-translate-1/editor/zh-CN"; });
    await page2.locator('[data-fr02-view="editor"]').waitFor({ timeout: 30_000 });
    await page2.getByRole("tab", { name: "时间轴", exact: true }).click();
    await page2.getByRole("button", { name: "整段 +500", exact: true }).click();

    await closeApp(phase4App);
    phase4App = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${phase4UserData}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        TRANSLATION_FAKE_PROVIDER: "1",
      },
      timeout: 60_000,
    });
    const pagePhase5Restart = await phase4App.firstWindow({ timeout: 60_000 });
    await pagePhase5Restart.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    const phase5Reopened = await pagePhase5Restart.evaluate(async () =>
      window.desktop.openProject({ projectId: "p04-translate-1" }),
    );
    assert.equal(phase5Reopened.ok, true);
    const phase5Source = phase5Reopened.data.sourceTracks[0];
    const phase5Layer = phase5Source.segments[0].targetTexts["zh-CN"];
    assert.equal(phase5Layer.previousManual, "人工校对稿");
    assert.equal(phase5Layer.stale, true);
    assert.ok(phase5Reopened.data.editorHistory.undoStack.length > 0);
    const persistedCandidate = phase5Source.targetTracks.find((track) => track.role === "candidate");
    assert.ok(persistedCandidate);
    assert.ok(persistedCandidate.candidateTexts[phase5Source.segments[0].id]);
    assert.equal(
      phase5Source.targetTracks.find((track) => track.isActive && track.languageCode === "zh-CN").status,
      "in_review",
    );
    console.log("E2E Phase 5 editor QA candidate loop passed");

    await closeApp(phase4App);
    phase4App = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${phase4UserData}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        TRANSLATION_FAKE_PROVIDER: "1",
      },
      timeout: 60_000,
    });
    const page2Continued = await phase4App.firstWindow({ timeout: 60_000 });
    await page2Continued.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });

    const failureProject = await page2Continued.evaluate(async () => {
      const source = await window.desktop.openProject({ projectId: "p04-translate-1" });
      const project = structuredClone(source.data);
      project.id = "p04-failure-retry";
      project.title = "Phase4 Failure Retry";
      project.sourceFileName = "failure-retry.srt";
      project.lifecycle = "draft";
      project.createdAt = "2026-07-16 13:00";
      project.updatedAt = "2026-07-16 13:00";
      project.recentRunIds = [];
      for (const track of project.sourceTracks) {
        for (const target of track.targetTracks) {
          target.status = "draft";
          target.snapshotIds = [];
          target.deliveryLabel = "draft";
        }
        for (const segment of track.segments) {
          for (const language of Object.keys(segment.targetTexts)) {
            segment.targetTexts[language] = { model: "", postProcessed: "", qaFlags: [] };
          }
        }
      }
      return window.desktop.createProject({ project });
    });
    assert.equal(failureProject.ok, true);

    await closeApp(phase4App);
    phase4App = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${phase4UserData}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        TRANSLATION_FAKE_PROVIDER: "1",
        TRANSLATION_FAKE_FAIL_LANGUAGE: "ja-JP",
      },
      timeout: 60_000,
    });
    const page3 = await phase4App.firstWindow({ timeout: 60_000 });
    await page3.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    await page3.evaluate(() => { window.location.hash = "/projects/p04-failure-retry"; });
    await page3.getByRole("heading", { name: "Phase4 Failure Retry" }).waitFor();
    await page3.getByRole("button", { name: "开始处理", exact: true }).click();
    await page3.getByRole("dialog", { name: "确认开始真实处理" }).getByRole("button", { name: "确认并开始", exact: true }).click();
    await expect.poll(() => page3.evaluate(async () => {
      const result = await window.desktop.subscribeTasks({ projectId: "p04-failure-retry" });
      if (!result.ok) return `IPC_ERROR:${result.error.code}`;
      return result.data.tasks
        .map((task) => `${task.status}:${task.targetLanguageCode ?? "all"}:${task.detail}`)
        .join("|");
    }), { timeout: 30_000 }).toContain("failed:all:Translation did not complete for ja-JP");

    await closeApp(phase4App);
    phase4App = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${phase4UserData}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        TRANSLATION_FAKE_PROVIDER: "1",
      },
      timeout: 60_000,
    });
    const page4 = await phase4App.firstWindow({ timeout: 60_000 });
    await page4.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    await page4.evaluate(() => { window.location.hash = "/projects/p04-failure-retry"; });
    await page4.locator(".next-action").getByRole("button", { name: "确认重试", exact: true }).click();
    await expect.poll(() => page4.evaluate(async () => {
      const [result, queue] = await Promise.all([
        window.desktop.openProject({ projectId: "p04-failure-retry" }),
        window.desktop.subscribeTasks({ projectId: "p04-failure-retry" }),
      ]);
      return Boolean(
        result.ok &&
        result.data?.sourceTracks[0]?.segments[0]?.targetTexts["ja-JP"]?.model &&
        queue.ok &&
        queue.data.tasks.some((task) => task.status === "completed"),
      );
    }), { timeout: 30_000 }).toBe(true);
    const retried = await page4.evaluate(async () =>
      window.desktop.openProject({ projectId: "p04-failure-retry" }),
    );
    assert.equal(retried.ok, true);
    assert.match(retried.data.sourceTracks[0].segments[0].targetTexts["ja-JP"].model, /Hello/);

    console.log("E2E Phase 4 provider translation loop passed");
    await closeApp(phase4App);
    phase4App = undefined;
  } finally {
    await closeApp(phase4App);
    phase4App = undefined;
    rmSync(phase4UserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  // Phase 6 media probe/extract/preview loop (real staged or repo-managed FFmpeg)
  const phase6UserData = mkdtempSync(join(tmpdir(), "e2e-phase6-"));
  const phase6Work = mkdtempSync(join(tmpdir(), "e2e-phase6-media-"));
  let phase6App;
  try {
    const { resolveVerifiedArtifactPaths } = await import("../backend/media/ffmpeg-artifact-manifest.mjs");
    const { runManagedProcess } = await import("../backend/media/process-runner.mjs");
    const manifest = JSON.parse(readFileSync(join(rootDir, "docs/third-party/ffmpeg/manifest.json"), "utf8"));
    const repoArtifacts = join(rootDir, "resources", "ffmpeg", "win32-x64");
    const stagedArtifacts = join(process.env.TEMP || tmpdir(), "desktop-ai-translator-p06-t00b-minimal-v2", "staged");
    const artifactRoot = existsSync(join(repoArtifacts, "bin", "ffmpeg.exe")) ? repoArtifacts : stagedArtifacts;
    const tools = resolveVerifiedArtifactPaths(manifest, { artifactRootDir: artifactRoot });
    const srt = join(phase6Work, "cues.srt");
    writeFileSync(srt, "1\n00:00:00,000 --> 00:00:00,900\nHello phase6\n\n");
    const mkv = join(phase6Work, "sample media 中文 &().mkv");
    await runManagedProcess({
      absoluteExe: tools.ffmpegPath,
      argv: [
        "-hide_banner", "-nostdin",
        "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
        "-i", srt,
        "-c:v", "ffv1", "-c:a", "pcm_s16le", "-c:s", "srt",
        "-map", "0:v:0", "-map", "1:a:0", "-map", "2:s:0",
        "-metadata:s:s:0", "language=eng", "-shortest", mkv,
      ],
      timeoutMs: 30_000,
    });

    const launched6 = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${phase6UserData}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        MEDIA_E2E_FIXTURE_PATH: mkv,
      },
      timeout: 60_000,
    });
    phase6App = launched6;
    const page6 = await phase6App.firstWindow({ timeout: 60_000 });
    await page6.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });

    const imported = await page6.evaluate(() => window.desktop.selectMediaSource({ copyIntoProject: false }));
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const projectId = imported.data.project.id;
    assert.equal(imported.data.project.activeSourceTrackId, null);
    assert.ok(imported.data.project.sourceProbeSummary?.media?.streams?.length >= 2);

    const sub = imported.data.project.sourceProbeSummary.media.streams.find(
      (stream) => stream.kind === "subtitle" && stream.extractable,
    );
    assert.ok(sub);
    const extracted = await page6.evaluate(
      ({ projectId: id, streamId }) => window.desktop.extractMediaSubtitle({ projectId: id, streamId }),
      { projectId, streamId: sub.streamId },
    );
    assert.equal(extracted.ok, true, JSON.stringify(extracted));
    const activated = await page6.evaluate(
      ({ projectId: id, sourceTrackId }) =>
        window.desktop.activateMediaSourceTrack({ projectId: id, sourceTrackId }),
      { projectId, sourceTrackId: extracted.data.candidateSourceTrackId },
    );
    assert.equal(activated.ok, true, JSON.stringify(activated));
    assert.equal(activated.data.project.activeSourceTrackId, extracted.data.candidateSourceTrackId);

    const preview = await page6.evaluate(
      (id) => window.desktop.getMediaPreviewUrl({ projectId: id }),
      projectId,
    );
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.match(preview.data.url, /^app-media:\/\/asset\//);
    const crossWindowDenied = await phase6App.evaluate(async ({ BrowserWindow }, url) => {
      const other = new BrowserWindow({ show: false });
      try {
        await other.loadURL(url);
        return false;
      } catch {
        return true;
      } finally {
        other.destroy();
      }
    }, preview.data.url);
    assert.equal(crossWindowDenied, true);

    await page6.reload();
    await page6.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    await page6.evaluate((id) => {
      window.location.hash = `/projects/${id}`;
    }, projectId);
    const persistedMedia = await page6.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
    assert.equal(persistedMedia.ok, true);
    assert.ok(persistedMedia.data.sourceProbeSummary?.media);

    await closeApp(phase6App);
    phase6App = undefined;
    const relaunched = await electron.launch({
      executablePath: electronPath,
      args: [".", `--user-data-dir=${phase6UserData}`],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", MEDIA_E2E_FIXTURE_PATH: mkv },
      timeout: 60_000,
    });
    phase6App = relaunched;
    const page6b = await phase6App.firstWindow({ timeout: 60_000 });
    await page6b.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
    const reopened = await page6b.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.data.activeSourceTrackId, extracted.data.candidateSourceTrackId);
    assert.ok(reopened.data.sourceProbeSummary?.media);

    console.log("E2E Phase 6 media probe extract preview loop passed");
    await closeApp(phase6App);
    phase6App = undefined;
  } finally {
    await closeApp(phase6App);
    phase6App = undefined;
    rmSync(phase6UserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(phase6Work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  // Phase 7 real CPU ASR loop: verified managed assets, cancellation, restart,
  // segmentation, language correction, activation, editor entry, and missing media.
  const phase7UserData = createPhase7UserDataDir("development");
  const phase7Work = mkdtempSync(join(tmpdir(), "e2e-phase7-media-"));
  let phase7App;
  try {
    const { resolveVerifiedArtifactPaths } = await import("../backend/media/ffmpeg-artifact-manifest.mjs");
    const ffmpegManifest = JSON.parse(readFileSync(join(rootDir, "docs/third-party/ffmpeg/manifest.json"), "utf8"));
    const ffmpegRoot = join(rootDir, "resources", "ffmpeg", "win32-x64");
    const ffmpeg = resolveVerifiedArtifactPaths(ffmpegManifest, { artifactRootDir: ffmpegRoot });
    await stageVerifiedAsrAssets({ userDataDir: phase7UserData });
    const fixtures = await createPhase7MediaFixtures({
      ffmpegPath: ffmpeg.ffmpegPath,
      workDir: phase7Work,
    });
    const launchPhase7 = async (mediaPath) => {
      const launched7 = await electron.launch({
        executablePath: electronPath,
        args: [".", `--user-data-dir=${phase7UserData}`],
        env: {
          ...process.env,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
          MEDIA_E2E_FIXTURE_PATH: mediaPath,
        },
        timeout: 60_000,
      });
      const page7 = await launched7.firstWindow({ timeout: 60_000 });
      await page7.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
      return { app: launched7, page: page7 };
    };

    let launched7 = await launchPhase7(fixtures.videoPath);
    phase7App = launched7.app;
    const workflow = await runPhase7AsrWorkflow({
      page: launched7.page,
      userDataDir: phase7UserData,
      restartPage: async () => {
        await closeApp(phase7App);
        phase7App = undefined;
        launched7 = await launchPhase7(fixtures.videoPath);
        phase7App = launched7.app;
        return launched7.page;
      },
    });
    console.log("Development Phase 7 real video ASR workflow passed", workflow);
    await closeApp(phase7App);
    phase7App = undefined;

    launched7 = await launchPhase7(fixtures.audioPath);
    phase7App = launched7.app;
    const audioWorkflow = await runPhase7AudioSmoke({
      page: launched7.page,
      userDataDir: phase7UserData,
    });
    const phase7Metrics = await phase7App.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map(({ name, type }) => ({ name, type })),
    );
    assert.equal(phase7Metrics.filter((metric) => metric.name === "Task Supervisor").length, 1);
    assert.ok(phase7Metrics.every((metric) => !/(?:ASR|Media|Translation) Worker/i.test(metric.name)));
    assert.ok(phase7Metrics.every((metric) => !/whisper|ffmpeg|ffprobe/i.test(metric.name)));
    console.log("Development Phase 7 pure-audio shortest path passed", audioWorkflow);
  } finally {
    await closeApp(phase7App);
    phase7App = undefined;
    rmSync(phase7UserData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    rmSync(phase7Work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  console.log("E2E smoke passed");
} finally {
  await closeApp(app);
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
