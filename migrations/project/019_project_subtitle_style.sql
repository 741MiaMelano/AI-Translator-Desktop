ALTER TABLE project_config ADD COLUMN subtitle_style_json TEXT;

-- “复制到项目”过去只留下了快照但没有消费者。升级时激活最近一次复制的字幕样式。
UPDATE project_config
SET subtitle_style_json = (
  SELECT payload_json
  FROM resource_snapshots
  WHERE resource_kind = 'subtitle_style'
  ORDER BY captured_at DESC, id ASC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM resource_snapshots WHERE resource_kind = 'subtitle_style'
);
