import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { RESOURCE_CONTRACT_VERSION } from "../../src/domain/resource-library.ts";
import { describePayloadProblem } from "../../src/domain/resource-payload.ts";
import { normalizeResourceWrite } from "../../shared/resource-library.mjs";

const updatedAt = "2026-07-23T00:00:00.000Z";
const resourceLibraryFixture = {
  glossaries: [{
    id: "glossary-fixture", kind: "glossary", name: "术语夹具", description: "测试合同", scope: "global",
    schemaVersion: RESOURCE_CONTRACT_VERSION, revision: 1, updatedAt,
    payload: { languagePairs: [
      { sourceLanguageCode: "en-US", targetLanguageCode: "zh-CN", entries: [{ id: "term-ai", source: "AI", target: "人工智能", enabled: true }] },
      { sourceLanguageCode: "ja-JP", targetLanguageCode: "zh-CN", entries: [] },
    ] },
  }],
  styleGuides: [{
    id: "guide-fixture", kind: "style_guide", name: "风格夹具", description: "测试合同", scope: "global",
    schemaVersion: RESOURCE_CONTRACT_VERSION, revision: 1, updatedAt,
    payload: { targetLanguageCode: "zh-CN", tags: [], scenes: [], rules: [] },
  }],
  subtitleStyles: [{
    id: "style-fixture", kind: "subtitle_style", name: "样式夹具", description: "测试合同", scope: "global",
    schemaVersion: RESOURCE_CONTRACT_VERSION, revision: 1, updatedAt,
    payload: {
      format: "ass", bilingualLayout: "source_top_target_bottom",
      primary: { fontFamily: "Microsoft YaHei", fontSizePx: 32, textColor: "#ffffff", outlineColor: "#111111", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
      secondary: { fontFamily: "Microsoft YaHei", fontSizePx: 24, textColor: "#dddddd", outlineColor: "#111111", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
      preview: { sourceText: "Source", targetText: "译文", direction: "auto", backgroundColor: "#1f1f1f" },
    },
  }],
  exportPresets: [{
    id: "export-fixture", kind: "export_preset", name: "导出夹具", description: "测试合同", scope: "global",
    schemaVersion: RESOURCE_CONTRACT_VERSION, revision: 1, updatedAt,
    payload: { outputs: [{ content: "target", format: "srt" }], burnVideo: false, fileNameTemplate: "{project}-{language}", destination: { kind: "project_exports" } },
  }],
};

test("resource fixtures follow the single Phase 10 contract", () => {
  const resources = Object.values(resourceLibraryFixture).flat();
  assert.deepEqual(new Set(resources.map((resource) => resource.kind)), new Set(["glossary", "style_guide", "subtitle_style", "export_preset"]));
  for (const resource of resources) {
    assert.equal(resource.scope, "global");
    assert.equal(resource.schemaVersion, RESOURCE_CONTRACT_VERSION);
    assert.ok(Number.isSafeInteger(resource.revision) && resource.revision > 0);
  }
  assert.ok(resourceLibraryFixture.glossaries[0].payload.languagePairs.length > 1);
  assert.ok(resourceLibraryFixture.styleGuides[0].payload.targetLanguageCode);
  assert.ok(resourceLibraryFixture.subtitleStyles[0].payload.primary.fontFamily);
  assert.ok(resourceLibraryFixture.exportPresets[0].payload.outputs.length > 0);
});

test("subtitle styles and export presets reject cross-owned fields", () => {
  const subtitleStyle = resourceLibraryFixture.subtitleStyles[0];
  assert.throws(
    () => normalizeResourceWrite({ ...subtitleStyle, payload: { ...subtitleStyle.payload, burnVideo: true } }),
    (error) => error?.code === "INVALID_RESOURCE",
  );
  const exportPreset = resourceLibraryFixture.exportPresets[0];
  assert.throws(
    () => normalizeResourceWrite({ ...exportPreset, payload: { ...exportPreset.payload, primary: subtitleStyle.payload.primary } }),
    (error) => error?.code === "INVALID_RESOURCE",
  );
});

test("new resource UI keeps structured subtitle style and export controls separate", () => {
  const source = readFileSync(new URL("../../src/frontend/LibraryPage.tsx", import.meta.url), "utf8");
  for (const field of ["fontFamily", "fontSizePx", "textColor", "outlineColor", "outlineWidthPx", "shadowColor", "shadowDepthPx", "position", "bilingualLayout", "backgroundColor"]) {
    assert.match(source, new RegExp(field), `structured editor must use ${field}`);
  }
  for (const field of ["export_preset", "fileNameTemplate", "burnVideo", "project_exports"]) assert.match(source, new RegExp(field));
  // 断在结构上而不是 eyebrow 文案上：这条要守的是"样式编辑器自带实时预览、且与
  // 导出控件分开"，标签叫什么是文案层的事（§10.1 已把大写 eyebrow 换成真词）。
  assert.match(source, /subtitle-style-preview/);
  assert.match(source, /placeholder="预览译文"/);
});

test("new resource UI exposes all structured editors and safe delimited exchange", () => {
  const source = readFileSync(new URL("../../src/frontend/LibraryPage.tsx", import.meta.url), "utf8");
  for (const marker of ["function GlossaryEditor", "function StyleGuideEditor", "function SubtitleStyleEditor", "function ExportPresetEditor", "parseGlossaryDelimited", "serializeGlossaryDelimited", "CSV \/ TSV", 'type="color"']) {
    assert.match(source, new RegExp(marker));
  }
});

test("structured resource forms reject incomplete export destinations before persistence", () => {
  assert.equal(describePayloadProblem("export_preset", {
    outputs: [{ content: "target", format: "srt" }],
    burnVideo: false,
    fileNameTemplate: "{project}-{language}",
    destination: { kind: "custom_directory", directory: "" },
  }), "自定义输出目录不能为空");
});
