CREATE TABLE IF NOT EXISTS candidate_track_metadata (
  target_track_id TEXT PRIMARY KEY REFERENCES target_tracks(id) ON DELETE CASCADE,
  base_track_id TEXT
);

CREATE TABLE IF NOT EXISTS candidate_target_text_layers (
  target_track_id TEXT NOT NULL REFERENCES target_tracks(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  model_text TEXT NOT NULL,
  post_processed_text TEXT NOT NULL,
  manual_text TEXT,
  previous_manual_text TEXT,
  locked INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,
  qa_flags_json TEXT NOT NULL DEFAULT '[]',
  origin TEXT,
  PRIMARY KEY (target_track_id, segment_id)
);

CREATE TABLE IF NOT EXISTS editor_history (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  undo_stack_json TEXT NOT NULL DEFAULT '[]',
  redo_stack_json TEXT NOT NULL DEFAULT '[]'
);
