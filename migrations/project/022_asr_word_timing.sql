ALTER TABLE segments ADD COLUMN asr_word_start_index INTEGER CHECK (asr_word_start_index IS NULL OR asr_word_start_index >= 0);
ALTER TABLE segments ADD COLUMN asr_word_end_index INTEGER CHECK (asr_word_end_index IS NULL OR asr_word_end_index >= asr_word_start_index);
ALTER TABLE segments ADD COLUMN timing_validity TEXT CHECK (timing_validity IS NULL OR timing_validity IN ('valid', 'invalidated_by_structure'));
