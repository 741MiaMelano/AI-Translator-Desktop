import assert from "node:assert/strict";
import test from "node:test";

import { extractFrequentTerms } from "../../src/domain/term-extraction.ts";

function segment(id, text) {
  return {
    id,
    start: "00:00:00,000",
    end: "00:00:01,000",
    sourceLanguage: "en-US",
    sourceText: { original: text, normalized: text },
    targetTexts: {},
  };
}

test("frequent term extraction finds repeated words and phrases without stopwords", () => {
  const candidates = extractFrequentTerms([
    segment("s1", "DeepSeek Flash translates the subtitles."),
    segment("s2", "DeepSeek Flash keeps terminology consistent."),
    segment("s3", "NVIDIA uses DeepSeek Flash."),
  ], { languageCode: "en-US", minOccurrences: 2 });

  assert.equal(candidates.find((item) => item.term === "DeepSeek Flash")?.count, 3);
  assert.equal(candidates.find((item) => item.term === "DeepSeek")?.count, 3);
  assert.equal(candidates.some((item) => item.term.toLowerCase() === "the"), false);
  assert.deepEqual(candidates[0].segmentIds.length <= 3, true);
});

test("frequent term extraction uses native word segmentation for Han subtitles", () => {
  const candidates = extractFrequentTerms([
    segment("s1", "人工智能字幕翻译正在运行。"),
    segment("s2", "人工智能字幕翻译需要术语一致。"),
  ], { languageCode: "zh-CN", minOccurrences: 2 });

  assert.ok(candidates.some((item) => item.term === "人工智能"));
});
