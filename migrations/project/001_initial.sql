PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project_meta (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT,
  active_source_track_id TEXT NOT NULL,
  recent_run_ids_json TEXT NOT NULL DEFAULT '[]',
  notes_json TEXT NOT NULL DEFAULT '[]',
  pending_confirmations_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS source_file (
  id TEXT PRIMARY KEY,
  source_file_name TEXT NOT NULL,
  original_path TEXT,
  project_relative_path TEXT,
  media_kind TEXT NOT NULL,
  no_source_media INTEGER NOT NULL DEFAULT 0,
  relink_state TEXT NOT NULL DEFAULT 'linked',
  probe_summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS project_config (
  source_language TEXT NOT NULL,
  target_languages_json TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  glossary_snapshot_id TEXT NOT NULL,
  style_guide_snapshot_id TEXT NOT NULL,
  output_format TEXT NOT NULL,
  budget_usd REAL NOT NULL,
  burn_video INTEGER NOT NULL DEFAULT 0,
  copy_media_into_project INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_tracks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  language_state TEXT NOT NULL,
  default_language TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS target_tracks (
  id TEXT PRIMARY KEY,
  source_track_id TEXT NOT NULL REFERENCES source_tracks(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  language_label TEXT NOT NULL,
  status TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  delivery_label TEXT NOT NULL,
  last_human_action TEXT NOT NULL,
  snapshot_ids_json TEXT NOT NULL DEFAULT '[]',
  qa_issues_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  source_track_id TEXT NOT NULL REFERENCES source_tracks(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  source_language TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  segment_version TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS source_text_layers (
  segment_id TEXT PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
  original_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  manual_text TEXT
);

CREATE TABLE IF NOT EXISTS target_text_layers (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  model_text TEXT NOT NULL,
  post_processed_text TEXT NOT NULL,
  manual_text TEXT,
  previous_manual_text TEXT,
  locked INTEGER,
  qa_flags_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (segment_id, language_code)
);

CREATE TABLE IF NOT EXISTS run_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  target_language_code TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  glossary_snapshot_id TEXT NOT NULL,
  style_guide_snapshot_id TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  segment_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_task_history (
  id TEXT PRIMARY KEY,
  queue_task_id TEXT,
  label TEXT NOT NULL,
  detail TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL,
  target_language_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_records (
  id TEXT PRIMARY KEY,
  target_language_code TEXT NOT NULL,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  target_track_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_snapshots (
  id TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  source_resource_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
