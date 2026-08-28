import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProjectPackage,
  listProjectPackageEntries,
  restoreProjectPackage,
} from "../../backend/export/project-package.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";

function projectFixture() {
  return {
    id: "package-project",
    title: "Package Demo",
    sourceFileName: "source.mkv",
    mediaKind: "video",
    noSourceMedia: false,
    lifecycle: "needs_review",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    activeSourceTrackId: "source-1",
    pendingConfirmations: [],
    notes: [],
    config: {
      sourceLanguage: "auto",
      targetLanguages: ["zh-CN"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "glossary",
      styleGuide: "style",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: true,
    },
    sourceTracks: [{
      id: "source-1",
      label: "Main",
      kind: "embedded_subtitle",
      languageState: "confirmed",
      defaultLanguage: "en",
      isActive: true,
      summary: "one cue",
      rawAssetRelativePath: "artifacts/raw/source.srt",
      segments: [{
        id: "segment-1",
        start: "00:00:00,000",
        end: "00:00:01,000",
        sourceLanguage: "en",
        sourceText: { original: "Hello", normalized: "Hello" },
        targetTexts: { "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] } },
      }],
      targetTracks: [{
        id: "target-zh",
        languageCode: "zh-CN",
        languageLabel: "简体中文",
        status: "in_review",
        isActive: true,
        qaIssues: [],
        snapshotIds: [],
        deliveryLabel: "待校对",
        lastHumanAction: "translated",
      }],
    }],
    recentRunIds: [],
    sourceProjectRelativePath: "artifacts/media/source.mkv",
    sourceProbeSummary: { subtitleFormat: "srt" },
  };
}

test("lightweight package restores as no-source-media while archive restores media", () => {
  const root = mkdtempSync(join(tmpdir(), "phase11-package-"));
  const containerDir = join(root, "project");
  const outputDir = join(root, "packages");
  const lightRestore = join(root, "restore-light");
  const archiveRestore = join(root, "restore-archive");
  const repo = openProjectRepository(containerDir);
  try {
    repo.saveProject(projectFixture());
    mkdirSync(join(containerDir, "artifacts", "media"), { recursive: true });
    mkdirSync(join(containerDir, "artifacts", "raw"), { recursive: true });
    writeFileSync(join(containerDir, "artifacts", "media", "source.mkv"), "media", "utf8");
    writeFileSync(join(containerDir, "artifacts", "raw", "source.srt"), "subtitle", "utf8");
    writeFileSync(join(containerDir, "logs", "run.log"), "private path", "utf8");
    writeFileSync(join(containerDir, "cache", "cache.bin"), "cache", "utf8");
    writeFileSync(join(containerDir, "credentials"), "must not ship", "utf8");
    writeFileSync(join(containerDir, "project.sqlite-wal"), "stale database sidecar", "utf8");

    const light = createProjectPackage({ containerDir, outputDir, kind: "lightweight" });
    const archive = createProjectPackage({ containerDir, outputDir, kind: "archive" });
    const lightEntries = listProjectPackageEntries(light.outputPath);
    const archiveEntries = listProjectPackageEntries(archive.outputPath);
    assert.ok(lightEntries.includes("project.sqlite"));
    assert.ok(lightEntries.includes("artifacts/raw/source.srt"));
    assert.ok(!lightEntries.includes("artifacts/media/source.mkv"));
    assert.ok(archiveEntries.includes("artifacts/media/source.mkv"));
    for (const entries of [lightEntries, archiveEntries]) {
      assert.ok(!entries.some((entry) => entry.startsWith("logs/")));
      assert.ok(!entries.some((entry) => entry.startsWith("cache/")));
      assert.ok(!entries.some((entry) => /credential|secret|token/i.test(entry)));
      assert.ok(!entries.some((entry) => /^project\.sqlite-(?:wal|shm|journal)$/i.test(entry)));
    }

    restoreProjectPackage({ packagePath: light.outputPath, destinationDir: lightRestore });
    restoreProjectPackage({ packagePath: archive.outputPath, destinationDir: archiveRestore });
    const lightRepo = openProjectRepository(lightRestore);
    const archiveRepo = openProjectRepository(archiveRestore);
    try {
      const lightProject = lightRepo.loadProject();
      const archiveProject = archiveRepo.loadProject();
      assert.equal(lightProject.noSourceMedia, true);
      assert.equal(lightProject.sourceProjectRelativePath, undefined);
      assert.equal(existsSync(join(lightRestore, "artifacts", "media", "source.mkv")), false);
      assert.equal(archiveProject.noSourceMedia, false);
      assert.equal(archiveProject.sourceProjectRelativePath, "artifacts/media/source.mkv");
      assert.equal(existsSync(join(archiveRestore, "artifacts", "media", "source.mkv")), true);
    } finally {
      lightRepo.close();
      archiveRepo.close();
    }
  } finally {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("package names version instead of overwriting", () => {
  const root = mkdtempSync(join(tmpdir(), "phase11-package-version-"));
  const containerDir = join(root, "project");
  const outputDir = join(root, "packages");
  const repo = openProjectRepository(containerDir);
  try {
    repo.saveProject(projectFixture());
    const first = createProjectPackage({ containerDir, outputDir, kind: "lightweight" });
    const second = createProjectPackage({ containerDir, outputDir, kind: "lightweight" });
    assert.notEqual(first.fileName, second.fileName);
    assert.match(second.fileName, /-2\.zip$/);
  } finally {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});
