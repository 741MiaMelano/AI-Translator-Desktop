import test from "node:test";
import assert from "node:assert/strict";

import { RESOURCE_CONTRACT_VERSION } from "../../src/domain/resource-library.ts";
import { resourceLibraryMock } from "../../src/mock/resource-library.ts";
import { normalizeResourceWrite } from "../../shared/resource-library.mjs";
import { describePayloadProblem } from "../../src/components/feature/resource-library/payload.ts";
import { readFileSync } from "node:fs";

test("resource seed follows the single Phase 10 contract", () => {
  const resources = Object.values(resourceLibraryMock).flat();

  assert.ok(resources.length > 0);
  assert.deepEqual(
    new Set(resources.map((resource) => resource.kind)),
    new Set(["glossary", "style_guide", "subtitle_style", "export_preset"]),
  );

  for (const resource of resources) {
    assert.equal(resource.scope, "global");
    assert.equal(resource.schemaVersion, RESOURCE_CONTRACT_VERSION);
    assert.ok(Number.isSafeInteger(resource.revision) && resource.revision > 0);
  }

  for (const glossary of resourceLibraryMock.glossaries) {
    assert.ok(glossary.payload.languagePairs.length > 0);
    for (const pair of glossary.payload.languagePairs) {
      assert.ok(pair.sourceLanguageCode);
      assert.ok(pair.targetLanguageCode);
    }
  }
  assert.ok(resourceLibraryMock.glossaries[0].payload.languagePairs.length > 1);

  for (const guide of resourceLibraryMock.styleGuides) {
    assert.ok(guide.payload.targetLanguageCode);
  }

  for (const style of resourceLibraryMock.subtitleStyles) {
    assert.equal(style.payload.format, "ass");
    assert.ok(style.payload.primary.fontFamily);
    assert.ok(style.payload.secondary.fontFamily);
  }

  for (const preset of resourceLibraryMock.exportPresets) {
    assert.ok(preset.payload.outputs.length > 0);
    assert.equal("activeTrackId" in preset.payload, false);
    assert.equal("subtitleStyleId" in preset.payload, false);
  }
});

test("subtitle styles and export presets reject cross-owned fields", () => {
  const subtitleStyle = resourceLibraryMock.subtitleStyles[0];
  assert.throws(
    () => normalizeResourceWrite({
      ...subtitleStyle,
      payload: { ...subtitleStyle.payload, burnVideo: true },
    }),
    (error) => error?.code === "INVALID_RESOURCE",
  );
  const exportPreset = resourceLibraryMock.exportPresets[0];
  assert.throws(
    () => normalizeResourceWrite({
      ...exportPreset,
      payload: { ...exportPreset.payload, primary: subtitleStyle.payload.primary },
    }),
    (error) => error?.code === "INVALID_RESOURCE",
  );
});

test("resource UI keeps ASS track preview and export preset controls separate", () => {
  const page = readFileSync(new URL("../../src/pages/TermsStylePage.tsx", import.meta.url), "utf8");
  const source = readFileSync(new URL("../../src/components/feature/resource-library/SubtitleStyleEditor.tsx", import.meta.url), "utf8");
  assert.match(source, /data-ass-preview="track-style"/);
  for (const field of ["fontFamily", "fontSizePx", "textColor", "outlineColor", "outlineWidthPx", "shadowColor", "shadowDepthPx", "position", "bilingualLayout", "direction", "backgroundColor"]) {
    assert.match(source, new RegExp(field), `preview must use ${field}`);
  }
  assert.match(page, /导出预设/);
  assert.match(page, /fileNameTemplate/);
  assert.match(page, /burnVideo/);
});

test("P0 resource UI exposes structured style and export forms with advanced JSON fallback", () => {
  const page = readFileSync(new URL("../../src/pages/TermsStylePage.tsx", import.meta.url), "utf8");
  const style = readFileSync(new URL("../../src/components/feature/resource-library/SubtitleStyleEditor.tsx", import.meta.url), "utf8");
  const guide = readFileSync(new URL("../../src/components/feature/resource-library/StyleGuideEditor.tsx", import.meta.url), "utf8");
  const glossary = readFileSync(new URL("../../src/components/feature/resource-library/GlossaryEditor.tsx", import.meta.url), "utf8");
  assert.match(style, /function SubtitleStyleEditor/);
  assert.match(page, /function ExportPresetEditor/);
  assert.match(page, /文件名示例/);
  assert.match(page, /高级：直接编辑 JSON/);
  assert.match(guide, /内置模板/);
  assert.match(guide, /纪录片/);
  assert.match(guide, /影视对白/);
  assert.match(glossary, /示例术语/);
});

test("structured resource forms reject incomplete export destinations before persistence", () => {
  assert.equal(describePayloadProblem("export_preset", {
    outputs: [{ content: "target", format: "srt" }],
    burnVideo: false,
    fileNameTemplate: "{project}-{language}",
    destination: { kind: "custom_directory", directory: "" },
  }), "自定义输出目录不能为空");
});
