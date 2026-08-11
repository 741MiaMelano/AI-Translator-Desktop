import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("package.json main points at Electron main output", () => {
  assert.equal(packageJson.main, "dist-electron/main.js");
});

test("Electron main and preload source entries exist", () => {
  assert.equal(existsSync(join(root, "electron/main.ts")), true);
  assert.equal(existsSync(join(root, "electron/preload.ts")), true);
});

test("BrowserWindow security defaults are fixed in main source", () => {
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  assert.match(mainSource, /contextIsolation:\s*true/);
  assert.match(mainSource, /nodeIntegration:\s*false/);
  assert.match(mainSource, /sandbox:\s*true/);
  assert.match(mainSource, /webSecurity:\s*true/);
});

test("packaged translation runtime keeps shared provider registry and utilityProcess boundary", () => {
  const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  const translationPort = readFileSync(
    join(root, "backend/translation/desktop-translation-port.mjs"),
    "utf8",
  );

  assert.equal(existsSync(join(root, "shared/provider-registry.mjs")), true);
  assert.match(builder, /shared\/\*\*\/\*/);
  assert.match(mainSource, /utilityProcess/);
  assert.doesNotMatch(translationPort, /createOpenAICompatibleClient|createTranslateService/);
});

test("P2 production translation worker keeps the complete project segments for summary context", () => {
  const supervisorSource = readFileSync(join(root, "backend/worker/task-supervisor-entry.mjs"), "utf8");
  assert.match(supervisorSource, /segments:\s*message\.segments,[\s\S]{0,120}projectSegments:\s*message\.projectSegments/);
});

test("production media runtime is composed through the task supervisor", () => {
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  const supervisorSource = readFileSync(join(root, "backend/worker/task-supervisor-entry.mjs"), "utf8");
  assert.match(mainSource, /taskSupervisorClient!\.runMediaProcess/);
  assert.match(mainSource, /taskSupervisorClient!\.cancelMedia/);
  assert.match(supervisorSource, /runManagedProcess/);
  assert.match(supervisorSource, /supervisor\.childProcess/);
  assert.match(mainSource, /webRequest\.onBeforeRequest/);
});

test("production ASR runtime is composed through the single task supervisor boundary", () => {
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  const supervisorSource = readFileSync(join(root, "backend/worker/task-supervisor-entry.mjs"), "utf8");
  const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");
  assert.equal(existsSync(join(root, "backend/worker/task-supervisor-entry.mjs")), true);
  assert.equal(existsSync(join(root, "backend/asr/runtime-process.mjs")), true);
  assert.equal(existsSync(join(root, "backend/asr/device-selector.mjs")), true);
  assert.match(mainSource, /createTaskSupervisorClient/);
  assert.match(mainSource, /task-supervisor-entry\.mjs/);
  assert.match(mainSource, /createAsrDeviceSelector/);
  assert.match(mainSource, /serviceName:\s*"Task Supervisor"/);
  assert.match(mainSource, /event\.preventDefault\(\)/);
  assert.match(mainSource, /await supervisor\.close\(\)/);
  assert.match(builder, /docs\/third-party\/asr\/manifest\.json/);
  assert.match(builder, /asr-runtime-staging/);
  assert.match(mainSource, /bundledRuntimeRoot/);
  assert.match(readFileSync(join(root, "electron/paths.ts"), "utf8"), /release["'],\s*["']asr-runtime-staging/);
  assert.match(mainSource, /net\.fetch/);
  assert.match(supervisorSource, /vad:\s*message\.vad/);
  assert.equal(mainSource.match(/openDownload,/g)?.length, 3);
  assert.doesNotMatch(mainSource, /process\.env\.PATH.*whisper|spawn\(\s*["']whisper-cli/i);
});

test("package command stages the verified CPU runtime while leaving the model external", () => {
  const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");
  const packageSource = readFileSync(join(root, "package.json"), "utf8");
  const packageJson = JSON.parse(packageSource);
  assert.equal(existsSync(join(root, "scripts/stage-packaged-asr-runtime.mjs")), true);
  assert.match(packageJson.scripts["start:desktop"], /^node scripts\/stage-packaged-asr-runtime\.mjs && electron \.$/);
  assert.match(packageJson.scripts["package:dir"], /^pnpm run build && node scripts\/stage-packaged-asr-runtime\.mjs/);
  assert.match(builder, /asr\/runtime\/whisper-cpp-cpu-x64/);
  assert.match(builder, /qwen-manifest\.json/);
  assert.match(builder, /qwen-requirements-cu128\.txt/);
  assert.match(builder, /qwen3-asr-sidecar\.py/);
  assert.doesNotMatch(builder, /ggml-small\.bin|asr\/models/);
});

test("production main composes the persisted ASR project workflow instead of renderer mocks", () => {
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  for (const factory of [
    "createAsrService",
    "createAsrCandidateService",
    "createAsrLanguageService",
    "createAsrProjectService",
  ]) {
    assert.match(mainSource, new RegExp(factory));
  }
  assert.match(mainSource, /taskSupervisorClient!\.transcribeAsr/);
  assert.match(mainSource, /taskSupervisorClient!\.detectAsrLanguageRegion/);
  assert.match(mainSource, /getProjectRepository/);
  assert.match(mainSource, /getDefaultModelId/);
  assert.match(mainSource, /isAssetInUse: \(\) => Boolean\(asrProjectService\?\.isBusy\(\)\) \|\| Boolean\(taskSupervisorClient\?\.isAsrBusy\(\)\)/);
  assert.doesNotMatch(mainSource, /renderer.*backend|mockAsr/i);
});

test("development and packaged smoke both require the real Phase 7 ASR acceptance workflow", () => {
  const helperPath = join(root, "scripts/asr-phase7-e2e.mjs");
  assert.equal(existsSync(helperPath), true);
  const development = readFileSync(join(root, "scripts/e2e-electron-smoke.mjs"), "utf8");
  const packaged = readFileSync(join(root, "scripts/e2e-packaged-smoke.mjs"), "utf8");
  const helper = existsSync(helperPath) ? readFileSync(helperPath, "utf8") : "";
  assert.match(development, /runPhase7AsrWorkflow/);
  assert.match(packaged, /runPhase7AsrWorkflow/);
  assert.match(helper, /runAsrTranscription/);
  assert.match(helper, /segmentAsrRun/);
  assert.match(helper, /detectAsrSegmentLanguages/);
  assert.match(helper, /updateAsrSegmentLanguages/);
  assert.match(helper, /activateMediaSourceTrack/);
  assert.match(helper, /cancelAsrProjectOperation/);
});

test("Phase 8 production main forks exactly one typed task supervisor", () => {
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  assert.equal(existsSync(join(root, "backend/worker/task-supervisor-entry.mjs")), true);
  assert.match(mainSource, /createTaskSupervisorClient/);
  assert.match(mainSource, /task-supervisor-entry\.mjs/);
  assert.match(mainSource, /serviceName:\s*"Task Supervisor"/);
  assert.equal(mainSource.match(/utilityProcess\.fork\(/g)?.length, 1);
  assert.doesNotMatch(mainSource, /create(?:Translation|Media|Asr)WorkerClient/);
});

test("Phase 8 production main composes and reconciles the durable task coordinator", () => {
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  assert.match(mainSource, /task-coordinator\.mjs/);
  assert.match(mainSource, /createTaskCoordinator/);
  assert.match(mainSource, /taskCoordinator\.reconcileInterrupted\(\)/);
  assert.match(mainSource, /taskCoordinator,\s*\n/);
  assert.match(mainSource, /onCrash:[\s\S]*reconcileInterrupted/);
});

test("Phase 8 close flow offers background, stop-and-exit, and cancel with tray ownership", () => {
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  assert.match(mainSource, /new Tray\(/);
  assert.match(mainSource, /buttons:\s*\["后台继续", "停止并退出", "取消退出"\]/);
  assert.match(mainSource, /await ipcAdapter\?\.stopActiveTasks\(\)/);
  assert.match(mainSource, /current\.hide\(\)/);
  assert.match(mainSource, /tray\?\.destroy\(\)/);
});

test("Phase 12 backup dialogs and project archive reveal use the configured backup directory", () => {
  const mainSource = readFileSync(join(root, "electron/main.ts"), "utf8");
  assert.match(mainSource, /defaultPath:\s*appSettingsService\.get\(\)\.backupPath/);
  assert.match(mainSource, /showItemInFolder:\s*\(path:\s*string\)\s*=>\s*shell\.showItemInFolder\(path\)/);
});
