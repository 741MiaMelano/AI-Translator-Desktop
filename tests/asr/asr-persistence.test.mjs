import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";

function project() {
  return {
    id: "project-asr-persistence",
    title: "ASR persistence",
    sourceFileName: "source.wav",
    mediaKind: "audio",
    lifecycle: "draft",
    noSourceMedia: false,
    activeSourceTrackId: null,
    sourceTracks: [],
    config: {
      sourceLanguage: "auto",
      targetLanguages: ["zh-CN"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "none",
      styleGuide: "none",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: true,
    },
    pendingConfirmations: [],
    notes: [],
    recentRunIds: [],
    createdAt: "2026-07-19T20:00:00.000Z",
    updatedAt: "2026-07-19T20:00:00.000Z",
  };
}

function result(text = " Hello world.") {
  return {
    schemaVersion: 1,
    mediaDurationMs: 2_000,
    detectedLanguage: "en",
    languageProbability: null,
    warnings: ["language_probability_unavailable"],
    segments: [{
      startMs: 0,
      endMs: 2_000,
      text,
      language: "en",
      languageProbability: null,
      words: [
        { startMs: 0, endMs: 800, text: " Hello", probability: 0.9 },
        { startMs: 800, endMs: 1_900, text: " world.", probability: 0.8 },
      ],
    }],
  };
}

function run(id, operationId, artifactBytes = Buffer.alloc(512), cacheFingerprint = "c".repeat(64)) {
  return {
    id,
    operationId,
    projectId: "project-asr-persistence",
    audioStreamId: "s:0",
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtimeId: "whisper-cpp-cpu-x64",
    runtimeVersion: "1.9.1",
    modelId: "small",
    modelVersion: "model-revision",
    modelHash: "a".repeat(64),
    cacheFingerprint,
    requestedDevice: "auto",
    actualDevice: "cpu",
    fallbackReason: "cuda_not_ready",
    languageMode: "auto",
    languageHint: null,
    parameters: {
      threads: 6, beamSize: 5, bestOf: 5, temperature: 0, wordTimestamps: true,
      vad: {
        mode: "auto",
        model: { id: "silero-vad-v6.2.0", version: "6.2.0", hash: "b".repeat(64) },
        parameters: {
          threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100,
          maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1,
        },
      },
    },
    rawArtifactRelativePath: `artifacts/asr/${id}.json`,
    rawArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    rawArtifactSizeBytes: artifactBytes.length,
    processingDurationMs: 1_250,
    canonicalizerVersion: "whisper.cpp-1.9.1-v2",
    createdAt: "2026-07-19T20:00:00.000Z",
    completedAt: "2026-07-19T20:00:01.250Z",
  };
}

test("ASR runs segments and words append atomically survive save and restart", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "asr-persistence-"));
  let repository;
  try {
    repository = openProjectRepository(containerDir);
    const initial = project();
    repository.saveProject(initial);
    assert.equal(repository.schemaVersion, 20);

    assert.deepEqual(repository.commitAsrRun({ run: run("asr-run-1", "asr-op-1"), result: result() }), {
      runId: "asr-run-1",
      operationId: "asr-op-1",
      segmentCount: 1,
      wordCount: 2,
      deduplicated: false,
    });
    assert.deepEqual(
      repository.commitAsrRun({ run: run("ignored-duplicate-id", "asr-op-1"), result: result(" different") }),
      {
        runId: "asr-run-1",
        operationId: "asr-op-1",
        segmentCount: 1,
        wordCount: 2,
        deduplicated: true,
      },
    );
    assert.throws(
      () => repository.commitAsrRun({
        run: run("stale-duplicate-id", "asr-op-1", Buffer.alloc(512), "d".repeat(64)),
        result: result(),
      }),
      (error) => error?.code === "CONFLICT",
    );
    repository.commitAsrRun({
      run: {
        ...run("asr-run-2", "asr-op-2"),
        modelId: "large-v3-turbo-q5_0",
        modelVersion: "turbo-revision",
        modelHash: "b".repeat(64),
      },
      result: result(" Second run."),
    });

    let runs = repository.listAsrRuns();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((entry) => entry.id), ["asr-run-1", "asr-run-2"]);
    const loaded = repository.getAsrRun("asr-run-1");
    assert.equal(loaded.run.status, "completed");
    assert.equal(loaded.run.actualDevice, "cpu");
    assert.equal(loaded.run.fallbackReason, "cuda_not_ready");
    assert.equal(loaded.run.cacheFingerprint, "c".repeat(64));
    assert.equal(loaded.run.parameters.vad.mode, "auto");
    assert.equal(loaded.run.parameters.vad.model.hash, "b".repeat(64));
    assert.equal(loaded.run.rawArtifactRelativePath, "artifacts/asr/asr-run-1.json");
    assert.deepEqual(loaded.result, result());

    repository.saveProject({ ...initial, title: "ordinary save", updatedAt: "2026-07-19T21:00:00.000Z" });
    assert.equal(repository.listAsrRuns().length, 2);
    repository.close();
    repository = openProjectRepository(containerDir);
    runs = repository.listAsrRuns();
    assert.equal(runs.length, 2);
    assert.deepEqual(repository.getAsrRun("asr-run-2").result, result(" Second run."));
    assert.equal(repository.getAsrRun("asr-run-2").run.modelId, "large-v3-turbo-q5_0");
    assert.equal(repository.getAsrRun("asr-run-2").run.parameters.vad.parameters.threshold, 0.5);
  } finally {
    repository?.close();
    rmSync(containerDir, { recursive: true, force: true });
  }
});

test("song classification intervals survive project restart with the ASR result", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "asr-song-persistence-"));
  let repository;
  try {
    repository = openProjectRepository(containerDir);
    repository.saveProject(project());
    const songActivity = {
      detector: "ina-speech-music-noise-v1",
      mode: "filter",
      filteredIntervals: [{ startMs: 100, endMs: 500 }],
      uncertainIntervals: [{ startMs: 1_000, endMs: 1_400 }],
    };
    repository.commitAsrRun({
      run: run("asr-song-run", "asr-song-op"),
      result: { ...result(), songActivity },
    });
    repository.close();
    repository = openProjectRepository(containerDir);
    assert.deepEqual(repository.getAsrRun("asr-song-run").result.songActivity, songActivity);
  } finally {
    repository?.close();
    rmSync(containerDir, { recursive: true, force: true });
  }
});

test("invalid ASR result and conflicting immutable run never leave partial rows", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "asr-persistence-rollback-"));
  const repository = openProjectRepository(containerDir);
  try {
    repository.saveProject(project());
    const invalid = result();
    invalid.segments[0].words[1].startMs = -1;
    assert.throws(
      () => repository.commitAsrRun({ run: run("invalid-run", "invalid-op"), result: invalid }),
      (error) => error?.code === "INVALID_ASR_RESULT",
    );
    assert.deepEqual(repository.listAsrRuns(), []);

    repository.commitAsrRun({ run: run("immutable-run", "immutable-op"), result: result() });
    assert.throws(
      () => repository.commitAsrRun({ run: run("immutable-run", "different-op"), result: result() }),
      (error) => error?.code === "CONFLICT",
    );
    assert.equal(repository.listAsrRuns().length, 1);
  } finally {
    repository.close();
    rmSync(containerDir, { recursive: true, force: true });
  }
});

test("Qwen Preview run provenance survives persistence without impersonating Whisper", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "qwen-asr-persistence-"));
  let repository = openProjectRepository(containerDir);
  try {
    repository.saveProject(project());
    repository.commitAsrRun({
      run: {
        ...run("qwen-run", "qwen-op"),
        engineId: "qwen3-asr", engineVersion: "0.0.6",
        runtimeId: "qwen3-asr-transformers-cu128-x64", runtimeVersion: "0.0.6+torch2.11.0-cu128",
        modelId: "qwen3-asr-1.7b", modelVersion: "7278e1e70fe206f11671096ffdd38061171dd6e5",
        actualDevice: "cuda", fallbackReason: null,
        canonicalizerVersion: "qwen3-asr-0.0.6-v2",
      },
      result: result(" Qwen output."),
    });
    repository.close();
    repository = openProjectRepository(containerDir);
    const stored = repository.getAsrRun("qwen-run").run;
    assert.deepEqual([stored.engineId, stored.runtimeId, stored.modelId, stored.actualDevice], [
      "qwen3-asr", "qwen3-asr-transformers-cu128-x64", "qwen3-asr-1.7b", "cuda",
    ]);
  } finally {
    repository?.close();
    rmSync(containerDir, { recursive: true, force: true });
  }
});

test("project restart removes finalized and partial ASR artifacts that no committed run owns", () => {
  const containerDir = mkdtempSync(join(tmpdir(), "asr-artifact-reconcile-"));
  let repository = openProjectRepository(containerDir);
  try {
    repository.saveProject(project());
    const referencedBytes = Buffer.from("referenced");
    const corruptedExpectedBytes = Buffer.from("expected-content");
    repository.commitAsrRun({ run: run("referenced-run", "referenced-op", referencedBytes), result: result() });
    repository.commitAsrRun({ run: run("corrupted-run", "corrupted-op", corruptedExpectedBytes), result: result() });
    const artifactRoot = join(containerDir, "artifacts", "asr");
    mkdirSync(artifactRoot, { recursive: true });
    const referenced = join(artifactRoot, "referenced-run.json");
    const corrupted = join(artifactRoot, "corrupted-run.json");
    const orphan = join(artifactRoot, "orphan-run.json");
    const partial = join(artifactRoot, "orphan-run.json.00000000-0000-4000-8000-000000000000.partial");
    writeFileSync(referenced, referencedBytes);
    writeFileSync(corrupted, "tampered-content");
    writeFileSync(orphan, "orphan");
    writeFileSync(partial, "partial");
    repository.close();
    repository = openProjectRepository(containerDir);
    assert.equal(existsSync(referenced), true);
    assert.equal(existsSync(corrupted), false);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(partial), false);
    assert.equal(repository.listAsrRuns().length, 2);
  } finally {
    repository?.close();
    rmSync(containerDir, { recursive: true, force: true });
  }
});
