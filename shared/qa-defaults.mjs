/** Phase 5 baseline QA defaults. Not a full settings center. */
export const QA_BASELINE_DEFAULTS = Object.freeze({
  maxLines: 2,
  maxCharsPerLine: 42,
  maxCps: 20,
  minDurationSec: 0.8,
  maxDurationSec: 7,
});

export const QA_RULE_IDS = Object.freeze({
  maxLines: "qa.max_lines",
  maxCharsPerLine: "qa.max_chars_per_line",
  maxCps: "qa.max_cps",
  minDuration: "qa.min_duration",
  maxDuration: "qa.max_duration",
  overlap: "qa.overlap",
  stale: "qa.stale",
  termConflict: "qa.term_conflict",
  invalidRange: "qa.invalid_range",
  missingActiveSourceTrack: "qa.missing_active_source_track",
  missingActiveTargetTrack: "qa.missing_active_target_track",
  emptyTarget: "qa.empty_target",
  suspectedLyrics: "qa.suspected_lyrics",
});
