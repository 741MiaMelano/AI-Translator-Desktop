import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import { createDesktopTranslationPort } from "../../backend/translation/desktop-translation-port.mjs";
import { fingerprintResourceSnapshot } from "../../backend/translation/run-snapshot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = join(root, "migrations", "project");

function project() {
  return {
    id: "profile-project",
    title: "Profile project",
    sourceFileName: "source.srt",
    mediaKind: "subtitle",
    noSourceMedia: true,
    lifecycle: "draft",
    createdAt: "2026-07-16 00:00",
    updatedAt: "2026-07-16 00:00",
    activeSourceTrackId: "source-1",
    pendingConfirmations: [],
    notes: [],
    config: {
      sourceLanguage: "en",
      targetLanguages: ["zh-CN"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "none",
      styleGuide: "none",
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
        summary: "test",
        segments: [
          {
            id: "s1",
            start: "00:00:01,000",
            end: "00:00:02,000",
            sourceLanguage: "en",
            sourceText: { original: "hello", normalized: "hello" },
            targetTexts: { "zh-CN": { model: "", postProcessed: "", qaFlags: [] } },
          },
          {
            id: "s2",
            start: "00:00:02,100",
            end: "00:00:03,000",
            sourceLanguage: "en",
            sourceText: { original: "world", normalized: "world" },
            targetTexts: { "zh-CN": { model: "旧世界", postProcessed: "旧世界", qaFlags: [] } },
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

test("translation requires a matching ready provider profile", async () => {
  const containerRoot = mkdtempSync(join(tmpdir(), "phase4-port-"));
  const projectsDir = join(containerRoot, "projects");
  const projectDir = join(projectsDir, "profile-project");
  const repo = openProjectRepository(projectDir, { migrationsDir });
  repo.saveProject(project());
  repo.close();

  const workerClient = {
    async testConnection({ baseUrl, model, transportMode }) {
      return { ok: true, baseUrlDisplay: baseUrl, model, transportMode };
    },
    async translateLanguage(request) {
      return completedOutcome(request, { s1: "你好", s2: "世界" }, "profile-run");
    },
  };
  let readiness = null;
  const port = createDesktopTranslationPort({
    openProjectRepository,
    projectsDir,
    projectMigrationsDir: migrationsDir,
    revealSecret: () => "sk-test",
    workerClient,
    client: workerClient,
    translateService: { translateLanguage: workerClient.translateLanguage },
    loadProviderReadiness: () => readiness,
    saveProviderReadiness: (next) => {
      readiness = next;
    },
  });

  try {
    // 从未测过连接就直接开跑：端口会自动先探测一次，通过就继续，
    // 不再把用户打发去「翻译 Provider」手动点一次再跳回来。
    const auto = await port.translateProject({ projectId: "profile-project", userConfirmed: true });
    assert.equal(auto.ok, true, "连接可用时应自动验证并继续");
    assert.equal(auto.data.results[0].status, "completed");
    assert.equal(readiness?.status, "ready", "自动验证的结果要落盘，下次不必再探测");

    // 换模型不该让已验证的连接作废：连接凭证只认
    // 「接口地址 + 密钥 + 传输方式」，模型不参与哈希。
    const tested = await port.testProviderConnection({ provider: "OpenAI", model: "GPT-4o" });
    assert.equal(tested.ok, true);
    const sameEndpoint = await port.translateProject({ projectId: "profile-project", userConfirmed: true });
    assert.equal(sameEndpoint.ok, true, "换模型不应让连接测试作废");
  } finally {
    rmSync(containerRoot, { recursive: true, force: true });
  }
});

test("auto verification still blocks a bad credential and reports the real reason", async () => {
  const containerRoot = mkdtempSync(join(tmpdir(), "phase4-port-badkey-"));
  const projectsDir = join(containerRoot, "projects");
  const repo = openProjectRepository(join(projectsDir, "profile-project"), { migrationsDir });
  repo.saveProject(project());
  repo.close();

  // 自动验证不是"无脑放行"：探测失败依旧不开跑，
  // 而且给出的是真实响应分类（auth），不是一句"你还没测过"。
  const workerClient = {
    async testConnection() {
      const error = new Error("401 unauthorized");
      error.code = "PROVIDER_AUTH";
      error.providerErrorClass = "auth";
      throw error;
    },
    async translateLanguage() {
      throw new Error("不应该走到真实翻译");
    },
  };
  let readiness = null;
  const port = createDesktopTranslationPort({
    openProjectRepository,
    projectsDir,
    projectMigrationsDir: migrationsDir,
    revealSecret: () => "sk-bad",
    workerClient,
    client: workerClient,
    translateService: { translateLanguage: workerClient.translateLanguage },
    loadProviderReadiness: () => readiness,
    saveProviderReadiness: (next) => { readiness = next; },
  });

  try {
    const blocked = await port.translateProject({ projectId: "profile-project", userConfirmed: true });
    assert.equal(blocked.ok, false, "密钥不可用时必须拦住");
    assert.equal(readiness, null, "失败的探测不应被记成 ready");
    assert.match(JSON.stringify(blocked.error), /auth|401/i);
  } finally {
    rmSync(containerRoot, { recursive: true, force: true });
  }
});


function completedOutcome(request, translations, id) {
  return {
    status: "completed",
    translations,
    networkCalls: 1,
    cacheHits: 0,
    usage: { inputTokens: 10, outputTokens: 5 },
    snapshot: {
      id,
      projectId: request.projectId,
      sourceTrackId: request.sourceTrackId,
      targetLanguageCode: request.targetLanguage,
      providerId: request.providerId,
      model: request.model,
      promptTemplateVersion: "translation.structured.v1",
      parameters: request.parameters,
      resourceSnapshot: request.resourceSnapshot,
      resourceFingerprint: fingerprintResourceSnapshot(request.resourceSnapshot),
      segmentVersion: "selected-v1",
      createdAt: "2026-07-18T12:00:00.000Z",
      cacheHits: 0,
      inputTokens: 10,
      outputTokens: 5,
    },
  };
}

test("project resource snapshots feed target-specific prompt hints and immutable run evidence", async () => {
  const current = project();
  current.id = "resource-project";
  current.config.glossary = "glossary-product";
  current.config.styleGuide = "style-concise";
  current.sourceTracks[0].segments[0].targetTexts["zh-CN"].manual = "人工术语";
  current.sourceTracks[0].segments[0].targetTexts["zh-CN"].locked = true;
  let captured = null;
  const workerClient = {
    async testConnection({ baseUrl, model, transportMode }) {
      return { ok: true, baseUrlDisplay: baseUrl, model, transportMode };
    },
    async translateLanguage(request) {
      captured = request;
      return completedOutcome(request, { s1: "你好", s2: "世界" }, "resource-run");
    },
  };
  const runtime = await readyPort(current, workerClient);
  const repo = openProjectRepository(join(runtime.projectsDir, current.id), { migrationsDir });
  try {
    repo.appendResourceSnapshot({
      id: "glossary-snapshot-r3",
      kind: "glossary",
      name: "Product glossary",
      scope: "project_snapshot",
      schemaVersion: 1,
      source: { kind: "global", resourceId: "glossary-product", revision: 3 },
      capturedAt: "2026-07-23T13:00:00.000Z",
      payload: {
        languagePairs: [{
          sourceLanguageCode: "en",
          targetLanguageCode: "zh-CN",
          entries: [{ id: "term-hello", source: "hello", target: "你好", enabled: true }],
        }],
      },
    });
    repo.appendResourceSnapshot({
      id: "style-snapshot-r2",
      kind: "style_guide",
      name: "Concise style",
      scope: "project_snapshot",
      schemaVersion: 1,
      source: { kind: "global", resourceId: "style-concise", revision: 2 },
      capturedAt: "2026-07-23T13:01:00.000Z",
      payload: {
        targetLanguageCode: "zh-CN",
        tags: [],
        scenes: [],
        rules: [{ id: "rule-1", title: "Concise", instruction: "Use concise Chinese.", enabled: true }],
      },
    });
  } finally {
    repo.close();
  }

  try {
    const result = await runtime.port.translateProject({ projectId: current.id, targetLanguages: ["zh-CN"] });
    assert.equal(result.ok, true);
    assert.match(captured.glossaryHint, /hello.*你好/);
    assert.match(captured.styleHint, /Use concise Chinese/);
    assert.equal(captured.resourceSnapshot.glossary.source.revision, 3);
    const persisted = openProjectRepository(join(runtime.projectsDir, current.id), { migrationsDir });
    try {
      const run = persisted.listRunSnapshots()[0];
      assert.equal(run.resourceSnapshot.styleGuide.source.revision, 2);
      assert.equal(typeof run.resourceFingerprint, "string");
      assert.equal(run.resourceFingerprint.length, 64);
      const loaded = persisted.loadProject();
      const protectedLayer = loaded.sourceTracks[0].segments[0].targetTexts["zh-CN"];
      assert.equal(protectedLayer.manual, "人工术语");
      assert.equal(protectedLayer.locked, true);
      assert.ok(loaded.sourceTracks[0].targetTracks[0].qaIssues.some((issue) => issue.ruleId === "qa.term_conflict"));
    } finally {
      persisted.close();
    }
  } finally {
    rmSync(runtime.containerRoot, { recursive: true, force: true });
  }
});

async function readyPort(projectValue, workerClient) {
  const containerRoot = mkdtempSync(join(tmpdir(), "phase5-port-"));
  const projectsDir = join(containerRoot, "projects");
  const repo = openProjectRepository(join(projectsDir, projectValue.id), { migrationsDir });
  repo.saveProject(projectValue);
  repo.close();
  let readiness = null;
  const port = createDesktopTranslationPort({
    openProjectRepository,
    projectsDir,
    projectMigrationsDir: migrationsDir,
    revealSecret: () => "sk-test",
    workerClient,
    loadProviderReadiness: () => readiness,
    saveProviderReadiness: (next) => { readiness = next; },
  });
  const tested = await port.testProviderConnection({ provider: "OpenAI", model: "GPT-4.1" });
  assert.equal(tested.ok, true);
  return { containerRoot, projectsDir, port };
}

test("selected rerun sends exact ids, read-only context, and persists previousManual coverage", async () => {
  const current = project();
  current.id = "selected-project";
  current.sourceTracks[0].segments[0].targetTexts["zh-CN"].manual = "人工稿";
  let captured = null;
  const workerClient = {
    async testConnection({ baseUrl, model, transportMode }) {
      return { ok: true, baseUrlDisplay: baseUrl, model, transportMode };
    },
    async translateLanguage(request) {
      captured = request;
      return completedOutcome(request, { s1: "局部重跑" }, "selected-run");
    },
  };
  const runtime = await readyPort(current, workerClient);
  try {
    const result = await runtime.port.translateProject({
      projectId: current.id,
      targetLanguages: ["zh-CN"],
      segmentIds: ["s1"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(captured.segments.map((segment) => segment.id), ["s1"]);
    assert.deepEqual(captured.contextSegments.map((segment) => segment.id), ["s2"]);
    const repo = openProjectRepository(join(runtime.projectsDir, current.id), { migrationsDir });
    try {
      const loaded = repo.loadProject();
      const rerun = loaded.sourceTracks[0].segments[0].targetTexts["zh-CN"];
      assert.equal(rerun.model, "局部重跑");
      assert.equal(rerun.manual, undefined);
      assert.equal(rerun.previousManual, "人工稿");
      assert.equal(loaded.sourceTracks[0].segments[1].targetTexts["zh-CN"].model, "旧世界");
      assert.deepEqual(repo.listRunSnapshots()[0].parameters.coverage, {
        mode: "selected_segments",
        segmentIds: ["s1"],
      });
    } finally {
      repo.close();
    }
  } finally {
    rmSync(runtime.containerRoot, { recursive: true, force: true });
  }
});

test("candidate translation persists separately and leaves active target text unchanged", async () => {
  const current = project();
  current.id = "candidate-project";
  current.sourceTracks[0].segments[0].targetTexts["zh-CN"].model = "活动稿";
  current.sourceTracks[0].segments[0].targetTexts["zh-CN"].postProcessed = "活动稿";
  current.sourceTracks[0].targetTracks.push({
    id: "candidate-1",
    languageCode: "zh-CN",
    languageLabel: "Chinese",
    status: "draft",
    isActive: false,
    role: "candidate",
    baseTrackId: "target-zh",
    qaIssues: [],
    snapshotIds: [],
    deliveryLabel: "候选整轨重译",
    lastHumanAction: "created candidate",
    candidateTexts: {},
  });
  const workerClient = {
    async testConnection({ baseUrl, model, transportMode }) {
      return { ok: true, baseUrlDisplay: baseUrl, model, transportMode };
    },
    async translateLanguage(request) {
      return completedOutcome(request, { s1: "候选稿", s2: "候选世界" }, "candidate-run");
    },
  };
  const runtime = await readyPort(current, workerClient);
  try {
    const result = await runtime.port.translateProject({
      projectId: current.id,
      targetLanguages: ["zh-CN"],
      candidateTrackId: "candidate-1",
    });
    assert.equal(result.ok, true);
    const repo = openProjectRepository(join(runtime.projectsDir, current.id), { migrationsDir });
    try {
      const loaded = repo.loadProject();
      assert.equal(loaded.sourceTracks[0].segments[0].targetTexts["zh-CN"].model, "活动稿");
      const candidate = loaded.sourceTracks[0].targetTracks.find((track) => track.id === "candidate-1");
      assert.equal(candidate.candidateTexts.s1.model, "候选稿");
      assert.equal(candidate.snapshotIds[0], "candidate-run");
    } finally {
      repo.close();
    }
  } finally {
    rmSync(runtime.containerRoot, { recursive: true, force: true });
  }
});
