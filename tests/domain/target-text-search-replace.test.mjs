import test from "node:test";
import assert from "node:assert/strict";

import {
  createUndoRedoStack,
  searchReplaceTargetTexts,
} from "../../shared/target-text-search-replace.mjs";

function seg(id, layer) {
  return {
    id,
    start: "00:00:01,000",
    end: "00:00:02,000",
    sourceLanguage: "en",
    sourceText: { original: "x", normalized: "x" },
    targetTexts: { "zh-CN": layer },
  };
}

test("plain replace updates unprotected segments in language scope", () => {
  const result = searchReplaceTargetTexts({
    segments: [
      seg("a", { model: "hello world", postProcessed: "hello world", qaFlags: [] }),
      seg("b", { model: "hello there", postProcessed: "hello there", qaFlags: [] }),
    ],
    languageCode: "zh-CN",
    findText: "hello",
    replaceText: "hi",
  });

  assert.equal(result.ok, true);
  assert.equal(result.replacedCount, 2);
  assert.equal(result.segments[0].targetTexts["zh-CN"].postProcessed, "hi world");
  assert.equal(result.segments[1].targetTexts["zh-CN"].postProcessed, "hi there");
});

test("scope limits replacement to selected segment ids", () => {
  const result = searchReplaceTargetTexts({
    segments: [
      seg("a", { model: "hello", postProcessed: "hello", qaFlags: [] }),
      seg("b", { model: "hello", postProcessed: "hello", qaFlags: [] }),
    ],
    languageCode: "zh-CN",
    findText: "hello",
    replaceText: "hi",
    scopeSegmentIds: ["b"],
  });

  assert.equal(result.replacedCount, 1);
  assert.equal(result.segments[0].targetTexts["zh-CN"].postProcessed, "hello");
  assert.equal(result.segments[1].targetTexts["zh-CN"].postProcessed, "hi");
  assert.deepEqual(result.changedSegmentIds, ["b"]);
});

test("locked segments are skipped and reported", () => {
  const result = searchReplaceTargetTexts({
    segments: [
      seg("locked", {
        model: "hello",
        postProcessed: "hello",
        locked: true,
        qaFlags: [],
      }),
      seg("open", { model: "hello", postProcessed: "hello", qaFlags: [] }),
    ],
    languageCode: "zh-CN",
    findText: "hello",
    replaceText: "hi",
  });

  assert.equal(result.replacedCount, 1);
  assert.equal(result.skippedLockedCount, 1);
  assert.deepEqual(result.skippedLockedSegmentIds, ["locked"]);
  assert.equal(result.segments[0].targetTexts["zh-CN"].postProcessed, "hello");
  assert.equal(result.segments[1].targetTexts["zh-CN"].postProcessed, "hi");
});

test("manual text can be replaced by user search path", () => {
  const result = searchReplaceTargetTexts({
    segments: [
      seg("m", {
        model: "model-hello",
        postProcessed: "post-hello",
        manual: "manual-hello",
        qaFlags: [],
      }),
    ],
    languageCode: "zh-CN",
    findText: "hello",
    replaceText: "hi",
  });

  assert.equal(result.replacedCount, 1);
  assert.equal(result.segments[0].targetTexts["zh-CN"].manual, "manual-hi");
  assert.equal(result.segments[0].targetTexts["zh-CN"].model, "model-hello");
});

test("source match can clear the corresponding translated subtitle", () => {
  const result = searchReplaceTargetTexts({
    segments: [seg("filler", { model: "呃。", postProcessed: "呃。", qaFlags: [] })],
    languageCode: "zh-CN",
    findText: "x",
    replaceText: "",
    matchField: "source",
  });

  assert.equal(result.replacedCount, 1);
  assert.equal(result.segments[0].targetTexts["zh-CN"].manual, "");
});

test("undo/redo stack restores serialized history after restart snapshot", () => {
  const stack = createUndoRedoStack({ limit: 10 });
  stack.push({ type: "replace", before: "a", after: "b" });
  stack.push({ type: "replace", before: "b", after: "c" });

  const snapshot = stack.serialize();
  const restored = createUndoRedoStack();
  restored.restore(snapshot);

  assert.equal(restored.canUndo(), true);
  const undoEntry = restored.undo();
  assert.deepEqual(undoEntry, { type: "replace", before: "b", after: "c" });
  assert.equal(restored.canRedo(), true);
  const redoEntry = restored.redo();
  assert.deepEqual(redoEntry, { type: "replace", before: "b", after: "c" });
});
