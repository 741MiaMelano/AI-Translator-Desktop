import { QA_BASELINE_DEFAULTS } from "./qa-defaults.mjs";

export const ASR_SEGMENTATION_CONFIG_VERSION = "asr-segmentation-v2";

export const ASR_SEGMENTATION_CONFIG = Object.freeze({
  version: ASR_SEGMENTATION_CONFIG_VERSION,
  maxLines: QA_BASELINE_DEFAULTS.maxLines,
  maxCharsPerLine: QA_BASELINE_DEFAULTS.maxCharsPerLine,
  maxCps: QA_BASELINE_DEFAULTS.maxCps,
  minDurationMs: QA_BASELINE_DEFAULTS.minDurationSec * 1_000,
  maxDurationMs: QA_BASELINE_DEFAULTS.maxDurationSec * 1_000,
  minGapMs: 20,
  preferredPauseMs: 700,
  secondaryPauseMs: 350,
});
