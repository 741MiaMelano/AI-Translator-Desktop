ALTER TABLE project_config ADD COLUMN asr_model_id TEXT
  CHECK (asr_model_id IS NULL OR asr_model_id IN (
    'small',
    'large-v3-turbo-q5_0',
    'large-v3-turbo-q8_0',
    'large-v3-turbo',
    'large-v3-q5_0',
    'large-v3'
  ));
