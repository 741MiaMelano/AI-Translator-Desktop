import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openAppRepository } from "../backend/persistence/app-repository.mjs";
import { openProjectRepository } from "../backend/persistence/project-repository.mjs";

const fixtures = JSON.parse(readFileSync("tests/fixtures/phase14-schema-fixtures.json", "utf8"));

function createOldDatabase(database, version, path) {
  const db = new DatabaseSync(path);
  const migrationDir = join(process.cwd(), "migrations", database);
  const migrations = readdirSync(migrationDir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()
    .slice(0, version);
  assert.equal(migrations.length, version, `${database} v${version} fixture migrations`);
  for (const migration of migrations) db.exec(readFileSync(join(migrationDir, migration), "utf8"));
  db.exec(`PRAGMA user_version = ${version}`);
  return db;
}

for (const fixture of fixtures) {
  test(`${fixture.name} upgrades to the current production schema without data loss`, () => {
    const root = mkdtempSync(join(tmpdir(), `phase14-${fixture.name}-`));
    const databasePath = join(root, fixture.database === "app" ? "app.sqlite" : "project.sqlite");
    let repository;
    try {
      const old = createOldDatabase(fixture.database, fixture.version, databasePath);
      if (fixture.database === "app") {
        old.prepare(
          `INSERT INTO project_index (
             id, title, container_path, source_file_name, media_kind, lifecycle,
             updated_at, latest_run_summary, trashed_at
           ) VALUES (?, 'Legacy app project', 'D:/legacy', 'legacy.srt', 'subtitle',
             'draft', '2026-07-01T00:00:00.000Z', 'preserve me', NULL)`,
        ).run(fixture.seedId);
      } else {
        old.prepare(
          `INSERT INTO project_meta (
             id, schema_version, title, media_kind, lifecycle, created_at, updated_at,
             trashed_at, active_source_track_id, recent_run_ids_json, notes_json,
             pending_confirmations_json
           ) VALUES (?, ?, 'Legacy project v5', 'subtitle', 'draft',
             '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL,
             'legacy-source', '[]', '["preserve me"]', '[]')`,
        ).run(fixture.seedId, fixture.version);
      }
      old.close();

      repository = fixture.database === "app" ? openAppRepository(root) : openProjectRepository(root);
      repository.close();
      repository = undefined;

      const upgraded = new DatabaseSync(databasePath);
      const latest = fixture.database === "app" ? 6 : 23;
      assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, latest);
      if (fixture.database === "app") {
        assert.equal(
          upgraded.prepare("SELECT latest_run_summary FROM project_index WHERE id = ?").get(fixture.seedId).latest_run_summary,
          "preserve me",
        );
        assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'batch_runs'").get());
      } else {
        assert.equal(
          upgraded.prepare("SELECT notes_json FROM project_meta WHERE id = ?").get(fixture.seedId).notes_json,
          '["preserve me"]',
        );
        assert.equal(upgraded.prepare("SELECT subtitle_style_json FROM project_config LIMIT 1").get(), undefined);
        assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'export_attempts'").get());
        assert.deepEqual(
          upgraded.prepare("PRAGMA table_info(segments)").all()
            .filter(({ name }) => ["asr_word_start_index", "asr_word_end_index", "timing_validity"].includes(name))
            .map(({ name }) => name),
          ["asr_word_start_index", "asr_word_end_index", "timing_validity"],
        );
      }
      upgraded.close();
    } finally {
      repository?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("project v18 activates the latest subtitle style that was already copied into the project", () => {
  const root = mkdtempSync(join(tmpdir(), "phase14-project-style-backfill-"));
  const databasePath = join(root, "project.sqlite");
  const payload = {
    format: "ass",
    bilingualLayout: "target_only",
    primary: {
      fontFamily: "Arial", fontSizePx: 36, textColor: "#FFFFFF",
      outlineColor: "#000000", outlineWidthPx: 2, shadowColor: "#000000",
      shadowDepthPx: 0, position: "bottom",
    },
    secondary: {
      fontFamily: "Arial", fontSizePx: 20, textColor: "#EEEEEE",
      outlineColor: "#111111", outlineWidthPx: 1, shadowColor: "#000000",
      shadowDepthPx: 0, position: "bottom",
    },
    preview: { sourceText: "Source", targetText: "目标", direction: "auto", backgroundColor: "#25211D" },
  };
  try {
    const old = createOldDatabase("project", 18, databasePath);
    old.prepare(
      `INSERT INTO project_config (
        source_language, target_languages_json, provider_id, model_id,
        glossary_snapshot_id, style_guide_snapshot_id, output_format, budget_usd,
        burn_video, copy_media_into_project, asr_model_id
      ) VALUES ('auto', '["zh-CN"]', 'OpenAI', 'GPT-4.1', '', '', 'ASS', 0, 0, 0, NULL)`,
    ).run();
    old.prepare(
      `INSERT INTO resource_snapshots (
        id, resource_kind, resource_name, schema_version,
        source_resource_id, source_revision, payload_json, captured_at
      ) VALUES ('style-old', 'subtitle_style', 'Old', 1, 'global-style', 1, ?, '2026-08-01T00:00:00Z')`,
    ).run(JSON.stringify({ ...payload, primary: { ...payload.primary, fontSizePx: 24 } }));
    old.prepare(
      `INSERT INTO resource_snapshots (
        id, resource_kind, resource_name, schema_version,
        source_resource_id, source_revision, payload_json, captured_at
      ) VALUES ('style-new', 'subtitle_style', 'New', 1, 'global-style', 2, ?, '2026-08-02T00:00:00Z')`,
    ).run(JSON.stringify(payload));
    old.close();

    openProjectRepository(root).close();
    const upgraded = new DatabaseSync(databasePath);
    assert.deepEqual(JSON.parse(upgraded.prepare("SELECT subtitle_style_json FROM project_config").get().subtitle_style_json), payload);
    upgraded.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
