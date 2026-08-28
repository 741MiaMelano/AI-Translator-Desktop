import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { validateAsrResult } from "./asr-contract.mjs";

const ALIGNMENT_CODE = "audio_silence_boundary_aligned";
const FRAME_SAMPLES = 320;
const FRAME_MS = 20;
const MIN_SILENCE_FRAMES = 15;
const MAX_LOUD_BRIDGE_FRAMES = 2;
const MIN_WORD_MS = 20;

function readAt(fd, length, position) {
  const value = Buffer.alloc(length);
  return readSync(fd, value, 0, length, position) === length ? value : null;
}

function pcmData(fd) {
  const file = fstatSync(fd);
  const header = readAt(fd, 12, 0);
  if (!header || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= file.size;) {
    const chunk = readAt(fd, 8, offset);
    if (!chunk) return null;
    const id = chunk.toString("ascii", 0, 4);
    const size = chunk.readUInt32LE(4);
    const payload = offset + 8;
    if (payload + size > file.size) return null;
    if (id === "fmt " && size >= 16) {
      const value = readAt(fd, 16, payload);
      if (!value) return null;
      format = {
        encoding: value.readUInt16LE(0),
        channels: value.readUInt16LE(2),
        sampleRate: value.readUInt32LE(4),
        blockAlign: value.readUInt16LE(12),
        bitsPerSample: value.readUInt16LE(14),
      };
    }
    if (id === "data") data = { offset: payload, size };
    if (format && data) break;
    offset = payload + size + (size % 2);
  }
  if (
    !format || !data || format.encoding !== 1 || format.channels !== 1 ||
    format.sampleRate !== 16_000 || format.blockAlign !== 2 || format.bitsPerSample !== 16 ||
    data.size < 2
  ) return null;
  return data;
}

function scanFrames(fd, data, visit) {
  const buffer = Buffer.alloc(1024 * 1024);
  let position = data.offset;
  let remaining = data.size - (data.size % 2);
  let sumSquares = 0;
  let samples = 0;
  let frame = 0;
  while (remaining > 0) {
    const requested = Math.min(buffer.length, remaining);
    const bytes = readSync(fd, buffer, 0, requested, position);
    if (bytes <= 0 || bytes % 2 !== 0) throw new Error("PCM data is truncated");
    for (let offset = 0; offset < bytes; offset += 2) {
      const sample = buffer.readInt16LE(offset);
      sumSquares += sample * sample;
      samples += 1;
      if (samples === FRAME_SAMPLES) {
        visit(frame, Math.max(-120, 20 * Math.log10(Math.sqrt(sumSquares / samples) / 32_768 || 1e-6)));
        frame += 1;
        sumSquares = 0;
        samples = 0;
      }
    }
    position += bytes;
    remaining -= bytes;
  }
  if (samples > 0) visit(frame, Math.max(-120, 20 * Math.log10(Math.sqrt(sumSquares / samples) / 32_768 || 1e-6)));
}

function percentile(histogram, count, fraction) {
  const target = Math.max(1, Math.ceil(count * fraction));
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index];
    if (seen >= target) return index - 120;
  }
  return 0;
}

function detectSilences(wavPath) {
  const fd = openSync(wavPath, "r");
  try {
    const data = pcmData(fd);
    if (!data) return [];
    const histogram = new Uint32Array(121);
    let frameCount = 0;
    scanFrames(fd, data, (_frame, db) => {
      histogram[Math.max(0, Math.min(120, Math.floor(db) + 120))] += 1;
      frameCount += 1;
    });
    if (frameCount < MIN_SILENCE_FRAMES) return [];
    const threshold = Math.min(-24, Math.max(-55, percentile(histogram, frameCount, 0.3)));
    if (percentile(histogram, frameCount, 0.8) - threshold < 6) return [];

    const intervals = [];
    let startFrame = -1;
    let lastQuietFrame = -1;
    let loudFrames = 0;
    const finish = () => {
      if (startFrame >= 0 && lastQuietFrame - startFrame + 1 >= MIN_SILENCE_FRAMES) {
        intervals.push({ startMs: startFrame * FRAME_MS, endMs: (lastQuietFrame + 1) * FRAME_MS });
      }
      startFrame = -1;
      lastQuietFrame = -1;
      loudFrames = 0;
    };
    scanFrames(fd, data, (frame, db) => {
      if (db <= threshold) {
        if (startFrame < 0) startFrame = frame;
        lastQuietFrame = frame;
        loudFrames = 0;
      } else if (startFrame >= 0 && ++loudFrames > MAX_LOUD_BRIDGE_FRAMES) {
        finish();
      }
    });
    finish();
    return intervals;
  } finally {
    closeSync(fd);
  }
}

function alignedWord(word, silences) {
  let startMs = word.startMs;
  let endMs = word.endMs;
  for (const silence of silences) {
    if (endMs <= silence.startMs || startMs >= silence.endMs) continue;
    const leftSpeechMs = Math.max(0, silence.startMs - startMs);
    const rightSpeechMs = Math.max(0, endMs - silence.endMs);
    if (leftSpeechMs >= rightSpeechMs && leftSpeechMs >= MIN_WORD_MS) endMs = silence.startMs;
    else if (rightSpeechMs >= MIN_WORD_MS) startMs = silence.endMs;
  }
  if (endMs - startMs < MIN_WORD_MS || (startMs === word.startMs && endMs === word.endMs)) return word;
  return {
    ...word,
    startMs,
    endMs,
    rawStartMs: word.rawStartMs ?? word.startMs,
    rawEndMs: word.rawEndMs ?? word.endMs,
    repairCodes: [...new Set([...(word.repairCodes ?? []), ALIGNMENT_CODE])],
  };
}

export function alignAsrResultToPcmSilence(rawResult, wavPath) {
  const result = validateAsrResult(rawResult);
  let silences;
  try {
    silences = detectSilences(wavPath);
  } catch {
    return result;
  }
  if (!silences.length) return result;
  let changed = false;
  const segments = result.segments.map((segment) => ({
    ...segment,
    words: segment.words.map((word) => {
      const next = alignedWord(word, silences);
      if (next !== word) changed = true;
      return next;
    }),
  }));
  if (!changed) return result;
  return validateAsrResult({
    ...result,
    warnings: [...new Set([...result.warnings, ALIGNMENT_CODE])],
    segments,
  });
}
