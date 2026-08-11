import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationFilePattern = /^(\d{3})_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;
const forbiddenControl =
  /\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|PRAGMA\s+user_version/i;

function loadMigrations(databaseName, migrationsDir) {
  const entries = readdirSync(migrationsDir);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql"));
  if (sqlFiles.length === 0) {
    throw new Error(`No ${databaseName} migrations found`);
  }

  const migrations = sqlFiles.map((filename) => {
    const match = migrationFilePattern.exec(filename);
    if (!match) {
      throw new Error(`Invalid ${databaseName} migration filename: ${filename}`);
    }

    const version = Number(match[1]);
    const sql = readFileSync(join(migrationsDir, filename), "utf8");
    if (forbiddenControl.test(sql)) {
      throw new Error(
        `Invalid ${databaseName} migration content in ${filename}: migration SQL must not control transactions or user_version`,
      );
    }

    return { version, filename, sql };
  });

  migrations.sort((left, right) => left.version - right.version);

  if (migrations[0].version !== 1) {
    throw new Error(
      `Invalid ${databaseName} migration sequence: expected version 1, found ${migrations[0].version}`,
    );
  }

  for (let index = 0; index < migrations.length; index += 1) {
    const expected = index + 1;
    const actual = migrations[index].version;
    if (actual !== expected) {
      throw new Error(
        `Invalid ${databaseName} migration sequence: expected version ${expected}, found ${actual}`,
      );
    }
  }

  return migrations;
}

function readUserVersion(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

function ensureForeignKeys(db) {
  db.exec("PRAGMA foreign_keys = ON");
  const enabled = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
  if (Number(enabled) !== 1) {
    throw new Error("Failed to enable SQLite foreign_keys");
  }
}

export function migrateDatabase(db, { databaseName, migrationsDir }) {
  const migrations = loadMigrations(databaseName, migrationsDir);
  const latestVersion = migrations[migrations.length - 1].version;

  ensureForeignKeys(db);

  const currentVersion = readUserVersion(db);
  if (currentVersion > latestVersion) {
    throw new Error(
      `Unsupported ${databaseName} database version ${currentVersion}; latest supported version is ${latestVersion}`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors when no transaction is active
      }

      const wrapped = new Error(
        `Failed to migrate ${databaseName} database to version ${migration.version} (${migration.filename})`,
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  return latestVersion;
}
