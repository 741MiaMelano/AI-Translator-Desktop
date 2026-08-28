ALTER TABLE project_task_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'translate';
ALTER TABLE project_task_history ADD COLUMN checkpoint_stage TEXT;
ALTER TABLE project_task_history ADD COLUMN last_error_code TEXT;
ALTER TABLE project_task_history ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_task_history ADD COLUMN run_snapshot_id TEXT;
ALTER TABLE project_task_history ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_task_history ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS project_task_history_queue_sequence
  ON project_task_history(queue_task_id, sequence)
  WHERE queue_task_id IS NOT NULL;
