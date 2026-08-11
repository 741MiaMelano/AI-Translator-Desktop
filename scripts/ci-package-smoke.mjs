import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "@playwright/test";
import { VOCAL_SEPARATION_IDENTITY } from "../backend/audio/vocal-separation-process.mjs";
import { SONG_CLASSIFIER_IDENTITY } from "../backend/audio/song-classifier-process.mjs";
import { validateAsrManifest } from "../backend/asr/runtime-registry.mjs";
import { validateQwenManifest } from "../backend/asr/qwen3-asr-port.mjs";
import { resolveVerifiedArtifactPaths } from "../backend/media/ffmpeg-artifact-manifest.mjs";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

const releaseRoot = process.env.PHASE14_PACKAGED_ROOT ?? join(process.cwd(), "release", "win-unpacked");
const resources = join(releaseRoot, "resources");
const executable = join(releaseRoot, "AI Translator Desktop.exe");
for (const path of [
  executable,
  join(releaseRoot, "LICENSE.electron.txt"),
  join(releaseRoot, "LICENSES.chromium.html"),
  join(resources, "LICENSE"),
  join(resources, "THIRD-PARTY-NOTICES.txt"),
]) assert.equal(existsSync(path), true, `missing packaged release file: ${path}`);
for (const path of [join(resources, "app", "node_modules"), join(resources, "app.asar.unpacked", "node_modules")]) {
  assert.equal(existsSync(path), false, `development dependency tree leaked into package: ${path}`);
}

resolveVerifiedArtifactPaths(
  JSON.parse(readFileSync(join(resources, "ffmpeg", "manifest.json"), "utf8")),
  { artifactRootDir: join(resources, "ffmpeg", "win32-x64") },
);
const asr = validateAsrManifest(JSON.parse(readFileSync(join(resources, "asr", "manifest.json"), "utf8")));
const qwen = validateQwenManifest(JSON.parse(readFileSync(join(resources, "asr", "qwen-manifest.json"), "utf8")));
assert.equal(existsSync(join(resources, "asr", "runtime", asr.runtime.id, asr.runtime.executable)), true);
assert.equal(existsSync(join(resources, "asr", "models", asr.model.id, "ggml-small.bin")), false);
assert.equal(existsSync(join(resources, qwen.runtime.requirementsFile)), true);
assert.equal(existsSync(join(resources, qwen.runtime.sidecarFile)), true);
assert.equal(existsSync(join(resources, "asr", "models", "qwen3-asr-0.6b")), false);

const separationRoot = join(resources, "audio-separation");
const separation = JSON.parse(readFileSync(join(separationRoot, "manifest.json"), "utf8"));
assert.equal(separation.schemaVersion, 1);
assert.equal(separation.engine.id, VOCAL_SEPARATION_IDENTITY.engineId);
assert.equal(separation.engine.version, VOCAL_SEPARATION_IDENTITY.engineVersion);
assert.equal(separation.sharedRuntime.id, qwen.runtime.id);
assert.equal(separation.sharedRuntime.version, qwen.runtime.version);
assert.equal(separation.model.id, VOCAL_SEPARATION_IDENTITY.modelId);
assert.equal(separation.model.revision, VOCAL_SEPARATION_IDENTITY.modelRevision);
assert.equal(separation.model.modelHash, VOCAL_SEPARATION_IDENTITY.modelSha256);
assert.equal(existsSync(join(separationRoot, separation.engine.notice.relativePath)), true);
for (const file of separation.model.files) {
  assert.equal(
    existsSync(join(separationRoot, file.relativePath)),
    file.role === "notice",
    `${file.role} package boundary is invalid: ${file.relativePath}`,
  );
}
assert.equal(existsSync(join(separationRoot, "models")), false);

const songClassifierRoot = join(resources, "song-classifier");
const songClassifier = JSON.parse(readFileSync(join(songClassifierRoot, "manifest.json"), "utf8"));
assert.equal(songClassifier.detector.id, SONG_CLASSIFIER_IDENTITY.detectorId);
assert.equal(songClassifier.model.sha256, SONG_CLASSIFIER_IDENTITY.modelSha256);
assert.equal(existsSync(join(resources, "backend", "audio", "song-classifier-sidecar.py")), true);
assert.equal(existsSync(join(songClassifierRoot, SONG_CLASSIFIER_IDENTITY.modelFileName)), false);
for (const notice of [
  "INA-SPEECH-SEGMENTER-MIT.txt", "H5PY-BSD-3-CLAUSE.txt",
  "SIDEKIT-LGPL-3.0-NOTICE.txt", "LGPL-3.0.txt", "GPL-3.0.txt",
]) {
  assert.equal(existsSync(join(songClassifierRoot, "licenses", notice)), true);
}

const ownsUserDataDir = !process.env.PHASE14_USER_DATA_DIR;
const userDataDir = process.env.PHASE14_USER_DATA_DIR ?? mkdtempSync(join(tmpdir(), "phase14-ci-package-"));
const expectPersistedSettings = process.env.PHASE14_EXPECT_PERSISTED_SETTINGS === "1";
mkdirSync(userDataDir, { recursive: true });
let app;

async function launch() {
  const launched = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", TRANSLATION_FAKE_PROVIDER: "1" },
    timeout: 60_000,
  });
  const page = await launched.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.desktop?.getAsrCapabilityStatus));
  return { launched, page };
}

try {
  let opened = await launch();
  app = opened.launched;
  let page = opened.page;
  const capability = await page.evaluate(() => window.desktop.getAsrCapabilityStatus({}));
  assert.equal(capability.ok, true, JSON.stringify(capability));
  assert.equal(capability.data.runtime.installState, "ready");
  assert.equal(capability.data.model.installState, "not_installed");
  await page.getByTestId("first-run-readiness").waitFor({ timeout: 30_000 });
  await page.getByText("FFmpeg 已内置并通过校验", { exact: true }).waitFor();
  await page.getByText("语音识别模型尚未安装", { exact: true }).waitFor();
  await page.getByRole("button", { name: "连接模型", exact: true }).waitFor();

  const settings = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(settings.ok, true, JSON.stringify(settings));
  if (expectPersistedSettings) {
    assert.equal(settings.data.notifications.release, false, "installer upgrade did not preserve application settings");
  } else {
    const saved = await page.evaluate((current) => window.desktop.saveAppSettings({ settings: {
      ...current,
      notifications: { ...current.notifications, release: false },
    } }), settings.data);
    assert.equal(saved.ok, true, JSON.stringify(saved));
  }
  const backup = await page.evaluate(() => window.desktop.createAppBackup());
  assert.equal(backup.ok, true, JSON.stringify(backup));
  assert.equal(existsSync(join(userDataDir, "backups", backup.data.fileName)), true);

  await closeElectronApp(app);
  app = undefined;
  opened = await launch();
  app = opened.launched;
  page = opened.page;
  const reopened = await page.evaluate(() => window.desktop.getAppSettings());
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(reopened.data.notifications.release, false, "packaged restart lost application settings");
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  if (ownsUserDataDir) rmSync(userDataDir, { recursive: true, force: true });
}

console.log("Phase 14 packaged first-run, restart, backup, and compliance smoke passed");
