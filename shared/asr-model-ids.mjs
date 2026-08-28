export const ASR_MODEL_IDS = Object.freeze([
  "small",
  "large-v3-turbo-q5_0",
  "large-v3-turbo-q8_0",
  "large-v3-turbo",
  "large-v3-q5_0",
  "large-v3",
  "qwen3-asr-0.6b",
  "qwen3-asr-1.7b",
]);

const ids = new Set(ASR_MODEL_IDS);

export function isAsrModelId(value) {
  return ids.has(value);
}

export function asrEngineForModelId(value) {
  return typeof value === "string" && value.startsWith("qwen3-asr-") ? "qwen3-asr" : "whisper.cpp";
}
