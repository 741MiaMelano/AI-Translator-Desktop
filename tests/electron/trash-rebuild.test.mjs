import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createIpcAdapter } from "../../electron/ipc/adapter.mjs";
import { openDesktopPersistencePort } from "../../backend/persistence/desktop-persistence-port.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const appMigrationsDir = join(root, "migrations", "app");
const projectMigrationsDir = join(root, "migrations", "project");

function sampleProject(id, title) {
  return {
    id,
    title,
    sourceFileName: "basic-utf8.srt",
    mediaKind: "subtitle",
    noSourceMedia: true,
    lifecycle: "draft",
    createdAt: "2026-07-13 12:00",
    updatedAt: "2026-07-13 12:00",
    activeSourceTrackId: "source-1",
    pendingConfirmations: [],
    notes: [],
    config: {
      sourceLanguage: "auto",
      targetLanguages: ["zh-CN"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "g",
      styleGuide: "s",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "external_subtitle",
        languageState: "pending",
        defaultLanguage: "auto",
        isActive: true,
        summary: "s",
        segments: [
          {
            id: "seg-1",
            start: "00:00:01,000",
            end: "00:00:02,000",
            sourceLanguage: "auto",
            sourceText: { original: "hello", normalized: "hello" },
            targetTexts: {
              "zh-CN": { model: "nihao", postProcessed: "nihao", qaFlags: [] },
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
        ],
      },
    ],
    recentRunIds: [],
  };
}

function makeHarness() {
  const rootDir = mkdtempSync(join(tmpdir(), "p02-trash-"));
  const appDir = join(rootDir, "app");
  const projectsDir = join(rootDir, "projects");
  const fakeMainFrame = { url: "file:///app/index.html" };
  const fakeWebContents = { id: 1, mainFrame: fakeMainFrame };
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: fakeWebContents,
    minimize() {},
    maximize() {},
    unmaximize() {},
    isMaximized: () => false,
    destroy() {},
  };
  const adapter = createIpcAdapter({
    openDesktopPersistencePort,
    appDir,
    projectsDir,
    appMigrationsDir,
    projectMigrationsDir,
    getMainWindow: () => fakeWindow,
    requestCloseAfterFlush: () => {},
  });
  return {
    adapter,
    event: { sender: fakeWebContents, senderFrame: fakeMainFrame },
    appDir,
    projectsDir,
    cleanup: () => {
      adapter.close();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

test("trash and restore persist across reopen", async () => {
  const { adapter, event, cleanup } = makeHarness();
  try {
    const project = sampleProject("project-trash-1", "Trash Me");
    await adapter.handle(event, { method: "project.create", request: { project } });
    const trashed = {
      ...project,
      trashedAt: "2026-07-13 12:30",
      updatedAt: "2026-07-13 12:30",
    };
    await adapter.handle(event, { method: "project.save", request: { project: trashed } });
    const listed = await adapter.handle(event, { method: "project.listRecent", request: {} });
    assert.equal(listed.ok, true);
    assert.equal(listed.data[0].trashedAt, "2026-07-13 12:30");

    const restored = { ...trashed, trashedAt: undefined, updatedAt: "2026-07-13 12:40" };
    delete restored.trashedAt;
    await adapter.handle(event, { method: "project.save", request: { project: restored } });
    const opened = await adapter.handle(event, {
      method: "project.open",
      request: { projectId: project.id },
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.data.trashedAt, undefined);
    assert.equal(opened.data.title, "Trash Me");
  } finally {
    cleanup();
  }
});

test("index rebuild recovers projects after app.sqlite deletion", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "p02-rebuild-"));
  const appDir = join(rootDir, "app");
  const projectsDir = join(rootDir, "projects");
  const fakeMainFrame = { url: "file:///app/index.html" };
  const fakeWebContents = { id: 1, mainFrame: fakeMainFrame };
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: fakeWebContents,
    minimize() {},
    maximize() {},
    unmaximize() {},
    isMaximized: () => false,
    destroy() {},
  };
  const event = { sender: fakeWebContents, senderFrame: fakeMainFrame };
  const adapter = createIpcAdapter({
    openDesktopPersistencePort,
    appDir,
    projectsDir,
    appMigrationsDir,
    projectMigrationsDir,
    getMainWindow: () => fakeWindow,
    requestCloseAfterFlush: () => {},
  });
  try {
    const project = sampleProject("project-rebuild-1", "Rebuild Me");
    await adapter.handle(event, { method: "project.create", request: { project } });
    adapter.close();

    const projectDbPath = join(projectsDir, project.id, "project.sqlite");
    const projectHashBefore = createHash("sha256").update(readFileSync(projectDbPath)).digest("hex");

    const dbPath = join(appDir, "app.sqlite");
    assert.equal(existsSync(dbPath), true);
    unlinkSync(dbPath);

    const rebuiltAdapter = createIpcAdapter({
      openDesktopPersistencePort,
      appDir,
      projectsDir,
      appMigrationsDir,
      projectMigrationsDir,
      getMainWindow: () => fakeWindow,
      requestCloseAfterFlush: () => {},
    });
    try {
      const result = rebuiltAdapter.reconcileProjectIndex();
      assert.ok(result.rebuilt >= 1);
      const listed = await rebuiltAdapter.handle(event, {
        method: "project.listRecent",
        request: {},
      });
      assert.equal(listed.ok, true);
      assert.equal(listed.data.some((row) => row.id === project.id), true);
      const opened = await rebuiltAdapter.handle(event, {
        method: "project.open",
        request: { projectId: project.id },
      });
      assert.equal(opened.data.title, "Rebuild Me");
      const projectHashAfter = createHash("sha256").update(readFileSync(projectDbPath)).digest("hex");
      assert.equal(projectHashAfter, projectHashBefore, "index rebuild must not rewrite project data");
    } finally {
      rebuiltAdapter.close();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
