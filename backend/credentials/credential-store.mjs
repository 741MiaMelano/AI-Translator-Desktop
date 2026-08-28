import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const INDEX_FILE = "index.json";
const CIPHER_DIR = "blobs";
const MAX_SECRET_CHARS = 8 * 1024;

function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isSafeCredentialId(credentialId) {
  return (
    typeof credentialId === "string" &&
    credentialId.length > 0 &&
    credentialId.length <= 128 &&
    credentialId !== "." &&
    credentialId !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(credentialId)
  );
}

function assertSafeStorage(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") {
    throw createStoreError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      "Secure credential storage is unavailable",
    );
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw createStoreError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      "Secure credential storage is unavailable",
    );
  }
  if (
    typeof safeStorage.encryptString !== "function" ||
    typeof safeStorage.decryptString !== "function"
  ) {
    throw createStoreError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      "Secure credential storage is unavailable",
    );
  }
}

function readIndex(indexPath) {
  if (!existsSync(indexPath)) {
    return { version: 1, entries: {} };
  }
  const raw = readFileSync(indexPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
    throw createStoreError("INTERNAL", "Credential index is corrupt");
  }
  return { version: 1, entries: { ...parsed.entries } };
}

function writeIndex(indexPath, index) {
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function toPublicStatus(entry) {
  if (!entry) {
    return { configured: false };
  }
  return {
    configured: true,
    credentialId: entry.credentialId,
    providerId: entry.providerId,
    label: entry.label,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Opens a Windows DPAPI-backed credential store via Electron safeStorage.
 * Ciphertext lives under rootDir; only non-secret references are indexed.
 * revealSecret is for main/worker use only and must never be exposed to renderer.
 */
export function openCredentialStore({ rootDir, safeStorage }) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw createStoreError("INVALID_INPUT", "Credential store root is required");
  }
  assertSafeStorage(safeStorage);

  const storeRoot = join(rootDir, "secure-credentials");
  const blobsDir = join(storeRoot, CIPHER_DIR);
  const indexPath = join(storeRoot, INDEX_FILE);
  mkdirSync(blobsDir, { recursive: true });

  function blobPath(credentialId) {
    return join(blobsDir, `${credentialId}.enc`);
  }

  function saveCredential({ credentialId, secret, providerId = "", label = "" }) {
    if (!isSafeCredentialId(credentialId)) {
      throw createStoreError("INVALID_INPUT", "credentialId is invalid");
    }
    if (typeof secret !== "string" || secret.length === 0) {
      throw createStoreError("INVALID_INPUT", "secret is required");
    }
    if (secret.length > MAX_SECRET_CHARS) {
      throw createStoreError("INVALID_INPUT", "secret exceeds size limit");
    }
    if (typeof providerId !== "string" || providerId.length > 128) {
      throw createStoreError("INVALID_INPUT", "providerId is invalid");
    }
    if (typeof label !== "string" || label.length > 256) {
      throw createStoreError("INVALID_INPUT", "label is invalid");
    }

    assertSafeStorage(safeStorage);
    const encrypted = safeStorage.encryptString(secret);
    if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
      throw createStoreError("INTERNAL", "Credential encryption failed");
    }
    const cipher = Buffer.from(encrypted);
    writeFileSync(blobPath(credentialId), cipher);

    const index = readIndex(indexPath);
    const updatedAt = new Date().toISOString();
    index.entries[credentialId] = {
      credentialId,
      providerId,
      label,
      updatedAt,
    };
    writeIndex(indexPath, index);

    return toPublicStatus(index.entries[credentialId]);
  }

  function deleteCredential({ credentialId }) {
    if (!isSafeCredentialId(credentialId)) {
      throw createStoreError("INVALID_INPUT", "credentialId is invalid");
    }
    const index = readIndex(indexPath);
    const existed = Boolean(index.entries[credentialId]);
    delete index.entries[credentialId];
    writeIndex(indexPath, index);
    const path = blobPath(credentialId);
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
    return { deleted: true, existed };
  }

  function getStatus({ credentialId } = {}) {
    const index = readIndex(indexPath);
    if (credentialId === undefined) {
      return {
        credentials: Object.values(index.entries)
          .map((entry) => toPublicStatus(entry))
          .sort((a, b) => a.credentialId.localeCompare(b.credentialId)),
      };
    }
    if (!isSafeCredentialId(credentialId)) {
      throw createStoreError("INVALID_INPUT", "credentialId is invalid");
    }
    return toPublicStatus(index.entries[credentialId]);
  }

  /** Internal only — never wire to renderer DesktopApi. */
  function revealSecret({ credentialId }) {
    if (!isSafeCredentialId(credentialId)) {
      throw createStoreError("INVALID_INPUT", "credentialId is invalid");
    }
    assertSafeStorage(safeStorage);
    const index = readIndex(indexPath);
    if (!index.entries[credentialId]) {
      throw createStoreError("NOT_FOUND", "Credential not found");
    }
    const path = blobPath(credentialId);
    if (!existsSync(path)) {
      throw createStoreError("NOT_FOUND", "Credential not found");
    }
    const cipher = readFileSync(path);
    const secret = safeStorage.decryptString(cipher);
    if (typeof secret !== "string" || secret.length === 0) {
      throw createStoreError("INTERNAL", "Credential decryption failed");
    }
    return secret;
  }

  function scanForPlaintext(secret) {
    if (typeof secret !== "string" || secret.length === 0) {
      return [];
    }
    const hits = [];
    if (existsSync(indexPath)) {
      const indexText = readFileSync(indexPath, "utf8");
      if (indexText.includes(secret)) {
        hits.push(INDEX_FILE);
      }
    }
    if (existsSync(blobsDir)) {
      for (const name of readdirSync(blobsDir)) {
        const full = join(blobsDir, name);
        const bytes = readFileSync(full);
        if (bytes.includes(secret) || bytes.toString("utf8").includes(secret)) {
          hits.push(`${CIPHER_DIR}/${name}`);
        }
      }
    }
    return hits;
  }

  return {
    saveCredential,
    deleteCredential,
    getStatus,
    revealSecret,
    scanForPlaintext,
    close() {},
  };
}

export function createMemorySafeStorage() {
  // Test double: reversible transform that must not leave plaintext bytes on disk.
  const key = 0xa5;
  const prefix = Buffer.from("mem-safe-v1:");
  return {
    isEncryptionAvailable() {
      return true;
    },
    encryptString(plain) {
      const raw = Buffer.from(String(plain), "utf8");
      const cipher = Buffer.alloc(raw.length);
      for (let i = 0; i < raw.length; i += 1) {
        cipher[i] = raw[i] ^ key ^ (i & 0xff);
      }
      return Buffer.concat([prefix, cipher]);
    },
    decryptString(buffer) {
      const buf = Buffer.from(buffer);
      if (!buf.subarray(0, prefix.length).equals(prefix)) {
        throw new Error("invalid cipher");
      }
      const cipher = buf.subarray(prefix.length);
      const raw = Buffer.alloc(cipher.length);
      for (let i = 0; i < cipher.length; i += 1) {
        raw[i] = cipher[i] ^ key ^ (i & 0xff);
      }
      return raw.toString("utf8");
    },
  };
}

export function createUnavailableSafeStorage() {
  return {
    isEncryptionAvailable() {
      return false;
    },
    encryptString() {
      throw new Error("unavailable");
    },
    decryptString() {
      throw new Error("unavailable");
    },
  };
}
