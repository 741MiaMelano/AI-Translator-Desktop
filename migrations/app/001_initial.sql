PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_index (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  container_path TEXT NOT NULL,
  source_file_name TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  latest_run_summary TEXT NOT NULL DEFAULT '',
  trashed_at TEXT
);

CREATE TABLE IF NOT EXISTS workspace_defaults (
  id TEXT PRIMARY KEY,
  source_language TEXT NOT NULL,
  target_languages_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  style_guide_id TEXT NOT NULL,
  glossary_id TEXT NOT NULL,
  output_format TEXT NOT NULL,
  budget_usd REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_library (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  language TEXT,
  description TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_config (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  model_list_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  credential_ref TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_queue (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  detail TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL,
  target_language_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
