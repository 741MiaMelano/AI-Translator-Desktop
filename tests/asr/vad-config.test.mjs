import assert from "node:assert/strict";
import test from "node:test";
import {
  ASR_VAD_RECOMMENDED_PARAMETERS,
  ASR_VAD_PRESET_PARAMETERS,
  DEFAULT_ASR_VAD_SETTINGS,
  effectiveAsrVadParameters,
  normalizeAsrVadSettings,
} from "../../shared/asr-vad-config.mjs";

test("VAD automatic mode resolves the verified whisper.cpp 1.9.1 defaults", () => {
  assert.deepEqual(DEFAULT_ASR_VAD_SETTINGS, {
    mode: "auto",
    customParameters: {
      threshold: 0.5,
      minSpeechDurationMs: 250,
      minSilenceDurationMs: 100,
      maxSpeechDurationSeconds: 0,
      speechPadMs: 30,
      samplesOverlapSeconds: 0.1,
    },
  });
  assert.deepEqual(effectiveAsrVadParameters(DEFAULT_ASR_VAD_SETTINGS), ASR_VAD_RECOMMENDED_PARAMETERS);
  assert.equal(effectiveAsrVadParameters({ ...DEFAULT_ASR_VAD_SETTINGS, mode: "off" }), null);
  assert.ok(ASR_VAD_PRESET_PARAMETERS.gentle.threshold < ASR_VAD_PRESET_PARAMETERS.balanced.threshold);
  assert.ok(ASR_VAD_PRESET_PARAMETERS.strong.threshold > ASR_VAD_PRESET_PARAMETERS.balanced.threshold);
  assert.deepEqual(
    effectiveAsrVadParameters({ mode: "custom", customParameters: ASR_VAD_PRESET_PARAMETERS.strong }),
    ASR_VAD_PRESET_PARAMETERS.strong,
  );
});

test("VAD settings accept bounded custom values and reject unknown or unsafe values", () => {
  const custom = normalizeAsrVadSettings({
    mode: "custom",
    customParameters: {
      threshold: 0.65,
      minSpeechDurationMs: 80,
      minSilenceDurationMs: 450,
      maxSpeechDurationSeconds: 15,
      speechPadMs: 120,
      samplesOverlapSeconds: 0.25,
    },
  });
  assert.deepEqual(effectiveAsrVadParameters(custom), custom.customParameters);
  assert.equal(normalizeAsrVadSettings({
    ...custom,
    customParameters: { ...custom.customParameters, threshold: 1 },
  }).customParameters.threshold, ASR_VAD_RECOMMENDED_PARAMETERS.threshold);

  for (const value of [
    { ...custom, injectedArgv: ["--prompt", "bad"] },
    { ...custom, mode: "sometimes" },
    { ...custom, customParameters: { ...custom.customParameters, threshold: Number.NaN } },
    { ...custom, customParameters: { ...custom.customParameters, threshold: 1.01 } },
    { ...custom, customParameters: { ...custom.customParameters, minSpeechDurationMs: -1 } },
    { ...custom, customParameters: { ...custom.customParameters, minSilenceDurationMs: 60_001 } },
    { ...custom, customParameters: { ...custom.customParameters, maxSpeechDurationSeconds: 86_401 } },
    { ...custom, customParameters: { ...custom.customParameters, speechPadMs: 60_001 } },
    { ...custom, customParameters: { ...custom.customParameters, samplesOverlapSeconds: 60.01 } },
    { ...custom, customParameters: { ...custom.customParameters, argv: "--vad" } },
  ]) {
    assert.throws(() => normalizeAsrVadSettings(value), (error) => error?.code === "INVALID_INPUT");
  }
});
