import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { normalizeProviderBaseUrl } from "../../backend/provider/base-url.mjs";
import { toSafeProviderError } from "../../backend/provider/errors.mjs";
import { createOpenAICompatibleClient } from "../../backend/provider/openai-compatible-client.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("base URL rejects credentials and non-HTTPS remote endpoints", () => {
  assert.throws(() => normalizeProviderBaseUrl("https://user:pass@api.openai.com/v1"));
  assert.throws(() => normalizeProviderBaseUrl("http://api.openai.com/v1"));
  const loopback = normalizeProviderBaseUrl("http://127.0.0.1:9/v1", { allowLoopbackHttp: true });
  assert.equal(loopback.href.endsWith("/v1"), true);
});

test("connection success and classified provider errors via fake server", async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url === "/v1/responses" && req.headers["x-scenario"] === undefined) {
      // default path uses body model; we branch on query-less path + sequential
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const scenario = JSON.parse(body || "{}").__scenario || "success";
      if (scenario === "auth") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key sk-leaked" } }));
        return;
      }
      if (scenario === "rate") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate" } }));
        return;
      }
      if (scenario === "server") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "down" } }));
        return;
      }
      if (scenario === "invalid") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad request" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          output_text: JSON.stringify({ targetLanguage: "zh-CN", segments: [] }),
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
      );
    });
  });
  const base = await listen(server);
  const client = createOpenAICompatibleClient({ allowLoopbackHttp: true });
  try {
    const ok = await client.testConnection({
      baseUrl: `${base}/v1`,
      apiKey: "sk-test",
      transportMode: "responses",
      model: "gpt-test",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.transportMode, "responses");
    assert.match(ok.baseUrlDisplay, /127\.0\.0\.1/);

    for (const [scenario, expectedClass] of [
      ["auth", "auth"],
      ["rate", "rate_limit"],
      ["server", "server"],
      ["invalid", "invalid_payload"],
    ]) {
      await assert.rejects(
        () =>
          client.requestJson({
            baseUrl: `${base}/v1`,
            path: "/responses",
            apiKey: "sk-test",
            body: { __scenario: scenario },
            transportMode: "responses",
          }),
        (error) => error.providerErrorClass === expectedClass,
      );
    }

    const safe = toSafeProviderError({
      message: "failed with sk-leaked-value and Bearer tok123",
      providerErrorClass: "auth",
      httpStatus: 401,
    });
    assert.equal(safe.details.providerErrorClass, "auth");
    assert.equal(safe.message.includes("sk-leaked-value"), false);
    assert.equal(safe.message.includes("tok123"), false);
    assert.ok(hits.every((hit) => hit.auth === "Bearer sk-test"));
  } finally {
    await close(server);
  }
});

test("timeout and cancel classification", async () => {
  const server = http.createServer((_req, res) => {
    // hang until client aborts
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 5000);
  });
  const base = await listen(server);
  const client = createOpenAICompatibleClient({ allowLoopbackHttp: true });
  try {
    await assert.rejects(
      () =>
        client.requestJson({
          baseUrl: `${base}/v1`,
          path: "/responses",
          apiKey: "sk-test",
          body: {},
          timeoutMs: 50,
          transportMode: "responses",
        }),
      (error) => error.providerErrorClass === "timeout",
    );

    const controller = new AbortController();
    const pending = client.requestJson({
      baseUrl: `${base}/v1`,
      path: "/responses",
      apiKey: "sk-test",
      body: {},
      timeoutMs: 5000,
      signal: controller.signal,
      transportMode: "responses",
    });
    controller.abort();
    await assert.rejects(pending, (error) => error.providerErrorClass === "cancelled");
  } finally {
    await close(server);
  }
});

test("oversized provider response is rejected before buffering without a limit", async () => {
  const server = http.createServer((_req, res) => {
    const body = JSON.stringify({ data: "x".repeat(4096) });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  const base = await listen(server);
  const client = createOpenAICompatibleClient({
    allowLoopbackHttp: true,
    maxResponseBytes: 256,
  });
  try {
    await assert.rejects(
      () =>
        client.requestJson({
          baseUrl: `${base}/v1`,
          path: "/responses",
          apiKey: "sk-test",
          body: {},
        }),
      (error) =>
        error.providerErrorClass === "invalid_payload" && /size limit/i.test(error.message),
    );
  } finally {
    await close(server);
  }
});

test("DeepSeek official uses json_object while other compatible endpoints keep json_schema", async () => {
  const bodies = [];
  const client = createOpenAICompatibleClient({
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"targetLanguage":"zh-CN","segments":[]}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const request = {
    apiKey: "sk-test",
    transportMode: "chat_completions",
    model: "test-model",
    schema: { name: "translation", schema: { type: "object" } },
    messages: [{ role: "user", content: "Return JSON" }],
  };

  await client.createStructuredTranslation({ ...request, baseUrl: "https://api.deepseek.com" });
  await client.createStructuredTranslation({ ...request, baseUrl: "https://proxy.example/v1" });

  assert.deepEqual(bodies[0].response_format, { type: "json_object" });
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.match(bodies[0].messages[0].content, /targetLanguage.*segmentId/);
  assert.equal(bodies[1].response_format.type, "json_schema");
});
