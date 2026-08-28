ALTER TABLE source_tracks ADD COLUMN asr_run_id TEXT REFERENCES asr_runs(id) ON DELETE RESTRICT;
ALTER TABLE source_tracks ADD COLUMN segmentation_config_version TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_tracks_asr_candidate
  ON source_tracks(asr_run_id, segmentation_config_version)
  WHERE asr_run_id IS NOT NULL;
