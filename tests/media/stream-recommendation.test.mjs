import assert from "node:assert/strict";
import test from "node:test";
import { recommendStreams } from "../../backend/media/stream-recommendation.mjs";

function probeWith(streams) {
  return {
    mediaKind: "video",
    format: { formatName: "matroska", durationMs: 1000, sizeBytes: 10 },
    streams,
    warnings: [],
    probeVersion: 1,
    artifact: { upstreamVersion: null, ffprobeSha256: null },
  };
}

test("input order changes do not change recommendation", () => {
  const streams = [
    { streamId: "s:0", index: 0, kind: "subtitle", codec: "subrip", language: "jpn", title: null, default: false, forced: false, extractable: true, width: null, height: null, channels: null, sampleRate: null },
    { streamId: "s:1", index: 1, kind: "subtitle", codec: "subrip", language: "eng", title: null, default: true, forced: false, extractable: true, width: null, height: null, channels: null, sampleRate: null },
    { streamId: "s:2", index: 2, kind: "audio", codec: "aac", language: "eng", title: null, default: true, forced: false, extractable: false, width: null, height: null, channels: 2, sampleRate: 48000 },
  ];
  const a = recommendStreams(probeWith(streams), { preferredSourceLanguage: "eng" });
  const b = recommendStreams(probeWith([...streams].reverse()), { preferredSourceLanguage: "eng" });
  assert.deepEqual(a.subtitle.streamId, b.subtitle.streamId);
  assert.deepEqual(a.audio.streamId, b.audio.streamId);
  assert.equal(a.subtitle.streamId, "s:1");
});

test("saved invalid selection falls back with warning", () => {
  const result = recommendStreams(
    probeWith([
      { streamId: "s:0", index: 0, kind: "subtitle", codec: "subrip", language: "eng", title: null, default: true, forced: false, extractable: true, width: null, height: null, channels: null, sampleRate: null },
      { streamId: "s:1", index: 1, kind: "audio", codec: "aac", language: null, title: null, default: true, forced: false, extractable: false, width: null, height: null, channels: 2, sampleRate: 48000 },
    ]),
    { savedSubtitleStreamId: "s:99", preferredSourceLanguage: "eng" },
  );
  assert.equal(result.subtitle.streamId, "s:0");
  assert.ok(result.warnings.some((w) => w.code === "SAVED_SUBTITLE_INVALID"));
});

test("bitmap never recommended as extractable; no ASR auto start", () => {
  const result = recommendStreams(
    probeWith([
      { streamId: "s:0", index: 0, kind: "subtitle", codec: "hdmv_pgs_subtitle", language: "eng", title: null, default: true, forced: false, extractable: false, width: null, height: null, channels: null, sampleRate: null },
      { streamId: "s:1", index: 1, kind: "audio", codec: "aac", language: "eng", title: null, default: true, forced: false, extractable: false, width: null, height: null, channels: 2, sampleRate: 48000 },
    ]),
    { preferredSourceLanguage: "eng" },
  );
  assert.equal(result.subtitle.streamId, null);
  assert.equal(result.autoStartAsr, false);
  assert.equal(result.audio.streamId, "s:1");
});

test("tied candidates require confirmation with low confidence", () => {
  const result = recommendStreams(
    probeWith([
      { streamId: "s:0", index: 0, kind: "subtitle", codec: "subrip", language: null, title: null, default: false, forced: false, extractable: true, width: null, height: null, channels: null, sampleRate: null },
      { streamId: "s:1", index: 1, kind: "subtitle", codec: "subrip", language: null, title: null, default: false, forced: false, extractable: true, width: null, height: null, channels: null, sampleRate: null },
    ]),
  );
  assert.equal(result.subtitle.requiresConfirmation, true);
  assert.equal(result.subtitle.confidence, "low");
  assert.ok(result.subtitle.reasonCodes.includes("TIE_BREAK_BY_INDEX"));
  assert.equal(result.subtitle.streamId, "s:0");
});

test("und/null does not pretend language match and does not mutate input", () => {
  const input = probeWith([
    { streamId: "s:0", index: 0, kind: "audio", codec: "aac", language: null, title: null, default: true, forced: false, extractable: false, width: null, height: null, channels: 2, sampleRate: 48000 },
  ]);
  const before = JSON.stringify(input);
  const result = recommendStreams(input, { preferredSourceLanguage: "eng" });
  assert.ok(!result.audio.reasonCodes.includes("SOURCE_LANGUAGE_MATCH"));
  assert.equal(JSON.stringify(input), before);
});
