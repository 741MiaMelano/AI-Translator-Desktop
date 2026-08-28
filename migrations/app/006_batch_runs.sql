CREATE TABLE IF NOT EXISTS batch_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  project_ids_json TEXT NOT NULL,
  groups_json TEXT NOT NULL,
  defaults_json TEXT NOT NULL,
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS batch_runs_status_updated
  ON batch_runs(status, updated_at DESC);
