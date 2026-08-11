import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  parseGlossaryDelimited,
  serializeGlossaryDelimited,
} from "../../src/domain/glossary-delimited.ts";

function ids() {
  let value = 0;
  return () => `term-${++value}`;
}

test("CSV glossary import handles BOM, aliases, commas, newlines, and escaped quotes", () => {
  const payload = parseGlossaryDelimited(
    '\uFEFF原文,固定译文,词性,标签,备注\r\n"DeepSeek, Flash",深度求索,专名,AI|模型,"第一行\n第二行"\r\nGPU,"图形""处理器",缩写,,',
    {
      format: "csv",
      defaultSourceLanguageCode: "en-US",
      defaultTargetLanguageCode: "zh-CN",
      idFactory: ids(),
    },
  );

  assert.equal(payload.languagePairs.length, 1);
  assert.deepEqual(payload.languagePairs[0], {
    sourceLanguageCode: "en-US",
    targetLanguageCode: "zh-CN",
    entries: [
      {
        id: "term-1",
        source: "DeepSeek, Flash",
        target: "深度求索",
        partOfSpeech: "专名",
        tags: ["AI", "模型"],
        note: "第一行\n第二行",
        enabled: true,
      },
      {
        id: "term-2",
        source: "GPU",
        target: '图形"处理器',
        partOfSpeech: "缩写",
        enabled: true,
      },
    ],
  });
});

test("TSV glossary import groups explicit language pairs and preserves optional fields", () => {
  const payload = parseGlossaryDelimited(
    "source_language\ttarget_language\tsource\ttarget\tdomain\ttags\tnote\tenabled\n" +
      "en-US\tzh-CN\tGPU\t图形处理器\thardware\tAI;video\tpreferred\tfalse\n" +
      "ja-JP\tzh-CN\t字幕\t字幕\tvideo\tcaption\t\t1\n",
    { format: "tsv", idFactory: ids() },
  );

  assert.equal(payload.languagePairs.length, 2);
  assert.deepEqual(payload.languagePairs[0].entries[0], {
    id: "term-1",
    source: "GPU",
    target: "图形处理器",
    domain: "hardware",
    tags: ["AI", "video"],
    note: "preferred",
    enabled: false,
  });
  assert.equal(payload.languagePairs[1].sourceLanguageCode, "ja-JP");
  assert.equal(payload.languagePairs[1].entries[0].enabled, true);
});

test("CSV and TSV glossary exchange round-trips the canonical payload", () => {
  const original = {
    languagePairs: [{
      sourceLanguageCode: "en-US",
      targetLanguageCode: "zh-CN",
      entries: [{
        id: "old-id",
        source: "large, language model",
        target: "大语言模型",
        partOfSpeech: "noun",
        domain: "AI",
        tags: ["model", "LLM"],
        note: 'Use "LLM" in UI\nSecond line',
        enabled: true,
      }],
    }],
  };

  for (const format of ["csv", "tsv"]) {
    const restored = parseGlossaryDelimited(serializeGlossaryDelimited(original, format), {
      format,
      idFactory: () => "new-id",
    });
    assert.deepEqual(restored.languagePairs[0], {
      ...original.languagePairs[0],
      entries: [{ ...original.languagePairs[0].entries[0], id: "new-id" }],
    });
  }
});

test("glossary import rejects malformed or unsafe files without returning partial data", () => {
  const defaults = {
    format: "csv",
    defaultSourceLanguageCode: "en-US",
    defaultTargetLanguageCode: "zh-CN",
    idFactory: ids(),
  };

  assert.throws(
    () => parseGlossaryDelimited('source,target\n"unfinished,译文', defaults),
    /引号没有闭合/,
  );
  assert.throws(
    () => parseGlossaryDelimited("source,note\nGPU,x", defaults),
    /缺少译文列/,
  );
  assert.throws(
    () => parseGlossaryDelimited(`source,target\n${"a".repeat(4097)},译文`, defaults),
    /字段过长/,
  );
});

test("documented CSV and TSV acceptance samples import with the advertised rows", () => {
  const sampleDir = join(process.cwd(), "docs", "samples");
  const csv = parseGlossaryDelimited(readFileSync(join(sampleDir, "glossary-import-example.csv"), "utf8"), {
    format: "csv",
    idFactory: ids(),
  });
  const tsv = parseGlossaryDelimited(readFileSync(join(sampleDir, "glossary-import-example.tsv"), "utf8"), {
    format: "tsv",
    idFactory: ids(),
  });

  assert.equal(csv.languagePairs.flatMap((pair) => pair.entries).length, 3);
  assert.equal(tsv.languagePairs.flatMap((pair) => pair.entries).length, 3);
  assert.equal(csv.languagePairs[0].entries[1].note, "第一行\n第二行");
  assert.equal(tsv.languagePairs[0].entries[0].source, "DeepSeek");
});
