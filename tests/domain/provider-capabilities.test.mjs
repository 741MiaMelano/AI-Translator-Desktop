import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TRANSLATION_SELECTION,
  buildTranslationCapabilityCatalog,
  getTranslationModelOptions,
  getTranslationProviderModelAllowlist,
  listSelectableTranslationProviders,
  reconcileTranslationSelection,
  resolveMostRecentSuccessfulTranslationSelection,
  TRANSLATION_PROVIDER_OPTIONS,
  TRANSLATION_PROVIDER_REGISTRY,
} from "../../src/domain/workspace.ts";
import { IPC_PROJECT_VALUES } from "../../electron/ipc/validate.mjs";
import {
  TRANSLATION_PROVIDER_RUNTIME,
  resolveTranslationModelId,
} from "../../backend/translation/provider-lookup.mjs";

const EXPECTED_PROVIDER_NAMES = [
  "OpenAI",
  "Anthropic",
  "Gemini",
  "DeepSeek",
  "智谱 GLM",
  "Kimi",
  "Grok",
  "OpenAI Compatible",
  "DeepL",
];

test("translation registry lists every supported provider in a stable order", () => {
  assert.deepEqual(
    TRANSLATION_PROVIDER_REGISTRY.map((provider) => provider.name),
    EXPECTED_PROVIDER_NAMES,
  );
  assert.deepEqual(TRANSLATION_PROVIDER_OPTIONS, EXPECTED_PROVIDER_NAMES);
  // OpenAI 必须排第一：DEFAULT_TRANSLATION_SELECTION 与 OPENAI_COMPATIBLE_DEFAULT_PARAMETERS 都取 [0]。
  assert.equal(TRANSLATION_PROVIDER_REGISTRY[0].name, "OpenAI");
});

test("provider ids and credential ids are unique and filesystem-safe", () => {
  const ids = TRANSLATION_PROVIDER_REGISTRY.map((provider) => provider.id);
  const credentialIds = TRANSLATION_PROVIDER_REGISTRY.map((provider) => provider.credentialId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(credentialIds).size, credentialIds.length);
  for (const credentialId of credentialIds) {
    assert.match(credentialId, /^[A-Za-z0-9._-]+$/);
  }
});

test("preset compatible providers ship a fixed base URL and chat_completions transport", () => {
  const presets = TRANSLATION_PROVIDER_REGISTRY.filter(
    (provider) => provider.profile === "openai_compatible_preset",
  );
  assert.deepEqual(presets.map((provider) => provider.id), [
    "gemini",
    "deepseek",
    "zhipu-glm",
    "kimi",
    "grok",
  ]);
  for (const provider of presets) {
    assert.match(provider.defaultBaseUrl, /^https:\/\//);
    assert.equal(provider.defaultTransport, "chat_completions");
    assert.deepEqual([...provider.supportedTransports], ["chat_completions"]);
    assert.equal(provider.v1TranslationEnabled, true);
    assert.ok(provider.models.length > 0);
  }
});

test("Anthropic uses its own messages transport", () => {
  const anthropic = TRANSLATION_PROVIDER_REGISTRY.find((provider) => provider.id === "anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic.profile, "anthropic_messages");
  assert.equal(anthropic.defaultBaseUrl, "https://api.anthropic.com");
  assert.equal(anthropic.defaultTransport, "messages");
  assert.deepEqual([...anthropic.supportedTransports], ["messages"]);
  assert.equal(anthropic.v1TranslationEnabled, true);
});

test("fetched models outside the built-in list resolve for preset and anthropic profiles", () => {
  for (const providerId of ["deepseek", "zhipu-glm", "kimi", "grok", "gemini", "anthropic", "openai-compatible"]) {
    const provider = TRANSLATION_PROVIDER_RUNTIME.find((candidate) => candidate.id === providerId);
    assert.equal(
      resolveTranslationModelId(provider, "some-newly-published-model"),
      "some-newly-published-model",
      providerId,
    );
  }
});

test("free-form model ids stay bounded for every fetch-capable provider", () => {
  const anthropic = TRANSLATION_PROVIDER_RUNTIME.find((provider) => provider.id === "anthropic");
  const openai = TRANSLATION_PROVIDER_RUNTIME.find((provider) => provider.id === "openai");

  // 边界必须守住：换行、路径穿越、超长一律拒绝。
  for (const provider of [anthropic, openai]) {
    assert.throws(() => resolveTranslationModelId(provider, "bad model\nid"), /not available/i);
    assert.throws(() => resolveTranslationModelId(provider, "../../etc/passwd"), /not available/i);
    assert.throws(() => resolveTranslationModelId(provider, "x".repeat(201)), /not available/i);
    // 200 字符是「拉取模型」侧的上限，必须仍然可用。
    assert.equal(resolveTranslationModelId(provider, "x".repeat(200)), "x".repeat(200));
  }

  // OpenAI 官方从封闭 allowlist 改为自由模型 ID。
  // 原因：界面提供了「拉取模型」，如果拉到的型号不能被选中保存，
  // 用户会遇到「列表里有、选了存不进去」。安全边界由 isSafeProviderModelId 独立把关。
  assert.equal(resolveTranslationModelId(openai, "gpt-9000-unreleased"), "gpt-9000-unreleased");
  // 内置友好 label → 真实 id 的映射优先级必须高于自由放行。
  assert.equal(resolveTranslationModelId(openai, "GPT-4.1 mini"), "gpt-4.1-mini");
});

test("OpenAI models stay ordered GPT-4.1, GPT-4.1 mini, GPT-4o", () => {
  assert.deepEqual(getTranslationModelOptions("OpenAI"), [
    "GPT-4.1",
    "GPT-4.1 mini",
    "GPT-4o",
  ]);
});

test("runtime provider models separate display labels from API ids", () => {
  const openai = TRANSLATION_PROVIDER_RUNTIME.find((provider) => provider.id === "openai");
  assert.deepEqual(openai.models, [
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { id: "gpt-4o", label: "GPT-4o" },
  ]);
  assert.equal(resolveTranslationModelId(openai, "GPT-4.1 mini"), "gpt-4.1-mini");
});

test("custom OpenAI-compatible provider is selectable with its own model slot", () => {
  assert.deepEqual(getTranslationModelOptions("OpenAI Compatible"), ["custom-model"]);
  assert.equal(
    listSelectableTranslationProviders().some((provider) => provider.id === "openai-compatible"),
    true,
  );
});

test("DeepL remains registered but is not V1-translation-enabled", () => {
  const deepl = TRANSLATION_PROVIDER_REGISTRY.find((provider) => provider.id === "deepl");
  assert.ok(deepl);
  assert.equal(deepl.v1TranslationEnabled, false);
  assert.match(deepl.unavailableReason ?? "", /尚未接入/);
  assert.deepEqual(getTranslationModelOptions("DeepL"), ["DeepL Pro"]);
  assert.equal(
    listSelectableTranslationProviders().some((provider) => provider.id === "deepl"),
    false,
  );
});

test("OpenAI model options never include DeepL Pro", () => {
  assert.equal(getTranslationModelOptions("OpenAI").includes("DeepL Pro"), false);
});

test("DeepL model options never include GPT models", () => {
  const models = getTranslationModelOptions("DeepL");
  assert.equal(models.some((model) => model.startsWith("GPT")), false);
});

test("switching OpenAI/GPT-4.1 to DeepL reconciles to DeepL/DeepL Pro", () => {
  const next = reconcileTranslationSelection(
    { provider: "OpenAI", model: "GPT-4.1" },
    { provider: "DeepL" },
  );
  assert.deepEqual(next, { provider: "DeepL", model: "DeepL Pro" });
});

test("switching DeepL/DeepL Pro to OpenAI reconciles to OpenAI/GPT-4.1", () => {
  const next = reconcileTranslationSelection(
    { provider: "DeepL", model: "DeepL Pro" },
    { provider: "OpenAI" },
  );
  assert.deepEqual(next, { provider: "OpenAI", model: "GPT-4.1" });
});

test("same-provider legal model switch succeeds", () => {
  const next = reconcileTranslationSelection(
    { provider: "OpenAI", model: "GPT-4.1" },
    { model: "GPT-4o" },
  );
  assert.deepEqual(next, { provider: "OpenAI", model: "GPT-4o" });
});

/**
 * 「拉取模型」取回的真实型号 ID 不在注册表兜底列表里。
 * 曾经的白名单校验会对它 throw——而调用方在 setState 的 updater 里，
 * 未捕获的异常会把整棵 React 树卸载成白屏（用户报告的「切换模型直接卡死」）。
 * 注册表契约（shared/provider-registry.mjs）：兜底列表不是能力清单，
 * 凡是拉取能列出来的 ID 都必须能被选中。
 */
test("fetched model id outside the registry fallback list is accepted", () => {
  const next = reconcileTranslationSelection(
    { provider: "DeepSeek", model: "deepseek-chat" },
    { model: "deepseek-v4-flash" },
  );
  assert.deepEqual(next, { provider: "DeepSeek", model: "deepseek-v4-flash" });
});

test("OpenAI raw model id (not the display label) is accepted", () => {
  const next = reconcileTranslationSelection(
    { provider: "OpenAI", model: "GPT-4.1" },
    { model: "gpt-4o-mini" },
  );
  assert.deepEqual(next, { provider: "OpenAI", model: "gpt-4o-mini" });
});

test("free-form model ids still reject unsafe values", () => {
  for (const model of ["bad\nmodel", "../escape", "a".repeat(201), " leading-space"]) {
    assert.throws(
      () =>
        reconcileTranslationSelection(
          { provider: "DeepSeek", model: "deepseek-chat" },
          { model },
        ),
      /Invalid translation selection/,
    );
  }
});

test("DeepL never accepts free-form model ids", () => {
  assert.throws(
    () =>
      reconcileTranslationSelection(
        { provider: "DeepL", model: "DeepL Pro" },
        { model: "deepl-custom" },
      ),
    /Invalid translation selection: DeepL \/ deepl-custom/,
  );
});

test("explicit DeepL/GPT-4.1 combination fails", () => {
  assert.throws(
    () =>
      reconcileTranslationSelection(
        { provider: "DeepL", model: "DeepL Pro" },
        { model: "GPT-4.1" },
      ),
    /Invalid translation selection: DeepL \/ GPT-4.1/,
  );
});

test("unknown provider fails", () => {
  assert.throws(
    () =>
      reconcileTranslationSelection(
        { provider: "OpenAI", model: "GPT-4.1" },
        { provider: "Nonexistent Vendor" },
      ),
    /Unsupported translation provider: Nonexistent Vendor/,
  );
});

test("empty provider or model fails", () => {
  assert.throws(
    () =>
      reconcileTranslationSelection(
        { provider: "OpenAI", model: "GPT-4.1" },
        { provider: "" },
      ),
    /还没有选择翻译服务商和模型|Translation provider and model are required/,
  );
  assert.throws(
    () =>
      reconcileTranslationSelection(
        { provider: "OpenAI", model: "GPT-4.1" },
        { model: "" },
      ),
    /还没有选择翻译服务商和模型|Translation provider and model are required/,
  );
});

test("does not mutate current or patch inputs", () => {
  const current = { provider: "OpenAI", model: "GPT-4.1" };
  const patch = { provider: "DeepL" };
  const currentBefore = structuredClone(current);
  const patchBefore = structuredClone(patch);

  reconcileTranslationSelection(current, patch);

  assert.deepEqual(current, currentBefore);
  assert.deepEqual(patch, patchBefore);
});

test("default selection is first provider first model", () => {
  assert.deepEqual(DEFAULT_TRANSLATION_SELECTION, {
    provider: "OpenAI",
    model: "GPT-4.1",
  });
});

test("the most recent successful connection becomes the new-project translation default", () => {
  const selection = resolveMostRecentSuccessfulTranslationSelection({
    openai: {
      credentialConfigured: true,
      connectionStatus: "ok",
      requestedModel: "GPT-4o",
      testedAt: "2026-07-28T08:00:00.000Z",
    },
    deepseek: {
      credentialConfigured: true,
      connectionStatus: "ok",
      requestedModel: "deepseek-v4-flash",
      testedAt: "2026-07-29T08:00:00.000Z",
    },
    gemini: {
      credentialConfigured: true,
      connectionStatus: "untested",
      requestedModel: "gemini-newer-but-not-tested",
      testedAt: "2026-07-30T08:00:00.000Z",
    },
  });

  assert.deepEqual(selection, {
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
  });
});

test("runtime capability catalog is the single SSOT for status models and reasons", () => {
  const catalog = buildTranslationCapabilityCatalog({
    openai: {
      credentialConfigured: true,
      connectionStatus: "ok",
      transportMode: "responses",
      baseUrlDisplay: "https://api.openai.com/v1",
    },
    "openai-compatible": {
      credentialConfigured: false,
      connectionStatus: "untested",
      configuredModels: ["my-proxy-model"],
      baseUrlDisplay: "https://proxy.example/v1",
    },
    deepseek: {
      credentialConfigured: true,
      connectionStatus: "untested",
      configuredModels: ["deepseek-v4-flash"],
    },
  });

  const openai = catalog.find((item) => item.id === "openai");
  const custom = catalog.find((item) => item.id === "openai-compatible");
  const deepseek = catalog.find((item) => item.id === "deepseek");
  const deepl = catalog.find((item) => item.id === "deepl");

  assert.equal(openai?.status, "ready");
  assert.equal(openai?.profile, "openai_official");
  assert.equal(openai?.transportMode, "responses");
  assert.deepEqual(openai?.supportedParameters, [
    "temperature",
    "top_p",
    "max_output_tokens",
  ]);

  assert.equal(custom?.status, "offline");
  assert.deepEqual(custom?.models, ["my-proxy-model"]);
  assert.equal(custom?.credentialConfigured, false);

  assert.equal(deepseek?.status, "ready");
  assert.deepEqual(deepseek?.models, ["deepseek-v4-flash"]);
  assert.match(deepseek?.summary ?? "", /首次使用/);

  assert.equal(deepl?.status, "unavailable");
  assert.match(deepl?.unavailableReason ?? "", /尚未接入/);
  assert.match(deepl?.summary ?? "", /尚未接入/);
});

test("IPC allowlist is derived from the same registry SSOT", () => {
  assert.deepEqual(getTranslationProviderModelAllowlist(), IPC_PROJECT_VALUES.providerModels);
});
