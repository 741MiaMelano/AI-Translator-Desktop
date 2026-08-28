import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppSettingsService } from "../../backend/settings/app-settings.mjs";
import { openAppRepository } from "../../backend/persistence/app-repository.mjs";
import { DEFAULT_ASR_VAD_SETTINGS } from "../../shared/asr-vad-config.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "phase12-settings-"));
  const paths = {
    cachePath: join(root, "cache"),
    modelPath: join(root, "models"),
    backupPath: join(root, "backups"),
  };
  Object.values(paths).forEach((path) => mkdirSync(path));
  return { root, paths };
}

test("system settings persist across repository reopen without project configuration", async () => {
  const { root, paths } = fixture();
  const defaults = {
    schemaVersion: 1,
    startupPage: "resume",
    translationProvider: null,
    translationModel: null,
    asrDefaultModelId: "small",
    ...paths,
    downloadSource: "official",
    customDownloadUrl: "",
    notifications: { taskDone: true, error: true, release: true, system: true },
  };
  try {
    let repository = openAppRepository(join(root, "app"));
    let service = createAppSettingsService({ repository, defaults });
    const saved = await service.save({
      ...defaults,
      startupPage: "projects",
      translationProvider: "DeepSeek",
      translationModel: "deepseek-v4-flash",
      asrDefaultModelId: "large-v3-turbo-q5_0",
      asrVocalSeparation: "on",
      asrSongHandling: "filter",
      downloadSource: "mirror",
      notifications: { taskDone: false, error: true, release: false, system: true },
    });
    assert.equal(saved.startupPage, "projects");
    assert.equal(saved.translationModel, "deepseek-v4-flash");
    assert.equal(saved.asrDefaultModelId, "large-v3-turbo-q5_0");
    assert.equal(saved.asrVocalSeparation, "on");
    assert.equal(saved.asrSongHandling, "filter");
    repository.close();

    repository = openAppRepository(join(root, "app"));
    service = createAppSettingsService({ repository, defaults });
    assert.deepEqual(service.get(), saved);
    repository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings reject illegal paths, unsafe custom sources and project fields", async () => {
  const { root, paths } = fixture();
  const repository = openAppRepository(join(root, "app"));
  const defaults = {
    schemaVersion: 1,
    startupPage: "resume",
    asrDefaultModelId: "small",
    ...paths,
    downloadSource: "official",
    customDownloadUrl: "",
    notifications: { taskDone: true, error: true, release: true, system: true },
  };
  const service = createAppSettingsService({ repository, defaults });
  try {
    await assert.rejects(() => service.save({ ...defaults, cachePath: "relative/cache" }), /absolute/i);
    await assert.rejects(() => service.save({ ...defaults, downloadSource: "custom", customDownloadUrl: "http://localhost/model.bin" }), /HTTPS/i);
    await assert.rejects(() => service.save({ ...defaults, asrVocalSeparation: "strong" }), /Vocal separation/i);
    await assert.rejects(() => service.save({ ...defaults, asrSongHandling: "auto" }), /Song handling/i);
    await assert.rejects(() => service.save({ ...defaults, projectId: "project-1" }), /field/i);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary saves and reset keep the model path locked while verified relocation can change it", async () => {
  const { root, paths } = fixture();
  const relocated = join(root, "relocated-models");
  mkdirSync(relocated);
  const repository = openAppRepository(join(root, "app"));
  const defaults = {
    schemaVersion: 1, startupPage: "resume", asrDefaultModelId: "small", ...paths,
    downloadSource: "official", customDownloadUrl: "",
    notifications: { taskDone: true, error: true, release: true, system: true },
  };
  const service = createAppSettingsService({ repository, defaults });
  try {
    await assert.rejects(() => service.save({ ...service.get(), modelPath: relocated }), /转移现有模型/);
    assert.equal((await service.relocateModelPath(relocated)).modelPath, relocated);
    assert.equal((await service.reset()).modelPath, relocated);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy settings inherit the Small ASR and disabled vocal separation defaults", async () => {
  const { root, paths } = fixture();
  const defaults = {
    schemaVersion: 1,
    startupPage: "resume",
    asrDefaultModelId: "small",
    ...paths,
    downloadSource: "official",
    customDownloadUrl: "",
    notifications: { taskDone: true, error: true, release: true, system: true },
  };
  const { asrDefaultModelId: _legacyMissing, ...legacy } = defaults;
  const repository = { getAppSettings: () => legacy };
  const service = createAppSettingsService({ repository, defaults });
  try {
    assert.equal(service.get().asrDefaultModelId, "small");
    assert.deepEqual(service.get().asrVad, DEFAULT_ASR_VAD_SETTINGS);
    assert.equal(service.get().asrVocalSeparation, "off");
    assert.equal((await service.validate(legacy)).asrVocalSeparation, "off");
    assert.equal(service.get().asrSongHandling, "preserve");
    assert.equal((await service.validate(legacy)).asrSongHandling, "preserve");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom VAD settings persist across restart and invalid values never reach storage", async () => {
  const { root, paths } = fixture();
  const defaults = {
    schemaVersion: 1,
    startupPage: "resume",
    asrDefaultModelId: "small",
    asrVad: DEFAULT_ASR_VAD_SETTINGS,
    ...paths,
    downloadSource: "official",
    customDownloadUrl: "",
    notifications: { taskDone: true, error: true, release: true, system: true },
  };
  const custom = {
    mode: "custom",
    customParameters: {
      threshold: 0.7,
      minSpeechDurationMs: 90,
      minSilenceDurationMs: 500,
      maxSpeechDurationSeconds: 20,
      speechPadMs: 80,
      samplesOverlapSeconds: 0.2,
    },
  };
  try {
    let repository = openAppRepository(join(root, "app"));
    let service = createAppSettingsService({ repository, defaults });
    await service.save({ ...defaults, asrVad: custom });
    repository.close();

    repository = openAppRepository(join(root, "app"));
    service = createAppSettingsService({ repository, defaults });
    assert.deepEqual(service.get().asrVad, custom);
    await assert.rejects(
      () => service.save({ ...defaults, asrVad: { ...custom, customParameters: { ...custom.customParameters, threshold: 2 } } }),
      (error) => error?.code === "INVALID_INPUT",
    );
    assert.deepEqual(service.get().asrVad, custom);
    repository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
