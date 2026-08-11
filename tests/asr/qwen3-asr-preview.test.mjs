import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createQwenRuntimePort, createUnifiedAsrRuntimePort, validateQwenManifest } from "../../backend/asr/qwen3-asr-port.mjs";
import { createQwenInstaller, createUnifiedAsrInstaller } from "../../backend/asr/qwen3-asr-installer.mjs";
import { createQwenAsrProcess } from "../../backend/asr/qwen3-asr-process.mjs";
import { createAsrDeviceSelector } from "../../backend/asr/device-selector.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sidecarSelfCheck = (command) => {
  const script = fileURLToPath(new URL("../../backend/asr/qwen3-asr-sidecar.py", import.meta.url));
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  let completed;
  for (const executable of candidates) {
    completed = spawnSync(executable, [script, command], { encoding: "utf8" });
    if (!completed.error || completed.error.code !== "ENOENT") break;
  }
  return completed;
};

test("Qwen Preview manifest exposes fixed 0.6B and 1.7B snapshots plus shared aligner", async () => {
  const raw = JSON.parse(await readFile(
    new URL("../../docs/third-party/asr/qwen-manifest.json", import.meta.url),
    "utf8",
  ));
  const manifest = validateQwenManifest(raw);

  assert.equal(manifest.engine.id, "qwen3-asr");
  assert.equal(manifest.engine.version, "0.0.6");
  assert.deepEqual(manifest.models.map(({ id }) => id), ["qwen3-asr-0.6b", "qwen3-asr-1.7b"]);
  assert.deepEqual(manifest.models.map(({ productStatus }) => productStatus), ["preview", "preview"]);
  assert.equal(manifest.models[0].files.find(({ relativePath }) => relativePath === "model.safetensors").sizeBytes, 1_876_091_704);
  assert.equal(manifest.models[1].files.filter(({ role }) => role === "weight").length, 2);
  assert.equal(manifest.aligner.id, "qwen3-forced-aligner-0.6b");
  assert.equal(manifest.runtime.device, "cuda");
  assert.equal(manifest.runtime.bootstrap.archive.sha256, "4e1278ede866be6c0bf32d2f466cc6de7a9fb399ecf20c9ce2d186e52424be47");
});

test("Qwen public capability never exposes managed paths or download URLs", async () => {
  const raw = JSON.parse(await readFile(
    new URL("../../docs/third-party/asr/qwen-manifest.json", import.meta.url),
    "utf8",
  ));
  const root = await mkdtemp(join(tmpdir(), "qwen-preview-capability-"));
  try {
    const status = await createQwenRuntimePort({
      manifest: raw,
      appOwnedRoot: join(root, "owned"),
      resourceRoot: root,
      platform: "win32",
      arch: "x64",
    }).getCapabilityStatus();
    assert.equal(/path|url|argv|cwd/i.test(JSON.stringify(status)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Qwen model channel installs a complete snapshot and its shared aligner", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-preview-installer-"));
  const notices = join(root, "notices");
  await mkdir(notices);
  const modelBytes = Buffer.from("model");
  const configBytes = Buffer.from("config");
  const alignerBytes = Buffer.from("aligner");
  const noticeBytes = Buffer.from("notice");
  await writeFile(join(notices, "NOTICE.txt"), noticeBytes);
  const entry = (relativePath, role, bytes) => ({ relativePath, role, sizeBytes: bytes.length, sha256: hash(bytes) });
  const snapshot = (id, bytes) => ({
    id,
    displayName: id,
    revision: "revision",
    snapshotHash: hash(Buffer.from(id)),
    sourceBaseUrl: `https://models.example/${id}/`,
    mirrorBaseUrl: `https://mirror.example/${id}/`,
    sizeBytes: bytes.length + configBytes.length,
    files: [entry("model.safetensors", "weight", bytes), entry("config.json", "config", configBytes), entry("licenses/NOTICE.txt", "notice", noticeBytes)],
  });
  const manifest = {
    runtime: { id: "qwen-runtime", version: "1", pythonVersion: "3.12.13", requirementsFile: "requirements.txt", sidecarFile: "sidecar.py", bootstrap: {} },
    models: [snapshot("qwen3-asr-0.6b", modelBytes)],
    aligner: snapshot("qwen3-forced-aligner-0.6b", alignerBytes),
  };
  const payloads = new Map([
    ["model.safetensors", [modelBytes, alignerBytes]],
    ["config.json", [configBytes, configBytes]],
  ]);
  let officialFailed = false;
  const installer = createQwenInstaller({
    manifest,
    appOwnedRoot: join(root, "owned"),
    trustedNoticeRoot: notices,
    resourceRoot: root,
    validateManifest: (value) => value,
    openDownload: async ({ url }) => {
      if (!officialFailed && new URL(url).hostname === "models.example") {
        officialFailed = true;
        throw new TypeError("official unavailable");
      }
      const name = new URL(url).pathname.split("/").pop();
      const values = payloads.get(name);
      const bytes = values.shift();
      return { status: 200, headers: { get: (key) => key.toLowerCase() === "etag" ? `\"${hash(bytes)}\"` : null }, body: Readable.from([bytes]) };
    },
  });

  try {
    const installed = await installer.install({ assetId: "qwen3-asr-0.6b", source: "auto", operationId: "install-qwen" });
    assert.deepEqual(installed, {
      assetId: "qwen3-asr-0.6b",
      installState: "ready",
      source: "mirror",
      sizeBytes: modelBytes.length + configBytes.length + alignerBytes.length + configBytes.length,
      sha256: manifest.models[0].snapshotHash,
      resumedFromBytes: 0,
    });
    assert.equal(await readFile(join(root, "owned", "models", "qwen3-asr-0.6b", "model.safetensors"), "utf8"), "model");
    assert.equal(await readFile(join(root, "owned", "auxiliary", "qwen3-forced-aligner-0.6b", "model.safetensors"), "utf8"), "aligner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Qwen startup reconciliation removes abandoned publishes and keeps only resumable partials", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-preview-reconcile-"));
  const modelBytes = Buffer.from("model");
  const configBytes = Buffer.from("config");
  const file = (relativePath, role, bytes) => ({ relativePath, role, sizeBytes: bytes.length, sha256: hash(bytes) });
  const snapshot = (id) => ({
    id,
    files: [file("model.safetensors", "weight", modelBytes), file("config.json", "config", configBytes)],
  });
  const manifest = {
    runtime: { id: "qwen-runtime", pythonVersion: "3.12.13" },
    models: [snapshot("qwen3-asr-0.6b")],
    aligner: snapshot("qwen3-forced-aligner-0.6b"),
  };
  const staging = join(root, "owned", "staging", "qwen", "qwen3-asr-0.6b");
  const downloads = join(staging, "downloads");
  const abandoned = join(staging, "publish-crashed");
  const runtimeRoot = join(root, "owned", "runtimes", "qwen-runtime");
  const runtimePython = join(runtimeRoot, "python", "cpython-3.12.13-windows-x86_64-none");
  await Promise.all([
    mkdir(downloads, { recursive: true }),
    mkdir(abandoned, { recursive: true }),
    mkdir(runtimePython, { recursive: true }),
    mkdir(join(runtimeRoot, "venv"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(downloads, "model.safetensors.partial"), "mo"),
    writeFile(join(downloads, "config.json.partial"), "wrong!"),
    writeFile(join(abandoned, "model.safetensors"), modelBytes),
    writeFile(join(runtimePython, "python.exe"), "python"),
    writeFile(join(runtimeRoot, "venv", "pyvenv.cfg"), "home = C:\\deleted-model-root\\python\nrelocatable = true\n"),
  ]);
  const installer = createQwenInstaller({
    manifest,
    appOwnedRoot: join(root, "owned"),
    trustedNoticeRoot: root,
    resourceRoot: root,
    validateManifest: (value) => value,
  });

  try {
    assert.deepEqual(await installer.reconcile(), {
      abandonedPublishesRemoved: 1,
      resumablePartialsPreserved: 1,
      invalidPartialsRemoved: 1,
    });
    assert.equal(await readFile(join(downloads, "model.safetensors.partial"), "utf8"), "mo");
    assert.match(await readFile(join(runtimeRoot, "venv", "pyvenv.cfg"), "utf8"), new RegExp(`^home = ${runtimePython.replaceAll("\\", "\\\\")}`, "m"));
    await assert.rejects(() => lstat(join(downloads, "config.json.partial")), { code: "ENOENT" });
    await assert.rejects(() => lstat(abandoned), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Qwen runtime channel creates an app-managed CUDA sidecar environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-preview-runtime-"));
  const resources = join(root, "resources");
  await mkdir(resources);
  await writeFile(join(resources, "requirements.txt"), "qwen-asr==0.0.6\n");
  await writeFile(join(resources, "sidecar.py"), "print('ok')\n");
  const archiveBytes = Buffer.from("verified uv archive");
  const manifest = {
    runtime: {
      id: "qwen-runtime",
      version: "1",
      pythonVersion: "3.12.13",
      requirementsFile: "requirements.txt",
      sidecarFile: "sidecar.py",
      bootstrap: { archive: { sizeBytes: archiveBytes.length, sha256: hash(archiveBytes), sourceUrl: "https://runtime.example/uv.zip", entries: [], ignoredEntries: [] } },
    },
    models: [],
    aligner: { id: "aligner" },
  };
  const commands = [];
  const progress = [];
  const buildRoot = join(root, "owned", "staging", "qwen", "qwen-runtime", "publish-runtime");
  const pythonAlias = "cpython-3.12-windows-x86_64-none";
  const managedPython = join(buildRoot, "python", "cpython-3.12.13-windows-x86_64-none", "python.exe");
  const oldRuntimeRoot = join(root, "owned", "runtimes", "qwen-runtime");
  await mkdir(join(buildRoot, ".."), { recursive: true });
  await writeFile(join(buildRoot, "..", "uv.zip"), archiveBytes);
  await mkdir(oldRuntimeRoot, { recursive: true });
  await writeFile(join(oldRuntimeRoot, "old-runtime.txt"), "still ready");
  const installer = createQwenInstaller({
    manifest,
    appOwnedRoot: join(root, "owned"),
    trustedNoticeRoot: root,
    resourceRoot: resources,
    validateManifest: (value) => value,
    reportProgress: (event) => progress.push(event),
    openDownload: async () => assert.fail("the verified bootstrap archive should be reused"),
    extractArchive: async ({ destinationRoot }) => {
      await assert.rejects(() => lstat(destinationRoot), { code: "ENOENT" });
      await mkdir(destinationRoot, { recursive: true });
      await writeFile(join(destinationRoot, "uv.exe"), "uv");
    },
    runProcess: async (spec) => {
      assert.equal(await readFile(join(oldRuntimeRoot, "old-runtime.txt"), "utf8"), "still ready");
      commands.push(spec.argv);
      if (spec.argv.at(-1) === "--self-check") assert.equal(spec.timeoutMs, 3 * 60_000);
      if (spec.argv[0] === "python" && spec.argv[1] === "find") {
        await mkdir(join(managedPython, ".."), { recursive: true });
        await writeFile(managedPython, "python");
        await symlink(join(managedPython, ".."), join(buildRoot, "python", pythonAlias), process.platform === "win32" ? "junction" : "dir");
        return { stdout: Buffer.from(`${managedPython}\n`) };
      }
      if (spec.argv[0] === "venv") {
        const python = join(buildRoot, "venv", "Scripts", "python.exe");
        await mkdir(join(python, ".."), { recursive: true });
        await writeFile(python, "python");
        await writeFile(join(buildRoot, "venv", "pyvenv.cfg"), `home = ${join(managedPython, "..")}\nrelocatable = true\n`);
      }
      return { stdout: Buffer.alloc(0) };
    },
  });

  try {
    const installed = await installer.installRuntime({ assetId: "qwen-runtime", source: "official", operationId: "runtime-install" });
    assert.equal(installed.installState, "ready");
    assert.deepEqual(commands.map((argv) => argv.slice(0, 2)), [
      ["python", "install"],
      ["python", "find"],
      ["venv", join(buildRoot, "venv")],
      ["pip", "install"],
      [join(resources, "sidecar.py"), "--self-check"],
    ]);
    assert.ok(commands.find(([command]) => command === "venv").includes("--relocatable"));
    const marker = JSON.parse(await readFile(join(root, "owned", "runtimes", "qwen-runtime", ".ready.json"), "utf8"));
    assert.deepEqual(marker, { runtimeId: "qwen-runtime", runtimeVersion: "1", pythonVersion: "3.12.13" });
    assert.match(await readFile(join(oldRuntimeRoot, "venv", "pyvenv.cfg"), "utf8"), new RegExp(`^home = ${join(oldRuntimeRoot, "python", "cpython-3.12.13-windows-x86_64-none").replaceAll("\\", "\\\\")}`, "m"));
    await assert.rejects(() => lstat(join(root, "owned", "runtimes", "qwen-runtime", "python", pythonAlias)), { code: "ENOENT" });
    assert.equal(progress.find(({ stage }) => stage === "packages").progress, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Qwen CUDA probe allows a cold runtime startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-preview-probe-"));
  try {
    const executablePath = join(root, "python.exe");
    const sidecarPath = join(root, "sidecar.py");
    await Promise.all([writeFile(executablePath, "python"), writeFile(sidecarPath, "sidecar")]);
    let observed;
    const process = createQwenAsrProcess({
      runProcess: async (spec) => {
        observed = spec;
        return { stdout: Buffer.alloc(0) };
      },
    });
    await process.probe({
      operationId: "qwen-cold-probe",
      runtime: {
        engineId: "qwen3-asr", engineVersion: "0.0.6",
        runtimeId: "qwen3-asr-transformers-cu128-x64",
        runtimeVersion: "0.0.6+torch2.11.0-cu128", device: "cuda",
        executablePath, cwd: root, sidecarPath,
      },
    });
    assert.equal(observed.timeoutMs, 2 * 60_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Qwen sidecar output is converted to the existing canonical ASR contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-preview-process-"));
  const workRoot = join(root, "work");
  const runtimeRoot = join(root, "runtime");
  const modelRoot = join(root, "model");
  const alignerRoot = join(root, "aligner");
  await Promise.all([workRoot, runtimeRoot, modelRoot, alignerRoot].map((path) => mkdir(path, { recursive: true })));
  const checkpointPath = join(root, "checkpoint.json");
  for (const path of ["python.exe", "sidecar.py"]) await writeFile(join(runtimeRoot, path), path);
  await writeFile(join(workRoot, "audio.wav"), "audio");
  const progress = [];
  const attempts = new Map();
  const process = createQwenAsrProcess({
    runProcess: async (spec) => {
      assert.equal(spec.envOverrides.USERNAME, "desktop-ai-translator");
      assert.equal(spec.truncateStderr, true);
      assert.equal(spec.timeoutMs, 5 * 60_000);
      assert.equal(spec.argv[spec.argv.indexOf("--checkpoint") + 1], checkpointPath);
      assert.equal(spec.argv[spec.argv.indexOf("--fingerprint") + 1], "c".repeat(64));
      assert.equal(spec.argv[spec.argv.indexOf("--duration-ms") + 1], "4000");
      spec.onStdout?.(Buffer.from('{"type":"progress","progress":5,'));
      spec.onStdout?.(Buffer.from('"completedChunks":1,"totalChunks":20}\n'));
      const output = spec.argv[spec.argv.indexOf("--output") + 1];
      const name = output.includes("retry-boundary") ? "retry" : output.includes("always-invalid") ? "always" : "valid";
      const attempt = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attempt);
      if (name !== "valid" && attempt > 1) {
        const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
        assert.equal(saved.segments.length, 1);
      }
      const excessiveBoundaryDrift = name === "always" || (name === "retry" && attempt === 1);
      const raw = {
        schemaVersion: 1,
        mediaDurationMs: 4_000,
        segments: [{
          startMs: 100,
          endMs: 400,
          result: [{ language: "", text: "", time_stamps: null }],
        }, {
          startMs: 500,
          endMs: 3_500,
          result: [{
            language: "English",
            text: "Hello, world! Again",
            time_stamps: { items: [
              { text: "Hello", start_time: excessiveBoundaryDrift ? -0.6 : -0.1, end_time: 0.3 },
              { text: "world", start_time: 0.3, end_time: 0.3 },
              { text: "!", start_time: 0.3, end_time: 0.3 },
              { text: "Again", start_time: 2.9, end_time: 3.2 },
            ] },
          }],
        }],
      };
      await writeFile(output, JSON.stringify(raw));
      await writeFile(checkpointPath, JSON.stringify({ ...raw, fingerprint: "c".repeat(64) }));
      return { stdout: Buffer.from("ok") };
    },
  });
  const runtime = {
    engineId: "qwen3-asr", engineVersion: "0.0.6", runtimeId: "qwen3-asr-transformers-cu128-x64",
    runtimeVersion: "0.0.6+torch2.11.0-cu128", device: "cuda",
    executablePath: join(runtimeRoot, "python.exe"), cwd: runtimeRoot, sidecarPath: join(runtimeRoot, "sidecar.py"),
    modelPath: modelRoot, modelId: "qwen3-asr-0.6b", modelVersion: "revision", modelHash: "a".repeat(64),
    alignerPath: alignerRoot, alignerId: "qwen3-forced-aligner-0.6b", alignerVersion: "revision", alignerHash: "b".repeat(64),
  };
  try {
    const completed = await process.transcribe({
      operationId: "qwen-transcribe", runtime, workRoot, audioPath: join(workRoot, "audio.wav"),
      outputName: "result", mediaDurationMs: 4_000, languageMode: "auto", languageHint: null,
      checkpointPath, checkpointFingerprint: "c".repeat(64), onProgress: (event) => progress.push(event),
    });
    const canonical = JSON.parse(await readFile(completed.canonicalResultPath, "utf8"));
    assert.equal(canonical.detectedLanguage, "en");
    assert.equal(canonical.segments[0].text, "Hello, world! Again");
    assert.deepEqual(canonical.segments[0].words.map(({ text }) => text), ["Hello,", " world!", " Again"]);
    assert.ok(canonical.warnings.includes("zero_duration_tokens_partitioned"));
    assert.ok(canonical.warnings.includes("leading_timestamp_clamped"));
    assert.ok(canonical.warnings.includes("terminal_timestamp_clamped"));
    assert.ok(canonical.segments[0].words.every((word) => word.endMs > word.startMs));
    assert.deepEqual(progress, [{ progress: 5, completedChunks: 1, totalChunks: 20 }]);
    const recovered = await process.transcribe({
      operationId: "qwen-retry-boundary", runtime, workRoot, audioPath: join(workRoot, "audio.wav"),
      outputName: "retry-boundary", mediaDurationMs: 4_000, languageMode: "auto", languageHint: null,
      checkpointPath, checkpointFingerprint: "c".repeat(64),
    });
    assert.equal(attempts.get("retry"), 2);
    assert.equal(JSON.parse(await readFile(recovered.canonicalResultPath, "utf8")).segments.length, 1);
    await assert.rejects(process.transcribe({
      operationId: "qwen-always-invalid", runtime, workRoot, audioPath: join(workRoot, "audio.wav"),
      outputName: "always-invalid", mediaDurationMs: 4_000, languageMode: "auto", languageHint: null,
      checkpointPath, checkpointFingerprint: "c".repeat(64),
    }), (error) => {
      assert.equal(error.code, "INVALID_ASR_RESULT");
      assert.deepEqual(error.safeDetails, { chunkIndex: 1, startMs: 500, endMs: 3_500 });
      return true;
    });
    assert.equal(attempts.get("always"), 2);
    assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).segments.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Qwen uses the verified Silero segmenter and persists excluded background-audio intervals", async () => {
  const root = await mkdtemp(join(tmpdir(), "qwen-preview-vad-中文-"));
  const workRoot = join(root, "work");
  const runtimeRoot = join(root, "runtime");
  const modelRoot = join(root, "model");
  const alignerRoot = join(root, "aligner");
  const vadRoot = join(root, "vad");
  await Promise.all([workRoot, runtimeRoot, modelRoot, alignerRoot, vadRoot].map((path) => mkdir(path, { recursive: true })));
  const runtime = {
    engineId: "qwen3-asr", engineVersion: "0.0.6", runtimeId: "qwen3-asr-transformers-cu128-x64",
    runtimeVersion: "0.0.6+torch2.11.0-cu128", device: "cuda",
    executablePath: join(runtimeRoot, "python.exe"), cwd: runtimeRoot, sidecarPath: join(runtimeRoot, "sidecar.py"),
    modelPath: modelRoot, modelId: "qwen3-asr-0.6b", modelVersion: "revision", modelHash: "a".repeat(64),
    alignerPath: alignerRoot, alignerId: "qwen3-forced-aligner-0.6b", alignerVersion: "revision", alignerHash: "b".repeat(64),
    vadExecutablePath: join(vadRoot, "whisper-vad-speech-segments.exe"),
    vadModelPath: join(vadRoot, "ggml-silero-v6.2.0.bin"), vadModelId: "silero-vad-v6.2.0",
    vadModelVersion: "6.2.0", vadModelHash: "c".repeat(64),
  };
  await Promise.all([
    writeFile(runtime.executablePath, "python"), writeFile(runtime.sidecarPath, "sidecar"),
    writeFile(runtime.vadExecutablePath, "vad-tool"), writeFile(runtime.vadModelPath, "vad-model"),
    writeFile(join(workRoot, "audio.wav"), "audio"),
  ]);
  const calls = [];
  let vadStdout = Buffer.from("\nDetected 2 speech segments:\nSpeech segment 0: start = 100.00, end = 250.00\nSpeech segment 1: start = 700.00, end = 900.00\n");
  const process = createQwenAsrProcess({
    runProcess: async (spec) => {
      calls.push(spec);
      if (spec.absoluteExe === runtime.vadExecutablePath) {
        assert.equal(spec.cwd, workRoot);
        assert.match(spec.argv[spec.argv.indexOf("--vad-model") + 1], /^(?:result|empty)\.silero-vad\.bin$/);
        assert.equal(spec.argv[spec.argv.indexOf("--file") + 1], "audio.wav");
        assert.equal(spec.argv[spec.argv.indexOf("--vad-threshold") + 1], "0.5");
        assert.ok(spec.argv.includes("--no-prints"));
        return { stdout: vadStdout };
      }
      const intervalsPath = spec.argv[spec.argv.indexOf("--speech-intervals") + 1];
      const { activity } = JSON.parse(await readFile(intervalsPath, "utf8"));
      const output = spec.argv[spec.argv.indexOf("--output") + 1];
      await writeFile(output, JSON.stringify({
        schemaVersion: 1,
        mediaDurationMs: 10_000,
        activity,
        segments: [{
          startMs: 1_000,
          endMs: 2_500,
          result: [{ language: "English", text: "Hello", time_stamps: { items: [
            { text: "Hello", start_time: 0, end_time: 1 },
          ] } }],
        }],
      }));
      return { stdout: Buffer.from('{"ok":true}\n') };
    },
  });
  try {
    const completed = await process.transcribe({
      operationId: "qwen-vad", runtime, workRoot, audioPath: join(workRoot, "audio.wav"),
      outputName: "result", mediaDurationMs: 10_000, languageMode: "auto", languageHint: null,
      vad: {
        mode: "auto",
        model: { id: "silero-vad-v6.2.0", version: "6.2.0", hash: "c".repeat(64) },
        parameters: {
          threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100,
          maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1,
        },
      },
    });
    const canonical = JSON.parse(await readFile(completed.canonicalResultPath, "utf8"));
    assert.equal(calls.length, 2);
    assert.deepEqual(canonical.activity.speechIntervals, [
      { startMs: 1_000, endMs: 2_500 }, { startMs: 7_000, endMs: 9_000 },
    ]);
    assert.deepEqual(canonical.activity.excludedIntervals, [
      { startMs: 0, endMs: 1_000 }, { startMs: 2_500, endMs: 7_000 }, { startMs: 9_000, endMs: 10_000 },
    ]);
    assert.equal(completed.summary.vadSpeechIntervalCount, 2);
    vadStdout = Buffer.from("\nDetected 0 speech segments:\n");
    await assert.rejects(process.transcribe({
      operationId: "qwen-vad-empty", runtime, workRoot, audioPath: join(workRoot, "audio.wav"),
      outputName: "empty", mediaDurationMs: 10_000, languageMode: "auto", languageHint: null,
      vad: {
        mode: "auto", model: { id: "silero-vad-v6.2.0", version: "6.2.0", hash: "c".repeat(64) },
        parameters: {
          threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100,
          maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1,
        },
      },
    }), (error) => error?.code === "NO_SPEECH_DETECTED");
    assert.equal(calls.length, 3, "the Qwen sidecar must not run after VAD filters every interval");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Qwen sidecar checkpoint protocol atomically resumes matching speech chunks", (t) => {
  const completed = sidecarSelfCheck("checkpoint-self-check");
  if (completed?.error?.code === "ENOENT") return t.skip("Python is unavailable");
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(JSON.parse(completed.stdout), { ok: true, checkpoint: "atomic-resume" });
});

test("Qwen sidecar scans a two-hour PCM stream with deterministic bounded reads", (t) => {
  const completed = sidecarSelfCheck("streaming-self-check");
  if (completed?.error?.code === "ENOENT") return t.skip("Python is unavailable");
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(JSON.parse(completed.stdout), {
    ok: true,
    durationMs: 7_200_000,
    intervalCount: 720,
    maxReadFrames: 16_000,
    contractDurationMs: 4_000,
    actualDurationMs: 4_200,
  });
});

test("unified ASR ports expose and route both Whisper and Qwen assets", async () => {
  const calls = [];
  const whisper = {
    getCapabilityStatus: async () => ({
      engineId: "whisper.cpp", engineVersion: "1.9.1",
      runtime: { id: "whisper-cpu", version: "1", installState: "ready" },
      models: [{ id: "small", version: "1", modelHash: "a".repeat(64), installState: "ready" }],
      optionalRuntimes: [], ready: true,
    }),
    resolveReadyRuntime: async (device, modelId) => ({ engineId: "whisper.cpp", device, modelId }),
    resolveReadyRuntimeForProbe: async (device) => ({ engineId: "whisper.cpp", device }),
    resolveReadyVadRuntime: async () => ({
      vadExecutablePath: "C:\\runtime\\whisper-vad-speech-segments.exe",
      vadModelPath: "C:\\vad\\model.bin",
    }),
  };
  const qwen = {
    getCapabilityStatus: async () => ({
      engine: { id: "qwen3-asr", version: "0.0.6" },
      runtime: { id: "qwen-runtime", version: "1", device: "cuda", installState: "ready" },
      aligner: { id: "qwen-aligner", version: "1", modelHash: "b".repeat(64), installState: "ready" },
      models: [{ id: "qwen3-asr-0.6b", version: "1", modelHash: "c".repeat(64), installState: "ready" }],
      ready: true,
    }),
    resolveReadyRuntime: async (device, modelId) => ({ engineId: "qwen3-asr", device, modelId }),
  };
  const port = createUnifiedAsrRuntimePort({ whisper, qwen });
  const status = await port.getCapabilityStatus();
  assert.deepEqual(status.models.map(({ id, engineId }) => [id, engineId]), [
    ["small", "whisper.cpp"], ["qwen3-asr-0.6b", "qwen3-asr"],
  ]);
  const qwenRuntime = await port.resolveReadyRuntime("cuda", "qwen3-asr-0.6b");
  assert.equal(qwenRuntime.engineId, "qwen3-asr");
  assert.equal(qwenRuntime.vadExecutablePath, "C:\\runtime\\whisper-vad-speech-segments.exe");
  assert.equal((await port.resolveReadyRuntime("cpu", "small")).engineId, "whisper.cpp");

  const api = (name) => ({
    install: async ({ assetId }) => (calls.push(`${name}:model:${assetId}`), { assetId }),
    installRuntime: async ({ assetId }) => (calls.push(`${name}:runtime:${assetId}`), { assetId }),
    cancel: () => ({ cancelled: false }), getDownloadStatus: () => [], reconcile: async () => ({}),
    getSourceHealth: async () => [],
  });
  const installer = createUnifiedAsrInstaller({ whisper: api("whisper"), qwen: api("qwen") });
  await installer.install({ assetId: "qwen3-asr-0.6b" });
  await installer.installRuntime({ assetId: "qwen3-asr-transformers-cu128-x64" });
  await installer.install({ assetId: "small" });
  assert.deepEqual(calls, [
    "qwen:model:qwen3-asr-0.6b", "qwen:runtime:qwen3-asr-transformers-cu128-x64", "whisper:model:small",
  ]);
});

test("Qwen Preview always selects its CUDA runtime and never falls back to Whisper CPU", async () => {
  const runtime = {
    engineId: "qwen3-asr", engineVersion: "0.0.6", runtimeId: "qwen3-asr-transformers-cu128-x64",
    runtimeVersion: "0.0.6+torch2.11.0-cu128", device: "cuda",
  };
  const selector = createAsrDeviceSelector({
    getCapabilityStatus: async () => ({
      runtime: { id: "whisper-cpu", version: "1.9.1", installState: "not_installed" },
      optionalRuntimes: [{ id: runtime.runtimeId, version: runtime.runtimeVersion, device: "cuda", engineId: "qwen3-asr", installState: "ready" }],
    }),
    resolveRuntime: async () => runtime,
    resolveProbeRuntime: async (device, modelId) => {
      assert.equal(device, "cuda");
      assert.equal(modelId, "qwen3-asr-0.6b");
      return runtime;
    },
    probeRuntime: async () => ({ available: true }),
    getDefaultModelId: () => "qwen3-asr-0.6b",
  });
  const detected = await selector.detect({ operationId: "qwen-detect" });
  assert.equal(detected.detection.cuda.status, "available");
  assert.equal(detected.detection.cuda.runtimeId, runtime.runtimeId);
  const completed = await selector.run({
    operationId: "qwen-device", modelId: "qwen3-asr-0.6b", requestedDevice: "auto", allowCudaFallback: true,
    executeStagedAttempt: async ({ device }) => device,
  });
  assert.equal(completed.actualDevice, "cuda");
  await assert.rejects(() => selector.run({
    operationId: "qwen-cpu", modelId: "qwen3-asr-1.7b", requestedDevice: "cpu", allowCudaFallback: true,
    executeStagedAttempt: async () => null,
  }), { code: "CUDA_UNAVAILABLE" });
});
