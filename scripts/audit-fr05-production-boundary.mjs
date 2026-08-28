import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), "..");

export const legacyUiTargets = [
  "src/App.tsx",
  "src/pages",
  "src/layout",
  "src/routes",
  "src/components/ui",
  "src/components/feature",
  "src/styles/globals.css",
  "src/theme/ThemeContext.tsx",
  "src/mock",
  "src/components/AppErrorBoundary.tsx",
  "src/state/use-model-options.ts",
  "src/assets/mock-video-cover.webp",
  "src/assets/surface-parchment-texture.webp",
];

const runtimeMarkers = [
  "workspaceMock",
  "resourceLibraryMock",
  "data-demo-action",
  "mock-candidate",
  "mockWaveform",
  "demoProgress",
  "createStartArtifacts",
  "模型演示列表",
  "静态演示",
  "演示任务",
  "当前阶段范围",
  "ParameterPanel",
  "demo-file",
  "只读校准",
  "编辑动作尚未开放",
  "只读母版",
];

const oldBundleMarkers = [
  ...runtimeMarkers,
  "--color-gold-wash",
  "[data-accent=green]",
  "Faster-Whisper",
];

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function resolveImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const extensions = [".ts", ".tsx", ".mts", ".js", ".mjs", ".css", ".json"];
  const candidates = extname(base)
    ? [base]
    : [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => join(base, `index${extension}`))];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

function moduleSpecifiers(path, text) {
  if (path.endsWith(".css")) {
    return [...text.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)].map((match) => match[1]);
  }
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".js") || path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

export function buildProductionGraph(root = defaultRoot) {
  const sourceRoot = join(root, "src");
  const sharedRoot = join(root, "shared");
  const queue = [join(sourceRoot, "main.tsx")];
  const visited = new Set();
  while (queue.length > 0) {
    const path = normalize(queue.shift());
    if (visited.has(path)) continue;
    if (!existsSync(path)) throw new Error(`Production dependency is missing: ${portable(root, path)}`);
    visited.add(path);
    const text = readFileSync(path, "utf8");
    for (const specifier of moduleSpecifiers(path, text)) {
      const target = resolveImport(path, specifier);
      if (target && (isInside(sourceRoot, target) || isInside(sharedRoot, target))) queue.push(target);
    }
  }
  return [...visited].sort().map((path) => portable(root, path));
}

function filesBelow(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => filesBelow(join(path, entry.name)));
}

function markerViolations(root, files, markers) {
  const violations = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const marker of markers) {
      if (text.includes(marker)) violations.push(`${file}: ${marker}`);
    }
  }
  return violations;
}

export function auditProductionBoundary({ root = defaultRoot, requireBuild = false } = {}) {
  const productionFiles = buildProductionGraph(root);
  const legacyExisting = legacyUiTargets.filter((path) => filesBelow(join(root, path)).length > 0);
  const legacyGraphHits = productionFiles.filter((file) => legacyUiTargets.some((target) => file === target || file.startsWith(`${target}/`)));
  const requiredGraphFiles = [
    "src/main.tsx",
    "src/frontend/App.tsx",
    "src/frontend/styles/prototype.css",
    "src/frontend/styles/production.css",
    "src/state/WorkspaceContext.tsx",
  ];
  const missingGraphFiles = requiredGraphFiles.filter((file) => !productionFiles.includes(file));
  const sourceMarkerViolations = markerViolations(root, productionFiles, runtimeMarkers);
  const buildRoot = join(root, "dist");
  const buildFiles = filesBelow(buildRoot)
    .filter((path) => [".html", ".js", ".css"].includes(extname(path)))
    .map((path) => portable(root, path));
  const buildMissing = requireBuild && buildFiles.length === 0;
  const bundleMarkerViolations = requireBuild && buildFiles.length > 0 ? markerViolations(root, buildFiles, oldBundleMarkers) : [];
  const bundleBytes = buildFiles.reduce((total, file) => total + statSync(join(root, file)).size, 0);
  const ok = !buildMissing && [legacyExisting, legacyGraphHits, missingGraphFiles, sourceMarkerViolations, bundleMarkerViolations].every((items) => items.length === 0);
  return {
    ok,
    entry: "src/main.tsx",
    productionFileCount: productionFiles.length,
    productionFiles,
    legacyTargetCount: legacyUiTargets.length,
    legacyExisting,
    legacyGraphHits,
    missingGraphFiles,
    sourceMarkerViolations,
    buildRequired: requireBuild,
    buildFileCount: buildFiles.length,
    bundleBytes,
    buildMissing,
    bundleMarkerViolations,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = auditProductionBoundary({ requireBuild: process.argv.includes("--require-build") });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
