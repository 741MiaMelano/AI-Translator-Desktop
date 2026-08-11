import assert from "node:assert/strict";
import test from "node:test";
import { createTranslateService } from "../../backend/translation/translate-service.mjs";
import { createMemoryTranslationCache } from "../../backend/translation/cache.mjs";

function fakeClient(handler) {
  return {
    async createStructuredTranslation(args) {
      return handler(args);
    },
  };
}

test("translation service sends glossary and style hints to the provider prompt", async () => {
  let promptPayload;
  const service = createTranslateService({
    idFactory: () => "run-resource-prompt",
    client: fakeClient(async ({ messages }) => {
      promptPayload = JSON.parse(messages[1].content);
      return {
        rawText: JSON.stringify({
          targetLanguage: "zh-CN",
          segments: [{ segmentId: "s1", text: "工作区" }],
        }),
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    }),
  });
  await service.translateLanguage({
    projectId: "p-resource",
    sourceTrackId: "source-1",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "fake-only",
    segments: [{ id: "s1", sourceText: { original: "workspace", normalized: "workspace" } }],
    glossaryHint: '[{"source":"workspace","target":"工作区"}]',
    styleHint: "Use concise Chinese.",
  });
  assert.match(promptPayload.glossaryHint, /工作区/);
  assert.equal(promptPayload.styleHint, "Use concise Chinese.");
});

test("translation service retries once when Chinese source is returned in the wrong language", async () => {
  let calls = 0;
  let retryMessage = "";
  const service = createTranslateService({
    idFactory: () => "run-target-language-retry",
    client: fakeClient(async ({ messages }) => {
      calls += 1;
      retryMessage = messages.at(-1).content;
      return {
        rawText: JSON.stringify({
          targetLanguage: "zh-CN",
          segments: [{
            segmentId: "s1",
            text: calls === 1 ? "This was incorrectly translated into English." : "这句话保持为中文。",
          }],
        }),
        usage: { inputTokens: 5, outputTokens: 3 },
      };
    }),
  });

  const result = await service.translateLanguage({
    projectId: "p-language",
    sourceTrackId: "source-1",
    targetLanguage: "zh-CN",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    apiKey: "fake-only",
    segments: [{ id: "s1", sourceText: { normalized: "这句话本来就是中文。" } }],
  });

  assert.equal(calls, 2);
  assert.match(retryMessage, /zh-CN/);
  assert.equal(result.networkCalls, 2);
  assert.equal(result.translations.s1, "这句话保持为中文。");
});

test("translation service corrects one malformed structured response before stopping the task", async () => {
  let calls = 0;
  let correction = "";
  const service = createTranslateService({
    client: fakeClient(async ({ messages }) => {
      calls += 1;
      correction = messages.at(-1).content;
      const payload = JSON.parse(messages[1].content);
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: calls === 1
            ? payload.segments.slice(0, 1).map(({ segmentId }) => ({ segmentId, text: "译文" }))
            : payload.segments.map(({ segmentId }) => ({ segmentId, text: "译文" })),
        }),
        usage: { inputTokens: 5, outputTokens: 3 },
      };
    }),
  });

  const result = await service.translateLanguage({
    projectId: "p-schema-retry",
    sourceTrackId: "source-1",
    targetLanguage: "zh-CN",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    apiKey: "fake-only",
    segments: [
      { id: "s1", sourceText: { normalized: "one" } },
      { id: "s2", sourceText: { normalized: "two" } },
    ],
  });

  assert.equal(calls, 2);
  assert.match(correction, /segment count mismatch/);
  assert.equal(result.translations.s1, "译文");
  assert.equal(result.translations.s2, "译文");
});

test("multi-language isolation: one failure does not erase other language results", async () => {
  const cache = createMemoryTranslationCache();
  let calls = 0;
  const service = createTranslateService({
    cache,
    idFactory: () => `run-${++calls}`,
    client: fakeClient(async ({ messages }) => {
      const payload = JSON.parse(messages[1].content);
      if (payload.targetLanguage === "ja-JP") {
        const error = new Error("boom");
        error.providerErrorClass = "server";
        throw error;
      }
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: payload.segments.map((segment) => ({
            segmentId: segment.segmentId,
            text: `${payload.targetLanguage}:${segment.text}`,
          })),
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  const segments = [
    { id: "s1", sourceText: { original: "Hello", normalized: "Hello" } },
    { id: "s2", sourceText: { original: "World", normalized: "World" } },
  ];

  const zh = await service.translateLanguage({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments,
  });
  assert.equal(zh.status, "completed");
  assert.equal(zh.translations.s1, "zh-CN:Hello");

  await assert.rejects(
    () =>
      service.translateLanguage({
        projectId: "p1",
        sourceTrackId: "src",
        targetLanguage: "ja-JP",
        providerId: "openai",
        model: "GPT-4.1",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        segments,
      }),
    (error) => error.providerErrorClass === "server",
  );

  assert.equal(zh.translations.s1, "zh-CN:Hello");
  assert.equal(zh.snapshot.targetLanguageCode, "zh-CN");
});

test("cache hit skips network and still records a new run", async () => {
  let networkCalls = 0;
  const cache = createMemoryTranslationCache();
  const service = createTranslateService({
    cache,
    idFactory: () => "run-cache",
    client: fakeClient(async ({ messages }) => {
      networkCalls += 1;
      const payload = JSON.parse(messages[1].content);
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: payload.segments.map((segment) => ({
            segmentId: segment.segmentId,
            text: `T:${segment.text}`,
          })),
        }),
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    }),
  });
  const segments = [{ id: "s1", sourceText: { original: "Hi", normalized: "Hi" } }];
  const first = await service.translateLanguage({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments,
  });
  assert.equal(first.networkCalls, 1);
  const second = await service.translateLanguage({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments,
  });
  assert.equal(second.networkCalls, 0);
  assert.equal(second.cacheHits, 1);
  assert.equal(second.snapshot.cacheHits, 1);
  assert.equal(second.snapshot.inputTokens, 0);
  assert.equal(second.snapshot.outputTokens, 0);
  assert.equal(second.translations.s1, "T:Hi");
  assert.equal(networkCalls, 1);
});

test("manual/locked layers are not overwritten by provider or cache", async () => {
  const service = createTranslateService({
    idFactory: () => "run-protect",
    client: fakeClient(async ({ messages }) => {
      const payload = JSON.parse(messages[1].content);
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: payload.segments.map((segment) => ({
            segmentId: segment.segmentId,
            text: "MODEL",
          })),
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
  });
  const result = await service.translateLanguage({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments: [
      { id: "s1", sourceText: { original: "A", normalized: "A" } },
      { id: "s2", sourceText: { original: "B", normalized: "B" } },
    ],
    existingTargetLayers: {
      s1: { model: "old", postProcessed: "old", manual: "人工", qaFlags: [] },
      s2: { model: "old", postProcessed: "old", locked: true, qaFlags: [] },
    },
  });
  assert.equal(result.translations.s1, undefined);
  assert.equal(result.translations.s2, undefined);
  assert.equal(result.networkCalls, 0);
});

test("provider usage is recorded on the run snapshot", async () => {
  const service = createTranslateService({
    idFactory: () => "run-usage",
    client: fakeClient(async ({ messages }) => {
      const payload = JSON.parse(messages[1].content);
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: payload.segments.map(({ segmentId }) => ({ segmentId, text: "译文" })),
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
        baseUrlDisplay: "https://api.openai.com/v1",
      };
    }),
  });

  const result = await service.translateLanguage({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments: [{ id: "s1", sourceText: { normalized: "hello" } }],
  });

  assert.equal(result.status, "completed");
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.snapshot.inputTokens, 10);
  assert.equal(result.snapshot.outputTokens, 5);
  assert.equal(result.snapshot.baseUrlDisplay, "https://api.openai.com/v1");
});

test("token estimation caps provider output tokens", async () => {
  let maxOutputTokens;
  const service = createTranslateService({
    client: fakeClient(async (request) => {
      maxOutputTokens = request.maxOutputTokens;
      const payload = JSON.parse(request.messages[1].content);
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: payload.segments.map(({ segmentId }) => ({ segmentId, text: "译文" })),
        }),
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    }),
  });

  await service.translateLanguage({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments: [{ id: "s1", sourceText: { normalized: "hello" } }],
  });

  assert.equal(typeof maxOutputTokens, "number");
  assert.ok(maxOutputTokens > 0);
  assert.ok(maxOutputTokens < 2048);
});

test("missing provider usage never fabricates token counts", async () => {
  const service = createTranslateService({
    client: fakeClient(async ({ messages }) => {
      const payload = JSON.parse(messages[1].content);
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: payload.segments.map(({ segmentId }) => ({ segmentId, text: "译文" })),
        }),
        usage: null,
      };
    }),
  });

  const result = await service.translateLanguage({
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments: [{ id: "s1", sourceText: { normalized: "hello" } }],
  });

  assert.equal(result.status, "completed");
  assert.equal(result.snapshot.inputTokens, 0);
  assert.equal(result.snapshot.outputTokens, 0);
});

test("later batch failure exposes earlier paid translations for persistence", async () => {
  let call = 0;
  const service = createTranslateService({
    idFactory: () => "run-partial-failure",
    client: fakeClient(async ({ messages }) => {
      call += 1;
      if (call === 2) {
        const error = new Error("second batch failed");
        error.providerErrorClass = "server";
        throw error;
      }
      const payload = JSON.parse(messages[1].content);
      return {
        rawText: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          segments: payload.segments.map(({ segmentId }) => ({ segmentId, text: "paid result" })),
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  await assert.rejects(
    () =>
      service.translateLanguage({
        projectId: "p1",
        sourceTrackId: "src",
        targetLanguage: "zh-CN",
        providerId: "openai",
        model: "gpt-4.1",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        segments: [
          { id: "s1", sourceText: { normalized: "a".repeat(3000) } },
          { id: "s2", sourceText: { normalized: "b".repeat(3000) } },
        ],
      }),
    (error) => {
      assert.equal(error.providerErrorClass, "server");
      assert.equal(error.partialOutcome.translations.s1, "paid result");
      assert.equal(error.partialOutcome.translations.s2, undefined);
      assert.equal(error.partialOutcome.snapshot.inputTokens, 10);
      assert.equal(error.partialOutcome.snapshot.outputTokens, 5);
      return true;
    },
  );
});

test("default run snapshot ids stay unique within the same millisecond", async (t) => {
  t.mock.method(Date, "now", () => 1_700_000_000_000);
  const service = createTranslateService({
    client: fakeClient(() => {
      throw new Error("protected cache-only run must not call the provider");
    }),
  });
  const request = {
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    segments: [{ id: "s1", sourceText: { normalized: "hello" } }],
    existingTargetLayers: { s1: { manual: "人工译文" } },
  };

  const first = await service.translateLanguage(request);
  const second = await service.translateLanguage(request);

  assert.notEqual(first.snapshot.id, second.snapshot.id);
});
