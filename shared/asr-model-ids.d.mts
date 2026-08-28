export const ASR_MODEL_IDS: readonly [
  "small",
  "large-v3-turbo-q5_0",
  "large-v3-turbo-q8_0",
  "large-v3-turbo",
  "large-v3-q5_0",
  "large-v3",
  "qwen3-asr-0.6b",
  "qwen3-asr-1.7b",
];

export function isAsrModelId(value: unknown): value is typeof ASR_MODEL_IDS[number];
export function asrEngineForModelId(value: unknown): "whisper.cpp" | "qwen3-asr";
