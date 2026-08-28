import assert from "node:assert/strict";
import test from "node:test";
import { buildTranslationResourceContext } from "../../backend/translation/resource-context.mjs";

const glossary = {
  id: "snapshot-glossary-r2",
  kind: "glossary",
  name: "Product terms",
  scope: "project_snapshot",
  schemaVersion: 1,
  source: { kind: "global", resourceId: "glossary-product", revision: 2 },
  capturedAt: "2026-07-23T12:00:00.000Z",
  payload: {
    languagePairs: [
      {
        sourceLanguageCode: "en-US",
        targetLanguageCode: "zh-CN",
        entries: [
          { id: "term-on", source: "workspace", target: "工作区", enabled: true },
          { id: "term-off", source: "draft", target: "草稿", enabled: false },
        ],
      },
      {
        sourceLanguageCode: "en-US",
        targetLanguageCode: "ja-JP",
        entries: [{ id: "term-ja", source: "workspace", target: "ワークスペース", enabled: true }],
      },
    ],
  },
};

const styleGuide = {
  id: "snapshot-style-r1",
  kind: "style_guide",
  name: "Concise Chinese",
  scope: "project_snapshot",
  schemaVersion: 1,
  source: { kind: "global", resourceId: "style-concise", revision: 1 },
  capturedAt: "2026-07-23T12:01:00.000Z",
  payload: {
    targetLanguageCode: "zh-CN",
    tags: ["concise"],
    scenes: ["UI"],
    rules: [
      { id: "rule-on", title: "Concise", instruction: "Use short UI labels.", enabled: true },
      { id: "rule-off", title: "Disabled", instruction: "Never include this.", enabled: false },
    ],
  },
};

test("translation resources are selected from immutable project snapshots per target language", () => {
  const context = buildTranslationResourceContext({
    snapshots: [glossary, styleGuide],
    glossarySelection: "glossary-product",
    styleGuideSelection: "style-concise",
    sourceLanguageCode: "en-US",
    targetLanguageCode: "zh-CN",
  });

  assert.equal(context.resourceSnapshot.glossary.source.revision, 2);
  assert.equal(context.resourceSnapshot.styleGuide.source.revision, 1);
  assert.match(context.glossaryHint, /workspace/);
  assert.match(context.glossaryHint, /工作区/);
  assert.doesNotMatch(context.glossaryHint, /ワークスペース|draft/);
  assert.match(context.styleHint, /Use short UI labels/);
  assert.doesNotMatch(context.styleHint, /Never include this/);
  assert.deepEqual(context.termConflictRules, [{ source: "workspace", required: "工作区" }]);
});

test("a target-mismatched style guide is not injected", () => {
  const context = buildTranslationResourceContext({
    snapshots: [glossary, styleGuide],
    glossarySelection: "glossary-product",
    styleGuideSelection: "style-concise",
    sourceLanguageCode: "en-US",
    targetLanguageCode: "ja-JP",
  });
  assert.match(context.glossaryHint, /ワークスペース/);
  assert.equal(context.styleHint, "");
  assert.equal(context.resourceSnapshot.styleGuide.empty, true);
});
