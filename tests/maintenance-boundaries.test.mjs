import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const files = [
  "src/pages/StartTranslatePage.tsx",
  "src/pages/start-translate-controller.ts",
  "src/pages/start-translate-view.tsx",
  "src/pages/ModelApiPage.tsx",
  "src/pages/model-api-controller.ts",
  "src/pages/model-api-view.tsx",
  "src/pages/SubtitleEditorPage.tsx",
  "src/domain/project-editor.ts",
  "shared/qa-engine.mjs",
  "backend/translation/desktop-translation-port.mjs",
  "backend/translation/translate-service.mjs",
];

function longFunctions(file) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const findings = [];

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.end).line + 1;
      if (end - start + 1 > 120) {
        const name = node.name?.getText(source) ?? node.parent?.name?.getText?.(source) ?? "anonymous";
        findings.push(`${relative(root, path)}:${start} ${name} (${end - start + 1} lines)`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return findings;
}

test("Phase 4 and 5 maintenance hotspots keep each function under 120 lines", () => {
  assert.deepEqual(files.flatMap(longFunctions), []);
});
