import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openAppRepository } from "../../backend/persistence/app-repository.mjs";
import { createDesktopTranslationPort } from "../../backend/translation/desktop-translation-port.mjs";

/**
 * 「拉取模型」的结果必须能穿过整条持久化链路。
 *
 * 这条链路上曾经有三处断裂，任何一处都会让用户在项目里选不到拉取到的型号：
 *   1. 拉取结果压根没写库（只活在页面局部 state）
 *   2. 写了但读回时没映射成 configuredModels
 *   3. 保存 API Key 时整行删除，把刚拉到的列表一起抹掉
 */
function withRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), "model-list-"));
  const repo = openAppRepository(join(dir, "app.db"));
  try {
    run(repo);
  } finally {
    repo.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the first model pull persists before any connection test", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-list-first-pull-"));
  const repo = openAppRepository(join(dir, "app.db"));
  try {
    const port = createDesktopTranslationPort({
      openProjectRepository: () => {
        throw new Error("本用例不该打开项目库");
      },
      projectsDir: join(dir, "projects"),
      projectMigrationsDir: join(dir, "migrations"),
      revealSecret: () => "sk-test",
      workerClient: {
        async listModels() {
          return {
            baseUrlDisplay: "https://api.deepseek.com",
            models: [
              { id: "deepseek-v4-flash", label: "deepseek-v4-flash" },
              { id: "deepseek-chat", label: "deepseek-chat" },
            ],
          };
        },
      },
      loadProviderReadiness: (providerId) => repo.getProviderReadiness(providerId),
      saveProviderReadiness: (readiness) => repo.upsertProviderReadiness(readiness),
    });

    const result = await port.listProviderModels({ provider: "DeepSeek" });
    assert.equal(result.ok, true);
    const loaded = repo.getProviderReadiness("deepseek");
    assert.equal(loaded.status, "untested");
    assert.equal(loaded.testedAt, undefined);
    assert.match(loaded.modelsFetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(loaded.configuredModels, ["deepseek-v4-flash", "deepseek-chat"]);
  } finally {
    repo.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetched model list survives the persistence round trip", () => {
  withRepo((repo) => {
    repo.upsertProviderReadiness({
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "untested",
      credentialId: "deepseek-default",
      configuredModels: ["deepseek-v4-flash", "deepseek-v4", "deepseek-chat"],
      testedAt: "2026-07-26T00:00:00.000Z",
    });

    const loaded = repo.getProviderReadiness("deepseek");
    assert.deepEqual(loaded.configuredModels, ["deepseek-v4-flash", "deepseek-v4", "deepseek-chat"]);
  });
});

test("saving a new API key keeps the fetched models but drops the verified state", () => {
  withRepo((repo) => {
    repo.upsertProviderReadiness({
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "ready",
      credentialId: "deepseek-default",
      profileKey: "key-1",
      modelId: "deepseek-v4-flash",
      configuredModels: ["deepseek-v4-flash", "deepseek-v4"],
      testedAt: "2026-07-26T00:00:00.000Z",
    });

    // 换钥匙：连通性要重验，但服务商提供哪些型号跟钥匙无关
    repo.invalidateProviderReadiness("deepseek");

    const loaded = repo.getProviderReadiness("deepseek");
    assert.deepEqual(loaded.configuredModels, ["deepseek-v4-flash", "deepseek-v4"], "模型列表必须保留");
    assert.equal(loaded.status, "untested", "验证状态必须作废");
    assert.equal(loaded.profileKey, undefined, "旧的连接凭证不能留下");
  });
});

test("a real connection test must not wipe a previously fetched model list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-list-port-"));
  const repo = openAppRepository(join(dir, "app.db"));
  try {
    repo.upsertProviderReadiness({
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "untested",
      credentialId: "deepseek-default",
      configuredModels: ["deepseek-v4-flash", "deepseek-v4"],
      testedAt: "2026-07-26T00:00:00.000Z",
    });

    /*
     * 关键：这里必须走**真实端口**，不能自己复现它的逻辑。
     * 第一版这条测试是我手写「先读回旧记录再带着 configuredModels 一起写」，
     * 于是测试通过了，而真实的 testProviderConnection 根本没有那一步——
     * 测的是我的意图，不是代码。
     */
    const port = createDesktopTranslationPort({
      openProjectRepository: () => {
        throw new Error("本用例不该打开项目库");
      },
      projectsDir: join(dir, "projects"),
      projectMigrationsDir: join(dir, "migrations"),
      revealSecret: () => "sk-test",
      workerClient: {
        async testConnection({ baseUrl, model, transportMode }) {
          return { ok: true, baseUrlDisplay: baseUrl, model, transportMode };
        },
      },
      loadProviderReadiness: (providerId) => repo.getProviderReadiness(providerId),
      saveProviderReadiness: (readiness) => repo.upsertProviderReadiness(readiness),
    });

    const tested = await port.testProviderConnection({ provider: "DeepSeek", model: "deepseek-chat" });
    assert.equal(tested.ok, true);

    const loaded = repo.getProviderReadiness("deepseek");
    assert.equal(loaded.status, "ready");
    assert.deepEqual(
      loaded.configuredModels,
      ["deepseek-v4-flash", "deepseek-v4"],
      "测一次连接不该把拉取到的型号列表替换成刚测的那一个",
    );
  } finally {
    repo.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting the credential removes the whole record", () => {
  withRepo((repo) => {
    repo.upsertProviderReadiness({
      providerId: "deepseek",
      providerName: "DeepSeek",
      status: "ready",
      credentialId: "deepseek-default",
      configuredModels: ["deepseek-v4"],
      testedAt: "2026-07-26T00:00:00.000Z",
    });
    repo.clearProviderReadiness("deepseek");
    assert.equal(repo.getProviderReadiness("deepseek"), null);
  });
});
