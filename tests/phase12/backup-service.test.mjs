import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackupService } from "../../backend/backup/backup-service.mjs";
import { createProjectPackage } from "../../backend/export/project-package.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";

test("application backup verifies its payload and restores only after confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase12-backup-"));
  const backupPath = join(root, "backups");
  mkdirSync(backupPath);
  let settings = { schemaVersion: 1, startupPage: "projects" };
  let resources = [{ id: "glossary-1", kind: "glossary", name: "Terms", description: "", schemaVersion: 1, revision: 2, payload: { entries: [] }, updatedAt: "2026-07-23T00:00:00.000Z" }];
  let selectedFile = null;
  const service = createBackupService({
    backupPath: () => backupPath,
    projectsDir: join(root, "projects"),
    getAppState: () => ({ settings: structuredClone(settings), resources: structuredClone(resources) }),
    restoreAppState: async (state) => {
      settings = structuredClone(state.settings);
      resources = structuredClone(state.resources);
    },
    selectBackupFile: async () => ({ canceled: false, filePath: selectedFile }),
    now: () => new Date("2026-07-23T12:00:00.000Z"),
  });
  try {
    const created = service.createAppBackup();
    selectedFile = join(backupPath, created.fileName);
    assert.equal(created.sha256.length, 64);
    assert.equal(readFileSync(selectedFile, "utf8").includes("credential"), false);

    settings = { schemaVersion: 1, startupPage: "start" };
    resources = [];
    const preview = await service.selectRestore({ kind: "app" });
    assert.equal(preview.kind, "app");
    assert.equal(preview.summary.resourceCount, 1);
    await assert.rejects(() => service.restore({ token: preview.token, userConfirmed: false }), /confirmation/i);
    assert.equal(settings.startupPage, "start");

    const restored = await service.restore({ token: preview.token, userConfirmed: true });
    assert.equal(restored.restartRequired, true);
    assert.equal(settings.startupPage, "projects");
    assert.equal(resources[0].revision, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampered application backup is rejected before restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase12-backup-tamper-"));
  const backupPath = join(root, "backups");
  mkdirSync(backupPath);
  let selectedFile = null;
  const service = createBackupService({
    backupPath: () => backupPath,
    projectsDir: join(root, "projects"),
    getAppState: () => ({ settings: { schemaVersion: 1 }, resources: [] }),
    restoreAppState: async () => assert.fail("tampered backup must not restore"),
    selectBackupFile: async () => ({ canceled: false, filePath: selectedFile }),
  });
  try {
    const created = service.createAppBackup();
    selectedFile = join(backupPath, created.fileName);
    const raw = readFileSync(selectedFile, "utf8").replace('"schemaVersion":1', '"schemaVersion":9');
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(selectedFile, raw));
    await assert.rejects(() => service.selectRestore({ kind: "app" }), /checksum|invalid/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project restore migrates the verified package and keeps a safety archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase12-project-restore-"));
  const projectsDir = join(root, "projects");
  const backupPath = join(root, "backups");
  const containerDir = join(projectsDir, "project-backup");
  mkdirSync(backupPath, { recursive: true });
  const project = {
    id: "project-backup", title: "Original", sourceFileName: "source.srt", mediaKind: "subtitle", noSourceMedia: true,
    lifecycle: "draft", createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z",
    activeSourceTrackId: "source-1", pendingConfirmations: [], notes: [], recentRunIds: [],
    config: { sourceLanguage: "en", targetLanguages: ["zh-CN"], provider: "OpenAI", model: "GPT-4.1", glossary: "", styleGuide: "", outputFormat: "SRT", burnVideo: false, copyMediaIntoProject: false },
    sourceTracks: [{ id: "source-1", label: "Main", kind: "external_subtitle", languageState: "confirmed", defaultLanguage: "en", isActive: true, summary: "", segments: [], targetTracks: [] }],
  };
  let repo = openProjectRepository(containerDir);
  repo.saveProject(project);
  repo.close();
  const packaged = createProjectPackage({ containerDir, outputDir: backupPath, kind: "archive", includeTrash: true });
  repo = openProjectRepository(containerDir);
  repo.saveProject({ ...project, title: "Changed" });
  repo.close();
  const service = createBackupService({
    backupPath: () => backupPath,
    projectsDir,
    getAppState: () => ({ settings: { schemaVersion: 1 }, resources: [] }),
    restoreAppState: async () => {},
    selectBackupFile: async () => ({ canceled: false, filePath: packaged.outputPath }),
    onProjectRestored: () => {
      const migrated = openProjectRepository(containerDir);
      migrated.close();
    },
  });
  try {
    const selected = await service.selectRestore({ kind: "project" });
    const result = await service.restore({ token: selected.token, userConfirmed: true });
    assert.match(result.safetyBackupFileName, /archive/);
    repo = openProjectRepository(containerDir);
    assert.equal(repo.loadProject().title, "Original");
    repo.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
