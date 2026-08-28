import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { alignAsrResultToPcmSilence } from "../../backend/asr/pcm-silence-aligner.mjs";

function pcmWav(parts, sampleRate = 16_000) {
  const samples = Int16Array.from(parts.flat());
  const dataBytes = samples.byteLength;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) wav.writeInt16LE(samples[index], 44 + index * 2);
  return wav;
}

const tone = (samples) => Array.from({ length: samples }, (_, index) =>
  Math.round(Math.sin(index / 8) * 12_000));

test("clear PCM silence trims a Whisper word tail without moving speech or text", () => {
  const root = mkdtempSync(join(tmpdir(), "pcm-silence-aligner-"));
  try {
    const wavPath = join(root, "speech-gap.wav");
    writeFileSync(wavPath, pcmWav([tone(16_000), Array(9_600).fill(0), tone(16_000)]));
    const source = {
      schemaVersion: 1,
      mediaDurationMs: 2_600,
      detectedLanguage: "en",
      languageProbability: null,
      warnings: [],
      segments: [{
        startMs: 0,
        endMs: 2_600,
        text: " First. Next.",
        language: "en",
        languageProbability: null,
        words: [
          { startMs: 0, endMs: 1_600, text: " First.", probability: 0.9 },
          { startMs: 1_600, endMs: 2_600, text: " Next.", probability: 0.9 },
        ],
      }],
    };

    const aligned = alignAsrResultToPcmSilence(source, wavPath);

    assert.equal(aligned.segments[0].words[0].startMs, 0);
    assert.equal(aligned.segments[0].words[0].endMs, 1_000);
    assert.equal(aligned.segments[0].words[0].rawEndMs, 1_600);
    assert.deepEqual(aligned.segments[0].words[0].repairCodes, ["audio_silence_boundary_aligned"]);
    assert.deepEqual(aligned.segments[0].words[1], source.segments[0].words[1]);
    assert.equal(aligned.segments[0].text, source.segments[0].text);
    assert.deepEqual(aligned.warnings, ["audio_silence_boundary_aligned"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("original VAD time mapping survives leading silence, short pauses, tiny speech and split segments before PCM alignment", () => {
  const root = mkdtempSync(join(tmpdir(), "pcm-vad-time-map-"));
  try {
    const wavPath = join(root, "vad-mapped.wav");
    writeFileSync(wavPath, pcmWav([
      Array(32_000).fill(0),
      tone(3_200),
      Array(1_600).fill(0),
      tone(22_400),
      Array.from({ length: 8_000 }, (_, index) => Math.round(Math.sin(index / 4) * 1_200)),
      Array(24_000).fill(0),
      tone(8_000),
      Array(48_000).fill(0),
    ]));
    const source = {
      schemaVersion: 1,
      mediaDurationMs: 10_000,
      detectedLanguage: "en",
      languageProbability: null,
      warnings: [],
      segments: [
        {
          startMs: 2_000, endMs: 2_200, text: " Ah.", language: "en", languageProbability: null,
          words: [{ startMs: 2_000, endMs: 2_200, text: " Ah.", probability: 0.8 }],
        },
        {
          startMs: 2_300, endMs: 3_700, text: " First split.", language: "en", languageProbability: null,
          words: [{ startMs: 2_300, endMs: 3_700, text: " First split.", probability: 0.9 }],
        },
        {
          startMs: 5_200, endMs: 5_700, text: " Second split.", language: "en", languageProbability: null,
          words: [{ startMs: 5_200, endMs: 5_700, text: " Second split.", probability: 0.9 }],
        },
      ],
    };

    const aligned = alignAsrResultToPcmSilence(source, wavPath);
    assert.deepEqual(
      aligned.segments.map(({ startMs, endMs }) => ({ startMs, endMs })),
      [{ startMs: 2_000, endMs: 2_200 }, { startMs: 2_300, endMs: 3_700 }, { startMs: 5_200, endMs: 5_700 }],
    );
    assert.deepEqual(aligned.segments.map((segment) => segment.words[0].startMs), [2_000, 2_300, 5_200]);
    assert.equal(aligned.segments.every((segment, index) => index === 0 || segment.startMs >= aligned.segments[index - 1].endMs), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
