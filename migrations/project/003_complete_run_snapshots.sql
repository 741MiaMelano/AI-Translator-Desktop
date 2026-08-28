CREATE TABLE run_snapshots_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  target_language_code TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_url_display TEXT,
  transport_mode TEXT,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  glossary_snapshot_id TEXT NOT NULL,
  style_guide_snapshot_id TEXT NOT NULL,
  resource_snapshot_json TEXT NOT NULL DEFAULT '{}',
  resource_fingerprint TEXT,
  prompt_template_version TEXT NOT NULL,
  segment_version TEXT NOT NULL,
  price_config_version TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  reserved_cost_usd REAL NOT NULL DEFAULT 0,
  actual_cost_usd REAL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  currency TEXT
);

INSERT INTO run_snapshots_v2 (
  id, project_id, source_track_id, target_language_code, provider_id, model_id,
  glossary_snapshot_id, style_guide_snapshot_id, prompt_template_version, segment_version,
  created_at, cache_hits, estimated_cost_usd, reserved_cost_usd
)
SELECT
  id, project_id, source_track_id, target_language_code, provider_id, model_id,
  glossary_snapshot_id, style_guide_snapshot_id, prompt_template_version, segment_version,
  created_at, cache_hits, estimated_cost_usd, estimated_cost_usd
FROM run_snapshots;

DROP TABLE run_snapshots;
ALTER TABLE run_snapshots_v2 RENAME TO run_snapshots;
