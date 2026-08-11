PRAGMA foreign_keys = OFF;

CREATE TABLE resource_snapshots_v12 (
  id TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('glossary', 'style_guide', 'subtitle_style', 'export_preset')),
  resource_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  source_resource_id TEXT,
  source_revision INTEGER,
  payload_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  CHECK (
    (source_resource_id IS NULL AND source_revision IS NULL)
    OR (source_resource_id IS NOT NULL AND source_revision > 0)
  )
);

INSERT INTO resource_snapshots_v12 (
  id, resource_kind, resource_name, schema_version,
  source_resource_id, source_revision, payload_json, captured_at
)
SELECT
  id, resource_kind, resource_name, 1,
  source_resource_id,
  CASE WHEN source_resource_id IS NULL THEN NULL ELSE 1 END,
  payload_json, created_at
FROM resource_snapshots;

DROP TABLE resource_snapshots;
ALTER TABLE resource_snapshots_v12 RENAME TO resource_snapshots;

CREATE INDEX resource_snapshots_kind_captured_idx
  ON resource_snapshots (resource_kind, captured_at DESC, id ASC);

PRAGMA foreign_keys = ON;
