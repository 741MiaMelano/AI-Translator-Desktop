import assert from "node:assert/strict";
import test from "node:test";
import { getSegmentPage } from "../../src/domain/segment-page.ts";

test("segment pages bound 1k/10k projects to 100 rendered rows", () => {
  assert.deepEqual(getSegmentPage(1_000, 9), { page: 9, pageCount: 10, start: 900, end: 1_000 });
  assert.deepEqual(getSegmentPage(10_000, 99), { page: 99, pageCount: 100, start: 9_900, end: 10_000 });
  assert.deepEqual(getSegmentPage(10_000, 500), { page: 99, pageCount: 100, start: 9_900, end: 10_000 });
});
