import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runManagedProcess } from "../backend/media/process-runner.mjs";
import { validateAsrManifest } from "../backend/asr/runtime-registry.mjs";
import { ASR_VAD_RECOMMENDED_PARAMETERS } from "../shared/asr-vad-config.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const LOW_CONFIDENCE_THRESHOLD = 0.8;

function assertOk(result, label) {
  assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
  return result.data;
}

function safeRelativeProjectPath(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^artifacts\/media\/[A-Za-z0-9._-]+$/);
  return value.split("/");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// 这些受信构件（whisper 运行时 + 约 490MB 的模型）不在仓库里，也没有脚本会去下载它们，
// 必须事先铺到 fixtureRoot 下。缺件时只报一个文件名，接手的人无从知道该去铺什么。
function missingFixtureHint(path) {
  return [
    `缺少 ASR 验收构件：${path}`,
    "这些构件不随仓库分发，需要先按 docs/third-party/asr/manifest.json 的哈希铺到验收目录：",
    `  PHASE7_ASR_FIXTURE_ROOT  当前解析为 ${resolvePhase7FixtureRoot()}`,
    "  PHASE7_ASR_RUNTIME_ROOT  whisper 最小运行时（默认 <fixtureRoot>/whisper-min-runtime-v1.9.1）",
    `  PHASE7_ASR_MODEL_ROOT    模型文件所在目录（默认 <fixtureRoot>，模型 ${resolvePhase7ModelId()}）`,
  ].join("\n");
}

async function verifyFile(path, entry) {
  assert.equal(existsSync(path), true, missingFixtureHint(path));
  assert.equal(statSync(path).isFile(), true, `ASR acceptance asset is not a file: ${entry.relativePath}`);
  assert.equal(statSync(path).size, entry.sizeBytes, `ASR acceptance size mismatch: ${entry.relativePath}`);
  assert.equal(await sha256File(path), entry.sha256, `ASR acceptance hash mismatch: ${entry.relativePath}`);
}

export function resolvePhase7FixtureRoot() {
  return process.env.PHASE7_ASR_FIXTURE_ROOT ||
    join(tmpdir(), "desktop-ai-translator-phase7-t01-20260719");
}

export function resolvePhase7ModelId() {
  return process.env.PHASE7_ASR_MODEL_ID || "small";
}

export function createPhase7UserDataDir(label) {
  const localAppData = process.env.LOCALAPPDATA;
  assert.ok(localAppData && isAbsolute(localAppData), "LOCALAPPDATA is required for managed ASR acceptance roots");
  const root = join(localAppData, "AI Translator Phase7 Acceptance");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${label}-`));
}

export async function stageVerifiedAsrAssets({
  userDataDir,
  fixtureRoot = resolvePhase7FixtureRoot(),
  runtimeFixtureRoot = process.env.PHASE7_ASR_RUNTIME_ROOT || join(fixtureRoot, "whisper-min-runtime-v1.9.1"),
  modelFixtureRoot = process.env.PHASE7_ASR_MODEL_ROOT || fixtureRoot,
  modelId = resolvePhase7ModelId(),
  manifestPath = join(rootDir, "docs", "third-party", "asr", "manifest.json"),
  trustedNoticeRoot = join(rootDir, "docs", "third-party", "asr", "licenses"),
  includeRuntime = true,
  includeModel = true,
}) {
  assert.ok(isAbsolute(userDataDir));
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = validateAsrManifest(rawManifest);
  const selectedModel = manifest.models.find((model) => model.id === modelId);
  assert.ok(selectedModel, `ASR acceptance model is not declared: ${modelId}`);
  const targets = [
    ...(includeRuntime ? [{
      destinationRoot: join(userDataDir, "asr", "runtimes", manifest.runtime.id),
      entries: manifest.runtime.files,
      sourceFor: (entry) => entry.role === "notice"
        ? join(trustedNoticeRoot, basename(entry.relativePath))
        : join(runtimeFixtureRoot, ...entry.relativePath.split("/")),
    }] : []),
    ...(includeModel ? [{
      destinationRoot: join(userDataDir, "asr", "models", selectedModel.id),
      entries: selectedModel.files,
      sourceFor: (entry) => entry.role === "notice"
        ? join(trustedNoticeRoot, basename(entry.relativePath))
        : join(modelFixtureRoot, ...entry.relativePath.split("/")),
    }] : []),
  ];

  for (const target of targets) {
    rmSync(target.destinationRoot, { recursive: true, force: true });
    for (const entry of target.entries) {
      const source = target.sourceFor(entry);
      const destination = join(target.destinationRoot, ...entry.relativePath.split("/"));
      await verifyFile(source, entry);
      mkdirSync(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await verifyFile(destination, entry);
    }
  }
  return { ...manifest, model: selectedModel };
}

export async function createPhase7MediaFixtures({
  ffmpegPath,
  workDir,
  fixtureRoot = resolvePhase7FixtureRoot(),
}) {
  assert.ok(isAbsolute(ffmpegPath) && isAbsolute(workDir));
  const speechFixture = resolve(process.env.PHASE7_MEDIA_FIXTURE_PATH ?? join(fixtureRoot, "fixtures", "subtitle-pauses.wav"));
  mkdirSync(workDir, { recursive: true });
  const videoPath = join(workDir, "phase7-video-no-subtitles.mkv");
  const audioPath = join(workDir, "phase7-audio.wav");
  await runManagedProcess({
    absoluteExe: ffmpegPath,
    argv: [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-i", speechFixture,
      "-filter_complex",
      "[0:a]atrim=0:2,asetpts=PTS-STARTPTS,volume=0.15[speech];anoisesrc=color=white:amplitude=0.06:d=2:r=16000:seed=3[noise];[speech][noise]amix=inputs=2:normalize=0[noisy];anullsrc=r=16000:cl=mono:d=0.6[gap];[0:a]atrim=2:13.5,asetpts=PTS-STARTPTS[rest];anullsrc=r=16000:cl=mono:d=2[tail];[noisy][gap][rest][tail]concat=n=4:v=0:a=1[out]",
      "-map", "[out]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", audioPath,
    ],
    timeoutMs: 30_000,
  });
  await runManagedProcess({
    absoluteExe: ffmpegPath,
    argv: [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x64:r=1:d=16.1",
      "-i", audioPath,
      "-t", "16.1", "-map", "0:v:0", "-map", "1:a:0", "-sn",
      "-c:v", "ffv1", "-c:a", "pcm_s16le", videoPath,
    ],
    timeoutMs: 30_000,
  });
  return { videoPath, audioPath };
}

function protectedSourceTrack() {
  return {
    id: "protected-source",
    label: "Protected manual source",
    kind: "external_subtitle",
    languageState: "known",
    defaultLanguage: "en",
    isActive: true,
    summary: "Phase 7 human-work protection sentinel",
    segments: [{
      id: "protected-segment",
      start: "00:00:00,000",
      end: "00:00:01,500",
      sourceLanguage: "en",
      sourceText: {
        original: "Original protected line.",
        normalized: "Original protected line.",
        manual: "Human protected source edit.",
      },
      targetTexts: {
        "zh-CN": {
          model: "模型旧稿",
          postProcessed: "处理旧稿",
          manual: "人工保护译文",
          qaFlags: ["human-reviewed"],
        },
      },
    }],
    targetTracks: [{
      id: "protected-target",
      languageCode: "zh-CN",
      languageLabel: "简体中文",
      status: "in_review",
      isActive: true,
      role: "active",
      qaIssues: [],
      snapshotIds: [],
      deliveryLabel: "人工稿",
      lastHumanAction: "manual edit",
    }],
  };
}

function assertProtectedWork(project) {
  const track = project.sourceTracks.find((item) => item.id === "protected-source");
  assert.ok(track, "protected source track must survive ASR activation");
  assert.equal(track.segments[0].sourceText.manual, "Human protected source edit.");
  assert.equal(track.segments[0].targetTexts["zh-CN"].manual, "人工保护译文");
  assert.equal(track.targetTracks[0].id, "protected-target");
}

function sqliteAudit(userDataDir, projectId, expectedRuns) {
  const dbPath = join(userDataDir, "projects", projectId, "project.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const runCount = db.prepare("SELECT COUNT(*) AS count FROM asr_runs").get().count;
    const segmentCount = db.prepare("SELECT COUNT(*) AS count FROM asr_raw_segments").get().count;
    const wordCount = db.prepare("SELECT COUNT(*) AS count FROM asr_words").get().count;
    assert.equal(runCount, expectedRuns);
    if (expectedRuns === 0) {
      assert.equal(segmentCount, 0);
      assert.equal(wordCount, 0);
      return null;
    }
    assert.ok(segmentCount > 0);
    assert.ok(wordCount > 0);
    return db.prepare(
      "SELECT id, engine_id, engine_version, model_id, model_hash, cache_fingerprint, parameters_json, raw_artifact_relative_path, raw_artifact_sha256, raw_artifact_size_bytes, actual_device FROM asr_runs ORDER BY created_at DESC LIMIT 1",
    ).get();
  } finally {
    db.close();
  }
}

async function artifactAudit(userDataDir, projectId, runId, expectedModelHash, expectedVadMode = "auto", expectedVadHash = null, expectedRuns = 1, expectedVadParameters = null) {
  const row = sqliteAudit(userDataDir, projectId, expectedRuns);
  assert.equal(row.id, runId);
  assert.equal(row.engine_id, "whisper.cpp");
  assert.equal(row.engine_version, "1.9.1");
  assert.equal(row.model_id, resolvePhase7ModelId());
  assert.equal(row.model_hash, expectedModelHash);
  assert.match(row.cache_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(row.actual_device, "cpu");
  const vad = JSON.parse(row.parameters_json).vad;
  assert.equal(vad.mode, expectedVadMode);
  if (expectedVadMode === "off") {
    assert.equal(vad.model, null);
    assert.equal(vad.parameters, null);
  } else {
    assert.equal(vad.model.hash, expectedVadHash);
    if (expectedVadParameters) assert.deepEqual(vad.parameters, expectedVadParameters);
    else assert.equal(Number.isFinite(vad.parameters.threshold), true);
  }
  assert.match(row.raw_artifact_relative_path, /^artifacts\/asr\/[A-Za-z0-9._-]+\.json$/);
  const path = join(userDataDir, "projects", projectId, ...row.raw_artifact_relative_path.split("/"));
  assert.equal(statSync(path).size, row.raw_artifact_size_bytes);
  assert.equal(await sha256File(path), row.raw_artifact_sha256);
}

function assertCancelledClean(userDataDir, projectId, operationId) {
  sqliteAudit(userDataDir, projectId, 0);
  const projectRoot = join(userDataDir, "projects", projectId);
  assert.equal(existsSync(join(projectRoot, "cache", "asr", operationId)), false);
  const artifactRoot = join(projectRoot, "artifacts", "asr");
  assert.deepEqual(existsSync(artifactRoot) ? readdirSync(artifactRoot) : [], []);
}

export async function importAndConfirmAudio(page, { copyIntoProject }) {
  const imported = assertOk(await page.evaluate(
    (copy) => window.desktop.selectMediaSource({
      copyIntoProject: copy,
      defaults: { sourceLanguage: "auto", targetLanguages: ["zh-CN"] },
    }),
    copyIntoProject,
  ), "select media source");
  const project = imported.project;
  assert.equal(project.sourceProbeSummary.media.streams.some((stream) => stream.kind === "subtitle"), false);
  const audio = project.sourceProbeSummary.media.streams.find((stream) => stream.kind === "audio");
  assert.ok(audio?.streamId, "real audio stream required");
  const selected = assertOk(await page.evaluate(
    ({ projectId, audioStreamId }) => window.desktop.selectMediaStreams({
      projectId,
      audioStreamId,
      subtitleStreamId: null,
    }),
    { projectId: project.id, audioStreamId: audio.streamId },
  ), "confirm audio stream");
  assert.equal(selected.project.mediaSource.selectedAudioStreamId, audio.streamId);
  return { project: selected.project, audioStreamId: audio.streamId };
}

export function transcriptionRequest(projectId, audioStreamId, operationId, {
  requestedDevice = "cpu",
  allowCudaFallback = false,
} = {}) {
  return {
    projectId,
    audioStreamId,
    languageMode: "auto",
    languageHint: null,
    requestedDevice,
    allowCudaFallback,
    operationId,
  };
}

export async function runPhase7AsrWorkflow({ page: initialPage, userDataDir, restartPage }) {
  let page = initialPage;
  const expectedModelId = resolvePhase7ModelId();
  let capability = assertOk(await page.evaluate(() => window.desktop.getAsrCapabilityStatus({})), "initial ASR capability");
  const installedModel = capability.models.find((model) => model.id === expectedModelId);
  assert.ok(installedModel, `ASR capability omitted ${expectedModelId}`);
  assert.equal(installedModel.installState, "ready");
  let settings = assertOk(await page.evaluate(() => window.desktop.getAppSettings()), "read ASR default");
  if (settings.asrDefaultModelId !== expectedModelId) {
    settings = assertOk(await page.evaluate(
      ({ value, modelId }) => window.desktop.saveAppSettings({ settings: { ...value, asrDefaultModelId: modelId } }),
      { value: settings, modelId: expectedModelId },
    ), "select installed acceptance model");
  }
  capability = assertOk(await page.evaluate(() => window.desktop.getAsrCapabilityStatus({})), "selected ASR capability");
  assert.equal(capability.ready, true, JSON.stringify(capability));
  assert.equal(capability.runtime.installState, "ready");
  assert.equal(capability.model.installState, "ready");
  assert.equal(capability.model.id, expectedModelId);
  const missingModel = capability.models.find((model) =>
    model.id !== expectedModelId && model.id === "large-v3-turbo-q5_0" && model.installState !== "ready",
  ) ?? capability.models.find((model) => model.id !== expectedModelId && model.engineId === "whisper.cpp" && model.installState !== "ready");
  assert.ok(missingModel, "ASR acceptance requires one declared but uninstalled whisper.cpp model");
  const missingModelId = missingModel.id;

  const selected = await importAndConfirmAudio(page, { copyIntoProject: true });
  const projectId = selected.project.id;
  settings = assertOk(await page.evaluate(
    ({ value, modelId }) => window.desktop.saveAppSettings({ settings: { ...value, asrDefaultModelId: modelId } }),
    { value: settings, modelId: missingModelId },
  ), "persist uninstalled Turbo global default");
  const protectedProject = {
    ...selected.project,
    config: { ...selected.project.config, asrModelId: expectedModelId },
    activeSourceTrackId: "protected-source",
    sourceTracks: [protectedSourceTrack()],
  };
  assertOk(await page.evaluate(
    (project) => window.desktop.saveProject({ project }),
    protectedProject,
  ), "persist protected work");

  assertOk(await page.evaluate(
    (project) => window.desktop.saveProject({ project: { ...project, config: { ...project.config, asrModelId: null } } }),
    protectedProject,
  ), "inherit Turbo global default");
  const inheritedMissing = await page.evaluate(
    (request) => window.desktop.runAsrTranscription(request),
    transcriptionRequest(projectId, selected.audioStreamId, "p3-2-missing-global-model"),
  );
  assert.equal(inheritedMissing.ok, false, JSON.stringify(inheritedMissing));
  assert.equal(inheritedMissing.error.code, "NOT_AVAILABLE");
  assertCancelledClean(userDataDir, projectId, "p3-2-missing-global-model");
  assertOk(await page.evaluate(
    (project) => window.desktop.saveProject({ project }),
    protectedProject,
  ), "restore installed project override");
  const cancelOperationId = "phase7-cancel-real-cpu";
  const cancelled = await page.evaluate(async ({ request, projectId: id, operationId, modelId }) => {
    const pending = window.desktop.runAsrTranscription(request);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const uninstall = await window.desktop.uninstallAsrModel({
      assetId: modelId,
      operationId: "p3-2-running-model-uninstall",
    });
    const cancellation = await window.desktop.cancelAsrProjectOperation({ projectId: id, operationId });
    return { uninstall, cancellation, outcome: await pending };
  }, {
    request: transcriptionRequest(projectId, selected.audioStreamId, cancelOperationId),
    projectId,
    operationId: cancelOperationId,
    modelId: expectedModelId,
  });
  assert.equal(cancelled.uninstall.ok, false, JSON.stringify(cancelled));
  assert.equal(cancelled.uninstall.error.code, "CONFLICT");
  assert.match(cancelled.uninstall.error.message, /语音识别正在运行/);
  assert.equal(cancelled.cancellation.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.cancellation.data.cancelled, true, JSON.stringify(cancelled));
  assert.equal(cancelled.outcome.ok, false, JSON.stringify(cancelled));
  assert.equal(cancelled.outcome.error.code, "CANCELLED");
  assertCancelledClean(userDataDir, projectId, cancelOperationId);

  const successOperationId = "phase7-transcribe-real-cpu";
  const completed = assertOk(await page.evaluate(
    (request) => window.desktop.runAsrTranscription(request),
    transcriptionRequest(projectId, selected.audioStreamId, successOperationId),
  ), "real CPU transcription");
  assert.ok(completed.segmentCount > 0);
  assert.ok(completed.wordCount > 0);
  await artifactAudit(userDataDir, projectId, completed.runId, capability.model.modelHash, "auto", capability.vadModel.modelHash, 1, ASR_VAD_RECOMMENDED_PARAMETERS);

  let status = assertOk(await page.evaluate(
    (id) => window.desktop.getAsrProjectStatus({ projectId: id }),
    projectId,
  ), "ASR project status before restart");
  assert.equal(status.runs.length, 1);
  assert.equal(status.runs[0].actualDevice, "cpu");
  assert.equal(status.runs[0].wordCount, completed.wordCount);
  assert.equal(Object.hasOwn(status.runs[0], "operationId"), false);
  assert.equal(Object.hasOwn(status.runs[0], "rawArtifactRelativePath"), false);

  page = await restartPage();
  status = assertOk(await page.evaluate(
    (id) => window.desktop.getAsrProjectStatus({ projectId: id }),
    projectId,
  ), "ASR project status after restart");
  assert.equal(status.runs[0].id, completed.runId);
  assert.equal(status.runs[0].wordCount, completed.wordCount);
  assert.equal(status.project.config.asrModelId, expectedModelId);
  assert.equal(
    assertOk(await page.evaluate(() => window.desktop.getAppSettings()), "ASR default after restart").asrDefaultModelId,
    missingModelId,
  );
  assertProtectedWork(status.project);

  await page.evaluate(() => { window.location.hash = "/system/asr"; });
  await page.getByRole("heading", { name: "本地语音识别" }).waitFor({ timeout: 30_000 });
  const modelPage = page.locator(".asset-ledger");
  const modelRow = (modelId) => modelPage.locator(":scope > article").filter({
    hasText: `${modelId} ·`,
  }).first();
  const missingRow = modelRow(missingModelId);
  const installedRow = modelRow(expectedModelId);
  await missingRow.waitFor();
  await installedRow.waitFor();
  assert.match(await missingRow.getAttribute("class") ?? "", /is-selected/);
  assert.match(await missingRow.innerText(), /未安装/);
  assert.match(await installedRow.innerText(), /可用/);
  assert.match(await installedRow.innerText(), /CPU/);
  await installedRow.getByRole("button", { name: "设为默认", exact: true }).click();
  await page.getByText(`已将 ${expectedModelId} 保存为全局默认模型。`, { exact: true }).waitFor();
  const uninstallButton = installedRow.getByRole("button", { name: "卸载", exact: true });
  assert.equal(await uninstallButton.isEnabled(), true);
  await uninstallButton.click();
  const uninstallDialog = page.getByRole("dialog", { name: `卸载模型 ${expectedModelId}？` });
  await uninstallDialog.waitFor();
  await uninstallDialog.getByRole("button", { name: "取消", exact: true }).click();
  await uninstallDialog.waitFor({ state: "hidden" });
  assert.match(await installedRow.innerText(), /可用/);
  const afterCancelledUninstall = assertOk(
    await page.evaluate(() => window.desktop.getAsrCapabilityStatus({})),
    "ASR capability after cancelled uninstall",
  );
  assert.equal(
    afterCancelledUninstall.models.find((model) => model.id === expectedModelId)?.installState,
    "ready",
    JSON.stringify(afterCancelledUninstall),
  );

  const segmented = assertOk(await page.evaluate(
    (request) => window.desktop.segmentAsrRun(request),
    {
      projectId,
      asrRunId: completed.runId,
      configVersion: "asr-segmentation-v3",
      operationId: "phase7-segment-real-run",
    },
  ), "segment persisted ASR run");
  const candidateId = segmented.sourceTrackId;
  let candidate = segmented.project.sourceTracks.find((track) => track.id === candidateId);
  assert.ok(candidate?.segments.length > 0);
  assert.equal(candidate.isActive, false);
  assert.equal(segmented.project.activeSourceTrackId, "protected-source");
  assertProtectedWork(segmented.project);

  const detected = assertOk(await page.evaluate(
    (request) => window.desktop.detectAsrSegmentLanguages(request),
    {
      projectId,
      sourceTrackId: candidateId,
      requestedDevice: "cpu",
      allowCudaFallback: false,
      operationId: "phase7-detect-real-regions",
    },
  ), "detect real segment languages");
  candidate = detected.project.sourceTracks.find((track) => track.id === candidateId);
  assert.ok(candidate.segments.every((segment) => Number.isFinite(segment.languageConfidence)));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.evaluate((id) => { window.location.hash = `/projects/${id}/media`; }, projectId);
  await page.getByTestId("asr-project-workflow").waitFor({ timeout: 30_000 });
  const runLedger = page.locator(".asr-run-ledger > article");
  await runLedger.first().waitFor({ timeout: 30_000 });
  assert.equal(await runLedger.count(), 1, "only the completed ASR run is visible");
  assert.match(await runLedger.first().innerText(), new RegExp(`${expectedModelId}.*CPU|CPU.*${expectedModelId}`, "s"));
  await page.getByRole("button", { name: "生成候选源轨", exact: true }).waitFor();
  await page.getByRole("button", { name: "检测语言区域", exact: true }).waitFor();
  const activateButton = page.getByRole("button", { name: "使用这份识别字幕", exact: true });
  await activateButton.waitFor();
  const asrLayout = await page.getByTestId("asr-project-workflow").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const activation = [...element.querySelectorAll("button")].find((button) => button.textContent?.includes("使用这份识别字幕"));
    const activationRect = activation?.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      activationRight: activationRect?.right ?? Number.POSITIVE_INFINITY,
      workflowRight: rect.right,
    };
  });
  assert.ok(asrLayout.scrollWidth <= asrLayout.clientWidth + 1, JSON.stringify(asrLayout));
  assert.ok(asrLayout.activationRight <= asrLayout.workflowRight + 1, JSON.stringify(asrLayout));
  const correctionTarget = [...candidate.segments].sort(
    (left, right) => left.languageConfidence - right.languageConfidence,
  )[0];
  assert.ok(
    correctionTarget.languageConfidence < LOW_CONFIDENCE_THRESHOLD,
    `real fixture must expose a low-confidence segment, got ${correctionTarget.languageConfidence}`,
  );
  const beforeCorrection = structuredClone(candidate);
  const manualLanguage = correctionTarget.detectedLanguage === "und" ? "en" : correctionTarget.detectedLanguage;
  const corrected = assertOk(await page.evaluate(
    (request) => window.desktop.updateAsrSegmentLanguages(request),
    {
      projectId,
      sourceTrackId: candidateId,
      changes: [{ segmentId: correctionTarget.id, manualLanguage }],
      confirmTrackConvergence: false,
    },
  ), "manually correct lowest-confidence segment");
  candidate = corrected.project.sourceTracks.find((track) => track.id === candidateId);
  const correctedSegment = candidate.segments.find((segment) => segment.id === correctionTarget.id);
  assert.equal(correctedSegment.manualLanguage, manualLanguage);
  assert.equal(correctedSegment.sourceLanguage, manualLanguage);
  for (const segment of candidate.segments.filter((item) => item.id !== correctionTarget.id)) {
    assert.deepEqual(segment, beforeCorrection.segments.find((item) => item.id === segment.id));
  }
  assert.deepEqual(candidate.targetTracks, beforeCorrection.targetTracks);
  assert.ok(candidate.segments.every((segment) =>
    Object.values(segment.targetTexts).every((target) => target.model === "" && target.postProcessed === ""),
  ));

  const activated = assertOk(await page.evaluate(
    ({ projectId: id, sourceTrackId }) => window.desktop.activateMediaSourceTrack({ projectId: id, sourceTrackId }),
    { projectId, sourceTrackId: candidateId },
  ), "activate ASR candidate");
  assert.equal(activated.project.activeSourceTrackId, candidateId);
  assertProtectedWork(activated.project);
  candidate = activated.project.sourceTracks.find((track) => track.id === candidateId);
  assert.equal(candidate.segments.find((segment) => segment.id === correctionTarget.id).manualLanguage, manualLanguage);

  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.evaluate((id) => {
    window.location.hash = `/projects/${id}`;
  }, projectId);
  await page.getByRole("heading", { name: activated.project.title }).waitFor({ timeout: 30_000 });
  const openEditor = page.locator(".subtitle-preview .inspector-link").filter({ hasText: "打开字幕编辑与校对" });
  assert.equal(await openEditor.isDisabled(), false);
  await openEditor.click();
  await page.locator('[data-fr02-view="editor"]').waitFor({ timeout: 30_000 });
  await page.getByText(correctedSegment.sourceText.normalized, { exact: true }).first().waitFor();
  const sourceCells = page.locator(".segment-source");
  const correctedIndex = (await sourceCells.allTextContents()).findIndex(
    (text) => text === correctedSegment.sourceText.normalized,
  );
  assert.notEqual(correctedIndex, -1, "corrected ASR segment is visible in the new editor");
  await sourceCells.nth(correctedIndex).locator("..").click();

  const mediaRelativePath = activated.project.sourceProjectRelativePath;
  const mediaPath = resolve(join(userDataDir, "projects", projectId), ...safeRelativeProjectPath(mediaRelativePath));
  const projectRoot = resolve(join(userDataDir, "projects", projectId));
  assert.equal(relative(projectRoot, mediaPath).startsWith(".."), false);
  rmSync(mediaPath);
  const missing = assertOk(await page.evaluate(
    (id) => window.desktop.probeMedia({ projectId: id }),
    projectId,
  ), "mark copied media missing");
  assert.equal(missing.availability, "missing");
  assert.equal(missing.project.mediaSource.availability, "missing");
  assert.equal(missing.project.activeSourceTrackId, candidateId);
  assertProtectedWork(missing.project);
  const unavailable = await page.evaluate(
    (request) => window.desktop.runAsrTranscription(request),
    transcriptionRequest(projectId, selected.audioStreamId, "phase7-missing-media-run"),
  );
  assert.equal(unavailable.ok, false, JSON.stringify(unavailable));
  assert.equal(unavailable.error.code, "NOT_FOUND");
  const reopened = assertOk(await page.evaluate(
    (id) => window.desktop.openProject({ projectId: id }),
    projectId,
  ), "open project with missing media");
  assert.equal(reopened.activeSourceTrackId, candidateId);
  assert.ok(reopened.sourceTracks.find((track) => track.id === candidateId));

  const reopenedSettings = assertOk(await page.evaluate(() => window.desktop.getAppSettings()), "restore ASR default");
  assertOk(await page.evaluate(
    ({ value, modelId }) => window.desktop.saveAppSettings({ settings: { ...value, asrDefaultModelId: modelId } }),
    { value: reopenedSettings, modelId: expectedModelId },
  ), "restore installed global default for following smoke");
  const finalCapability = assertOk(
    await page.evaluate(() => window.desktop.getAsrCapabilityStatus({})),
    "final video ASR capability",
  );
  assert.equal(
    finalCapability.models.find((model) => model.id === expectedModelId)?.installState,
    "ready",
    JSON.stringify(finalCapability),
  );

  return {
    projectId,
    runId: completed.runId,
    candidateId,
    segmentCount: candidate.segments.length,
    minimumLanguageConfidence: correctionTarget.languageConfidence,
    correctedLowConfidence: correctionTarget.languageConfidence < LOW_CONFIDENCE_THRESHOLD,
  };
}

export async function runPhase7AudioSmoke({ page, userDataDir }) {
  const expectedModelId = resolvePhase7ModelId();
  const startupSettings = assertOk(await page.evaluate(() => window.desktop.getAppSettings()), "read audio ASR default");
  assertOk(await page.evaluate(
    ({ settings, modelId }) => window.desktop.saveAppSettings({ settings: { ...settings, asrDefaultModelId: modelId } }),
    { settings: startupSettings, modelId: expectedModelId },
  ), "select installed audio ASR default");
  const capability = assertOk(await page.evaluate(() => window.desktop.getAsrCapabilityStatus({})), "audio ASR capability");
  assert.equal(capability.ready, true, JSON.stringify(capability));
  assert.equal(capability.model.id, expectedModelId);
  const selected = await importAndConfirmAudio(page, { copyIntoProject: false });
  const initialSettings = assertOk(await page.evaluate(() => window.desktop.getAppSettings()), "read VAD settings for audio smoke");
  assertOk(await page.evaluate(
    (settings) => window.desktop.saveAppSettings({ settings: { ...settings, asrVad: { ...settings.asrVad, mode: "off" } } }),
    initialSettings,
  ), "persist VAD off mode");
  const completed = assertOk(await page.evaluate(
    (request) => window.desktop.runAsrTranscription(request),
    transcriptionRequest(selected.project.id, selected.audioStreamId, "phase7-audio-vad-off-run"),
  ), "pure audio VAD-off transcription");
  await artifactAudit(userDataDir, selected.project.id, completed.runId, capability.model.modelHash, "off");

  const customSettings = assertOk(await page.evaluate(() => window.desktop.getAppSettings()), "read VAD off settings");
  const customParameters = {
    threshold: 0.6,
    minSpeechDurationMs: 100,
    minSilenceDurationMs: 400,
    maxSpeechDurationSeconds: 10,
    speechPadMs: 60,
    samplesOverlapSeconds: 0.2,
  };
  assertOk(await page.evaluate(
    ({ settings, parameters }) => window.desktop.saveAppSettings({ settings: { ...settings, asrVad: { mode: "custom", customParameters: parameters } } }),
    { settings: customSettings, parameters: customParameters },
  ), "persist custom VAD mode");
  const customCompleted = assertOk(await page.evaluate(
    (request) => window.desktop.runAsrTranscription(request),
    transcriptionRequest(selected.project.id, selected.audioStreamId, "phase7-audio-vad-custom-run"),
  ), "pure audio custom-VAD transcription");
  assert.ok(customCompleted.segmentCount > 0);
  assert.ok(customCompleted.wordCount > 0);
  await artifactAudit(userDataDir, selected.project.id, customCompleted.runId, capability.model.modelHash, "custom", capability.vadModel.modelHash, 2, customParameters);

  const segmented = assertOk(await page.evaluate(
    (request) => window.desktop.segmentAsrRun(request),
    {
      projectId: selected.project.id,
      asrRunId: completed.runId,
      configVersion: "asr-segmentation-v3",
      operationId: "phase7-audio-shortest-segment",
    },
  ), "pure audio segmentation");
  const activated = assertOk(await page.evaluate(
    ({ projectId, sourceTrackId }) => window.desktop.activateMediaSourceTrack({ projectId, sourceTrackId }),
    { projectId: selected.project.id, sourceTrackId: segmented.sourceTrackId },
  ), "pure audio candidate activation");
  assert.equal(activated.project.activeSourceTrackId, segmented.sourceTrackId);
  const finalSettings = assertOk(await page.evaluate(() => window.desktop.getAppSettings()), "restore automatic VAD mode");
  assertOk(await page.evaluate(
    (settings) => window.desktop.saveAppSettings({ settings: { ...settings, asrVad: { ...settings.asrVad, mode: "auto" } } }),
    finalSettings,
  ), "restore automatic VAD mode");
  return { projectId: selected.project.id, runId: completed.runId };
}
