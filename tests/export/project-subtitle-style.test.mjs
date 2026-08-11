import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportSubtitleMatrix } from "../../backend/export/project-export.mjs";
import { serializeAss } from "../../backend/subtitle/ass.mjs";

const primary = {
  fontFamily: "Noto Sans CJK SC",
  fontSizePx: 36,
  textColor: "#123456",
  outlineColor: "#ABCDEF",
  outlineWidthPx: 3,
  shadowColor: "#010203",
  shadowDepthPx: 2,
  position: "bottom",
};

const secondary = {
  fontFamily: "Courier New",
  fontSizePx: 20,
  textColor: "#FFEEDD",
  outlineColor: "#112233",
  outlineWidthPx: 1,
  shadowColor: "#445566",
  shadowDepthPx: 1,
  position: "top",
};

function subtitleStyle(bilingualLayout) {
  return {
    format: "ass",
    bilingualLayout,
    primary,
    secondary,
    preview: {
      sourceText: "Source preview",
      targetText: "Target preview",
      direction: "auto",
      backgroundColor: "#101010",
    },
  };
}

function projectFixture(bilingualLayout) {
  return {
    id: "styled-project",
    title: "Styled project",
    activeSourceTrackId: "source-main",
    config: { subtitleStyle: subtitleStyle(bilingualLayout) },
    sourceTracks: [{
      id: "source-main",
      isActive: true,
      targetTracks: [{
        id: "target-zh",
        languageCode: "zh-CN",
        status: "approved",
        isActive: true,
        qaIssues: [],
      }],
      segments: [{
        id: "segment-1",
        start: "00:00:00,000",
        end: "00:00:02,000",
        sourceText: { original: "SOURCE LINE", normalized: "SOURCE LINE" },
        targetTexts: {
          "zh-CN": { model: "TARGET LINE", postProcessed: "TARGET LINE", qaFlags: [] },
        },
      }],
    }],
  };
}

function exportAss(layout) {
  const containerDir = mkdtempSync(join(tmpdir(), "subtitle-style-export-"));
  const summary = exportSubtitleMatrix({
    project: projectFixture(layout),
    containerDir,
    requests: [{
      id: layout,
      exportKind: "bilingual",
      targetLanguageCode: "zh-CN",
      format: "ass",
    }],
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(summary.ok, true);
  return {
    containerDir,
    text: readFileSync(join(containerDir, summary.succeeded[0].exportRecord.path), "utf8"),
  };
}

test("ASS style serialization writes font, size, and #RRGGBB colors as BGR", () => {
  const output = serializeAss([
    { startMs: 0, endMs: 1_000, style: "Target", text: "Styled" },
  ], { styles: { Target: primary } });
  const fields = output.split("\n").find((line) => line.startsWith("Style: Target,"))?.split(",");

  assert.equal(fields?.[1], "Noto Sans CJK SC");
  assert.equal(fields?.[2], "36");
  assert.equal(fields?.[3], "&H00563412");
  assert.equal(fields?.[5], "&H00EFCDAB");
  assert.equal(fields?.[6], "&H00030201");
});

test("project ASS export preserves the selected bilingual event order", () => {
  for (const [layout, expected] of [
    ["source_top_target_bottom", ["Source", "Target"]],
    ["target_top_source_bottom", ["Target", "Source"]],
  ]) {
    const exported = exportAss(layout);
    try {
      const dialogue = exported.text.split(/\r?\n/).filter((line) => line.startsWith("Dialogue:"));
      assert.deepEqual(dialogue.map((line) => line.split(",")[3]), expected);
      assert.match(dialogue[0], new RegExp(`${expected[0] === "Source" ? "SOURCE" : "TARGET"} LINE$`));
      assert.match(dialogue[1], new RegExp(`${expected[1] === "Source" ? "SOURCE" : "TARGET"} LINE$`));
      assert.match(exported.text, /^Style: Target,Noto Sans CJK SC,36,/m);
      assert.match(exported.text, /^Style: Source,Courier New,20,/m);
    } finally {
      rmSync(exported.containerDir, { recursive: true, force: true });
    }
  }
});

test("target_only project ASS export emits only the target cue", () => {
  const exported = exportAss("target_only");
  try {
    const dialogue = exported.text.split(/\r?\n/).filter((line) => line.startsWith("Dialogue:"));
    assert.equal(dialogue.length, 1);
    assert.match(dialogue[0], /,Target,.*TARGET LINE$/);
    assert.doesNotMatch(dialogue[0], /SOURCE LINE/);
  } finally {
    rmSync(exported.containerDir, { recursive: true, force: true });
  }
});
