import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function inspectControls() {
  // ponytail: keep the cheap static gate alongside the real Electron paths.
  const findings = [];
  for (const path of sourceFiles(join(root, "src"))) {
    const text = readFileSync(path, "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    function visit(node, interactiveAncestor = false) {
      const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
      const tag = opening?.tagName.getText(source);
      const attributes = new Set(opening?.attributes.properties.filter(ts.isJsxAttribute).map((attribute) => attribute.name.getText(source)) ?? []);
      const isButton = tag === "button";
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const location = `${relative(root, path)}:${line}`;

      if (isButton && interactiveAncestor) findings.push(`${location} nested button`);
      if (isButton && !attributes.has("onClick") && !attributes.has("disabled")) findings.push(`${location} enabled button has no action`);
      if (tag === "input" && attributes.has("placeholder") && !attributes.has("onChange") && !attributes.has("disabled")) {
        findings.push(`${location} enabled input has no action`);
      }
      if (tag === "select" && attributes.has("value") && !attributes.has("onChange") && !attributes.has("disabled")) {
        findings.push(`${location} enabled controlled select cannot change`);
      }
      const staticDisabled = opening?.attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "disabled" && !attribute.initializer,
      );
      if (staticDisabled && !attributes.has("title")) findings.push(`${location} disabled control has no explanation`);
      ts.forEachChild(node, (child) => visit(child, interactiveAncestor || isButton));
    }

    visit(source);
  }
  return findings;
}

test("production interactive controls are actionable, explained when disabled, and never nested", () => {
  assert.deepEqual(inspectControls(), []);
});
