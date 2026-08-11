import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAss, serializeAss } from "../../backend/subtitle/ass.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtures = join(root, "tests", "fixtures", "subtitles");

test("parses basic ASS fixture and strips tags from editable text", () => {
  const text = readFileSync(join(fixtures, "valid", "basic.ass"), "utf8");
  const parsed = parseAss(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, "ass");
  assert.equal(parsed.cues.length, 2);
  assert.ok(parsed.cues.every((cue) => !/\{\\/.test(cue.text)));
});

test("keeps commas inside dialogue text", () => {
  const text = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello, world, again",
    "",
  ].join("\n");
  const parsed = parseAss(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cues[0].text, "Hello, world, again");
});

test("SSA input normalizes and ASS subset export round-trips text timeline", () => {
  const text = [
    "[Script Info]",
    "ScriptType: v4.00",
    "",
    "[V4 Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding",
    "Style: Default,Arial,20,16777215,65535,65535,-2147483640,0,0,1,2,0,2,10,10,10,0,1",
    "",
    "[Events]",
    "Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0000,0000,0000,,Plain text",
    "",
  ].join("\n");
  const parsed = parseAss(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, "ssa");
  const serialized = serializeAss(parsed.cues);
  const second = parseAss(serialized);
  assert.equal(second.ok, true);
  assert.equal(second.format, "ass");
  assert.equal(second.cues[0].text, "Plain text");
  assert.equal(second.cues[0].startMs, 1000);
});
