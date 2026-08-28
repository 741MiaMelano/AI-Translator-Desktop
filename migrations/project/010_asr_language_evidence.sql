ALTER TABLE segments ADD COLUMN detected_language TEXT;
ALTER TABLE segments ADD COLUMN language_confidence REAL;
ALTER TABLE segments ADD COLUMN language_detection_method TEXT;
ALTER TABLE segments ADD COLUMN language_detection_version TEXT;
ALTER TABLE segments ADD COLUMN manual_language TEXT;
ALTER TABLE segments ADD COLUMN language_overlap_status TEXT;
