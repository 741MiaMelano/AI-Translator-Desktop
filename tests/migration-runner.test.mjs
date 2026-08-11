import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../backend/persistence/migration-runner.mjs";

function writeMigration(dir, filename, sql) {
  writeFileSync(join(dir, filename), sql, "utf8");
}

function readUserVersion(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

function readForeignKeys(db) {
  return Number(db.prepare("PRAGMA foreign_keys").get().foreign_keys);
}

const root = mkdtempSync(join(tmpdir(), "translator-migrations-"));
const mainDir = join(root, "main");
const gapDir = join(root, "gap");
const badNameDir = join(root, "bad-name");
const futureDbPath = join(root, "future.sqlite");
const mainDbPath = join(root, "main.sqlite");

mkdirSync(mainDir);
mkdirSync(gapDir);
mkdirSync(badNameDir);

let mainDb;
let futureDb;
let gapDb;
let badNameDb;

try {
  writeMigration(
    mainDir,
    "001_initial.sql",
    `CREATE TABLE items (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO items (id, value) VALUES ('item-v1', 'created-by-v1');
`,
  );

  mainDb = new DatabaseSync(mainDbPath);
  const version1 = migrateDatabase(mainDb, {
    databaseName: "app",
    migrationsDir: mainDir,
  });
  assert.equal(version1, 1);
  assert.equal(readUserVersion(mainDb), 1);
  assert.equal(readForeignKeys(mainDb), 1);
  const itemAfterV1 = mainDb.prepare("SELECT id, value FROM items").get();
  assert.equal(itemAfterV1.id, "item-v1");
  assert.equal(itemAfterV1.value, "created-by-v1");

  writeMigration(
    mainDir,
    "002_add_note.sql",
    `ALTER TABLE items ADD COLUMN note TEXT;
UPDATE items
SET note = 'migrated-by-v2'
WHERE id = 'item-v1';
`,
  );

  const version2 = migrateDatabase(mainDb, {
    databaseName: "app",
    migrationsDir: mainDir,
  });
  assert.equal(version2, 2);
  assert.equal(readUserVersion(mainDb), 2);
  const itemAfterV2 = mainDb.prepare("SELECT id, value, note FROM items").get();
  assert.equal(itemAfterV2.id, "item-v1");
  assert.equal(itemAfterV2.value, "created-by-v1");
  assert.equal(itemAfterV2.note, "migrated-by-v2");

  const version2Again = migrateDatabase(mainDb, {
    databaseName: "app",
    migrationsDir: mainDir,
  });
  assert.equal(version2Again, 2);
  assert.equal(readUserVersion(mainDb), 2);
  assert.equal(mainDb.prepare("SELECT COUNT(*) AS count FROM items").get().count, 1);
  const itemAfterIdempotent = mainDb.prepare("SELECT id, value, note FROM items").get();
  assert.equal(itemAfterIdempotent.id, "item-v1");
  assert.equal(itemAfterIdempotent.value, "created-by-v1");
  assert.equal(itemAfterIdempotent.note, "migrated-by-v2");

  futureDb = new DatabaseSync(futureDbPath);
  futureDb.exec("PRAGMA user_version = 3");
  assert.throws(
    () =>
      migrateDatabase(futureDb, {
        databaseName: "app",
        migrationsDir: mainDir,
      }),
    /Unsupported app database version 3/,
  );
  assert.equal(readUserVersion(futureDb), 3);
  futureDb.close();
  futureDb = undefined;

  writeMigration(
    mainDir,
    "003_failing.sql",
    `CREATE TABLE partial_change (id TEXT);
THIS IS NOT VALID SQL;
`,
  );

  assert.throws(
    () =>
      migrateDatabase(mainDb, {
        databaseName: "app",
        migrationsDir: mainDir,
      }),
    /Failed to migrate app database to version 3 \(003_failing\.sql\)/,
  );
  assert.equal(readUserVersion(mainDb), 2);
  assert.equal(
    mainDb.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'partial_change'",
    ).get().count,
    0,
  );
  const itemAfterFailed = mainDb.prepare("SELECT id, value, note FROM items").get();
  assert.equal(itemAfterFailed.id, "item-v1");
  assert.equal(itemAfterFailed.value, "created-by-v1");
  assert.equal(itemAfterFailed.note, "migrated-by-v2");

  writeMigration(
    gapDir,
    "001_initial.sql",
    "CREATE TABLE gap_items (id TEXT PRIMARY KEY);\n",
  );
  writeMigration(
    gapDir,
    "003_gap.sql",
    "ALTER TABLE gap_items ADD COLUMN note TEXT;\n",
  );
  gapDb = new DatabaseSync(join(root, "gap.sqlite"));
  assert.throws(
    () =>
      migrateDatabase(gapDb, {
        databaseName: "project",
        migrationsDir: gapDir,
      }),
    /Invalid project migration sequence/,
  );
  assert.equal(readUserVersion(gapDb), 0);
  gapDb.close();
  gapDb = undefined;

  writeMigration(badNameDir, "migration.sql", "CREATE TABLE bad (id TEXT);\n");
  badNameDb = new DatabaseSync(join(root, "bad-name.sqlite"));
  assert.throws(
    () =>
      migrateDatabase(badNameDb, {
        databaseName: "app",
        migrationsDir: badNameDir,
      }),
    /Invalid app migration filename: migration\.sql/,
  );
  assert.equal(readUserVersion(badNameDb), 0);
  badNameDb.close();
  badNameDb = undefined;
} finally {
  mainDb?.close();
  futureDb?.close();
  gapDb?.close();
  badNameDb?.close();
  rmSync(root, { recursive: true, force: true });
}
