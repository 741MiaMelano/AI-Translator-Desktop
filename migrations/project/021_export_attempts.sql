CREATE TABLE IF NOT EXISTS export_attempts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  destination_kind TEXT NOT NULL CHECK (destination_kind IN ('project', 'user')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  export_record_id TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  retry_of_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_export_attempts_created_at
  ON export_attempts(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_export_attempts_retry_of
  ON export_attempts(retry_of_id);
