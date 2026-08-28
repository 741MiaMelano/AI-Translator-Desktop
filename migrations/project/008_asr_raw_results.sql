CREATE TABLE IF NOT EXISTS asr_runs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  audio_stream_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'completed'),
  result_schema_version INTEGER NOT NULL CHECK (result_schema_version = 1),
  engine_id TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_hash TEXT NOT NULL,
  requested_device TEXT NOT NULL CHECK (requested_device IN ('auto', 'cpu', 'cuda')),
  actual_device TEXT NOT NULL CHECK (actual_device IN ('cpu', 'cuda')),
  fallback_reason TEXT CHECK (fallback_reason IN ('cuda_not_ready', 'cuda_probe_failed', 'cuda_initialization_failed')),
  language_mode TEXT NOT NULL CHECK (language_mode IN ('auto', 'fixed')),
  language_hint TEXT,
  parameters_json TEXT NOT NULL,
  canonicalizer_version TEXT NOT NULL,
  raw_artifact_relative_path TEXT NOT NULL,
  raw_artifact_sha256 TEXT NOT NULL,
  raw_artifact_size_bytes INTEGER NOT NULL CHECK (raw_artifact_size_bytes > 0),
  media_duration_ms INTEGER NOT NULL CHECK (media_duration_ms > 0),
  processing_duration_ms INTEGER NOT NULL CHECK (processing_duration_ms >= 0),
  raw_segment_count INTEGER NOT NULL CHECK (raw_segment_count >= 0),
  word_count INTEGER NOT NULL CHECK (word_count >= 0),
  detected_language TEXT NOT NULL,
  language_probability REAL,
  warning_codes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asr_raw_segments (
  run_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  text TEXT NOT NULL,
  language TEXT NOT NULL,
  language_probability REAL,
  PRIMARY KEY (run_id, segment_index),
  FOREIGN KEY (run_id) REFERENCES asr_runs(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS asr_words (
  run_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  word_index INTEGER NOT NULL CHECK (word_index >= 0),
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  text TEXT NOT NULL,
  probability REAL,
  raw_start_ms INTEGER,
  raw_end_ms INTEGER,
  repair_codes_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, segment_index, word_index),
  FOREIGN KEY (run_id, segment_index)
    REFERENCES asr_raw_segments(run_id, segment_index) ON DELETE RESTRICT,
  CHECK ((raw_start_ms IS NULL AND raw_end_ms IS NULL) OR (raw_start_ms IS NOT NULL AND raw_end_ms IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_asr_runs_created_at ON asr_runs(created_at, id);
CREATE INDEX IF NOT EXISTS idx_asr_segments_run ON asr_raw_segments(run_id, segment_index);
CREATE INDEX IF NOT EXISTS idx_asr_words_run ON asr_words(run_id, segment_index, word_index);
