// 便携版专属回归：portable.nsi 在启动和退出各执行一次 `RMDir /r $INSTDIR`。只要两个实例
// 共用同一个解包目录，后启动的那个就会把前一个的文件删掉，剩下的实例跑在残缺的 resources 上，
// 表现是"该功能当前不可用""仍有项目未能保存""模型未安装"这一串互不相干的报错。
//
// ci-package-smoke.mjs 启动的是 release/win-unpacked，结构上碰不到这条路径，所以单独立一个。
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { findMissingPackagedResources } from "../shared/packaged-resource-integrity.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(rootDir, "release", "AI-Translator-Desktop.exe");
const temp = tmpdir();
const EXTRACT_TIMEOUT_MS = 180_000;

assert.equal(existsSync(executable), true, `Portable smoke input missing: ${executable}`);

function tempSnapshot() {
  return new Set(readdirSync(temp));
}

// extractAppPackage.nsh 先把内嵌包解到 $PLUGINSDIR\7z-out，复制进 $INSTDIR 之后再删掉它。
// 那个暂存目录同样"看起来像"一棵完整的树，但它会消失——断言必须落在真正的 $INSTDIR 上。
const STAGING_DIR_NAME = "7z-out";

/** 解包目录里必须能看到一个可执行文件，才算是这次启动铺开的树而不是别人的临时目录。 */
function extractionRootsUnder(directory) {
  const roots = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".exe"))
      && entries.some((entry) => entry.isDirectory() && entry.name === "resources")) {
      roots.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== STAGING_DIR_NAME) walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(directory, 0);
  return roots;
}

async function waitForCompleteExtraction(label, before, child) {
  const deadline = Date.now() + EXTRACT_TIMEOUT_MS;
  let lastMissing = ["(还没出现解包目录)"];
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label}: wrapper exited early with ${child.exitCode}`);
    for (const name of tempSnapshot()) {
      if (before.has(name)) continue;
      const candidate = join(temp, name);
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const root of extractionRootsUnder(candidate)) {
        const missing = findMissingPackagedResources(join(root, "resources"));
        if (missing.length === 0) return { tempEntry: name, root };
        lastMissing = missing;
      }
    }
    await delay(500);
  }
  throw new Error(`${label}: no complete extraction appeared within ${EXTRACT_TIMEOUT_MS}ms; last gap: ${lastMissing.join(", ")}`);
}

function launch(userDataDir) {
  const before = tempSnapshot();
  const child = spawn(executable, [`--user-data-dir=${userDataDir}`], {
    cwd: rootDir,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    windowsHide: true,
    stdio: "ignore",
    detached: false,
  });
  return { child, before };
}

function terminate(child) {
  if (!child || child.exitCode !== null) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    child.kill();
  }
}

/**
 * taskkill /T 打在便携版外壳上并不总能带走 Electron 的子进程，留下的孤儿会一直占着
 * 解包目录，让清理失败、下一次运行从一堆残留里挑目录。按可执行文件路径精确收尾：
 * 只杀跑在这次解包目录里的进程，绝不碰用户自己开着的那个实例。
 */
function terminateByExtractionRoot(root) {
  if (!root) return;
  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:SMOKE_EXTRACTION_ROOT) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], { stdio: "ignore", windowsHide: true, env: { ...process.env, SMOKE_EXTRACTION_ROOT: root } });
  } catch {
    // 收尾失败不该让断言结果变色；下面的 rmSync 会报出残留。
  }
}

const userDataDirs = [mkdtempSync(join(temp, "portable-extract-a-")), mkdtempSync(join(temp, "portable-extract-b-"))];
const launched = [];
const extractions = [];

try {
  const first = launch(userDataDirs[0]);
  launched.push(first.child);
  extractions.push(await waitForCompleteExtraction("first launch", first.before, first.child));
  console.log(`first launch unpacked to ${extractions[0].root}`);

  // 第二个实例带自己的 userData，绕开单实例锁，制造真正的重叠运行。
  const second = launch(userDataDirs[1]);
  launched.push(second.child);
  extractions.push(await waitForCompleteExtraction("second launch", second.before, second.child));
  console.log(`second launch unpacked to ${extractions[1].root}`);

  assert.notEqual(
    extractions[0].root,
    extractions[1].root,
    "两个实例共用了同一个解包目录：退出时的 RMDir /r 会互相删文件",
  );
  assert.deepEqual(
    findMissingPackagedResources(join(extractions[0].root, "resources")),
    [],
    "第二个实例启动后，第一个实例的 resources 树被破坏了",
  );

  // 让后启动的那个退出，再确认先启动的那棵树还在——退出路径上的 RMDir /r 是同一个陷阱。
  terminate(launched[1]);
  terminateByExtractionRoot(extractions[1].root);
  await delay(5_000);
  assert.deepEqual(
    findMissingPackagedResources(join(extractions[0].root, "resources")),
    [],
    "第二个实例退出时把第一个实例的 resources 树删掉了",
  );

  console.log("Portable extraction isolation smoke passed");
} finally {
  for (const child of launched) terminate(child);
  for (const entry of extractions) terminateByExtractionRoot(entry.root);
  await delay(3_000);
  for (const path of [...userDataDirs, ...extractions.map((entry) => join(temp, entry.tempEntry))]) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch {
      console.warn(`portable extraction smoke could not clean up ${path}`);
    }
  }
}
