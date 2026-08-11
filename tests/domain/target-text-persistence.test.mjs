import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import {
  applyExplicitRerunResult,
  markStaleTargetText,
  setLockedTargetText,
  setManualTargetText,
} from "../../shared/target-text-state.mjs";
import { editProjectTimeline, undoProjectEdit } from "../../src/domain/project-editor.ts";

function createProject(targetText) {
  return {
    id: "project-target-state",
    title: "Target state",
    sourceFileName: "a.srt",
    mediaKind: "subtitle",
    noSourceMedia: true,
    lifecycle: "needs_review",
    createdAt: "2026-07-18 10:00",
    updatedAt: "2026-07-18 10:00",
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
            id: "seg-manual",
            start: "00:00:01,000",
            end: "00:00:02,000",
            sourceLanguage: "en",
            sourceText: { original: "Hello", normalized: "Hello" },
            targetTexts: {
              "zh-CN": targetText,
            },
          },
          {
            id: "seg-open",
            start: "00:00:03,000",
            end: "00:00:04,000",
            sourceLanguage: "en",
            sourceText: { original: "World", normalized: "World" },
            targetTexts: {
              "zh-CN": {
                model: "世界",
                postProcessed: "世界",
                stale: true,
                qaFlags: [],
              },
            },
          },
        ],
        targetTracks: [
          {
            id: "target-zh",
            languageCode: "zh-CN",
            languageLabel: "Chinese",
            status: "in_review",
            isActive: true,
            qaIssues: [],
            snapshotIds: [],
            deliveryLabel: "review",
            lastHumanAction: "edit",
          },
        ],
      },
    ],
    recentRunIds: [],
  };
}

test("manual/locked/previousManual/stale round-trip through project repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "target-state-rt-"));
  const repo = openProjectRepository(dir);
  try {
    const manual = setManualTargetText(
      { model: "模型", postProcessed: "后处理", qaFlags: [], stale: false },
      "人工译文",
    ).layer;
    const locked = setLockedTargetText(manual, true).layer;
    const staleLocked = markStaleTargetText(locked).layer;

    repo.saveProject(createProject(staleLocked));
    const loaded = repo.loadProject().sourceTracks[0].segments[0].targetTexts["zh-CN"];
    assert.equal(loaded.manual, "人工译文");
    assert.equal(loaded.locked, true);
    assert.equal(loaded.stale, true);
    assert.equal(loaded.model, "模型");
    assert.equal(loaded.postProcessed, "后处理");

    const open = repo.loadProject().sourceTracks[0].segments[1].targetTexts["zh-CN"];
    assert.equal(open.stale, true);
    assert.equal(open.model, "世界");

    // false stale remains omitted after round-trip (safe default)
    const cleared = { ...open, stale: false };
    const project = repo.loadProject();
    project.sourceTracks[0].segments[1].targetTexts["zh-CN"] = cleared;
    repo.saveProject(project);
    assert.equal(
      repo.loadProject().sourceTracks[0].segments[1].targetTexts["zh-CN"].stale,
      undefined,
    );
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("text/time subtitle split and its undo history survive repository restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "target-split-rt-"));
  const repo = openProjectRepository(dir);
  try {
    const input = createProject({ model: "和你的家庭，你可以送他们上学", postProcessed: "", qaFlags: [] });
    const split = editProjectTimeline(input, {
      kind: "split_text", segmentId: "seg-manual", atTimestamp: "00:00:01,500",
      languageCode: "zh-CN", targetText: "和你的家庭，你可以送他们上学", targetOffset: 6,
      idFactory: (() => { let index = 0; return () => `split-${++index}`; })(),
    });
    assert.equal(split.ok, true);
    repo.saveProject(split.project);
    const loaded = repo.loadProject();
    assert.deepEqual(loaded.sourceTracks[0].segments.slice(0, 2).map((segment) => [
      segment.start, segment.end, segment.targetTexts["zh-CN"].manual,
    ]), [
      ["00:00:01,000", "00:00:01,500", "和你的家庭"],
      ["00:00:01,500", "00:00:02,000", "你可以送他们上学"],
    ]);
    assert.deepEqual(undoProjectEdit(loaded).project.sourceTracks[0].segments.map(({ id }) => id), ["seg-manual", "seg-open"]);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Qwen Preview model choice survives the project schema migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "qwen-model-rt-"));
  const repo = openProjectRepository(dir);
  try {
    const project = createProject({ model: "译文", postProcessed: "", qaFlags: [] });
    project.config.asrModelId = "qwen3-asr-1.7b";
    repo.saveProject(project);
    assert.equal(repo.loadProject().config.asrModelId, "qwen3-asr-1.7b");
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyModelTranslations skips manual and locked, updates open stale segment", () => {
  const dir = mkdtempSync(join(tmpdir(), "target-state-apply-"));
  const repo = openProjectRepository(dir);
  try {
    const manual = setManualTargetText(
      { model: "old", postProcessed: "old", qaFlags: [], stale: false },
      "人工",
    ).layer;
    repo.saveProject(createProject(manual));

    const lockedProject = repo.loadProject();
    const lockedLayer = setLockedTargetText(
      lockedProject.sourceTracks[0].segments[0].targetTexts["zh-CN"],
      true,
    ).layer;
    lockedProject.sourceTracks[0].segments[0].targetTexts["zh-CN"] = lockedLayer;
    repo.saveProject(lockedProject);

    const result = repo.applyModelTranslations({
      languageCode: "zh-CN",
      translations: {
        "seg-manual": "不得覆盖",
        "seg-open": "新世界",
      },
    });
    assert.equal(result.applied, 1);
    assert.equal(result.skippedProtected, 1);

    const loaded = repo.loadProject();
    const protectedText = loaded.sourceTracks[0].segments[0].targetTexts["zh-CN"];
    assert.equal(protectedText.manual, "人工");
    assert.equal(protectedText.locked, true);
    assert.equal(protectedText.model, "old");

    const openText = loaded.sourceTracks[0].segments[1].targetTexts["zh-CN"];
    assert.equal(openText.model, "新世界");
    assert.equal(openText.postProcessed, "新世界");
    assert.equal(openText.stale, undefined);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit rerun previousManual survives restart and blocks later automatic overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "target-state-rerun-"));
  const repo = openProjectRepository(dir);
  try {
    const manual = setManualTargetText(
      { model: "old", postProcessed: "old", qaFlags: [], stale: false },
      "人工稿",
    ).layer;
    repo.saveProject(createProject(manual));

    const current = repo.loadProject();
    const rerun = applyExplicitRerunResult(
      current.sourceTracks[0].segments[0].targetTexts["zh-CN"],
      "重跑结果",
    );
    assert.equal(rerun.ok, true);
    current.sourceTracks[0].segments[0].targetTexts["zh-CN"] = rerun.layer;
    repo.saveProject(current);

    const reopened = openProjectRepository(dir);
    try {
      const layer = reopened.loadProject().sourceTracks[0].segments[0].targetTexts["zh-CN"];
      assert.equal(layer.manual, undefined);
      assert.equal(layer.previousManual, "人工稿");
      assert.equal(layer.model, "重跑结果");

      const blocked = reopened.applyModelTranslations({
        languageCode: "zh-CN",
        translations: { "seg-manual": "自动覆盖" },
      });
      assert.equal(blocked.applied, 0);
      assert.equal(blocked.skippedProtected, 1);
      assert.equal(
        reopened.loadProject().sourceTracks[0].segments[0].targetTexts["zh-CN"].model,
        "重跑结果",
      );
      assert.equal(
        reopened.loadProject().sourceTracks[0].segments[0].targetTexts["zh-CN"].previousManual,
        "人工稿",
      );
    } finally {
      reopened.close();
    }
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate texts and editor undo history survive repository restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "target-state-candidate-"));
  const repo = openProjectRepository(dir);
  try {
    const project = createProject({ model: "活动稿", postProcessed: "活动稿", qaFlags: [] });
    project.editorHistory = {
      undoStack: [
        {
          kind: "source_manual",
          segmentId: "seg-manual",
          beforeManual: null,
          afterManual: "人工源稿",
        },
      ],
      redoStack: [],
    };
    project.sourceTracks[0].targetTracks.push({
      id: "candidate-zh-1",
      languageCode: "zh-CN",
      languageLabel: "Chinese",
      status: "in_review",
      isActive: false,
      role: "candidate",
      baseTrackId: "target-zh",
      qaIssues: [],
      snapshotIds: ["candidate-run"],
      deliveryLabel: "候选待比较",
      lastHumanAction: "created candidate",
      candidateTexts: {
        "seg-manual": {
          model: "候选稿",
          postProcessed: "候选稿",
          qaFlags: [],
          origin: "candidate_full_track",
        },
      },
    });

    repo.saveProject(project);
    repo.close();
    const reopened = openProjectRepository(dir);
    try {
      const loaded = reopened.loadProject();
      assert.deepEqual(loaded.editorHistory, project.editorHistory);
      const candidate = loaded.sourceTracks[0].targetTracks.find(
        (track) => track.id === "candidate-zh-1",
      );
      assert.equal(candidate.role, "candidate");
      assert.equal(candidate.baseTrackId, "target-zh");
      assert.equal(candidate.candidateTexts["seg-manual"].postProcessed, "候选稿");
      assert.equal(candidate.candidateTexts["seg-manual"].origin, "candidate_full_track");
    } finally {
      reopened.close();
    }
  } finally {
    try {
      repo.close();
    } catch {
      // already closed for restart verification
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
