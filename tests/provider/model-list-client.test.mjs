import assert from "node:assert/strict";
import test from "node:test";
import { toSafeProviderError } from "../../backend/provider/errors.mjs";
import {
  createProviderModelsClient,
  describeModelListError,
  normalizeModelListBaseUrl,
  resolveModelListStyle,
} from "../../backend/provider/model-list-client.mjs";

const API_KEY = "sk-local-stub-key";

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Records every request so header/URL assertions never need a real network call. */
function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, headers: init.headers });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

test("registry profiles map to a model-list style", () => {
  assert.equal(resolveModelListStyle({ profile: "openai_official" }), "bearer");
  assert.equal(resolveModelListStyle({ profile: "openai_compatible_custom" }), "bearer");
  assert.equal(resolveModelListStyle({ profile: "deepseek" }), "bearer");
  assert.equal(resolveModelListStyle({ profile: "anthropic" }), "anthropic");
  assert.equal(resolveModelListStyle({ profile: "anthropic_official" }), "anthropic");
  assert.equal(resolveModelListStyle({ profile: "deepl" }), null);
  assert.equal(resolveModelListStyle({ profile: "glm", modelListStyle: null }), null);
  assert.equal(resolveModelListStyle({ profile: "kimi", modelListStyle: "bearer" }), "bearer");
});

test("OpenAI-compatible listing calls GET /models with a bearer token", async () => {
  const { calls, fetchImpl } = recordingFetch(() =>
    jsonResponse({
      object: "list",
      data: [
        { id: "gpt-4.1", object: "model" },
        { id: "gpt-4.1-mini", object: "model" },
        { id: "gpt-4.1", object: "model" },
        { object: "model" },
      ],
    }),
  );
  const client = createProviderModelsClient({ fetchImpl });

  const result = await client.listModels({
    baseUrl: "https://api.example.com/v1",
    apiKey: API_KEY,
    style: "bearer",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].headers["x-api-key"], undefined);
  assert.deepEqual(result.models, [
    { id: "gpt-4.1", label: "gpt-4.1" },
    { id: "gpt-4.1-mini", label: "gpt-4.1-mini" },
  ]);
  assert.equal(result.truncated, false);
  assert.equal(result.baseUrlDisplay, "https://api.example.com/v1");
});

test("Anthropic listing calls GET /v1/models with x-api-key and a version header", async () => {
  const { calls, fetchImpl } = recordingFetch(() =>
    jsonResponse({
      data: [
        { id: "claude-opus-4", display_name: "Claude Opus 4", type: "model" },
        { id: "claude-haiku-4", type: "model" },
      ],
      has_more: true,
    }),
  );
  const client = createProviderModelsClient({ fetchImpl });

  const result = await client.listModels({
    baseUrl: "https://api.anthropic.com",
    apiKey: API_KEY,
    style: "anthropic",
  });

  assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models\?limit=\d+$/);
  assert.equal(calls[0].headers["x-api-key"], API_KEY);
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(result.models, [
    { id: "claude-opus-4", label: "Claude Opus 4" },
    { id: "claude-haiku-4", label: "claude-haiku-4" },
  ]);
  assert.equal(result.truncated, true);
});

test("Anthropic base URL that already carries /v1 is not versioned twice", async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: [] }));
  const client = createProviderModelsClient({ fetchImpl });

  const result = await client.listModels({
    baseUrl: "https://proxy.example.com/anthropic/v1",
    apiKey: API_KEY,
    style: "anthropic",
  });

  assert.match(calls[0].url, /^https:\/\/proxy\.example\.com\/anthropic\/v1\/models\?limit=\d+$/);
  assert.deepEqual(result.models, []);
});

test("missing credential fails before any request leaves the process", async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: [] }));
  const client = createProviderModelsClient({ fetchImpl });

  for (const apiKey of [undefined, "", null]) {
    await assert.rejects(
      () => client.listModels({ baseUrl: "https://api.example.com/v1", apiKey, style: "bearer" }),
      (error) =>
        error.providerErrorClass === "auth" &&
        error.code === "INVALID_INPUT" &&
        /密钥/.test(error.message),
    );
  }
  assert.equal(calls.length, 0);
});

test("HTTP failures are classified and never echo the credential", async () => {
  const cases = [
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [503, "server"],
    [400, "invalid_payload"],
  ];
  for (const [status, expectedClass] of cases) {
    const client = createProviderModelsClient({
      fetchImpl: async () =>
        jsonResponse({ error: { message: `rejected ${API_KEY}` } }, { status }),
    });
    await assert.rejects(
      () =>
        client.listModels({
          baseUrl: "https://api.example.com/v1",
          apiKey: API_KEY,
          style: "bearer",
        }),
      (error) => {
        assert.equal(error.providerErrorClass, expectedClass, `status ${status}`);
        assert.equal(error.httpStatus, status);
        assert.equal(error.message.includes(API_KEY), false);
        assert.equal(toSafeProviderError(error).message.includes(API_KEY), false);
        return true;
      },
    );
  }
});

test("invalid base URLs are rejected by the shared validator with localized copy", async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ data: [] }));
  const client = createProviderModelsClient({ fetchImpl });

  const cases = [
    ["", "请先填写服务地址"],
    ["   ", "请先填写服务地址"],
    ["not-a-url", "服务地址格式无效"],
    ["http://api.example.com/v1", "服务地址必须使用 HTTPS"],
    ["https://user:pass@api.example.com/v1", "服务地址不能包含账号或密码"],
    ["ftp://api.example.com/v1", "服务地址使用了不被允许的协议"],
    ["file:///c:/secrets", "服务地址使用了不被允许的协议"],
  ];
  for (const [baseUrl, expectedMessage] of cases) {
    await assert.rejects(
      () => client.listModels({ baseUrl, apiKey: API_KEY, style: "bearer" }),
      (error) => {
        assert.equal(error.providerErrorClass, "invalid_config", baseUrl);
        assert.equal(error.code, "INVALID_INPUT", baseUrl);
        assert.equal(error.message, expectedMessage, baseUrl);
        return true;
      },
    );
  }
  assert.equal(calls.length, 0, "an invalid base URL must never be fetched");

  const loopback = normalizeModelListBaseUrl("http://127.0.0.1:1/v1", { allowLoopbackHttp: true });
  assert.equal(loopback.href, "http://127.0.0.1:1/v1");
});

test("unsupported style, redirects, and unparsable payloads are classified", async () => {
  const client = createProviderModelsClient({ fetchImpl: async () => jsonResponse({ data: [] }) });
  await assert.rejects(
    () =>
      client.listModels({ baseUrl: "https://api.example.com/v1", apiKey: API_KEY, style: "deepl" }),
    (error) => error.providerErrorClass === "invalid_config" && error.code === "INVALID_INPUT",
  );

  const redirecting = createProviderModelsClient({
    fetchImpl: async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example.com/models" } }),
  });
  await assert.rejects(
    () =>
      redirecting.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
      }),
    (error) => error.providerErrorClass === "redirect_blocked" && error.httpStatus === 302,
  );

  const rejectingRedirect = createProviderModelsClient({
    fetchImpl: async () => {
      throw new TypeError("fetch failed: unexpected redirect");
    },
  });
  await assert.rejects(
    () =>
      rejectingRedirect.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
      }),
    (error) => error.providerErrorClass === "redirect_blocked",
  );

  const nonJson = createProviderModelsClient({
    fetchImpl: async () => new Response("<html>nope</html>", { status: 200 }),
  });
  await assert.rejects(
    () =>
      nonJson.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
      }),
    (error) => error.providerErrorClass === "invalid_payload",
  );

  const shapeless = createProviderModelsClient({
    fetchImpl: async () => jsonResponse({ result: "ok" }),
  });
  await assert.rejects(
    () =>
      shapeless.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
      }),
    (error) => error.providerErrorClass === "invalid_payload",
  );

  const offline = createProviderModelsClient({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () =>
      offline.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
      }),
    (error) => error.providerErrorClass === "network" && error.retryable === true,
  );
});

test("oversized listings and huge catalogs stay bounded", async () => {
  const body = JSON.stringify({ data: Array.from({ length: 200 }, (_, i) => ({ id: `m-${i}` })) });
  const capped = createProviderModelsClient({
    maxResponseBytes: 128,
    fetchImpl: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(body.length) },
      }),
  });
  await assert.rejects(
    () =>
      capped.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
      }),
    (error) => error.providerErrorClass === "invalid_payload" && /大小上限/.test(error.message),
  );

  const streamed = createProviderModelsClient({
    maxResponseBytes: 128,
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  await assert.rejects(
    () =>
      streamed.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
      }),
    (error) => error.providerErrorClass === "invalid_payload",
  );

  const limited = createProviderModelsClient({
    maxModels: 3,
    fetchImpl: async () => jsonResponse(JSON.parse(body)),
  });
  const result = await limited.listModels({
    baseUrl: "https://api.example.com/v1",
    apiKey: API_KEY,
    style: "bearer",
  });
  assert.equal(result.models.length, 3);
  assert.equal(result.truncated, true);
});

test("timeout and caller cancellation are distinguishable", async () => {
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  const client = createProviderModelsClient({ fetchImpl: hangingFetch });

  await assert.rejects(
    () =>
      client.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
        timeoutMs: 20,
      }),
    (error) => error.providerErrorClass === "timeout" && error.retryable === true,
  );

  const controller = new AbortController();
  const pending = client.listModels({
    baseUrl: "https://api.example.com/v1",
    apiKey: API_KEY,
    style: "bearer",
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error.providerErrorClass === "cancelled" && error.code === "CANCELLED",
  );

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    () =>
      client.listModels({
        baseUrl: "https://api.example.com/v1",
        apiKey: API_KEY,
        style: "bearer",
        signal: preAborted.signal,
      }),
    (error) => error.providerErrorClass === "cancelled",
  );
});

test("worker-relayed errors are relabelled in Simplified Chinese", () => {
  assert.equal(describeModelListError("auth", "Task operation failed"), "鉴权失败，请检查 API 密钥是否正确");
  assert.equal(describeModelListError("rate_limit", "Task operation failed"), "服务商限流，请稍后重试");
  assert.equal(describeModelListError("unknown", undefined), "获取模型列表失败");
  assert.equal(describeModelListError("not-a-class", "Task operation failed"), "获取模型列表失败");
  assert.equal(describeModelListError("invalid_config", "服务地址必须使用 HTTPS"), "服务地址必须使用 HTTPS");
});
