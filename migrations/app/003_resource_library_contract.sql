PRAGMA foreign_keys = OFF;

CREATE TABLE resource_library_v3 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('glossary', 'style_guide', 'subtitle_style', 'export_preset')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO resource_library_v3 (
  id, kind, name, description, schema_version, revision, payload_json, updated_at
)
SELECT
  id, kind, name, description, 1, 1, payload_json, updated_at
FROM resource_library;

DROP TABLE resource_library;
ALTER TABLE resource_library_v3 RENAME TO resource_library;

CREATE INDEX resource_library_kind_updated_idx
  ON resource_library (kind, updated_at DESC, id ASC);

PRAGMA foreign_keys = ON;
