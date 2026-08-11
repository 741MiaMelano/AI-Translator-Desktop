import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMemorySafeStorage,
  createUnavailableSafeStorage,
  openCredentialStore,
} from "../../backend/credentials/credential-store.mjs";
import { readFileSync as readSource } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("DesktopApi contract exposes save/status/delete without a secret getter", () => {
  const contract = readSource(join(root, "src/contracts/desktop-api.ts"), "utf8");
  assert.match(contract, /saveCredential/, "credential save surface expected");
  assert.match(contract, /getCredentialStatus/, "credential status surface expected");
  assert.match(contract, /deleteCredential/, "credential delete surface expected");
  const desktopApiBlock = contract.slice(contract.indexOf("export interface DesktopApi"), contract.indexOf("export const DESKTOP_API_CHANNEL"));
  assert.doesNotMatch(
    desktopApiBlock,
    /\b(getSecret|revealSecret|readCredential)\b/,
    "renderer DesktopApi must not expose a secret getter",
  );
  const preload = readSource(join(root, "electron/preload.ts"), "utf8");
  assert.match(preload, /credential\.save/);
  assert.doesNotMatch(preload, /\b(revealSecret|getSecret)\b/);
});

test("fail closed when safeStorage is unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-unavail-"));
  try {
    assert.throws(
      () => openCredentialStore({ rootDir: dir, safeStorage: createUnavailableSafeStorage() }),
      (error) => error?.code === "CREDENTIAL_STORE_UNAVAILABLE",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save replace delete status without plaintext in store or public status", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-crud-"));
  const secret = "sk-test-phase4-secret-value-NOT-FOR-PRODUCTION";
  const store = openCredentialStore({
    rootDir: dir,
    safeStorage: createMemorySafeStorage(),
  });
  try {
    const saved = store.saveCredential({
      credentialId: "openai-default",
      secret,
      providerId: "openai",
      label: "OpenAI official",
    });
    assert.equal(saved.configured, true);
    assert.equal(saved.credentialId, "openai-default");
    assert.equal(saved.providerId, "openai");
    assert.ok(saved.updatedAt);
    assert.equal("secret" in saved, false);
    assert.equal(JSON.stringify(saved).includes(secret), false);

    const status = store.getStatus({ credentialId: "openai-default" });
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes(secret), false);

    const list = store.getStatus();
    assert.equal(list.credentials.length, 1);
    assert.equal(JSON.stringify(list).includes(secret), false);

    // Ciphertext and index must not contain plaintext secret.
    assert.deepEqual(store.scanForPlaintext(secret), []);

    const replaced = store.saveCredential({
      credentialId: "openai-default",
      secret: "sk-replaced-secret-value",
      providerId: "openai",
      label: "OpenAI official",
    });
    assert.equal(replaced.configured, true);
    assert.equal(store.revealSecret({ credentialId: "openai-default" }), "sk-replaced-secret-value");
    assert.deepEqual(store.scanForPlaintext("sk-replaced-secret-value"), []);
    assert.deepEqual(store.scanForPlaintext(secret), []);

    const deleted = store.deleteCredential({ credentialId: "openai-default" });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.existed, true);
    assert.equal(store.getStatus({ credentialId: "openai-default" }).configured, false);
    assert.throws(
      () => store.revealSecret({ credentialId: "openai-default" }),
      (error) => error?.code === "NOT_FOUND",
    );

    const secureRoot = join(dir, "secure-credentials");
    assert.ok(existsSync(secureRoot));
    const indexText = readFileSync(join(secureRoot, "index.json"), "utf8");
    assert.equal(indexText.includes(secret), false);
    assert.equal(indexText.includes("sk-replaced-secret-value"), false);
    const blobNames = readdirSync(join(secureRoot, "blobs"));
    assert.equal(blobNames.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects unsafe credential ids and empty secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-invalid-"));
  const store = openCredentialStore({
    rootDir: dir,
    safeStorage: createMemorySafeStorage(),
  });
  try {
    assert.throws(
      () => store.saveCredential({ credentialId: "../escape", secret: "x" }),
      (error) => error?.code === "INVALID_INPUT",
    );
    assert.throws(
      () => store.saveCredential({ credentialId: "ok", secret: "" }),
      (error) => error?.code === "INVALID_INPUT",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary app settings JSON must not be used as credential plaintext store", () => {
  // Guardrail: project/app repositories must not grow secret columns.
  const appRepo = readSource(join(root, "backend/persistence/app-repository.mjs"), "utf8");
  const projectRepo = readSource(join(root, "backend/persistence/project-repository.mjs"), "utf8");
  assert.doesNotMatch(appRepo, /apiKey|api_key|encryptString|safeStorage/);
  assert.doesNotMatch(projectRepo, /apiKey|api_key|credential.*secret|safeStorage/);
});
