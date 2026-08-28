import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = join(root, "src");
const entry = join(sourceRoot, "main.tsx");
const banned = [
  "src/App.tsx",
  "src/pages/",
  "src/layout/",
  "src/routes/",
  "src/components/ui/",
  "src/components/feature/",
  "src/styles/globals.css",
  "src/theme/ThemeContext.tsx",
  "src/mock/",
];

function portable(path) {
  return relative(root, path).split(sep).join("/");
}

function resolveImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = extname(base)
    ? [base]
    : [base, ...[".ts", ".tsx", ".js", ".mjs", ".css", ".json"].map((extension) => `${base}${extension}`), ...[".ts", ".tsx", ".js", ".mjs", ".css"].map((extension) => join(base, `index${extension}`))];
  return candidates.find(existsSync) ?? null;
}

function moduleSpecifiers(path, text) {
  if (path.endsWith(".css")) {
    return [...text.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)].map((match) => match[1]);
  }
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const imports = [];
  source.forEachChild((node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
  });
  return imports;
}

function productionGraph() {
  const queue = [entry];
  const visited = new Set();
  while (queue.length > 0) {
    const path = normalize(queue.shift());
    if (visited.has(path)) continue;
    visited.add(path);
    const text = readFileSync(path, "utf8");
    for (const specifier of moduleSpecifiers(path, text)) {
      const target = resolveImport(path, specifier);
      if (target && (target.startsWith(sourceRoot) || target.startsWith(join(root, "shared")))) queue.push(target);
    }
  }
  return visited;
}

test("production renderer entry resolves only through the new frontend tree", () => {
  const graph = [...productionGraph()].map(portable);
  const violations = graph.filter((path) => banned.some((prefix) => path === prefix || path.startsWith(prefix)));
  assert.deepEqual(violations, []);
  assert.ok(graph.includes("src/frontend/App.tsx"));
  assert.ok(graph.includes("src/frontend/styles/prototype.css"));
  assert.ok(graph.includes("src/frontend/styles/production.css"));
});

test("new frontend contains no prototype demo runtime hooks", () => {
  const graph = [...productionGraph()]
    .filter((path) => portable(path).startsWith("src/frontend/"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.doesNotMatch(graph, /data-demo-action|workspaceMock|mock\/workspace|innerHTML\s*=|document\.addEventListener\(\s*["']click/);
});

test("A-brass direction contract survives at the renderer document boundary", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  assert.match(html, /<body><!--[\s\S]*THESIS:[\s\S]*OWN-WORLD:[\s\S]*STORY:[\s\S]*FIRST VIEWPORT:[\s\S]*FORM:[\s\S]*seed key abda1daf[\s\S]*FINISH:/);
  assert.ok(html.indexOf("THESIS:") < html.indexOf('<div id="root">'));
});

test("migrated prototype stylesheet no longer carries its dangling compact-rail selector", () => {
  const css = readFileSync(join(root, "src", "frontend", "styles", "prototype.css"), "utf8");
  assert.doesNotMatch(css, /html\.rail-compact \.sound-toggle,\s*@media/);
});
