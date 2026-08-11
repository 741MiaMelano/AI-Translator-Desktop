ALTER TABLE project_meta ADD COLUMN archived_at TEXT;
ALTER TABLE source_tracks ADD COLUMN trashed_at TEXT;
ALTER TABLE target_tracks ADD COLUMN trashed_at TEXT;
ALTER TABLE target_tracks ADD COLUMN trashed_with_source INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_source_tracks_trashed_at ON source_tracks(trashed_at);
CREATE INDEX IF NOT EXISTS idx_target_tracks_trashed_at ON target_tracks(trashed_at);
