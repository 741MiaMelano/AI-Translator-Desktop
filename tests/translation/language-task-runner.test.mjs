import assert from "node:assert/strict";
import test from "node:test";
import { createLanguageTaskRunner } from "../../backend/translation/language-task-runner.mjs";

test("independent language tasks keep successful results when another fails", async () => {
  const persisted = [];
  const events = [];
  const runner = createLanguageTaskRunner({
    translateService: {
      async translateLanguage({ targetLanguage }) {
        if (targetLanguage === "ja-JP") {
          const error = new Error("fail ja");
          error.providerErrorClass = "server";
          throw error;
        }
        return {
          status: "completed",
          translations: { s1: `${targetLanguage}-ok` },
          snapshot: {
            id: `snap-${targetLanguage}`,
            cacheHits: 0,
            createdAt: "2026-07-16T00:00:00.000Z",
          },
          networkCalls: 1,
          cacheHits: 0,
          usage: { inputTokens: 20, outputTokens: 8 },
        };
      },
    },
    async persistLanguageResult(payload) {
      persisted.push(payload);
    },
  });

  const { results } = await runner.runLanguages({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguages: ["zh-CN", "ja-JP", "en-US"],
    providerId: "openai",
    model: "GPT-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments: [{ id: "s1", sourceText: { normalized: "Hi" } }],
    onTaskEvent: (event) => events.push(event),
  });

  assert.equal(results.filter((item) => item.status === "completed").length, 2);
  assert.equal(results.filter((item) => item.status === "failed").length, 1);
  assert.deepEqual(
    persisted.map((item) => item.targetLanguage).sort(),
    ["en-US", "zh-CN"],
  );
  assert.ok(events.some((event) => event.status === "failed" && event.targetLanguage === "ja-JP"));
  assert.ok(events.some((event) => event.status === "completed" && event.targetLanguage === "zh-CN"));
});

test("partial provider failure persists its language resource rules without masking the original error", async () => {
  const persisted = [];
  const events = [];
  const providerError = new Error("provider failed after a paid batch");
  providerError.providerErrorClass = "server";
  providerError.partialOutcome = {
    status: "failed",
    translations: { s1: "partial" },
    snapshot: { id: "snap-partial", createdAt: "2026-07-23T00:00:00.000Z" },
    usage: { inputTokens: 12, outputTokens: 4 },
  };
  const runner = createLanguageTaskRunner({
    translateService: { async translateLanguage() { throw providerError; } },
    async persistLanguageResult(payload) { persisted.push(payload); },
  });

  const result = await runner.runLanguages({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguages: ["ja-JP"],
    providerId: "openai",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments: [{ id: "s1", sourceText: { normalized: "Hi" } }],
    resourceContextsByLanguage: {
      "ja-JP": { termConflictRules: [{ source: "Hi", required: "こんにちは" }] },
    },
    onTaskEvent: (event) => events.push(event),
  });

  assert.equal(result.results[0].error, providerError);
  assert.deepEqual(result.results[0].usage, { inputTokens: 12, outputTokens: 4 });
  assert.deepEqual(persisted[0].termConflictRules, [{ source: "Hi", required: "こんにちは" }]);
  assert.ok(events.some((event) => event.status === "failed" && event.message === providerError.message));
});

test("confirmed retry sends only target segments that are still empty", async () => {
  let requestedIds = [];
  const runner = createLanguageTaskRunner({
    translateService: {
      async translateLanguage(request) {
        requestedIds = request.segments.map((segment) => segment.id);
        return {
          status: "completed",
          translations: { s3: "补译" },
          snapshot: { id: "snap-resume", cacheHits: 0, createdAt: "2026-08-11T00:00:00.000Z" },
          networkCalls: 1,
          cacheHits: 0,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });

  await runner.runLanguages({
    projectId: "p-resume",
    sourceTrackId: "src",
    targetLanguages: ["zh-CN"],
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "fake-only",
    resumeExistingTargetText: true,
    segments: [
      { id: "s1", sourceText: { normalized: "one" } },
      { id: "s2", sourceText: { normalized: "two" } },
      { id: "s3", sourceText: { normalized: "three" } },
    ],
    existingTargetLayersByLanguage: {
      "zh-CN": {
        s1: { model: "已译", postProcessed: "已译" },
        s2: { manual: "人工译文", model: "旧译文" },
        s3: { model: "", postProcessed: "" },
      },
    },
  });

  assert.deepEqual(requestedIds, ["s3"]);
});
