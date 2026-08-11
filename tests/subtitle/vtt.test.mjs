import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVtt, serializeVtt } from "../../backend/subtitle/vtt.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtures = join(root, "tests", "fixtures", "subtitles");

test("parses unicode space filename fixture", () => {
  const text = readFileSync(join(fixtures, "valid", "中文 空格.vtt"), "utf8");
  const parsed = parseVtt(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues.length, 2);
  assert.ok(!parsed.cues.some((cue) => /WEBVTT/.test(cue.text)));
});

test("NOTE STYLE REGION are not cues and degrade explicitly", () => {
  const text = [
    "WEBVTT",
    "",
    "NOTE this is a note",
    "",
    "STYLE",
    "::cue { color: red; }",
    "",
    "REGION",
    "id:fred",
    "",
    "cue-1",
    "00:00:01.000 --> 00:00:02.000 align:start",
    "Hello",
    "",
  ].join("\n");
  const parsed = parseVtt(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0].text, "Hello");
  assert.equal(parsed.cues[0].identifier, "cue-1");
  assert.equal(parsed.cues[0].settings, "align:start");
  assert.ok(parsed.warnings.some((item) => /NOTE|STYLE|REGION/i.test(item)));
  assert.ok(parsed.warnings.some((item) => /会丢失|只保留/.test(item)));
});

test("rejects a malformed timing block instead of silently dropping its cue", () => {
  const parsed = parseVtt([
    "WEBVTT",
    "",
    "00:00:01.000 --> not-a-time",
    "Must not disappear",
    "",
    "00:00:03.000 --> 00:00:04.000",
    "Valid cue",
    "",
  ].join("\n"));

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  assert.match(parsed.error.message, /timing/i);
});

test("VTT round-trip keeps timeline and text", () => {
  const text = readFileSync(join(fixtures, "valid", "中文 空格.vtt"), "utf8");
  const first = parseVtt(text);
  const serialized = serializeVtt(first.cues.map(({ startMs, endMs, text: body }) => ({ startMs, endMs, text: body })));
  const second = parseVtt(serialized);
  assert.deepEqual(
    second.cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text })),
    first.cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text })),
  );
});
