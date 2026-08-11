import assert from "node:assert/strict";
import test from "node:test";
import {
  PROMPT_TEMPLATE_VERSION,
  buildProjectContentSummary,
  buildTranslationMessages,
  validateTranslationResponse,
} from "../../backend/translation/prompt-contract.mjs";
import { planTranslationBatches } from "../../backend/translation/batching.mjs";
import {
  buildTranslationCacheFingerprint,
  createMemoryTranslationCache,
  isProtectedTargetLayer,
} from "../../backend/translation/cache.mjs";
import { estimateTokensForBatch } from "../../backend/translation/budget.mjs";
import {
  buildEmptyResourceSnapshot,
  createRunSnapshotRecord,
} from "../../backend/translation/run-snapshot.mjs";

test("prompt response requires exact segment id set", () => {
  const expected = ["s1", "s2"];
  const messages = buildTranslationMessages({
    targetLanguage: "zh-CN",
    segments: [
      { segmentId: "s1", text: "hello" },
      { segmentId: "s2", text: "world" },
    ],
    contextSegments: [{ segmentId: "s0", text: "prev" }],
  });
  assert.match(messages[0].content, new RegExp(PROMPT_TEMPLATE_VERSION));
  assert.match(messages[0].content, /segments\[\]\.text.*targetLanguage/i);
  assert.equal(JSON.parse(messages[1].content).contextReadOnly[0].segmentId, "s0");

  const ok = validateTranslationResponse(
    JSON.stringify({
      targetLanguage: "zh-CN",
      segments: [
        { segmentId: "s2", text: "世界" },
        { segmentId: "s1", text: "你好" },
      ],
    }),
    { targetLanguage: "zh-CN", expectedSegmentIds: expected },
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.segments.map((item) => item.segmentId), expected);

  for (const raw of [
    JSON.stringify({ targetLanguage: "en-US", segments: [{ segmentId: "s1", text: "a" }, { segmentId: "s2", text: "b" }] }),
    JSON.stringify({ targetLanguage: "zh-CN", segments: [{ segmentId: "s1", text: "a" }] }),
    JSON.stringify({
      targetLanguage: "zh-CN",
      segments: [
        { segmentId: "s1", text: "a" },
        { segmentId: "s1", text: "b" },
      ],
    }),
    JSON.stringify({
      targetLanguage: "zh-CN",
      segments: [
        { segmentId: "s1", text: "a" },
        { segmentId: "s9", text: "b" },
      ],
    }),
    JSON.stringify({
      targetLanguage: "zh-CN",
      segments: [
        { segmentId: "s1", text: "a" },
        { segmentId: "s2", text: 3 },
      ],
    }),
    "not-json",
  ]) {
    const result = validateTranslationResponse(raw, {
      targetLanguage: "zh-CN",
      expectedSegmentIds: expected,
    });
    assert.equal(result.ok, false, raw);
  }
});

test("response validation rejects an obvious target-script mismatch", () => {
  const result = validateTranslationResponse(
    JSON.stringify({
      targetLanguage: "zh-CN",
      segments: [{ segmentId: "s1", text: "This was incorrectly translated into English." }],
    }),
    {
      targetLanguage: "zh-CN",
      expectedSegmentIds: ["s1"],
      sourceSegments: [{ segmentId: "s1", text: "这句话本来就是中文。" }],
    },
  );

  assert.deepEqual(result, {
    ok: false,
    error: "translated text does not use target language",
  });
});

test("response validation rejects an empty target segment", () => {
  const result = validateTranslationResponse(
    JSON.stringify({
      targetLanguage: "zh-CN",
      segments: [{ segmentId: "s1", text: "  " }],
    }),
    {
      targetLanguage: "zh-CN",
      expectedSegmentIds: ["s1"],
      sourceSegments: [{ segmentId: "s1", text: "The truth" }],
    },
  );

  assert.deepEqual(result, {
    ok: false,
    error: "translated text is empty",
  });
});

test("translation prompt treats adjacent subtitle segments as continuous discourse", () => {
  const segments = [
    { segmentId: "s1", text: "The" },
    { segmentId: "s2", text: "truth" },
    { segmentId: "s3", text: "is that I've" },
  ];
  const messages = buildTranslationMessages({
    targetLanguage: "zh-CN",
    segments,
  });
  const instruction = messages[0].content;

  assert.match(instruction, /continuous (?:discourse|transcript)/i);
  assert.match(instruction, /boundaries may split a sentence or phrase/i);
  assert.match(instruction, /never translate (?:a|each) segment in isolation/i);
  assert.match(instruction, /do not (?:omit or duplicate|duplicate or omit) meaning/i);
  assert.match(instruction, /read fluently/i);
  assert.match(instruction, /never leave.*target text empty/i);
  assert.deepEqual(JSON.parse(messages[1].content).segments, segments);
});

test("translation prompt reconstructs sentence-level semantic units without changing segment ids", () => {
  const segments = [
    { segmentId: "s1", text: "The" },
    { segmentId: "s2", text: "truth" },
    { segmentId: "s3", text: "is that I've been rich for almost 30 years." },
    { segmentId: "s4", text: "NVIDIA went" },
    { segmentId: "s5", text: "public in 1999." },
  ];
  const messages = buildTranslationMessages({ targetLanguage: "zh-CN", segments });
  const payload = JSON.parse(messages[1].content);

  assert.deepEqual(payload.semanticUnits, [
    {
      segmentIds: ["s1", "s2", "s3"],
      sourceText: "The truth is that I've been rich for almost 30 years.",
    },
    {
      segmentIds: ["s4", "s5"],
      sourceText: "NVIDIA went public in 1999.",
    },
  ]);
  assert.deepEqual(payload.segments, segments);
});

test("batching is deterministic, does not split segments, context is read-only", () => {
  const segments = [
    { segmentId: "a", text: "one" },
    { segmentId: "b", text: "two" },
    { segmentId: "c", text: "three" },
  ];
  const batches = planTranslationBatches(segments, { maxChars: 20, contextRadius: 1 });
  assert.ok(batches.length >= 2);
  assert.deepEqual(
    batches.flatMap((batch) => batch.expectedSegmentIds),
    ["a", "b", "c"],
  );
  for (const batch of batches) {
    for (const context of batch.contextSegments) {
      assert.equal(batch.expectedSegmentIds.includes(context.segmentId), false);
    }
  }
  const again = planTranslationBatches(segments, { maxChars: 20, contextRadius: 1 });
  assert.deepEqual(batches, again);
});

test("default batching expands context to subtitle sentence boundaries", () => {
  const segments = [
    { segmentId: "s0", text: "Previous sentence." },
    { segmentId: "s1", text: "A split" },
    { segmentId: "s2", text: "sentence continues" },
    { segmentId: "s3", text: "and ends here." },
    { segmentId: "s4", text: "Next split" },
    { segmentId: "s5", text: "sentence ends." },
  ];
  const batches = planTranslationBatches(segments, { maxChars: 45 });
  const middle = batches.find((batch) => batch.expectedSegmentIds.includes("s2"));

  assert.deepEqual(
    middle.contextSegments.map((segment) => segment.segmentId),
    ["s1", "s3"],
  );
});

test("project content summary is bounded and represented in every translation prompt", () => {
  const segments = Array.from({ length: 30 }, (_, index) => ({
    segmentId: `s${index}`,
    text: `Topic ${index} explains the project section ${index}.`,
  }));
  const projectSummary = buildProjectContentSummary(segments, { maxChars: 180, maxUnits: 4 });
  const messages = buildTranslationMessages({
    targetLanguage: "zh-CN",
    segments: segments.slice(10, 12),
    projectSummary,
  });
  const payload = JSON.parse(messages[1].content);

  assert.ok(projectSummary.length >= 2);
  assert.ok(projectSummary.length <= 4);
  assert.ok(JSON.stringify(projectSummary).length <= 220);
  assert.deepEqual(payload.projectSummaryReadOnly, projectSummary);
  assert.match(messages[0].content, /project summary.*context/i);
});

test("cache fingerprint is complete and protected layers are detected", () => {
  const a = buildTranslationCacheFingerprint({
    sourceText: "hello",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    parameters: { temperature: 0.2 },
    resourceSnapshot: buildEmptyResourceSnapshot(),
    segmentVersion: "seg-v1",
  });
  const b = buildTranslationCacheFingerprint({
    sourceText: "hello",
    targetLanguage: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    parameters: { temperature: 0.3 },
    resourceSnapshot: buildEmptyResourceSnapshot(),
    segmentVersion: "seg-v1",
  });
  assert.notEqual(a, b);
  const endpointChanged = buildTranslationCacheFingerprint({
    sourceText: "hello",
    targetLanguage: "zh-CN",
    providerId: "openai-compatible",
    model: "custom-model",
    baseUrl: "https://proxy-b.example/v1",
    transportMode: "chat_completions",
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    parameters: { temperature: 0.2 },
    resourceSnapshot: buildEmptyResourceSnapshot(),
    segmentVersion: "seg-v1",
  });
  const endpointOriginal = buildTranslationCacheFingerprint({
    sourceText: "hello",
    targetLanguage: "zh-CN",
    providerId: "openai-compatible",
    model: "custom-model",
    baseUrl: "https://proxy-a.example/v1",
    transportMode: "chat_completions",
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    parameters: { temperature: 0.2 },
    resourceSnapshot: buildEmptyResourceSnapshot(),
    segmentVersion: "seg-v1",
  });
  assert.notEqual(endpointOriginal, endpointChanged);
  assert.equal(a.length, 64);

  const cache = createMemoryTranslationCache();
  cache.set(a, { text: "你好" });
  assert.equal(cache.get(a).text, "你好");
  assert.equal(isProtectedTargetLayer({ locked: true, model: "x", postProcessed: "x", qaFlags: [] }), true);
  assert.equal(isProtectedTargetLayer({ manual: "人工", model: "x", postProcessed: "x", qaFlags: [] }), true);
  assert.equal(isProtectedTargetLayer({ model: "x", postProcessed: "x", qaFlags: [] }), false);
});

test("token reservation is conservative for multi-byte subtitle text", () => {
  const text = "字幕".repeat(1_000);
  const tokens = estimateTokensForBatch({
    segments: [{ segmentId: "s1", text }],
    contextSegments: [],
  });
  const sourceBytes = Buffer.byteLength(text, "utf8");

  assert.ok(tokens.inputTokens >= sourceBytes * 2);
  assert.ok(tokens.outputTokens >= sourceBytes);
  assert.equal(tokens.totalTokens, tokens.inputTokens + tokens.outputTokens);
});

test("output reservation includes structured response and segment id overhead", () => {
  const segments = Array.from({ length: 100 }, (_, index) => ({
    segmentId: `segment-${index.toString().padStart(3, "0")}`,
    text: "",
  }));
  const tokens = estimateTokensForBatch({ segments, contextSegments: [] });

  assert.ok(tokens.outputTokens >= 4096);
  assert.ok(tokens.outputTokens <= 8192);
});

test("run snapshot is immutable and empty resources fingerprint", () => {
  const snapshot = createRunSnapshotRecord({
    id: "run-1",
    projectId: "p1",
    sourceTrackId: "src",
    targetLanguageCode: "zh-CN",
    providerId: "openai",
    model: "GPT-4.1",
    baseUrlDisplay: "https://api.openai.com/v1",
    transportMode: "responses",
    segmentVersion: "v1",
  });
  assert.equal(snapshot.promptTemplateVersion, PROMPT_TEMPLATE_VERSION);
  assert.equal(snapshot.resourceSnapshot.glossary.empty, true);
  assert.throws(() => {
    snapshot.cacheHits = 9;
  });
});
