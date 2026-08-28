ALTER TABLE project_index ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_project_index_archived_at ON project_index(archived_at, updated_at);
