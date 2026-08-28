import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolveVerifiedArtifactPaths } from "../backend/media/ffmpeg-artifact-manifest.mjs";
import { validateAsrManifest } from "../backend/asr/runtime-registry.mjs";
import { listWindowsProcessTreeNames } from "./electron-test-lifecycle.mjs";
import {
  createPhase7MediaFixtures,
  createPhase7UserDataDir,
  resolvePhase7ModelId,
  runPhase7AsrWorkflow,
  runPhase7AudioSmoke,
  stageVerifiedAsrAssets,
} from "./asr-phase7-e2e.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const releaseRoot = join(rootDir, "release");
const unpackedRoot = join(releaseRoot, "win-unpacked");
const executable = join(releaseRoot, "AI-Translator-Desktop.exe");
const checksumPath = `${executable}.sha256`;
const resources = join(unpackedRoot, "resources");
const asrManifest = validateAsrManifest(JSON.parse(readFileSync(join(resources, "asr", "manifest.json"), "utf8")));
const modelId = resolvePhase7ModelId();
const acceptanceModel = asrManifest.models.find((model) => model.id === modelId);
assert.ok(acceptanceModel, `Portable acceptance model is not declared: ${modelId}`);
const modelFile = acceptanceModel.files.find((entry) => entry.role === "model");
assert.ok(modelFile, `Portable ${modelId} manifest entry missing`);
for (const path of [executable, checksumPath]) assert.equal(existsSync(path), true, `Portable smoke input missing: ${path}`);
assert.equal(existsSync(join(resources, "asr", "models", modelId, ...modelFile.relativePath.split("/"))), false, "Portable package bundled the optional model");

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const portableHash = await sha256File(executable);
assert.equal(readFileSync(checksumPath, "utf8"), `${portableHash}  ${executable.split(/[\\/]/).at(-1)}\n`, "Portable checksum mismatch");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string", "failed to allocate a loopback port");
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForEndpoint(child, port, stderr, spawnFailure) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (spawnFailure.value) throw spawnFailure.value;
    if (child.exitCode !== null) throw new Error(`Portable exited before CDP was ready (${child.exitCode}): ${stderr.value}`);
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) });
      const version = response.ok ? await response.json() : null;
      if (typeof version?.webSocketDebuggerUrl === "string") return version.webSocketDebuggerUrl;
    } catch {}
    await delay(250);
  }
  throw new Error(`Portable CDP endpoint timed out: ${stderr.value}`);
}

function terminatePortable(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {
    child.kill();
  }
}

async function waitForPortableExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signalCode: child.signalCode };
  }
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", (exitCode, signalCode) => resolveExit({ exitCode, signalCode }))),
    delay(timeoutMs).then(() => null),
  ]);
}

async function firstDesktopPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (await page.evaluate(() => Boolean(window.desktop)).catch(() => false)) return page;
      }
    }
    await delay(100);
  }
  throw new Error("Portable renderer did not expose the desktop bridge");
}

async function launchPortable(userDataDir, mediaPath) {
  const port = await freePort();
  const stderr = { value: "" };
  const spawnFailure = { value: null };
  const child = spawn(executable, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      TRANSLATION_FAKE_PROVIDER: "1",
      MEDIA_E2E_FIXTURE_PATH: mediaPath,
    },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.once("error", (error) => { spawnFailure.value = error; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-4_000); });
  let browser;
  try {
    browser = await chromium.connectOverCDP(await waitForEndpoint(child, port, stderr, spawnFailure), { timeout: 30_000 });
    const page = await firstDesktopPage(browser);
    await page.setViewportSize({ width: 1440, height: 900 });
    return { browser, child, page, stderr };
  } catch (error) {
    await browser?.close().catch(() => {});
    terminatePortable(child);
    if (!await waitForPortableExit(child, 10_000)) {
      throw new AggregateError([error, new Error("Portable launch cleanup did not terminate the process tree")], "Portable launch and cleanup failed");
    }
    throw error;
  }
}

async function closePortable(opened, { strict = false } = {}) {
  if (!opened) return;
  const { browser, child, page } = opened;
  let exit = child.exitCode !== null || child.signalCode !== null
    ? { exitCode: child.exitCode, signalCode: child.signalCode }
    : null;
  const wasRunning = exit === null;
  let forced = false;
  if (child.exitCode === null) {
    await page?.evaluate(() => window.desktop.windowControl({ action: "close" })).catch(() => {});
    exit = await waitForPortableExit(child, 20_000);
    if (!exit) {
      forced = true;
      terminatePortable(child);
      exit = await waitForPortableExit(child, 10_000);
    }
  }
  await browser.close().catch(() => {});
  if (strict) {
    assert.equal(wasRunning, true, "Portable exited before the close request");
    assert.equal(forced, false, "Portable required forced termination during a normal close");
    assert.ok(exit, "Portable did not exit after the close request");
    assert.equal(exit.exitCode, 0, `Portable exited with code ${exit.exitCode} and signal ${exit.signalCode}`);
    assert.equal(exit.signalCode, null, `Portable was terminated by ${exit.signalCode}`);
  }
}

function assertPortableWorkersExited(opened) {
  assert.doesNotMatch(
    listWindowsProcessTreeNames(opened.child.pid).join(" "),
    /whisper(?:-cli)?|ffmpeg|ffprobe/i,
    "Portable left an ASR or media worker running",
  );
}

const ffmpeg = resolveVerifiedArtifactPaths(
  JSON.parse(readFileSync(join(resources, "ffmpeg", "manifest.json"), "utf8")),
  { artifactRootDir: join(resources, "ffmpeg", "win32-x64") },
);
const userDataDir = createPhase7UserDataDir("portable");
const workDir = mkdtempSync(join(tmpdir(), "p3-5-portable-media-"));
let opened;
let primaryError = null;

try {
  const fixtures = await createPhase7MediaFixtures({ ffmpegPath: ffmpeg.ffmpegPath, workDir });
  await stageVerifiedAsrAssets({
    userDataDir,
    includeRuntime: false,
    manifestPath: join(resources, "asr", "manifest.json"),
    trustedNoticeRoot: join(resources, "asr", "licenses"),
  });
  opened = await launchPortable(userDataDir, fixtures.videoPath);
  const initial = await opened.page.evaluate(() => window.desktop.getAsrCapabilityStatus({}));
  assert.equal(initial.ok, true, JSON.stringify(initial));
  assert.equal(initial.data.runtime.installState, "ready");
  assert.equal(initial.data.models.find((model) => model.id === modelId)?.installState, "ready");

  const workflow = await runPhase7AsrWorkflow({
    page: opened.page,
    userDataDir,
    restartPage: async () => {
      await closePortable(opened, { strict: true });
      opened = undefined;
      opened = await launchPortable(userDataDir, fixtures.videoPath);
      return opened.page;
    },
  });
  assertPortableWorkersExited(opened);
  await closePortable(opened, { strict: true });
  opened = undefined;
  opened = await launchPortable(userDataDir, fixtures.audioPath);
  const audioWorkflow = await runPhase7AudioSmoke({ page: opened.page, userDataDir });
  assertPortableWorkersExited(opened);
  await closePortable(opened, { strict: true });
  opened = undefined;
  console.log("Portable offline local-model staging, recognition, timeline, and restart smoke passed", { workflow, audioWorkflow });
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  await closePortable(opened).catch(() => {});
  const cleanupErrors = [];
  for (const [path, maxRetries, retryDelay] of [[userDataDir, 20, 250], [workDir, 10, 200]]) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries, retryDelay });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length && !primaryError) throw new AggregateError(cleanupErrors, "portable smoke cleanup failed");
  if (cleanupErrors.length) {
    console.warn(`Portable smoke cleanup also failed: ${cleanupErrors.map((error) => error.code ?? error.message).join(", ")}`);
  }
}
