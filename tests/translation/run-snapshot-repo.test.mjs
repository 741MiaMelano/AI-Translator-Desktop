import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import { createRunSnapshotRecord } from "../../backend/translation/run-snapshot.mjs";

const baseProject = {
  id: "project-snap-1",
  title: "Snap",
  sourceFileName: "a.srt",
  mediaKind: "subtitle",
  noSourceMedia: true,
  lifecycle: "draft",
  createdAt: "2026-07-16 10:00",
  updatedAt: "2026-07-16 10:00",
  activeSourceTrackId: "source-1",
  pendingConfirmations: [],
  notes: [],
  config: {
    sourceLanguage: "en",
    targetLanguages: ["zh-CN"],
    provider: "OpenAI",
    model: "GPT-4.1",
    glossary: "",
    styleGuide: "",
    outputFormat: "SRT",
    burnVideo: false,
    copyMediaIntoProject: false,
  },
  sourceTracks: [
    {
      id: "source-1",
      label: "Main",
      kind: "external_subtitle",
      languageState: "known",
      defaultLanguage: "en",
      isActive: true,
      summary: "s",
      segments: [
        {
          id: "seg-1",
          start: "00:00:01,000",
          end: "00:00:02,000",
          sourceLanguage: "en",
          sourceText: { original: "Hello", normalized: "Hello" },
          targetTexts: {
            "zh-CN": { model: "", postProcessed: "", qaFlags: [] },
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

test("run snapshots are append-only and survive ordinary save", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-snap-"));
  const repo = openProjectRepository(dir);
  try {
    repo.saveProject(baseProject);
    const snapshot = createRunSnapshotRecord({
      id: "run-1",
      projectId: baseProject.id,
      sourceTrackId: "source-1",
      targetLanguageCode: "zh-CN",
      providerId: "openai",
      model: "GPT-4.1",
      baseUrlDisplay: "https://api.openai.com/v1",
      transportMode: "responses",
      parameters: { temperature: 0.2 },
      resourceSnapshot: {
        glossary: { id: "glossary-v1", empty: false },
        styleGuide: { id: "", empty: true },
      },
      segmentVersion: "v1",
      cacheHits: 2,
      inputTokens: 120,
      outputTokens: 40,
    });
    repo.appendRunSnapshot(snapshot);
    assert.throws(
      () => repo.appendRunSnapshot({ ...snapshot, cacheHits: 9 }),
      (error) => error?.code === "CONFLICT" || /immutable/i.test(error?.message ?? ""),
    );

    repo.saveProject({
      ...baseProject,
      title: "Snap updated",
      updatedAt: "2026-07-16 11:00",
    });
    const listed = repo.listRunSnapshots();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "run-1");
    assert.equal(listed[0].cacheHits, 2);
    assert.equal(listed[0].baseUrlDisplay, "https://api.openai.com/v1");
    assert.equal(listed[0].transportMode, "responses");
    assert.deepEqual(listed[0].parameters, { temperature: 0.2 });
    assert.deepEqual(listed[0].resourceSnapshot, snapshot.resourceSnapshot);
    assert.equal(listed[0].resourceFingerprint, snapshot.resourceFingerprint);
    assert.equal(listed[0].inputTokens, 120);
    assert.equal(listed[0].outputTokens, 40);

    repo.applyModelTranslations({
      languageCode: "zh-CN",
      translations: { "seg-1": "你好" },
    });
    const loaded = repo.loadProject();
    assert.equal(loaded.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, "你好");
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("translation result commits text snapshot task and project state atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-atomic-"));
  const repo = openProjectRepository(dir);
  try {
    repo.saveProject(baseProject);
    const snapshot = createRunSnapshotRecord({
      id: "run-atomic-1",
      projectId: baseProject.id,
      sourceTrackId: "source-1",
      targetLanguageCode: "zh-CN",
      providerId: "openai",
      model: "gpt-4.1",
      segmentVersion: "v1",
    });
    const task = {
      id: "task-atomic-history",
      queueTaskId: "task-atomic",
      label: "Translate zh-CN",
      detail: "completed",
      stage: "translate",
      status: "completed",
      progress: 1,
      targetLanguageCode: "zh-CN",
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.createdAt,
    };

    repo.commitTranslationResult({
      languageCode: "zh-CN",
      translations: { "seg-1": "你好" },
      snapshot,
      task,
    });

    const committed = repo.loadProject();
    assert.equal(committed.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, "你好");
    assert.equal(committed.lifecycle, "needs_review");
    assert.deepEqual(committed.recentRunIds, [snapshot.id]);
    assert.deepEqual(committed.sourceTracks[0].targetTracks[0].snapshotIds, [snapshot.id]);
    assert.equal(committed.sourceTracks[0].targetTracks[0].status, "in_review");
    assert.equal(repo.listTaskHistory().length, 1);

    assert.throws(
      () =>
        repo.commitTranslationResult({
          languageCode: "zh-CN",
          translations: { "seg-1": "不得提交" },
          snapshot,
          task: { ...task, id: "task-rollback-history" },
        }),
      (error) => error?.code === "CONFLICT",
    );
    assert.equal(
      repo.loadProject().sourceTracks[0].segments[0].targetTexts["zh-CN"].model,
      "你好",
    );
    assert.equal(repo.listTaskHistory().length, 1);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
