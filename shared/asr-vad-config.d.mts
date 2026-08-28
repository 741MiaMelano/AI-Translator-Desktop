export type AsrVadMode = "auto" | "off" | "custom";
export interface AsrVadParameters {
  threshold: number;
  minSpeechDurationMs: number;
  minSilenceDurationMs: number;
  maxSpeechDurationSeconds: number;
  speechPadMs: number;
  samplesOverlapSeconds: number;
}
export interface AsrVadSettings {
  mode: AsrVadMode;
  customParameters: AsrVadParameters;
}
export const ASR_VAD_RECOMMENDED_PARAMETERS: Readonly<AsrVadParameters>;
export const ASR_VAD_PRESET_PARAMETERS: Readonly<{
  gentle: Readonly<AsrVadParameters>;
  balanced: Readonly<AsrVadParameters>;
  strong: Readonly<AsrVadParameters>;
}>;
export const DEFAULT_ASR_VAD_SETTINGS: Readonly<AsrVadSettings>;
export function normalizeAsrVadParameters(value: unknown): AsrVadParameters;
export function normalizeAsrVadSettings(value: unknown): AsrVadSettings;
export function effectiveAsrVadParameters(settings: unknown): AsrVadParameters | null;
