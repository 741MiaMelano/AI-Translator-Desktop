import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const builder = readFileSync("electron-builder.yml", "utf8");
const icon = readFileSync("build/icon.ico");
const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const readme = readFileSync("README.md", "utf8");
const userGuide = readFileSync("docs/user-guide.md", "utf8");
const privacy = readFileSync("docs/privacy.md", "utf8");
const portableLauncher = readFileSync("启动便携版-Start-Portable.bat", "utf8");

test("CI uses a clean pinned Windows toolchain and the unified gates", () => {
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v7\.0\.1/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v7\.0\.0/);
  assert.match(workflow, /pnpm\/action-setup@[0-9a-f]{40} # v6\.0\.9/);
  assert.match(workflow, /node-version-file: \.node-version/);
  assert.match(workflow, /version: 11\.10\.0/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /python -m pip install --disable-pip-version-check --no-input numpy==2\.4\.6/);
  assert.match(workflow, /pnpm run check/);
  assert.match(workflow, /pnpm run package:ci/);
  assert.match(workflow, /PHASE7_ASR_ALLOW_DOWNLOAD: "1"/);
  assert.doesNotMatch(workflow, /cache:/);
  assert.equal(packageJson.scripts.postinstall, "install-electron");
  assert.match(packageJson.scripts["package:installer"], /--publish never/);
  assert.equal(packageJson.devDependencies["@playwright/test"], "1.55.1");
  assert.match(workspace, /overrides:\s+fast-uri: 3\.1\.4/);
});

test("Windows installer and portable build use the product icon", () => {
  assert.match(builder, /electronDist: node_modules\/electron\/dist/);
  assert.match(builder, /target: nsis/);
  assert.match(builder, /portable:\s+artifactName: AI-Translator-Desktop\.\$\{ext\}/);
  assert.match(builder, /icon: build\/icon\.ico/);
  assert.match(builder, /perMachine: false/);
  assert.match(builder, /deleteAppDataOnUninstall: false/);
  assert.match(builder, /differentialPackage: false/);
  assert.match(builder, /artifactName: AI-Translator-Desktop-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
  assert.match(packageJson.scripts["package:portable"], /--win portable/);
  assert.match(packageJson.scripts["package:portable"], /--publish never/);
  assert.equal(packageJson.scripts["package:release"], "pnpm run package:artifacts");
  assert.match(portableLauncher, /PORTABLE_NAME=AI-Translator-Desktop\.exe/);
  assert.match(portableLauncher, /releases\/latest/);
  assert.match(portableLauncher, /PORTABLE_SHA256=f5c7ea0390b7518401df66cf24b1caff290613eb331e488a4913e8e143831bb8/);
  assert.doesNotMatch(portableLauncher, /private GitHub Release|releases\/tag\/v1\.0\.2-rc\.6/);
  assert.match(portableLauncher, /Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(portableLauncher, /System\.Net\.WebClient/);
  assert.match(portableLauncher, /PORTABLE_VERIFY_ONLY/);
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  const frameCount = icon.readUInt16LE(4);
  const frameSizes = Array.from({ length: frameCount }, (_, index) => {
    const encoded = icon[6 + index * 16];
    return encoded === 0 ? 256 : encoded;
  });
  assert.deepEqual(frameSizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
});

test("user documentation covers the real install, data, update, and recovery boundaries", () => {
  assert.doesNotMatch(readme, /Provider calls, media processing, ASR, FFmpeg execution.*not implemented/i);
  assert.match(readme, /docs\/user-guide\.md/);
  assert.match(readme, /docs\/privacy\.md/);
  for (const expected of [
    /SRT, VTT, ASS or SSA/,
    /Unknown publisher/,
    /SHA-256/,
    /before every application update/i,
    /Normal uninstall.*keeps[\s\S]*projects/i,
    /%APPDATA%\\desktop-ai-translator-ui/,
    /never silently replayed at startup/,
  ]) assert.match(userGuide, expected);
  for (const expected of [
    /no product account, analytics,[\s\S]*telemetry/,
    /selected subtitle text[\s\S]*selected Provider/,
    /Windows\s+DPAPI/,
    /Normal uninstall intentionally[\s\S]*keeps user data/,
  ]) assert.match(privacy, expected);
});

test("release commands reuse the complete E2E and packaged runtime paths", () => {
  for (const script of [
    "e2e-phase13-usability.mjs",
    "e2e-electron-smoke.mjs",
    "e2e-phase8-recovery-smoke.mjs",
    "e2e-phase8-exit-smoke.mjs",
    "e2e-phase10-resource-tabs.mjs",
    "e2e-phase12-settings-smoke.mjs",
  ]) assert.match(packageJson.scripts["test:e2e:release"], new RegExp(script.replace(".", "\\.")));
  assert.match(packageJson.scripts["package:ci"], /--win nsis portable/);
  assert.match(packageJson.scripts["package:ci"], /ci-package-smoke\.mjs/);
  assert.doesNotMatch(packageJson.scripts["package:ci"], /package:artifacts|installer-smoke|e2e-portable-smoke/);
  assert.equal(packageJson.scripts["package:release"], "pnpm run package:artifacts");
});
