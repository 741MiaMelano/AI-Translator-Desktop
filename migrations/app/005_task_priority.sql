ALTER TABLE task_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS task_queue_priority_created
  ON task_queue(status, priority DESC, created_at ASC);
