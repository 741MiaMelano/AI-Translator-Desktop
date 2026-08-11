import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSrt, serializeSrt } from "../../backend/subtitle/srt.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtures = join(root, "tests", "fixtures", "subtitles");

test("parses basic utf8 fixture without hardcoding body text", () => {
  const text = readFileSync(join(fixtures, "valid", "basic-utf8.srt"), "utf8");
  const parsed = parseSrt(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].startMs, 1000);
  assert.equal(parsed.cues[0].endMs, 3000);
  assert.equal(parsed.cues[1].startMs, 4000);
  assert.equal(parsed.cues[1].endMs, 6500);
  assert.ok(parsed.cues.every((cue) => typeof cue.text === "string" && cue.text.length > 0));
});

test("supports optional index, CRLF, multiline, and long timestamps", () => {
  const text = [
    "00:00:01,000 --> 00:00:02,000",
    "line one",
    "line two",
    "",
    "99",
    "25:00:00,000 --> 25:00:01,500",
    "long hour",
    "",
  ].join("\r\n");
  const parsed = parseSrt(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].text, "line one\nline two");
  assert.equal(parsed.cues[1].startMs, ((25 * 60) * 60) * 1000);
});

test("rejects invalid timestamps and end before start", () => {
  const invalid = parseSrt(readFileSync(join(fixtures, "invalid", "invalid-timestamp.srt"), "utf8"));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_INPUT");

  const reversed = parseSrt("1\n00:00:03,000 --> 00:00:01,000\nnope\n");
  assert.equal(reversed.ok, false);

  const empty = parseSrt("");
  assert.equal(empty.ok, false);
});

test("round-trips parse -> serialize -> parse", () => {
  const text = readFileSync(join(fixtures, "valid", "basic-utf8.srt"), "utf8");
  const first = parseSrt(text);
  assert.equal(first.ok, true);
  const serialized = serializeSrt(first.cues);
  const second = parseSrt(serialized);
  assert.equal(second.ok, true);
  assert.deepEqual(
    second.cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text })),
    first.cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text })),
  );
});
