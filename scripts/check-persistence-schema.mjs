import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(rootDir, "docs", "persistence-schema.json");
const appMigrationsDir = join(rootDir, "migrations", "app");
const projectMigrationsDir = join(rootDir, "migrations", "project");

assert.ok(
  existsSync(schemaPath),
  "docs/persistence-schema.json must define the app/project SQLite contract before persistence code is added",
);

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const tablesFor = (databaseName) => {
  const database = schema.databases?.[databaseName];
  assert.ok(database, `${databaseName} database contract is required`);
  assert.ok(Array.isArray(database.tables), `${databaseName} database tables must be an array`);
  return new Set(database.tables.map((table) => table.name));
};

assert.equal(schema.schemaVersion, 1, "schemaVersion starts at 1");

const appTables = tablesFor("app");
const projectTables = tablesFor("project");

assert.equal(
  schema.databases.app.metadataTable,
  "app_meta",
  "app database metadata table is app_meta",
);
assert.equal(
  schema.databases.project.metadataTable,
  "project_meta",
  "project database metadata table is project_meta",
);

for (const table of [
  "app_meta",
  "project_index",
  "workspace_defaults",
  "resource_library",
  "capability_config",
  "task_queue",
  "settings",
]) {
  assert.ok(appTables.has(table), `app database owns ${table}`);
}

for (const table of [
  "project_meta",
  "source_file",
  "project_config",
  "source_tracks",
  "target_tracks",
  "segments",
  "source_text_layers",
  "target_text_layers",
  "run_snapshots",
  "project_task_history",
  "export_records",
  "resource_snapshots",
]) {
  assert.ok(projectTables.has(table), `project database owns ${table}`);
}

function loadMigrationSql(migrationsDir) {
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();
  assert.ok(files.length > 0, `migrations exist under ${migrationsDir}`);
  return files.map((name) => readFileSync(join(migrationsDir, name), "utf8")).join("\n");
}

function assertColumnsPresent(databaseName, migrationSql, tableName, columns) {
  for (const column of columns ?? []) {
    assert.ok(
      new RegExp(`\\b${column}\\b`, "i").test(migrationSql),
      `${databaseName} migrations mention ${tableName}.${column}`,
    );
  }
}

function assertMigrationMatchesContract(databaseName, migrationSql) {
  for (const table of schema.databases[databaseName].tables) {
    const createPattern = new RegExp(
      `CREATE TABLE(?: IF NOT EXISTS)?\\s+${table.name}(?:_v\\d+)?\\s*\\(([^;]+)\\)`,
      "ig",
    );
    const matches = [...migrationSql.matchAll(createPattern)];
    assert.ok(matches.length > 0, `${databaseName} migration creates ${table.name}`);
    const latestBody = matches[matches.length - 1][1];
    for (const column of table.columns ?? []) {
      assert.ok(
        new RegExp(`\\b${column}\\b`, "i").test(latestBody) ||
          new RegExp(`ALTER TABLE\\s+${table.name}\\s+ADD COLUMN\\s+${column}\\b`, "i").test(migrationSql),
        `${databaseName} migration ${table.name} has ${column}`,
      );
    }
    assertColumnsPresent(databaseName, migrationSql, table.name, table.columns);
  }
}

assertMigrationMatchesContract("app", loadMigrationSql(appMigrationsDir));
assertMigrationMatchesContract("project", loadMigrationSql(projectMigrationsDir));

const requiredConcepts = [
  "Project",
  "ProjectConfig",
  "SourceTrack",
  "TargetTrack",
  "Segment",
  "SourceTextLayers",
  "TargetTextLayers",
  "RunSnapshot",
  "ProjectTask",
  "WorkspaceDefaults",
  "ResourceLibrary",
  "Capabilities",
  "Settings",
];

for (const concept of requiredConcepts) {
  const mapping = schema.domainConcepts?.[concept];
  assert.ok(mapping, `${concept} must have one persistence owner`);
  assert.ok(["app", "project"].includes(mapping.database), `${concept} database must be app or project`);
  assert.ok(Array.isArray(mapping.tables) && mapping.tables.length > 0, `${concept} must map to at least one table`);

  const ownedTables = mapping.database === "app" ? appTables : projectTables;
  for (const table of mapping.tables) {
    assert.ok(ownedTables.has(table), `${concept} maps to declared ${mapping.database} table ${table}`);
  }
}

assert.deepEqual(schema.domainConcepts.Segment.tables, ["segments"], "Segment remains the timeline SSOT");
assert.ok(
  schema.domainConcepts.TargetTextLayers.tables.includes("target_text_layers"),
  "target text layers stay separate from segment timing",
);

const forbiddenProjectColumn = /api.?key|secret|credential|access_token|refresh_token|bearer_token/i;
for (const table of schema.databases.project.tables) {
  for (const column of table.columns ?? []) {
    assert.ok(
      !forbiddenProjectColumn.test(column),
      `project database must not persist secret-like column ${table.name}.${column}`,
    );
  }
}

assert.equal(
  schema.migrations?.versioning,
  "sqlite-user-version",
  "migrations must use PRAGMA user_version as the sole version SSOT",
);
assert.equal(
  schema.migrations?.filePattern,
  "NNN_name.sql",
  "migration files must follow NNN_name.sql",
);

console.log("persistence schema contract ok");
