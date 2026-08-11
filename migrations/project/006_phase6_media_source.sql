-- Phase 6: media source fields on source_file + nullable active_source_track_id.
-- Table rebuild for project_meta (SQLite cannot drop NOT NULL in place).
-- Transaction control stays with the migration runner.

CREATE TABLE project_meta_v6 (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 6,
  title TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT,
  active_source_track_id TEXT,
  recent_run_ids_json TEXT NOT NULL DEFAULT '[]',
  notes_json TEXT NOT NULL DEFAULT '[]',
  pending_confirmations_json TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO project_meta_v6 (
  id, schema_version, title, media_kind, lifecycle, created_at, updated_at, trashed_at,
  active_source_track_id, recent_run_ids_json, notes_json, pending_confirmations_json
)
SELECT
  id, schema_version, title, media_kind, lifecycle, created_at, updated_at, trashed_at,
  active_source_track_id, recent_run_ids_json, notes_json, pending_confirmations_json
FROM project_meta;

DROP TABLE project_meta;
ALTER TABLE project_meta_v6 RENAME TO project_meta;

CREATE TABLE source_file_v6 (
  id TEXT PRIMARY KEY,
  source_file_name TEXT NOT NULL,
  original_path TEXT,
  project_relative_path TEXT,
  media_kind TEXT NOT NULL,
  no_source_media INTEGER NOT NULL DEFAULT 0,
  relink_state TEXT NOT NULL DEFAULT 'available',
  probe_summary_json TEXT NOT NULL DEFAULT '{}',
  identity_json TEXT NOT NULL DEFAULT '{}',
  selected_audio_stream_id TEXT,
  selected_subtitle_stream_id TEXT
);

INSERT INTO source_file_v6 (
  id, source_file_name, original_path, project_relative_path, media_kind,
  no_source_media, relink_state, probe_summary_json, identity_json,
  selected_audio_stream_id, selected_subtitle_stream_id
)
SELECT
  id,
  source_file_name,
  original_path,
  project_relative_path,
  media_kind,
  no_source_media,
  CASE
    WHEN relink_state = 'linked' THEN 'available'
    WHEN relink_state IN ('available', 'missing', 'relink_required', 'invalid') THEN relink_state
    ELSE 'available'
  END,
  probe_summary_json,
  '{}',
  NULL,
  NULL
FROM source_file;

DROP TABLE source_file;
ALTER TABLE source_file_v6 RENAME TO source_file;
