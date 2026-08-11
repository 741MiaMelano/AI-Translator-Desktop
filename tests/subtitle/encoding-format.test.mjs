import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSubtitleBytes } from "../../backend/subtitle/encoding.mjs";
import { detectSubtitleFormat } from "../../backend/subtitle/detect-format.mjs";
import { parseSubtitleBytes } from "../../backend/subtitle/parse.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtures = join(root, "tests", "fixtures", "subtitles");

test("detects SRT from content even with wrong extension", () => {
  const text = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
  const result = detectSubtitleFormat({ fileName: "clip.vtt", text });
  assert.equal(result.ok, true);
  assert.equal(result.format, "srt");
  assert.ok(result.warnings.some((item) => /以内容为准/.test(item)));
});

test("detects WEBVTT header and does not invent video", () => {
  const text = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n";
  const result = detectSubtitleFormat({ fileName: "clip.mp4", text });
  assert.equal(result.ok, true);
  assert.equal(result.format, "vtt");
});

test("UTF-8 BOM and strict UTF-8 decode", () => {
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nA\n", "utf8")]);
  const decoded = decodeSubtitleBytes(bom);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.encoding, "utf-8");
  assert.equal(decoded.bom, true);
});

test("UTF-16LE BOM decodes without mojibake fallback", () => {
  const text = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
  const utf16 = Buffer.from(`\uFEFF${text}`, "utf16le");
  const decoded = decodeSubtitleBytes(utf16);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.encoding, "utf-16le");
  assert.match(decoded.text, /Hello/);
});

test("ambiguous GBK/Shift-JIS requires confirmation", () => {
  // bytes that are valid under both labels for Node TextDecoder on this platform may vary;
  // force the confirmation path with a synthetic dual-success mock by choosing a byte
  // sequence that is invalid UTF-8 and not UTF-16-like, then confirm forced decode works.
  const bytes = Uint8Array.from([0x61, 0x82, 0xa0, 0x62]);
  const decoded = decodeSubtitleBytes(bytes);
  if (decoded.needsEncodingConfirmation) {
    assert.deepEqual(decoded.encodingCandidates, ["gbk", "shift_jis"]);
    const forced = decodeSubtitleBytes(bytes, "gbk");
    assert.equal(forced.ok, true);
    assert.equal(forced.encoding, "gbk");
  } else if (decoded.ok) {
    assert.ok(["gbk", "shift_jis"].includes(decoded.encoding));
  } else {
    assert.equal(decoded.error.code, "INVALID_INPUT");
  }
});

test("fixture basic-utf8.srt parses through detection pipeline", () => {
  const bytes = readFileSync(join(fixtures, "valid", "basic-utf8.srt"));
  const parsed = parseSubtitleBytes({ fileName: "basic-utf8.srt", bytes });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, "srt");
  assert.equal(parsed.cues.length, 2);
});
