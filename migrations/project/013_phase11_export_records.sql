ALTER TABLE export_records ADD COLUMN track_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE export_records ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE export_records ADD COLUMN destination_kind TEXT NOT NULL DEFAULT 'project';

CREATE INDEX IF NOT EXISTS idx_export_records_created_at
  ON export_records(created_at, id);

CREATE INDEX IF NOT EXISTS idx_export_records_target_track
  ON export_records(target_track_id, created_at);
