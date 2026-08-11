import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const installer = join(
  process.cwd(),
  "release",
  `AI-Translator-Desktop-${packageJson.version}-x64.exe`,
);
let materialUserDataDir = null;
let primaryError = null;
let materialAcceptanceRoot = null;

if (process.env.PHASE14_MATERIAL_ROOT) {
  const localAppData = process.env.LOCALAPPDATA;
  assert.ok(localAppData && isAbsolute(localAppData), "LOCALAPPDATA is required for installed ASR acceptance");
  materialAcceptanceRoot = join(localAppData, "AI Translator Phase14 Acceptance");
}

function assertTemporary(path) {
  const resolvedTemp = resolve(tmpdir());
  const resolvedPath = resolve(path);
  const child = relative(resolvedTemp, resolvedPath);
  assert.ok(child && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`), `unsafe test path: ${path}`);
}

function assertManagedAcceptance(path) {
  const root = resolve(process.env.LOCALAPPDATA, "AI Translator Phase14 Acceptance");
  const child = relative(root, resolve(path));
  assert.ok(child && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`), `unsafe acceptance path: ${path}`);
}

function terminateTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    child.kill();
  }
}

async function run(executable, args, label, timeout = 180_000, env = process.env) {
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    windowsHide: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-20_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
  const result = await new Promise((resolveResult) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(value);
    };
    const timer = setTimeout(() => {
      terminateTree(child);
      finish({ status: null, signal: null, error: new Error(`${label} timed out after ${timeout}ms`) });
    }, timeout);
    child.once("error", (error) => finish({ status: null, signal: null, error }));
    child.once("exit", (status, signal) => finish({ status, signal, error: null }));
  });
  assert.equal(
    result.status,
    0,
    `${label} failed (${result.status ?? result.signal}): ${result.error?.message ?? (stderr || stdout)}`,
  );
}

async function waitUntilMissing(path, label) {
  for (let attempt = 0; attempt < 120 && existsSync(path); attempt += 1) await delay(250);
  assert.equal(existsSync(path), false, `uninstaller left ${label} behind: ${path}`);
}

assert.equal(existsSync(installer), true, `missing installer: ${installer}`);
const expectedChecksum = `${createHash("sha256").update(readFileSync(installer)).digest("hex")}  ${basename(installer)}\n`;
assert.equal(readFileSync(`${installer}.sha256`, "utf8"), expectedChecksum, "installer checksum mismatch");
const testRoot = mkdtempSync(join(tmpdir(), "字幕翻译-安装回归-"));
const installDir = join(testRoot, "应用程序");
const userDataDir = join(testRoot, "用户数据");
const marker = join(userDataDir, "project-data-preserved.txt");

assertTemporary(testRoot);

try {
  if (materialAcceptanceRoot) {
    mkdirSync(materialAcceptanceRoot, { recursive: true });
    materialUserDataDir = mkdtempSync(join(materialAcceptanceRoot, "installed-mixed-"));
  }
  await run(installer, ["/S", `/D=${installDir}`], "fresh install");
  const executable = join(installDir, "AI Translator Desktop.exe");
  assert.equal(existsSync(executable), true, "fresh install did not create the application executable");

  mkdirSync(userDataDir);
  writeFileSync(marker, "phase14-user-project-marker\n", "utf8");
  await run(
    process.execPath,
    [join(process.cwd(), "scripts", "ci-package-smoke.mjs")],
    "fresh installed application smoke",
    180_000,
    {
      ...process.env,
      PHASE14_PACKAGED_ROOT: installDir,
      PHASE14_USER_DATA_DIR: userDataDir,
      PHASE14_EXPECT_PERSISTED_SETTINGS: "0",
    },
  );

  await run(installer, ["/S", `/D=${installDir}`], "overwrite upgrade");
  assert.equal(existsSync(marker), true, "overwrite upgrade removed user data");
  await run(
    process.execPath,
    [join(process.cwd(), "scripts", "ci-package-smoke.mjs")],
    "upgraded installed application smoke",
    180_000,
    {
      ...process.env,
      PHASE14_PACKAGED_ROOT: installDir,
      PHASE14_USER_DATA_DIR: userDataDir,
      PHASE14_EXPECT_PERSISTED_SETTINGS: "1",
    },
  );

  await run(
    process.execPath,
    [join(process.cwd(), "scripts", "e2e-packaged-smoke.mjs")],
    "installed real ASR download, recognition, and restart smoke",
    1_200_000,
    {
      ...process.env,
      PHASE14_PACKAGED_ROOT: installDir,
      PHASE14_PACKAGED_EXECUTABLE: executable,
    },
  );

  if (materialUserDataDir) {
    await run(
      process.execPath,
      [join(process.cwd(), "scripts", "e2e-release-candidate.mjs")],
      "installed mixed-material release candidate smoke",
      900_000,
      {
        ...process.env,
        PHASE14_PACKAGED_ROOT: installDir,
        PHASE14_USER_DATA_DIR: materialUserDataDir,
      },
    );
  }

  const uninstallers = readdirSync(installDir).filter((name) => /^Uninstall.*\.exe$/i.test(name));
  assert.equal(uninstallers.length, 1, `expected one uninstaller, found: ${uninstallers.join(", ")}`);
  await run(join(installDir, uninstallers[0]), ["/S"], `uninstall ${basename(uninstallers[0])}`);
  await waitUntilMissing(installDir, "application directory");
  assert.equal(existsSync(marker), true, "uninstall removed user project data");
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  assertTemporary(testRoot);
  const cleanupErrors = [];
  try {
    rmSync(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (materialUserDataDir) {
    assertManagedAcceptance(materialUserDataDir);
    try {
      rmSync(materialUserDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length && !primaryError) throw new AggregateError(cleanupErrors, "installer smoke cleanup failed");
  if (cleanupErrors.length) {
    console.warn(`Installer smoke cleanup also failed: ${cleanupErrors.map((error) => error.code ?? error.message).join(", ")}`);
  }
}

console.log("Phase 14 fresh install, overwrite upgrade, launch, and uninstall smoke passed");
