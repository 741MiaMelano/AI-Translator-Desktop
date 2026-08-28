import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppRepository } from "../backend/persistence/app-repository.mjs";
import { openProjectRepository } from "../backend/persistence/project-repository.mjs";
import { DatabaseSync } from "node:sqlite";

const appDir = mkdtempSync(join(tmpdir(), "translator-resource-library-"));
const projectDir = mkdtempSync(join(tmpdir(), "translator-resource-snapshots-"));
const legacyAppDir = mkdtempSync(join(tmpdir(), "translator-resource-legacy-"));
let repository;
let projectRepository;

const glossary = {
  id: "glossary-product",
  kind: "glossary",
  name: "Product terms",
  description: "Terms for the product UI",
  payload: {
    languagePairs: [
      {
        sourceLanguageCode: "en-US",
        targetLanguageCode: "zh-CN",
        entries: [
          {
            id: "term-workspace",
            source: "workspace",
            target: "工作区",
            enabled: true,
          },
        ],
      },
    ],
  },
};

const subtitleStyle = {
  id: "subtitle-style-form",
  kind: "subtitle_style",
  name: "Form style",
  description: "Created by the structured form",
  payload: {
    format: "ass",
    bilingualLayout: "source_top_target_bottom",
    primary: { fontFamily: "Microsoft YaHei", fontSizePx: 32, textColor: "#ffffff", outlineColor: "#111111", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
    secondary: { fontFamily: "Arial", fontSizePx: 22, textColor: "#dddddd", outlineColor: "#111111", outlineWidthPx: 1, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
    preview: { sourceText: "Hello", targetText: "你好", direction: "auto", backgroundColor: "#25211d" },
  },
};

const exportPreset = {
  id: "export-preset-form",
  kind: "export_preset",
  name: "Form preset",
  description: "Created by the structured form",
  payload: {
    outputs: [{ content: "target", format: "srt" }, { content: "bilingual", format: "ass" }],
    burnVideo: false,
    fileNameTemplate: "{project}-{language}-{content}",
    destination: { kind: "project_exports" },
  },
};

try {
  repository = openAppRepository(appDir);
  const created = repository.saveResource(glossary);
  assert.equal(created.revision, 1);
  assert.equal(created.schemaVersion, 1);
  assert.equal(created.scope, "global");
  assert.deepEqual(repository.getResource(glossary.id), created);
  repository.close();

  repository = openAppRepository(appDir);
  assert.deepEqual(repository.listResources({ kind: "glossary" }), [created]);

  const savedStyle = repository.saveResource(subtitleStyle);
  const savedPreset = repository.saveResource(exportPreset);
  repository.close();
  repository = openAppRepository(appDir);
  assert.deepEqual(repository.getResource(subtitleStyle.id), savedStyle);
  assert.deepEqual(repository.getResource(exportPreset.id), savedPreset);

  const updated = repository.saveResource(
    { ...glossary, description: "Updated terms" },
    { expectedRevision: created.revision },
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.description, "Updated terms");
  assert.throws(
    () => repository.saveResource(glossary, { expectedRevision: 1 }),
    (error) => error?.code === "RESOURCE_CONFLICT",
  );

  repository.deleteResource(glossary.id, { expectedRevision: updated.revision });
  assert.equal(repository.getResource(glossary.id), null);

  const snapshot = {
    id: "snapshot-glossary-product-r2",
    kind: "glossary",
    name: "Product terms",
    scope: "project_snapshot",
    schemaVersion: 1,
    source: { kind: "global", resourceId: glossary.id, revision: 2 },
    capturedAt: "2026-07-23T10:00:00.000Z",
    payload: glossary.payload,
  };
  projectRepository = openProjectRepository(projectDir);
  projectRepository.appendResourceSnapshot(snapshot);
  assert.deepEqual(projectRepository.getResourceSnapshot(snapshot.id), snapshot);
  assert.deepEqual(projectRepository.listResourceSnapshots({ kind: "glossary" }), [snapshot]);
  assert.throws(
    () => projectRepository.appendResourceSnapshot(snapshot),
    (error) => error?.code === "RESOURCE_SNAPSHOT_CONFLICT",
  );
  projectRepository.close();
  projectRepository = openProjectRepository(projectDir);
  assert.deepEqual(projectRepository.getResourceSnapshot(snapshot.id), snapshot);

  const legacyMigrationsDir = join(legacyAppDir, "migrations");
  mkdirSync(legacyMigrationsDir);
  for (const fileName of ["001_initial.sql", "002_task_queue_runtime.sql"]) {
    copyFileSync(join(process.cwd(), "migrations", "app", fileName), join(legacyMigrationsDir, fileName));
  }
  const legacyRepository = openAppRepository(legacyAppDir, { migrationsDir: legacyMigrationsDir });
  legacyRepository.close();
  const legacyDb = new DatabaseSync(join(legacyAppDir, "app.sqlite"));
  legacyDb.prepare(
    `INSERT INTO resource_library (
      id, kind, name, scope, language, description, count, payload_json, updated_at
    ) VALUES (?, 'glossary', ?, 'global', ?, ?, 1, ?, ?)`,
  ).run(
    "legacy-glossary",
    "Legacy glossary",
    "zh-CN",
    "Legacy row",
    JSON.stringify(glossary.payload),
    "2026-07-22T00:00:00.000Z",
  );
  legacyDb.close();
  const upgraded = openAppRepository(legacyAppDir);
  try {
    const migrated = upgraded.getResource("legacy-glossary");
    assert.equal(migrated.schemaVersion, 1);
    assert.equal(migrated.revision, 1);
    assert.deepEqual(migrated.payload, glossary.payload);
  } finally {
    upgraded.close();
  }
} finally {
  repository?.close();
  projectRepository?.close();
  rmSync(appDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(legacyAppDir, { recursive: true, force: true });
}
