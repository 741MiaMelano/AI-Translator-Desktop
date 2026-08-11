CREATE TABLE project_config_next (
  source_language TEXT NOT NULL,
  target_languages_json TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  glossary_snapshot_id TEXT NOT NULL,
  style_guide_snapshot_id TEXT NOT NULL,
  output_format TEXT NOT NULL,
  budget_usd REAL NOT NULL,
  burn_video INTEGER NOT NULL DEFAULT 0,
  copy_media_into_project INTEGER NOT NULL DEFAULT 0,
  asr_model_id TEXT CHECK (asr_model_id IS NULL OR asr_model_id IN (
    'small',
    'large-v3-turbo-q5_0',
    'large-v3-turbo-q8_0',
    'large-v3-turbo',
    'large-v3-q5_0',
    'large-v3',
    'qwen3-asr-0.6b',
    'qwen3-asr-1.7b'
  ))
);

INSERT INTO project_config_next (
  source_language, target_languages_json, provider_id, model_id,
  glossary_snapshot_id, style_guide_snapshot_id, output_format, budget_usd,
  burn_video, copy_media_into_project, asr_model_id
)
SELECT
  source_language, target_languages_json, provider_id, model_id,
  glossary_snapshot_id, style_guide_snapshot_id, output_format, budget_usd,
  burn_video, copy_media_into_project, asr_model_id
FROM project_config;

DROP TABLE project_config;
ALTER TABLE project_config_next RENAME TO project_config;
