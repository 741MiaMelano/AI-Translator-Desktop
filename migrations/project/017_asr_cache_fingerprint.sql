ALTER TABLE asr_runs ADD COLUMN cache_fingerprint TEXT
  CHECK (cache_fingerprint IS NULL OR (
    length(cache_fingerprint) = 64 AND
    cache_fingerprint NOT GLOB '*[^a-f0-9]*'
  ));
