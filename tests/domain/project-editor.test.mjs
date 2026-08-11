import assert from "node:assert/strict";
import test from "node:test";
import {
  approveProjectTargetTrack,
  adoptProjectCandidateSegment,
  createProjectCandidateTrack,
  editProjectTimeline,
  fillProjectCandidateTexts,
  planProjectSelectedRerun,
  applyProjectSelectedRerunResult,
  refreshProjectTargetQa,
  redoProjectEdit,
  replaceProjectTargetTexts,
  setProjectSourceManual,
  setProjectTargetLocked,
  setProjectTargetManual,
  undoProjectEdit,
} from "../../src/domain/project-editor.ts";

function project({ locked = false, text = "" } = {}) {
  return {
    id: "editor-project",
    title: "Editor project",
    sourceFileName: "source.srt",
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
        summary: "main",
        segments: [
          {
            id: "s1",
            start: "00:00:01,000",
            end: "00:00:03,000",
            sourceLanguage: "en",
            sourceText: { original: "Hello", normalized: "Hello" },
            targetTexts: {
              "zh-CN": { model: text, postProcessed: text, locked, qaFlags: [] },
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
            lastHumanAction: "none",
          },
        ],
      },
    ],
    recentRunIds: [],
  };
}

test("project approval recomputes QA and rejects an empty target", () => {
  const result = approveProjectTargetTrack(project(), "zh-CN");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "hard_qa_errors");
  assert.equal(result.project.sourceTracks[0].targetTracks[0].status, "in_review");
  assert.ok(result.project.sourceTracks[0].targetTracks[0].qaIssues.length > 0);
});

test("project selected rerun rejects a locked segment before any paid request", () => {
  const result = planProjectSelectedRerun(project({ locked: true, text: "人工" }), "zh-CN", ["s1"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "all_selected_locked");
});

test("timeline edit marks target stale and degrades an approved track", () => {
  const current = project({ text: "译文" });
  current.sourceTracks[0].targetTracks[0].status = "approved";
  const result = editProjectTimeline(current, {
    kind: "nudge",
    segmentId: "s1",
    edge: "start",
    deltaMs: 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.project.sourceTracks[0].segments[0].start, "00:00:01,100");
  assert.equal(result.project.sourceTracks[0].segments[0].targetTexts["zh-CN"].stale, true);
  assert.equal(result.project.sourceTracks[0].targetTracks[0].status, "in_review");
  assert.equal(current.sourceTracks[0].segments[0].start, "00:00:01,000");
});

test("timeline edits survive restart and can be undone and redone", () => {
  const edited = editProjectTimeline(project({ text: "译文" }), {
    kind: "shift",
    segmentId: "s1",
    deltaMs: 250,
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.project.sourceTracks[0].segments[0].start, "00:00:01,250");

  const undone = undoProjectEdit(JSON.parse(JSON.stringify(edited.project)));
  assert.equal(undone.ok, true);
  assert.equal(undone.project.sourceTracks[0].segments[0].start, "00:00:01,000");
  const redone = redoProjectEdit(undone.project);
  assert.equal(redone.ok, true);
  assert.equal(redone.project.sourceTracks[0].segments[0].start, "00:00:01,250");
});

test("timeline undo restores segment identity after split and merge", () => {
  const split = editProjectTimeline(project({ text: "译文" }), {
    kind: "split",
    segmentId: "s1",
    atTimestamp: "00:00:02,000",
    idFactory: (() => {
      let index = 0;
      return () => `split-${++index}`;
    })(),
  });
  assert.deepEqual(split.project.sourceTracks[0].segments.map(({ id }) => id), ["split-1", "split-2"]);
  const unsplit = undoProjectEdit(split.project);
  assert.deepEqual(unsplit.project.sourceTracks[0].segments.map(({ id }) => id), ["s1"]);
  const resplit = redoProjectEdit(unsplit.project);
  assert.deepEqual(resplit.project.sourceTracks[0].segments.map(({ id }) => id), ["split-1", "split-2"]);

  const mergeInput = project({ text: "译文" });
  mergeInput.sourceTracks[0].segments.push({
    ...structuredClone(mergeInput.sourceTracks[0].segments[0]),
    id: "s2",
    start: "00:00:03,000",
    end: "00:00:04,000",
  });
  const merged = editProjectTimeline(mergeInput, {
    kind: "merge",
    leftSegmentId: "s1",
    rightSegmentId: "s2",
    idFactory: () => "merged",
  });
  assert.deepEqual(merged.project.sourceTracks[0].segments.map(({ id }) => id), ["merged"]);
  assert.deepEqual(
    undoProjectEdit(merged.project).project.sourceTracks[0].segments.map(({ id }) => id),
    ["s1", "s2"],
  );
});

test("user splits a subtitle at the target caret and current playback time", () => {
  const current = project({ text: "和你的家庭，你可以送他们上学，你可以为你的家庭创造美好的生活" });
  current.sourceTracks[0].segments[0].start = "00:00:27,220";
  current.sourceTracks[0].segments[0].end = "00:00:32,330";
  current.sourceTracks[0].segments[0].sourceText = {
    original: "and your family and you can send them to school and you can create a good life",
    normalized: "and your family and you can send them to school and you can create a good life",
  };

  const split = editProjectTimeline(current, {
    kind: "split_text",
    segmentId: "s1",
    atTimestamp: "00:00:28,500",
    languageCode: "zh-CN",
    targetText: "和你的家庭，你可以送他们上学，你可以为你的家庭创造美好的生活",
    targetOffset: 6,
    idFactory: (() => {
      let index = 0;
      return () => `text-split-${++index}`;
    })(),
  });

  assert.equal(split.ok, true);
  const [left, right] = split.project.sourceTracks[0].segments;
  assert.deepEqual([left.start, left.end, right.start, right.end], [
    "00:00:27,220",
    "00:00:28,500",
    "00:00:28,500",
    "00:00:32,330",
  ]);
  assert.equal(left.targetTexts["zh-CN"].manual, "和你的家庭");
  assert.equal(right.targetTexts["zh-CN"].manual, "你可以送他们上学，你可以为你的家庭创造美好的生活");
  assert.equal(`${left.sourceText.normalized} ${right.sourceText.normalized}`,
    "and your family and you can send them to school and you can create a good life");
  assert.deepEqual(
    undoProjectEdit(split.project).project.sourceTracks[0].segments.map(({ id }) => id),
    ["s1"],
  );
});

test("text split derives an interior timestamp when playback is at the segment boundary", () => {
  const current = project({ text: "你知道，富有只是意味着你有足够的钱。" });
  current.sourceTracks[0].segments[0].start = "00:00:16,820";
  current.sourceTracks[0].segments[0].end = "00:00:20,260";
  current.sourceTracks[0].segments[0].sourceText = {
    original: "You know, rich just simply means that you have enough money.",
    normalized: "You know, rich just simply means that you have enough money.",
  };

  const split = editProjectTimeline(current, {
    kind: "split_text",
    segmentId: "s1",
    atTimestamp: "00:00:16,820",
    languageCode: "zh-CN",
    targetText: "你知道，富有只是意味着你有足够的钱。",
    targetOffset: 3,
    idFactory: (() => {
      let index = 0;
      return () => `caret-split-${++index}`;
    })(),
  });

  assert.equal(split.ok, true);
  const [left, right] = split.project.sourceTracks[0].segments;
  assert.equal(left.targetTexts["zh-CN"].manual, "你知道");
  assert.equal(right.targetTexts["zh-CN"].manual, "富有只是意味着你有足够的钱。");
  assert.equal(left.end, right.start);
  assert.notEqual(left.end, "00:00:16,820");
  assert.notEqual(right.start, "00:00:20,260");
});

test("plain target replace records serializable undo and redo history", () => {
  const replaced = replaceProjectTargetTexts(
    project({ text: "Hello Hello" }),
    "zh-CN",
    "Hello",
    "你好",
  );
  assert.equal(replaced.ok, true);
  assert.equal(replaced.project.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, "你好 你好");
  assert.equal(replaced.project.editorHistory.undoStack.length, 1);

  const restarted = JSON.parse(JSON.stringify(replaced.project));
  const undone = undoProjectEdit(restarted);
  assert.equal(undone.ok, true);
  assert.equal(undone.project.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, "Hello Hello");
  const redone = redoProjectEdit(undone.project);
  assert.equal(redone.ok, true);
  assert.equal(redone.project.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, "你好 你好");
});

test("candidate creation and adopt never replace the active track implicitly", () => {
  const created = createProjectCandidateTrack(project({ text: "活动稿" }), "zh-CN", () => "candidate-1");
  assert.equal(created.ok, true);
  const filled = fillProjectCandidateTexts(created.project, "candidate-1", { s1: "候选稿" }, "run-1");
  assert.equal(filled.ok, true);
  const source = filled.project.sourceTracks[0];
  assert.equal(source.targetTracks.find((track) => track.id === "target-zh").isActive, true);
  assert.equal(source.targetTracks.find((track) => track.id === "candidate-1").isActive, false);
  assert.equal(source.segments[0].targetTexts["zh-CN"].model, "活动稿");

  const adopted = adoptProjectCandidateSegment(filled.project, "candidate-1", "s1");
  assert.equal(adopted.ok, true);
  assert.equal(adopted.project.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, "候选稿");
  assert.equal(adopted.project.sourceTracks[0].targetTracks[1].candidateTexts.s1.model, "候选稿");
});

test("source manual edit records restart-safe undo history", () => {
  const edited = setProjectSourceManual(project({ text: "译文" }), "s1", "人工源稿");
  assert.equal(edited.ok, true);
  assert.equal(edited.project.sourceTracks[0].segments[0].sourceText.manual, "人工源稿");
  const undone = undoProjectEdit(JSON.parse(JSON.stringify(edited.project)));
  assert.equal(undone.ok, true);
  assert.equal(undone.project.sourceTracks[0].segments[0].sourceText.manual, undefined);
});

test("target manual action cannot bypass a locked layer", () => {
  const locked = setProjectTargetLocked(project({ text: "模型稿" }), "zh-CN", "s1", true);
  assert.equal(locked.ok, true);
  const blocked = setProjectTargetManual(locked.project, "zh-CN", "s1", "不得覆盖");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "locked");
  assert.equal(blocked.project.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, "模型稿");
});

test("selected rerun result updates only planned ids and preserves previous manual", () => {
  const current = project({ text: "模型稿" });
  current.sourceTracks[0].segments[0].targetTexts["zh-CN"].manual = "人工稿";
  const applied = applyProjectSelectedRerunResult(current, "zh-CN", ["s1"], { s1: "重跑稿" });
  assert.equal(applied.ok, true);
  const layer = applied.project.sourceTracks[0].segments[0].targetTexts["zh-CN"];
  assert.equal(layer.model, "重跑稿");
  assert.equal(layer.manual, undefined);
  assert.equal(layer.previousManual, "人工稿");
});

test("QA refresh writes deterministic hard errors onto the project track", () => {
  const refreshed = refreshProjectTargetQa(project(), "zh-CN");
  assert.equal(refreshed.ok, true);
  assert.ok(refreshed.project.sourceTracks[0].targetTracks[0].qaIssues.length > 0);
});
