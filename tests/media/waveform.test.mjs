import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWaveformArgv,
  decodeWaveformPeaks,
} from "../../backend/media/waveform.mjs";

test("waveform extraction is bounded and selects the confirmed audio stream", () => {
  const argv = buildWaveformArgv("C:\\media\\sample.mkv", 2, 60_000);
  assert.deepEqual(argv.slice(0, 7), [
    "-hide_banner", "-nostdin", "-i", "C:\\media\\sample.mkv", "-map", "0:2", "-vn",
  ]);
  assert.ok(argv.includes("f32le"));
  const rate = Number(argv[argv.indexOf("-ar") + 1]);
  assert.ok(rate >= 8 && rate <= 200);
});

test("float samples become normalized, bounded waveform peaks", () => {
  const samples = new Float32Array([0, -0.25, 0.5, -1, 0.2, -0.8, 0.1, 0.4]);
  const peaks = decodeWaveformPeaks(Buffer.from(samples.buffer), 4);

  assert.equal(peaks.length, 4);
  assert.deepEqual(peaks, [0.25, 1, 0.8, 0.4]);
  assert.ok(peaks.every((value) => value >= 0 && value <= 1));

  const quiet = new Float32Array([0.01, -0.02, 0.05, -0.1]);
  assert.equal(Math.max(...decodeWaveformPeaks(Buffer.from(quiet.buffer), 4)), 1);
});
