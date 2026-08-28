import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDesktopPersistencePort } from "../../backend/persistence/desktop-persistence-port.mjs";

function project(id) {
  return {
    id,
    title: id,
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
    sourceTracks: [{
      id: `source-${id}`,
      label: "Source",
      kind: "external_subtitle",
      languageState: "pending",
      defaultLanguage: "auto",
      isActive: true,
      summary: "1 cue",
      segments: [{
        id: "cue-1",
        start: "00:00:00,000",
        end: "00:00:01,000",
        sourceLanguage: "auto",
        sourceText: { original: "hello", normalized: "hello" },
        targetTexts: { "zh-CN": { model: "", postProcessed: "", qaFlags: [] } },
      }],
      targetTracks: [{
        id: "target-zh",
        languageCode: "zh-CN",
        languageLabel: "zh-CN",
        status: "draft",
        isActive: true,
        qaIssues: [],
        snapshotIds: [],
        deliveryLabel: "未开跑",
        lastHumanAction: "imported",
      }],
    }],
    recentRunIds: [],
  };
}

test("batch project creation is all-or-nothing across containers and app index", () => {
  const root = mkdtempSync(join(tmpdir(), "phase9-batch-persistence-"));
  const appDir = join(root, "app");
  const projectsDir = join(root, "projects");
  const port = openDesktopPersistencePort({ appDir, projectsDir });
  try {
    assert.throws(() => port.createProjects([
      { project: project("project-a"), artifacts: [] },
      { project: { ...project("project-b"), sourceTracks: null }, artifacts: [] },
    ]));
    assert.deepEqual(port.listRecentProjects(), []);
    assert.equal(existsSync(join(projectsDir, "project-a")), false);
    assert.equal(existsSync(join(projectsDir, "project-b")), false);

    const created = port.createProjects([
      { project: project("project-a"), artifacts: [] },
      { project: project("project-b"), artifacts: [] },
    ]);
    assert.deepEqual(created.projectIds, ["project-a", "project-b"]);
    assert.deepEqual(created.projects.map(({ id }) => id), ["project-a", "project-b"]);
    assert.equal(port.listRecentProjects().length, 2);
    assert.equal(existsSync(join(projectsDir, "project-a", "project.sqlite")), true);
    assert.equal(existsSync(join(projectsDir, "project-b", "project.sqlite")), true);
  } finally {
    port.close();
    rmSync(root, { recursive: true, force: true });
  }
});
