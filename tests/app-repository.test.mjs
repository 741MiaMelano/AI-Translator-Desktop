import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openAppRepository } from "../backend/persistence/app-repository.mjs";

function readUserVersion(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare("PRAGMA user_version").get().user_version;
  } finally {
    db.close();
  }
}

const appDir = mkdtempSync(join(tmpdir(), "translator-app-"));
const futureDir = mkdtempSync(join(tmpdir(), "translator-app-future-"));
const dbPath = join(appDir, "app.sqlite");
const legacyMigrationsDir = join(appDir, "legacy-migrations");
mkdirSync(legacyMigrationsDir);
copyFileSync(
  join(process.cwd(), "migrations", "app", "001_initial.sql"),
  join(legacyMigrationsDir, "001_initial.sql"),
);

const expectedIndex = [
  {
    id: "project-new",
    title: "Newer project",
    containerPath: "D:/translator/project-new",
    sourceFileName: "new.srt",
    mediaKind: "subtitle",
    lifecycle: "needs_review",
    updatedAt: "2026-07-09 12:00",
    latestRunSummary: "needs review",
    trashedAt: "2026-07-09 12:30",
  },
  {
    id: "project-old",
    title: "Older project",
    containerPath: "D:/translator/project-old",
    sourceFileName: "old.mp4",
    mediaKind: "video",
    lifecycle: "draft",
    updatedAt: "2026-07-08 09:00",
    latestRunSummary: "waiting",
  },
];

let repository;

try {
  repository = openAppRepository(appDir, { migrationsDir: legacyMigrationsDir });
  repository.upsertProjectIndex({
    id: "project-old",
    title: "Older project",
    containerPath: "D:/translator/project-old",
    sourceFileName: "old.mp4",
    mediaKind: "video",
    lifecycle: "draft",
    updatedAt: "2026-07-08 09:00",
    latestRunSummary: "waiting",
  });
  repository.upsertProjectIndex({
    id: "project-new",
    title: "Newer project",
    containerPath: "D:/translator/project-new",
    sourceFileName: "new.srt",
    mediaKind: "subtitle",
    lifecycle: "needs_review",
    updatedAt: "2026-07-09 12:00",
    latestRunSummary: "needs review",
    trashedAt: "2026-07-09 12:30",
  });

  assert.ok(existsSync(dbPath), "app.sqlite is created");
  assert.deepEqual(repository.listProjectIndex(), expectedIndex);
  repository.upsertProviderReadiness({
    providerId: "openai",
    providerName: "OpenAI",
    status: "ready",
    credentialId: "openai-default",
    profileKey: "profile-1",
    requestedModel: "GPT-4.1",
    modelId: "gpt-4.1",
    baseUrlDisplay: "https://api.openai.com/v1",
    transportMode: "responses",
    testedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(repository.getProviderReadiness("openai").profileKey, "profile-1");
  const asrDeviceState = {
    requestedDevice: "auto",
    allowCudaFallback: false,
    actualDevice: "cpu",
    actualRuntimeId: "whisper-cpp-cpu-x64",
    actualRuntimeVersion: "1.9.1",
    fallbackReason: "cuda_not_ready",
    detection: {
      cpu: { status: "available", runtimeId: "whisper-cpp-cpu-x64", runtimeVersion: "1.9.1" },
      cuda: { status: "unavailable", runtimeId: "whisper-cpp-cuda-12.4-x64", runtimeVersion: "1.9.1", reason: "runtime_not_ready" },
    },
    updatedAt: "2026-07-19T20:00:00.000Z",
  };
  repository.upsertAsrDeviceState(asrDeviceState);
  assert.deepEqual(repository.getAsrDeviceState(), asrDeviceState);
  repository.close();
  repository = undefined;

  assert.equal(readUserVersion(dbPath), 1);

  repository = openAppRepository(appDir);
  assert.deepEqual(repository.listProjectIndex(), expectedIndex);
  assert.equal(repository.getProviderReadiness("openai").status, "ready");
  assert.deepEqual(repository.getAsrDeviceState(), asrDeviceState);
  repository.close();
  repository = undefined;
  assert.equal(readUserVersion(dbPath), 5);

  repository = openAppRepository(appDir);
  assert.deepEqual(repository.listProjectIndex(), expectedIndex);
  repository.close();
  repository = undefined;
  assert.equal(readUserVersion(dbPath), 5);

  const futureDbPath = join(futureDir, "app.sqlite");
  const futureDb = new DatabaseSync(futureDbPath);
  futureDb.exec("PRAGMA user_version = 6");
  futureDb.close();

  assert.throws(
    () => openAppRepository(futureDir),
    /Unsupported app database version 6/,
  );
  rmSync(futureDir, { recursive: true, force: true });
} finally {
  repository?.close();
  rmSync(appDir, { recursive: true, force: true });
  if (existsSync(futureDir)) {
    rmSync(futureDir, { recursive: true, force: true });
  }
}
