import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicClient } from "../../backend/provider/anthropic-client.mjs";
import { toSafeProviderError } from "../../backend/provider/errors.mjs";

const BASE_URL = "https://api.anthropic.com";
const API_KEY = "sk-ant-stub-key";
const SCHEMA = { name: "subtitle_translation_batch", schema: { type: "object" } };
const MESSAGES = [
  { role: "system", content: "You are a professional subtitle translator." },
  { role: "user", content: JSON.stringify({ targetLanguage: "zh-CN", segments: [{ segmentId: "s1", text: "hello" }] }) },
];

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function translateRequest(overrides = {}) {
  return {
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: "claude-test",
    schema: SCHEMA,
    messages: MESSAGES,
    temperature: 0.2,
    maxOutputTokens: 512,
    ...overrides,
  };
}

test("structured translation maps the Anthropic Messages contract onto the shared client shape", async () => {
  const payload = { targetLanguage: "zh-CN", segments: [{ segmentId: "s1", text: "你好" }] };
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(payload) }],
      usage: { input_tokens: 12, output_tokens: 7 },
    }));
  const client = createAnthropicClient({ fetchImpl });

  const result = await client.createStructuredTranslation(translateRequest());

  assert.deepEqual(JSON.parse(result.rawText), payload);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  assert.equal(result.baseUrlDisplay, "https://api.anthropic.com");
  assert.equal(result.transportMode, "messages");

  const [call] = calls;
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers["x-api-key"], API_KEY);
  assert.equal(call.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.init.headers.Authorization, undefined);
  // system 是顶层参数，messages 只留 user/assistant，且必须显式给 max_tokens。
  assert.match(call.body.system, /professional subtitle translator/);
  assert.match(call.body.system, /single JSON object/);
  assert.equal(call.body.messages.length, 1);
  assert.equal(call.body.messages[0].role, "user");
  assert.equal(typeof call.body.max_tokens, "number");
  assert.ok(call.body.max_tokens >= 1024);
  // 当前 Claude 模型拒绝采样参数，客户端不得下发 temperature。
  assert.equal("temperature" in call.body, false);
});

test("tool_use blocks and fenced JSON both yield the structured payload", async () => {
  const payload = { targetLanguage: "ja", segments: [{ segmentId: "s1", text: "こんにちは" }] };
  const responses = [
    jsonResponse({
      content: [{ type: "tool_use", id: "toolu_1", name: "subtitle_translation_batch", input: payload }],
      usage: { input_tokens: 3, output_tokens: 4 },
    }),
    jsonResponse({
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "```json\n" + JSON.stringify(payload) + "\n```" },
      ],
    }),
    jsonResponse({
      content: [{ type: "text", text: `Here you go: ${JSON.stringify(payload)} hope it helps.` }],
    }),
  ];
  const { fetchImpl } = stubFetch(() => responses.shift());
  const client = createAnthropicClient({ fetchImpl });

  for (let index = 0; index < 3; index += 1) {
    const result = await client.createStructuredTranslation(translateRequest());
    assert.deepEqual(JSON.parse(result.rawText), payload);
  }
});

test("connection test posts a minimal message and never leaks the credential", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }));
  const client = createAnthropicClient({ fetchImpl });

  const result = await client.testConnection({ baseUrl: `${BASE_URL}/v1`, apiKey: API_KEY, model: "claude-test" });

  assert.deepEqual(result, {
    ok: true,
    transportMode: "messages",
    baseUrlDisplay: "https://api.anthropic.com/v1",
    model: "claude-test",
  });
  // baseUrl 已经带 /v1 时不能拼成 /v1/v1/messages。
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].body.messages[0].role, "user");
  assert.equal(typeof calls[0].body.max_tokens, "number");
});

test("HTTP failures map onto the shared providerErrorClass vocabulary", async () => {
  const cases = [
    { status: 401, expected: "auth", retryable: false },
    { status: 403, expected: "auth", retryable: false },
    { status: 429, expected: "rate_limit", retryable: true },
    { status: 503, expected: "server", retryable: true },
    { status: 400, expected: "invalid_payload", retryable: false },
  ];
  for (const item of cases) {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ type: "error", error: { type: "authentication_error", message: `bad ${API_KEY}` } }, item.status));
    const client = createAnthropicClient({ fetchImpl });
    await assert.rejects(
      () => client.createStructuredTranslation(translateRequest()),
      (error) => {
        assert.equal(error.providerErrorClass, item.expected);
        assert.equal(error.httpStatus, item.status);
        assert.equal(error.retryable, item.retryable);
        // 供应商原文可能带凭据，错误消息只能用本地文案。
        assert.equal(error.message.includes(API_KEY), false);
        assert.equal(toSafeProviderError(error).message.includes(API_KEY), false);
        return true;
      },
    );
  }
});

test("missing credential and empty prompt fail before any request is sent", async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ content: [] }));
  const client = createAnthropicClient({ fetchImpl });

  await assert.rejects(
    () => client.createStructuredTranslation(translateRequest({ apiKey: "" })),
    (error) => error.providerErrorClass === "auth" && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () => client.createStructuredTranslation(translateRequest({ messages: [MESSAGES[0]] })),
    (error) => error.providerErrorClass === "invalid_payload" && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () => client.createStructuredTranslation(translateRequest({ baseUrl: "http://api.anthropic.com" })),
    (error) => error.providerErrorClass === "invalid_config",
  );
  assert.equal(calls.length, 0);
});

test("timeout and cancellation are classified without touching the network again", async () => {
  const abortable = () => (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });

  const timeoutClient = createAnthropicClient({ fetchImpl: abortable() });
  await assert.rejects(
    () => timeoutClient.createStructuredTranslation(translateRequest({ timeoutMs: 20 })),
    (error) => error.providerErrorClass === "timeout" && error.retryable === true,
  );

  const cancelClient = createAnthropicClient({ fetchImpl: abortable() });
  const controller = new AbortController();
  const pending = cancelClient.createStructuredTranslation(
    translateRequest({ timeoutMs: 5_000, signal: controller.signal }),
  );
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error.providerErrorClass === "cancelled" && error.code === "CANCELLED",
  );
});

test("responses that do not match the Messages contract are schema_mismatch", async () => {
  const bodies = [
    { id: "msg_stub", type: "message" },
    { content: "not-a-block-array" },
    { content: [{ type: "thinking", thinking: "internal only" }] },
  ];
  for (const body of bodies) {
    const { fetchImpl } = stubFetch(() => jsonResponse(body));
    const client = createAnthropicClient({ fetchImpl });
    await assert.rejects(
      () => client.createStructuredTranslation(translateRequest()),
      (error) => error.providerErrorClass === "schema_mismatch",
    );
  }
});

test("redirects and oversized payloads are refused", async () => {
  const redirectClient = createAnthropicClient({
    fetchImpl: async () => new Response(null, { status: 307, headers: { location: "https://evil.example/v1/messages" } }),
  });
  await assert.rejects(
    () => redirectClient.createStructuredTranslation(translateRequest()),
    (error) => error.providerErrorClass === "redirect_blocked",
  );

  const hugeClient = createAnthropicClient({
    maxResponseBytes: 128,
    fetchImpl: async () => jsonResponse({ content: [{ type: "text", text: "x".repeat(4096) }] }),
  });
  await assert.rejects(
    () => hugeClient.createStructuredTranslation(translateRequest()),
    (error) => error.providerErrorClass === "invalid_payload" && /体积上限/.test(error.message),
  );
});

test("transport failures fall back to the retryable network class", async () => {
  const client = createAnthropicClient({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () => client.createStructuredTranslation(translateRequest()),
    (error) => error.providerErrorClass === "network" && error.retryable === true,
  );
});
