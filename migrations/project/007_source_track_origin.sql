-- Keep each Source Track's raw asset separate from the Main Media Source.

ALTER TABLE source_tracks ADD COLUMN raw_asset_relative_path TEXT;
ALTER TABLE source_tracks ADD COLUMN source_stream_id TEXT;

-- Repair Phase 6 databases where the latest extracted raw subtitle replaced
-- the copied/reference media pointer.
UPDATE source_tracks
SET raw_asset_relative_path = (SELECT project_relative_path FROM source_file WHERE id = 'primary'),
    source_stream_id = (SELECT selected_subtitle_stream_id FROM source_file WHERE id = 'primary')
WHERE id = (
  SELECT id FROM source_tracks ORDER BY is_active DESC, sort_order DESC LIMIT 1
)
AND EXISTS (
  SELECT 1 FROM source_file
  WHERE id = 'primary'
    AND media_kind IN ('video', 'audio')
    AND project_relative_path LIKE 'artifacts/raw/%'
);

UPDATE source_file
SET project_relative_path = NULL
WHERE id = 'primary'
  AND media_kind IN ('video', 'audio')
  AND project_relative_path LIKE 'artifacts/raw/%';

UPDATE source_tracks
SET raw_asset_relative_path = (SELECT project_relative_path FROM source_file WHERE id = 'primary')
WHERE kind = 'external_subtitle'
  AND is_active = 1
  AND EXISTS (
    SELECT 1 FROM source_file
    WHERE id = 'primary'
      AND media_kind = 'subtitle'
      AND project_relative_path LIKE 'artifacts/raw/%'
  );
