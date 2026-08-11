ALTER TABLE task_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'translate';
ALTER TABLE task_queue ADD COLUMN checkpoint_stage TEXT;
ALTER TABLE task_queue ADD COLUMN last_error_code TEXT;
ALTER TABLE task_queue ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_queue ADD COLUMN run_snapshot_id TEXT;
ALTER TABLE task_queue ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_queue ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_queue ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE task_queue ADD COLUMN pause_capability TEXT NOT NULL DEFAULT 'checkpoint';

CREATE INDEX IF NOT EXISTS task_queue_status_updated
  ON task_queue(status, updated_at DESC);
