import test from "node:test";
import assert from "node:assert/strict";

import {
  canStartProjectFromSelection,
  countQaIssues,
  deriveProjectStatusSummary,
  getLatestProjectTask,
  getLatestProjectTranslationTask,
  getPrimaryTaskControl,
  mergeStartedTaskSnapshot,
  resolveAsrLanguageSelection,
  setTargetLanguages,
  sortProjectsByPriority,
} from "../../src/domain/workspace.ts";

test("ASR uses the project's configured source language", () => {
  assert.deepEqual(resolveAsrLanguageSelection("自动检测"), {
    languageMode: "auto",
    languageHint: null,
  });
  assert.deepEqual(resolveAsrLanguageSelection("英语"), {
    languageMode: "fixed",
    languageHint: "en",
  });
  assert.deepEqual(resolveAsrLanguageSelection("zh-CN"), {
    languageMode: "fixed",
    languageHint: "zh",
  });
});

test("a later successful translation hides an older failed attempt", () => {
  const failed = {
    id: "failed",
    projectId: "project-1",
    kind: "translate",
    stage: "translate",
    status: "failed",
    updatedAt: "2026-07-28T10:11:00.000Z",
  };
  const completed = {
    ...failed,
    id: "completed",
    status: "completed",
    updatedAt: "2026-07-28T10:17:00.000Z",
  };
  const laterExport = {
    ...completed,
    id: "export",
    kind: "export",
    stage: "export",
    updatedAt: "2026-07-28T10:18:00.000Z",
  };

  assert.equal(getLatestProjectTranslationTask([failed, completed, laterExport], "project-1"), completed);
});

test("project task control follows the task's real pause capability", () => {
  const base = {
    id: "task-1",
    projectId: "project-1",
    kind: "translate",
    stage: "translate",
    status: "running",
    updatedAt: "2026-07-30T10:00:00.000Z",
  };

  assert.deepEqual(getPrimaryTaskControl({ ...base, pauseCapability: "checkpoint" }), {
    action: "pause",
    label: "暂停",
  });
  assert.deepEqual(getPrimaryTaskControl({ ...base, kind: "asr", stage: "asr", pauseCapability: "never" }), {
    action: "cancel",
    label: "停止",
  });
  assert.deepEqual(getPrimaryTaskControl({ ...base, status: "paused" }), {
    action: "resume",
    label: "继续",
  });
  assert.deepEqual(getPrimaryTaskControl({ ...base, status: "recoverable" }), {
    action: "resume",
    label: "确认继续",
  });
  assert.deepEqual(getPrimaryTaskControl({ ...base, status: "failed", retryable: true }), {
    action: "retry",
    label: "确认重试",
  });
  assert.equal(getPrimaryTaskControl({ ...base, status: "completed" }), null);
});

test("bulk project control uses the newest task of any kind", () => {
  const translation = {
    id: "translate-old",
    projectId: "project-1",
    kind: "translate",
    stage: "translate",
    status: "completed",
    updatedAt: "2026-07-30T10:00:00.000Z",
  };
  const media = {
    ...translation,
    id: "media-new",
    kind: "media",
    stage: "extract",
    status: "running",
    pauseCapability: "never",
    updatedAt: "2026-07-30T10:01:00.000Z",
  };

  assert.equal(getLatestProjectTask([translation, media], "project-1"), media);
});

test("bulk start never silently retranslates completed or failed work", () => {
  const project = { lifecycle: "processing" };
  const task = { kind: "translate", status: "completed" };

  assert.equal(canStartProjectFromSelection(project, task), false);
  assert.equal(canStartProjectFromSelection(project, { ...task, status: "failed" }), false);
  assert.equal(canStartProjectFromSelection({ ...project, lifecycle: "completed" }), false);
  assert.equal(canStartProjectFromSelection(project, { ...task, kind: "media" }), true);
});

test("a terminal task snapshot wins over the stale pending response from translation.start", () => {
  const started = {
    id: "task-1",
    projectId: "project-1",
    status: "pending",
    sequence: 0,
    updatedAt: "2026-07-28T07:04:02.368Z",
  };
  const failed = {
    ...started,
    status: "failed",
    sequence: 4,
    lastErrorCode: "PROVIDER_UNKNOWN",
    updatedAt: "2026-07-28T07:04:02.414Z",
  };
  const unrelated = { ...started, id: "task-2", projectId: "project-2" };

  assert.deepEqual(mergeStartedTaskSnapshot(started, [failed, unrelated]), [failed, unrelated]);
});

test("legacy long-silence QA entries stay compatible but are hidden from user counts", () => {
  const track = createTargetTrack({
    qaIssues: [
      { id: "qa.gap:a:b", ruleId: "qa.gap", label: "间隔过大", severity: "warning", detail: "legacy" },
      { id: "qa.max_duration:a", ruleId: "qa.max_duration", label: "时长过长", severity: "warning", detail: "visible" },
    ],
  });
  assert.equal(countQaIssues([track], "warning"), 1);
});

function createTargetTrack(overrides = {}) {
  return {
    id: overrides.id ?? "target-zh",
    languageCode: overrides.languageCode ?? "zh-CN",
    languageLabel: overrides.languageLabel ?? "简体中文",
    status: overrides.status ?? "draft",
    isActive: overrides.isActive ?? true,
    qaIssues: overrides.qaIssues ?? [],
    snapshotIds: overrides.snapshotIds ?? [],
    deliveryLabel: overrides.deliveryLabel ?? "未开跑",
    lastHumanAction: overrides.lastHumanAction ?? "等待首次处理",
  };
}

function createSegment(overrides = {}) {
  return {
    id: overrides.id ?? "segment-1",
    start: overrides.start ?? "00:00:01,000",
    end: overrides.end ?? "00:00:02,000",
    sourceLanguage: overrides.sourceLanguage ?? "en",
    sourceText: overrides.sourceText ?? {
      original: "hello",
      normalized: "hello",
    },
    targetTexts: overrides.targetTexts ?? {
      "zh-CN": {
        model: "你好",
        postProcessed: "你好",
        qaFlags: [],
      },
    },
  };
}

function createProject(overrides = {}) {
  const sourceTrackId = overrides.activeSourceTrackId ?? "source-1";
  const inactiveSourceTrackId = "source-inactive";

  return {
    id: overrides.id ?? "project-1",
    title: overrides.title ?? "Sample Project",
    sourceFileName: overrides.sourceFileName ?? "sample.mp4",
    mediaKind: overrides.mediaKind ?? "video",
    noSourceMedia: overrides.noSourceMedia ?? false,
    lifecycle: overrides.lifecycle ?? "processing",
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-02T00:00:00.000Z",
    ...(overrides.archivedAt ? { archivedAt: overrides.archivedAt } : {}),
    activeSourceTrackId: sourceTrackId,
    pendingConfirmations: overrides.pendingConfirmations ?? [],
    notes: overrides.notes ?? [],
    config: {
      sourceLanguage: "en",
      targetLanguages: ["简体中文"],
      provider: "openai",
      model: "gpt-4.1",
      glossary: "default",
      styleGuide: "default",
      outputFormat: "srt",
      burnVideo: false,
      copyMediaIntoProject: false,
      ...(overrides.config ?? {}),
    },
    sourceTracks: overrides.sourceTracks ?? [
      {
        id: sourceTrackId,
        label: "Main source track",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "Primary timeline",
        segments: [
          createSegment({ id: "segment-1" }),
          createSegment({
            id: "segment-2",
            start: "00:00:03,000",
            end: "00:00:04,000",
            sourceText: {
              original: "world",
              normalized: "world",
            },
            targetTexts: {
              "zh-CN": {
                model: "世界",
                postProcessed: "世界",
                qaFlags: [],
              },
            },
          }),
        ],
        targetTracks: [createTargetTrack()],
      },
      {
        id: inactiveSourceTrackId,
        label: "Inactive source track",
        kind: "asr",
        languageState: "known",
        defaultLanguage: "en",
        isActive: false,
        summary: "Historical source",
        segments: [
          createSegment({
            id: "inactive-segment-1",
            targetTexts: {
              "zh-CN": {
                model: "历史中文",
                postProcessed: "历史中文",
                qaFlags: [],
              },
              "en-US": {
                model: "historical english",
                postProcessed: "historical english",
                qaFlags: [],
              },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack({
            id: "inactive-target-zh",
            languageCode: "zh-CN",
            languageLabel: "简体中文",
          }),
          createTargetTrack({
            id: "inactive-target-en",
            languageCode: "en-US",
            languageLabel: "英语",
            isActive: true,
          }),
        ],
      },
    ],
    recentRunIds: overrides.recentRunIds ?? [],
  };
}

function getActiveSource(project) {
  return project.sourceTracks.find((track) => track.id === project.activeSourceTrackId);
}

function getInactiveSource(project) {
  return project.sourceTracks.find((track) => track.id === "source-inactive");
}

test("pending confirmation takes priority over processing state", () => {
  const project = createProject({
    lifecycle: "processing",
    pendingConfirmations: ["确认源语言"],
  });

  assert.deepEqual(deriveProjectStatusSummary(project), {
    tone: "red",
    label: "待确认",
    actionLabel: "处理待确认",
    helperText: "确认源语言",
  });
});

test("sorts projects by actionable priority without mutating input", () => {
  const draft = createProject({
    id: "draft",
    title: "Draft",
    lifecycle: "draft",
    pendingConfirmations: [],
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  const processing = createProject({
    id: "processing",
    title: "Processing",
    lifecycle: "processing",
    pendingConfirmations: [],
    updatedAt: "2026-07-02T00:00:00.000Z",
  });
  const pending = createProject({
    id: "pending",
    title: "Pending",
    lifecycle: "processing",
    pendingConfirmations: ["确认源语言"],
    updatedAt: "2026-07-03T00:00:00.000Z",
  });
  const archivedPending = createProject({
    id: "archived-pending",
    title: "Archived pending",
    lifecycle: "processing",
    pendingConfirmations: ["旧的待确认"],
    archivedAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  });

  const projects = [draft, processing, archivedPending, pending];
  const sorted = sortProjectsByPriority(projects);

  assert.deepEqual(
    sorted.map((project) => project.id),
    ["pending", "processing", "draft", "archived-pending"],
  );
  assert.deepEqual(
    projects.map((project) => project.id),
    ["draft", "processing", "archived-pending", "pending"],
  );
  assert.notEqual(sorted, projects);
});

test("adds target language across config, active track, and all segment texts", () => {
  const project = createProject();
  const next = setTargetLanguages(project, ["简体中文", "英语"]);

  assert.deepEqual(next.config.targetLanguages, ["简体中文", "英语"]);

  const activeTrack = getActiveSource(next);
  const englishTracks = activeTrack.targetTracks.filter((track) => track.languageCode === "en-US");
  assert.equal(englishTracks.length, 1);
  assert.equal(englishTracks[0].isActive, true);
  assert.equal(englishTracks[0].languageLabel, "英语");
  assert.equal(englishTracks[0].status, "draft");
  assert.deepEqual(englishTracks[0].qaIssues, []);
  assert.deepEqual(englishTracks[0].snapshotIds, []);
  assert.equal(englishTracks[0].deliveryLabel, "未开跑");
  assert.equal(englishTracks[0].lastHumanAction, "等待首次处理");

  for (const segment of activeTrack.segments) {
    assert.deepEqual(segment.targetTexts["en-US"], {
      model: "",
      postProcessed: "",
      stale: false,
      qaFlags: [],
    });
    assert.equal(segment.targetTexts["zh-CN"].model, segment.id === "segment-1" ? "你好" : "世界");
  }
});

test("does not mutate the input project when adding a language", () => {
  const project = createProject();
  const before = structuredClone(project);

  setTargetLanguages(project, ["简体中文", "英语"]);

  assert.deepEqual(project, before);
});

test("keeps existing protected text and track metadata when language is retained", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main source track",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "Primary timeline",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": {
                model: "机翻",
                postProcessed: "后处理",
                manual: "人工",
                previousManual: "旧人工",
                locked: true,
                qaFlags: ["length"],
              },
              "en-US": {
                model: "hello",
                postProcessed: "hello",
                qaFlags: [],
              },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack({
            status: "in_review",
            qaIssues: [{ id: "qa-1", label: "length", severity: "warning", detail: "too long" }],
            snapshotIds: ["snap-1"],
            deliveryLabel: "校对中",
            lastHumanAction: "人工校对",
          }),
          createTargetTrack({
            id: "target-en",
            languageCode: "en-US",
            languageLabel: "英语",
          }),
        ],
      },
    ],
  });

  const next = setTargetLanguages(project, ["简体中文", "英语"]);
  const active = getActiveSource(next);
  const zhTrack = active.targetTracks.find((track) => track.languageCode === "zh-CN");
  const text = active.segments[0].targetTexts["zh-CN"];

  assert.equal(zhTrack.status, "in_review");
  assert.deepEqual(zhTrack.snapshotIds, ["snap-1"]);
  assert.equal(zhTrack.qaIssues[0].id, "qa-1");
  assert.equal(text.manual, "人工");
  assert.equal(text.previousManual, "旧人工");
  assert.equal(text.locked, true);
  assert.deepEqual(text.qaFlags, ["length"]);
});

test("removes unprotected language by deactivating track and deleting target texts", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": { model: "hello", postProcessed: "hello", qaFlags: [] },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({
            id: "target-en",
            languageCode: "en-US",
            languageLabel: "英语",
            status: "approved",
            snapshotIds: ["snap-en"],
          }),
        ],
      },
      createProject().sourceTracks[1],
    ],
  });

  const next = setTargetLanguages(project, ["简体中文"]);
  const active = getActiveSource(next);
  const english = active.targetTracks.find((track) => track.languageCode === "en-US");

  assert.deepEqual(next.config.targetLanguages, ["简体中文"]);
  assert.equal(english.isActive, false);
  assert.equal(english.status, "approved");
  assert.deepEqual(english.snapshotIds, ["snap-en"]);
  assert.equal(active.segments[0].targetTexts["en-US"], undefined);
  assert.ok(active.segments[0].targetTexts["zh-CN"]);
});

test("does not modify inactive source tracks when removing a language", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": { model: "hello", postProcessed: "hello", qaFlags: [] },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({
            id: "target-en",
            languageCode: "en-US",
            languageLabel: "英语",
          }),
        ],
      },
      createProject().sourceTracks[1],
    ],
  });
  const beforeInactive = structuredClone(getInactiveSource(project));

  const next = setTargetLanguages(project, ["简体中文"]);
  assert.deepEqual(getInactiveSource(next), beforeInactive);
});

test("rejects removing the last target language without changing the project", () => {
  const project = createProject();
  const before = structuredClone(project);

  assert.throws(() => setTargetLanguages(project, []), /至少要选择一种目标语言/);
  assert.deepEqual(project, before);
});

test("rejects removing a language with manual text", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": { model: "hello", postProcessed: "hello", manual: "edited", qaFlags: [] },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({ id: "target-en", languageCode: "en-US", languageLabel: "英语" }),
        ],
      },
    ],
  });
  const before = structuredClone(project);

  assert.throws(
    () => setTargetLanguages(project, ["简体中文"]),
    /Cannot remove target language 英语 \(en-US\)/,
  );
  assert.deepEqual(project, before);
});

test("rejects removing a language with empty manual string", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": { model: "hello", postProcessed: "hello", manual: "", qaFlags: [] },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({ id: "target-en", languageCode: "en-US", languageLabel: "英语" }),
        ],
      },
    ],
  });

  assert.throws(() => setTargetLanguages(project, ["简体中文"]), /en-US/);
});

test("rejects removing a language with previousManual", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": {
                model: "hello",
                postProcessed: "hello",
                previousManual: "old",
                qaFlags: [],
              },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({ id: "target-en", languageCode: "en-US", languageLabel: "英语" }),
        ],
      },
    ],
  });

  assert.throws(() => setTargetLanguages(project, ["简体中文"]), /en-US/);
});

test("rejects removing a language with locked true", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": {
                model: "hello",
                postProcessed: "hello",
                locked: true,
                qaFlags: [],
              },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({ id: "target-en", languageCode: "en-US", languageLabel: "英语" }),
        ],
      },
    ],
  });

  assert.throws(() => setTargetLanguages(project, ["简体中文"]), /en-US/);
});

test("rejects multi-language removal when one language is protected", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语", "日语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": { model: "hello", postProcessed: "hello", qaFlags: [] },
              "ja-JP": {
                model: "こんにちは",
                postProcessed: "こんにちは",
                manual: "人工日文",
                qaFlags: [],
              },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({ id: "target-en", languageCode: "en-US", languageLabel: "英语" }),
          createTargetTrack({ id: "target-ja", languageCode: "ja-JP", languageLabel: "日语" }),
        ],
      },
    ],
  });
  const before = structuredClone(project);

  assert.throws(() => setTargetLanguages(project, ["简体中文"]), /日语|ja-JP/);
  assert.deepEqual(project, before);
  assert.deepEqual(project.config.targetLanguages, ["简体中文", "英语", "日语"]);
});

test("rejects duplicate target languages", () => {
  const project = createProject();
  assert.throws(
    () => setTargetLanguages(project, ["简体中文", "简体中文"]),
    /目标语言不能重复/,
  );
});

test("rejects unsupported target languages", () => {
  const project = createProject();
  assert.throws(
    () => setTargetLanguages(project, ["克林贡语"]),
    /Unsupported target language: 克林贡语/,
  );
});

test("never creates two active tracks for the same language", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [createSegment()],
        targetTracks: [
          createTargetTrack({ id: "target-zh-active", isActive: true }),
          createTargetTrack({
            id: "target-zh-candidate",
            isActive: false,
            status: "approved",
            deliveryLabel: "候选",
          }),
        ],
      },
    ],
  });

  const next = setTargetLanguages(project, ["简体中文"]);
  const activeZh = getActiveSource(next).targetTracks.filter(
    (track) => track.languageCode === "zh-CN" && track.isActive,
  );
  assert.equal(activeZh.length, 1);
  assert.equal(activeZh[0].id, "target-zh-active");
  assert.equal(
    getActiveSource(next).targetTracks.find((track) => track.id === "target-zh-candidate").isActive,
    false,
  );
});

test("creates deterministic unique target track ids", () => {
  const project = createProject();
  const first = setTargetLanguages(project, ["简体中文", "英语"]);
  const second = setTargetLanguages(project, ["简体中文", "英语"]);

  const firstId = getActiveSource(first).targetTracks.find((track) => track.languageCode === "en-US").id;
  const secondId = getActiveSource(second).targetTracks.find((track) => track.languageCode === "en-US").id;

  assert.equal(firstId, "target-source-1-en-US");
  assert.equal(secondId, firstId);
  assert.equal(
    getActiveSource(first).targetTracks.filter((track) => track.id === firstId).length,
    1,
  );
});

test("rejects protected manual text even when english track is inactive", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": {
                model: "hello",
                postProcessed: "hello",
                manual: "human",
                qaFlags: [],
              },
            },
          }),
        ],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({
            id: "target-en",
            languageCode: "en-US",
            languageLabel: "英语",
            isActive: false,
          }),
        ],
      },
    ],
  });
  const before = structuredClone(project);

  assert.throws(
    () => setTargetLanguages(project, ["简体中文"]),
    /英语|en-US/,
  );
  assert.deepEqual(project, before);
  assert.equal(project.sourceTracks[0].segments[0].targetTexts["en-US"].manual, "human");
});

test("rejects protected text even when english track is missing", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文", "英语"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [
          createSegment({
            targetTexts: {
              "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
              "en-US": {
                model: "hello",
                postProcessed: "hello",
                previousManual: "old-human",
                qaFlags: [],
              },
            },
          }),
        ],
        targetTracks: [createTargetTrack()],
      },
    ],
  });
  const before = structuredClone(project);

  assert.throws(
    () => setTargetLanguages(project, ["简体中文"]),
    /英语|en-US/,
  );
  assert.deepEqual(project, before);
  assert.equal(
    project.sourceTracks[0].segments[0].targetTexts["en-US"].previousManual,
    "old-human",
  );
});

test("uses deterministic numeric suffix when base target track id is occupied", () => {
  const project = createProject({
    config: { targetLanguages: ["简体中文"] },
    sourceTracks: [
      {
        id: "source-1",
        label: "Main",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "main",
        segments: [createSegment()],
        targetTracks: [
          createTargetTrack(),
          createTargetTrack({
            id: "target-source-1-en-US",
            languageCode: "zh-CN",
            languageLabel: "历史占用ID",
            isActive: false,
            status: "approved",
          }),
        ],
      },
    ],
  });

  const first = setTargetLanguages(project, ["简体中文", "英语"]);
  const second = setTargetLanguages(project, ["简体中文", "英语"]);
  const firstEnglish = getActiveSource(first).targetTracks.find(
    (track) => track.languageCode === "en-US" && track.isActive,
  );
  const secondEnglish = getActiveSource(second).targetTracks.find(
    (track) => track.languageCode === "en-US" && track.isActive,
  );
  const ids = getActiveSource(first).targetTracks.map((track) => track.id);

  assert.equal(firstEnglish.id, "target-source-1-en-US-2");
  assert.equal(secondEnglish.id, firstEnglish.id);
  assert.equal(new Set(ids).size, ids.length);
});
