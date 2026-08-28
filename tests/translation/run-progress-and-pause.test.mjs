import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import { createDesktopTranslationPort } from "../../backend/translation/desktop-translation-port.mjs";
import { createLanguageTaskRunner } from "../../backend/translation/language-task-runner.mjs";
import { createTranslateService } from "../../backend/translation/translate-service.mjs";

const root = join(process.cwd(), "migrations", "project");

/** 单段就超过默认的 3500 字符上限，于是 N 段必定切成 N 个批次。 */
function oversizedSegments(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `seg-${index + 1}`,
    sourceText: { original: "x".repeat(4000), normalized: "x".repeat(4000) },
  }));
}

function fakeClient(onCall = () => {}) {
  return {
    async createStructuredTranslation({ messages }) {
      const payload = JSON.parse(messages[1].content);
      onCall(payload);
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: payload.segments.map((segment) => ({ segmentId: segment.segmentId, text: "译" })),
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

test("每个批次都回报一次进度：长任务不再整轮停在 0%", async () => {
  const seen = [];
  const service = createTranslateService({ client: fakeClient(), idFactory: () => "run-batch-progress" });
  await service.translateLanguage({
    projectId: "p-batch",
    sourceTrackId: "source-1",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "fake-only",
    segments: oversizedSegments(3),
    onBatch: (event) => seen.push(event),
  });

  assert.equal(seen.length, 3, JSON.stringify(seen));
  assert.deepEqual(seen.map((event) => event.batchIndex), [0, 1, 2]);
  assert.deepEqual(seen.map((event) => event.batchCount), [3, 3, 3]);
});

test("暂停停在批次之间：onBatch 没有 resolve 之前不发下一批", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createTranslateService({
    client: fakeClient(() => { calls += 1; }),
    idFactory: () => "run-batch-pause",
  });

  let held = 0;
  const finished = service.translateLanguage({
    projectId: "p-pause",
    sourceTrackId: "source-1",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "fake-only",
    segments: oversizedSegments(3),
    onBatch: async ({ batchIndex }) => {
      if (batchIndex !== 0) return;
      held = calls;
      await gate;
    },
  });

  // 让第一批完整跑完并卡在 onBatch 上；此刻只应该有一次付费请求。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(held, 1);
  assert.equal(calls, 1, "暂停期间不允许再发下一批");

  release();
  await finished;
  assert.equal(calls, 3);
});

test("语言任务把批次进度转成 0 与 1 之间的任务事件", async () => {
  const events = [];
  const runner = createLanguageTaskRunner({
    translateService: createTranslateService({ client: fakeClient(), idFactory: () => "run-runner-progress" }),
    taskIdFactory: () => "task-runner-progress",
    persistLanguageResult: () => {},
  });

  await runner.runLanguages({
    projectId: "p-runner",
    sourceTrackId: "source-1",
    targetLanguages: ["zh-CN"],
    providerId: "openai",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "fake-only",
    segments: oversizedSegments(4),
    onTaskEvent: (event) => events.push(event),
  });

  const progresses = events.map((event) => event.progress);
  assert.equal(progresses[0], 0, "开始事件仍然是 0");
  assert.equal(progresses.at(-1), 1, "完成事件仍然是 1");
  const middle = progresses.slice(1, -1);
  assert.ok(middle.length >= 3, `批次进度事件缺失：${JSON.stringify(progresses)}`);
  assert.ok(middle.every((value) => value > 0 && value <= 1), JSON.stringify(middle));
  assert.deepEqual([...middle].sort((left, right) => left - right), middle, "进度不能回退");
  assert.ok(events.every((event) => event.languageCount === 1));
});

const historyProject = {
  id: "project-task-history",
  title: "History",
  sourceFileName: "a.srt",
  mediaKind: "subtitle",
  noSourceMedia: true,
  lifecycle: "draft",
  createdAt: "2026-07-26 10:00",
  updatedAt: "2026-07-26 10:00",
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
      segments: [],
      targetTracks: [],
    },
  ],
  recentRunIds: [],
};

/**
 * project_task_history 是追加式的：一个任务每换一次状态就多一行。
 * 把这些行原样当成任务返回，界面上一个任务会分裂成三个，
 * 其中 pending / running 那两行永远停在 0%——「翻译早完了进度条还在转」就是这么来的。
 */
test("任务历史按队列任务归并：一个任务只回一条，且停在最后的状态", () => {
  const projectsDir = mkdtempSync(join(tmpdir(), "task-history-collapse-"));
  const repo = openProjectRepository(join(projectsDir, historyProject.id), { migrationsDir: root });
  try {
    repo.saveProject(historyProject);
    const rows = [
      { status: "pending", detail: "Queued", progress: 0, sequence: 0, at: "2026-07-26 10:00" },
      { status: "running", detail: "Running", progress: 0, sequence: 1, at: "2026-07-26 10:01" },
      { status: "running", detail: "Translate zh-CN", progress: 60, sequence: 2, at: "2026-07-26 10:05" },
      { status: "completed", detail: "Completed", progress: 100, sequence: 3, at: "2026-07-26 10:09" },
    ];
    for (const row of rows) {
      repo.appendTaskHistory({
        id: `task-translate-1:${row.sequence}`,
        queueTaskId: "task-translate-1",
        label: "Translate project",
        detail: row.detail,
        stage: "translate",
        status: row.status,
        progress: row.progress,
        targetLanguageCode: "zh-CN",
        createdAt: rows[0].at,
        updatedAt: row.at,
        recordedAt: row.at,
        sequence: row.sequence,
      });
    }
    assert.equal(repo.listTaskHistory().length, 4, "历史本身仍然是追加式的");
  } finally {
    repo.close();
  }

  const port = createDesktopTranslationPort({
    openProjectRepository,
    projectsDir,
    projectMigrationsDir: root,
    workerClient: { translateLanguage: async () => ({ status: "completed", translations: {} }) },
    loadProviderReadiness: () => null,
    saveProviderReadiness: () => {},
    revealSecret: () => "fake-only",
  });
  try {
    const state = port.getProjectRuntimeState({ projectId: historyProject.id });
    assert.equal(state.ok, true);
    assert.equal(state.data.tasks.length, 1, JSON.stringify(state.data.tasks));
    const [task] = state.data.tasks;
    assert.equal(task.status, "completed");
    assert.equal(task.progress, 100);
    // id 必须还原成队列里的任务 id，否则暂停/继续/取消都会 TASK_NOT_FOUND。
    assert.equal(task.id, "task-translate-1");
    assert.equal(task.projectId, historyProject.id);
  } finally {
    rmSync(projectsDir, { recursive: true, force: true });
  }
});
