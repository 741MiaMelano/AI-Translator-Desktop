import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import { createDesktopTranslationPort } from "../../backend/translation/desktop-translation-port.mjs";
import { getTranslationProviderByName } from "../../backend/translation/provider-lookup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = join(root, "migrations", "project");
const SECRET = "sk-stub-never-leaves-main";

/** Stub worker: records what main would ship to the execution process. */
function stubWorker(listModels) {
  const calls = [];
  return {
    calls,
    async testConnection() {
      return { ok: true };
    },
    async translateLanguage() {
      throw new Error("not used");
    },
    async listModels(request) {
      calls.push(request);
      return listModels(request);
    },
  };
}

function createPort({ workerClient, revealSecret = () => SECRET, allowLoopbackHttp = false }) {
  const containerRoot = mkdtempSync(join(tmpdir(), "provider-models-"));
  const port = createDesktopTranslationPort({
    openProjectRepository,
    projectsDir: join(containerRoot, "projects"),
    projectMigrationsDir: migrationsDir,
    revealSecret,
    workerClient,
    allowLoopbackHttp,
  });
  return { port, cleanup: () => rmSync(containerRoot, { recursive: true, force: true }) };
}

test("listProviderModels returns the catalog and keeps the secret in main", async () => {
  const worker = stubWorker(() => ({
    models: [
      { id: "gpt-4.1", label: "gpt-4.1" },
      { id: "gpt-4.1-mini", label: "gpt-4.1-mini" },
    ],
    truncated: false,
    baseUrlDisplay: "https://api.openai.com/v1",
  }));
  const { port, cleanup } = createPort({ workerClient: worker });
  try {
    const result = await port.listProviderModels({ provider: "OpenAI" });

    assert.equal(result.ok, true);
    assert.equal(result.data.providerId, "openai");
    assert.equal(result.data.providerName, "OpenAI");
    assert.equal(result.data.baseUrlDisplay, "https://api.openai.com/v1");
    assert.equal(result.data.truncated, false);
    assert.deepEqual(result.data.models, [
      { id: "gpt-4.1", label: "gpt-4.1" },
      { id: "gpt-4.1-mini", label: "gpt-4.1-mini" },
    ]);

    assert.equal(worker.calls.length, 1);
    assert.equal(worker.calls[0].style, "bearer");
    assert.equal(worker.calls[0].apiKey, SECRET);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  } finally {
    cleanup();
  }
});

test("a caller-supplied base URL is honored and validated before the secret is read", async () => {
  const worker = stubWorker(({ baseUrl }) => ({
    models: [{ id: "custom-model", label: "custom-model" }],
    truncated: false,
    baseUrlDisplay: baseUrl,
  }));
  let revealed = 0;
  const { port, cleanup } = createPort({
    workerClient: worker,
    revealSecret: () => {
      revealed += 1;
      return SECRET;
    },
  });
  try {
    const ok = await port.listProviderModels({
      provider: "OpenAI Compatible",
      baseUrl: "https://proxy.example.com/v1",
    });
    assert.equal(ok.ok, true);
    assert.equal(worker.calls[0].baseUrl, "https://proxy.example.com/v1");
    assert.equal(revealed, 1);

    const rejected = await port.listProviderModels({
      provider: "OpenAI Compatible",
      baseUrl: "http://proxy.example.com/v1",
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "INVALID_INPUT");
    assert.equal(rejected.error.details.providerErrorClass, "invalid_config");
    assert.equal(rejected.error.message, "服务地址必须使用 HTTPS");
    assert.equal(worker.calls.length, 1, "an invalid base URL must not reach the worker");
    assert.equal(revealed, 1, "an invalid base URL must not decrypt the credential");
  } finally {
    cleanup();
  }
});

test("a missing credential reports a saveable-key message without touching the worker", async () => {
  const worker = stubWorker(() => ({ models: [], truncated: false }));
  const { port, cleanup } = createPort({
    workerClient: worker,
    revealSecret: () => {
      const error = new Error("Credential not found");
      error.code = "NOT_FOUND";
      throw error;
    },
  });
  try {
    const result = await port.listProviderModels({ provider: "OpenAI" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_INPUT");
    assert.equal(result.error.details.providerErrorClass, "auth");
    assert.equal(result.error.message, "尚未保存该服务商的 API 密钥");
    assert.equal(worker.calls.length, 0);
  } finally {
    cleanup();
  }
});

test("provider auth failures relayed from the worker surface localized copy", async () => {
  const worker = stubWorker(() => {
    // The worker strips messages for INTERNAL codes; only the class survives.
    const error = new Error("Task operation failed");
    error.providerErrorClass = "auth";
    error.httpStatus = 401;
    throw error;
  });
  const { port, cleanup } = createPort({ workerClient: worker });
  try {
    const result = await port.listProviderModels({ provider: "OpenAI" });
    assert.equal(result.ok, false);
    assert.equal(result.error.details.providerErrorClass, "auth");
    assert.equal(result.error.details.httpStatus, 401);
    assert.equal(result.error.message, "鉴权失败，请检查 API 密钥是否正确");
  } finally {
    cleanup();
  }
});

test("unknown providers and execution clients without listing support are refused", async () => {
  const worker = stubWorker(() => ({ models: [], truncated: false }));
  const { port, cleanup } = createPort({ workerClient: worker });
  try {
    const unknown = await port.listProviderModels({ provider: "Nope" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "INVALID_INPUT");
    assert.equal(unknown.error.details.providerErrorClass, "invalid_config");
    assert.equal(unknown.error.message, "该服务商当前不可用");
    assert.equal(worker.calls.length, 0);
  } finally {
    cleanup();
  }

  const legacy = createPort({
    workerClient: { async testConnection() { return { ok: true }; }, async translateLanguage() {} },
  });
  try {
    const unsupported = await legacy.port.listProviderModels({ provider: "OpenAI" });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error.code, "INTERNAL");
    assert.equal(unsupported.error.message, "模型列表服务不可用");
  } finally {
    legacy.cleanup();
  }
});

test("registry-driven style selection reaches the execution client", async () => {
  // Guarded so the assertion activates as soon as an Anthropic entry is registered.
  const anthropic = getTranslationProviderByName("Anthropic");
  if (!anthropic?.v1TranslationEnabled) return;

  const worker = stubWorker(() => ({ models: [{ id: "claude", label: "Claude" }], truncated: false }));
  const { port, cleanup } = createPort({ workerClient: worker });
  try {
    const result = await port.listProviderModels({ provider: "Anthropic" });
    assert.equal(result.ok, true);
    assert.equal(worker.calls[0].style, "anthropic");
  } finally {
    cleanup();
  }
});
