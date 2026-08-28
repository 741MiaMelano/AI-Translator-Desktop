import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  describeIncompletePackagedResources,
  findMissingPackagedResources,
  PACKAGED_RESOURCE_REQUIREMENTS,
} from "../../shared/packaged-resource-integrity.mjs";

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function stageCompleteTree() {
  const root = mkdtempSync(join(tmpdir(), "packaged-resources-"));
  for (const requirement of PACKAGED_RESOURCE_REQUIREMENTS) {
    const absolute = join(root, ...requirement.path.split("/"));
    if (requirement.suffix) {
      mkdirSync(absolute, { recursive: true });
      writeFileSync(join(absolute, `001_probe${requirement.suffix}`), "probe");
    } else {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, "probe");
    }
  }
  return root;
}

test("a complete resources tree reports nothing missing", () => {
  const root = stageCompleteTree();
  try {
    assert.deepEqual(findMissingPackagedResources(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each requirement is detected independently", () => {
  for (const requirement of PACKAGED_RESOURCE_REQUIREMENTS) {
    const root = stageCompleteTree();
    try {
      rmSync(join(root, ...requirement.path.split("/")), { recursive: true, force: true });
      assert.deepEqual(findMissingPackagedResources(root), [requirement.label], requirement.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a directory requirement is unsatisfied when it holds no matching file", () => {
  const root = stageCompleteTree();
  const requirement = PACKAGED_RESOURCE_REQUIREMENTS.find((entry) => entry.suffix);
  try {
    const absolute = join(root, ...requirement.path.split("/"));
    rmSync(absolute, { recursive: true, force: true });
    mkdirSync(absolute, { recursive: true });
    writeFileSync(join(absolute, "README.txt"), "not a migration");
    assert.deepEqual(findMissingPackagedResources(root), [requirement.label]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent or blank root reports every requirement rather than throwing", () => {
  const labels = PACKAGED_RESOURCE_REQUIREMENTS.map((requirement) => requirement.label);
  assert.deepEqual(findMissingPackagedResources(""), labels);
  assert.deepEqual(findMissingPackagedResources(join(tmpdir(), "packaged-resources-absent")), labels);
});

test("the diagnosis names every missing item and the action to take", () => {
  const text = describeIncompletePackagedResources(["FFmpeg 构件清单", "语音活动检测模型"]);
  assert.ok(text.includes("FFmpeg 构件清单"));
  assert.ok(text.includes("语音活动检测模型"));
  assert.ok(text.includes("只启动一次"), "the diagnosis must state what the user should do");
});

test("every requirement is covered by a declared extraResources entry", () => {
  // 这份清单的意义就在于和打包配置一一对应；配置里删了某条而这里没删，
  // 打出来的包会在启动时被自己判成残缺。
  const builder = readFileSync(join(rootDir, "electron-builder.yml"), "utf8");
  const destinations = [...builder.matchAll(/^\s+to:\s*(\S+)\s*$/gm)].map((match) => match[1].replaceAll("\\", "/"));
  assert.ok(destinations.length > 0, "extraResources destinations were not parsed");
  for (const requirement of PACKAGED_RESOURCE_REQUIREMENTS) {
    const covered = destinations.some(
      (destination) => requirement.path === destination || requirement.path.startsWith(`${destination}/`),
    );
    assert.equal(covered, true, `${requirement.path} is not shipped by extraResources`);
  }
});
