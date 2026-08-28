CREATE TABLE export_records_v2 (
  id TEXT PRIMARY KEY,
  export_kind TEXT NOT NULL,
  target_language_code TEXT,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  target_track_id TEXT
);

INSERT INTO export_records_v2 (
  id,
  export_kind,
  target_language_code,
  format,
  path,
  created_at,
  source_track_id,
  target_track_id
)
SELECT
  id,
  'target',
  target_language_code,
  format,
  path,
  created_at,
  source_track_id,
  target_track_id
FROM export_records;

DROP TABLE export_records;

ALTER TABLE export_records_v2 RENAME TO export_records;
