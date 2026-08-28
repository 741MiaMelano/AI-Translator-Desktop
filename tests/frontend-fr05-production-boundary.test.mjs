import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { auditProductionBoundary, legacyUiTargets } from "../scripts/audit-fr05-production-boundary.mjs";

test("FR-05 production graph contains the new frontend and no legacy UI tree", () => {
  const result = auditProductionBoundary();
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.entry, "src/main.tsx");
  assert.equal(result.legacyTargetCount, legacyUiTargets.length);
  assert.deepEqual(result.legacyExisting, []);
  assert.deepEqual(result.legacyGraphHits, []);
  assert.deepEqual(result.missingGraphFiles, []);
  assert.deepEqual(result.sourceMarkerViolations, []);
});

test("FR-05 editor shortcut resolves to the real project editor instead of a read-only calibration surface", () => {
  const app = readFileSync(new URL("../src/frontend/App.tsx", import.meta.url), "utf8");
  const pages = readFileSync(new URL("../src/frontend/pages.tsx", import.meta.url), "utf8");
  assert.match(app, /function EditorShortcut/);
  assert.match(app, /getActiveSourceTrack/);
  assert.match(app, /\/projects\/\$\{app\.activeProject\.id\}\/editor\/\$\{encodeURIComponent\(target\.languageCode\)\}/);
  assert.match(app, /<Route path="\/editor" element=\{<EditorShortcut\/>\}/);
  assert.doesNotMatch(`${app}\n${pages}`, /SubtitleEditorPage|只读校准|编辑动作尚未开放|只读母版/);
});
