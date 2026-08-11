CREATE TABLE target_text_layers_v2 (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  model_text TEXT NOT NULL,
  post_processed_text TEXT NOT NULL,
  manual_text TEXT,
  previous_manual_text TEXT,
  locked INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,
  qa_flags_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (segment_id, language_code)
);

INSERT INTO target_text_layers_v2 (
  segment_id, language_code, model_text, post_processed_text, manual_text,
  previous_manual_text, locked, stale, qa_flags_json
)
SELECT
  segment_id, language_code, model_text, post_processed_text, manual_text,
  previous_manual_text, locked, 0, qa_flags_json
FROM target_text_layers;

DROP TABLE target_text_layers;
ALTER TABLE target_text_layers_v2 RENAME TO target_text_layers;
