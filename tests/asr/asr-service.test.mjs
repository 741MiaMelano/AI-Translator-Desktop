import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ASR_RESULT_LIMITS } from "../../backend/asr/asr-contract.mjs";
import {
  buildCanonicalPcmArgv,
  buildPcmExtractionArgv,
  buildSeparationExtractionArgv,
  createAsrService,
} from "../../backend/asr/asr-service.mjs";
import { VOCAL_SEPARATION_IDENTITY } from "../../backend/audio/vocal-separation-process.mjs";
import { SONG_CLASSIFIER_IDENTITY } from "../../backend/audio/song-classifier-process.mjs";

function project(overrides = {}) {
  return {
    id: "project-asr-service",
    noSourceMedia: false,
    mediaSource: {
      assetId: "primary",
      availability: "available",
      selectedAudioStreamId: "s:1",
    },
    sourceProbeSummary: {
      media: {
        mediaKind: "video",
        format: { durationMs: 2_000, sizeBytes: 2_048 },
        streams: [{ streamId: "s:1", index: 1, kind: "audio" }],
      },
    },
    sourceTracks: [],
    activeSourceTrackId: null,
    config: {},
    ...overrides,
  };
}

function canonicalResult(overrides = {}) {
  return {
    schemaVersion: 1,
    mediaDurationMs: 2_000,
    detectedLanguage: "en",
    languageProbability: null,
    warnings: ["language_probability_unavailable"],
    segments: [{
      startMs: 0,
      endMs: 2_000,
      text: " Hello world.",
      language: "en",
      languageProbability: null,
      words: [
        { startMs: 0, endMs: 800, text: " Hello", probability: 0.9 },
        { startMs: 800, endMs: 1_900, text: " world.", probability: 0.8 },
      ],
    }],
    ...overrides,
  };
}

function coded(code, message = "private C:\\secret\\media.wav --prompt transcript") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createHarness({
  projectValue = project(),
  capability = null,
  diskFreeBytes = 1024 ** 4,
  mediaFailure = null,
  transcribeFailure = null,
  result = canonicalResult(),
  holdMedia = false,
  globalDefaultModelId = "small",
  vadSettings = {
    mode: "off",
    customParameters: {
      threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100,
      maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1,
    },
  },
  vocalSeparationSetting = "off",
  separationFailure = null,
  songHandlingSetting = "preserve",
  songClassificationFailure = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "asr-service-"));
  const sourcePath = join(root, "source.wav");
  const ffmpegPath = join(root, "ffmpeg.exe");
  writeFileSync(sourcePath, "source");
  writeFileSync(ffmpegPath, "fake");
  const commits = [];
  const runs = [];
  const mediaCalls = [];
  const transcribeCalls = [];
  const separationProbeCalls = [];
  const separationCalls = [];
  const songProbeCalls = [];
  const songClassificationCalls = [];
  const cancelCalls = [];
  const selectedModelIds = [];
  let releaseMedia;
  const repo = {
    containerDir: root,
    loadProject: () => projectValue,
    listAsrRuns: () => [...runs],
    commitAsrRun(payload) {
      commits.push(payload);
      runs.push({ ...payload.run });
      return {
        runId: payload.run.id,
        operationId: payload.run.operationId,
        segmentCount: payload.result.segments.length,
        wordCount: payload.result.segments.reduce((sum, segment) => sum + segment.words.length, 0),
        deduplicated: false,
      };
    },
  };
  const resolvedCapability = capability ?? {
    ready: true,
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtime: { installState: "ready" },
    model: { installState: "ready" },
    models: [
      { id: "small", version: "small-revision", modelHash: "a".repeat(64), installState: "ready" },
      { id: "large-v3-turbo-q5_0", version: "turbo-revision", modelHash: "b".repeat(64), installState: "ready" },
    ],
    vadModel: {
      id: "silero-vad-v6.2.0", displayName: "Silero VAD v6.2.0", version: "6.2.0",
      modelHash: "c".repeat(64), sizeBytes: 885_098, license: "MIT", installState: "ready",
    },
  };
  const runtimeFor = (modelId = "small") => {
    const selectedModel = resolvedCapability.models?.find((entry) => entry.id === modelId);
    const qwen = (selectedModel?.engineId ?? resolvedCapability.engineId) === "qwen3-asr";
    return {
    engineId: qwen ? "qwen3-asr" : "whisper.cpp",
    engineVersion: qwen ? "0.0.6" : "1.9.1",
    runtimeId: qwen ? "qwen3-asr-transformers-cu128-x64" : "whisper-cpp-cpu-x64",
    runtimeVersion: qwen ? "0.0.6" : "1.9.1",
    device: qwen ? "cuda" : "cpu",
    executablePath: join(root, "whisper-cli.exe"),
    cwd: root,
    modelId,
    modelVersion: selectedModel?.version ?? (modelId === "small" ? "small-revision" : "turbo-revision"),
    modelHash: selectedModel?.modelHash ?? (modelId === "small" ? "a" : "b").repeat(64),
    modelPath: join(root, `${modelId}.bin`),
    vadModelId: "silero-vad-v6.2.0",
    vadModelVersion: "6.2.0",
    vadModelHash: "c".repeat(64),
    vadModelPath: join(root, "ggml-silero-v6.2.0.bin"),
  };
  };
  const service = createAsrService({
    getProjectRepository: () => repo,
    resolveMediaPath: () => sourcePath,
    resolveFfmpegArtifacts: () => ({ ffmpegPath }),
    getAsrCapabilityStatus: async () => resolvedCapability,
    getDefaultModelId: () => globalDefaultModelId,
    getVadSettings: () => vadSettings,
    getVocalSeparationSettings: () => vocalSeparationSetting,
    getSongHandlingSettings: () => songHandlingSetting,
    vocalSeparation: {
      resolveRuntime: ({ ffmpegPath, device }) => ({
        device,
        ffmpegPath,
      }),
      probe: async (payload) => {
        separationProbeCalls.push(payload);
        return {
          engineId: VOCAL_SEPARATION_IDENTITY.engineId,
          engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
          modelId: VOCAL_SEPARATION_IDENTITY.modelId,
          modelRevision: VOCAL_SEPARATION_IDENTITY.modelRevision,
          device: payload.runtime.device,
        };
      },
      separate: async (payload) => {
        separationCalls.push(payload);
        const injected = typeof separationFailure === "function"
          ? await separationFailure(payload)
          : separationFailure;
        if (injected) throw injected;
        const vocalsPath = join(payload.outputDir, VOCAL_SEPARATION_IDENTITY.outputFileName);
        writeFileSync(vocalsPath, Buffer.alloc(64_044));
        return {
          vocalsPath,
          device: payload.runtime.device,
          engineId: VOCAL_SEPARATION_IDENTITY.engineId,
          engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
          modelId: VOCAL_SEPARATION_IDENTITY.modelId,
          modelRevision: VOCAL_SEPARATION_IDENTITY.modelRevision,
          modelHash: VOCAL_SEPARATION_IDENTITY.modelSha256,
          configHash: VOCAL_SEPARATION_IDENTITY.configSha256,
          chunkDurationSeconds: payload.chunkDurationSeconds,
          processingDurationMs: 25,
        };
      },
      cancel: (operationId) => {
        cancelCalls.push(["separation", operationId]);
        return { cancelled: true };
      },
    },
    songClassifier: {
      resolveRuntime: ({ device }) => ({ device }),
      probe: async (payload) => {
        songProbeCalls.push(payload);
        return { available: true, detectorId: SONG_CLASSIFIER_IDENTITY.detectorId, device: payload.runtime.device };
      },
      classify: async (payload) => {
        songClassificationCalls.push(payload);
        const injected = typeof songClassificationFailure === "function"
          ? await songClassificationFailure(payload)
          : songClassificationFailure;
        if (injected) throw injected;
        const filteredAudioPath = join(payload.outputDir, "filtered.wav");
        writeFileSync(filteredAudioPath, Buffer.alloc(64_044));
        payload.onProgress?.(50);
        return {
          detector: SONG_CLASSIFIER_IDENTITY.detectorId,
          modelHash: SONG_CLASSIFIER_IDENTITY.modelSha256,
          device: payload.runtime.device,
          durationMs: payload.mediaDurationMs,
          filteredIntervals: [{ startMs: 0, endMs: 500 }],
          uncertainIntervals: [{ startMs: 1_000, endMs: 1_500 }],
          filteredAudioPath,
        };
      },
      cancel: (operationId) => {
        cancelCalls.push(["song", operationId]);
        return { cancelled: true };
      },
    },
    getDiskFreeBytes: () => diskFreeBytes,
    runMediaProcess: async (payload) => {
      mediaCalls.push(payload);
      const injectedMediaFailure = typeof mediaFailure === "function"
        ? await mediaFailure(payload)
        : mediaFailure;
      if (injectedMediaFailure) throw injectedMediaFailure;
      if (holdMedia) await new Promise((resolve) => { releaseMedia = resolve; });
      mkdirSync(payload.cwd, { recursive: true });
      writeFileSync(payload.argv.at(-1), Buffer.alloc(64_044));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
    cancelMediaProcess: async (operationId) => {
      cancelCalls.push(["media", operationId]);
      releaseMedia?.();
      return { cancelled: true };
    },
    deviceSelector: {
      async run({ operationId, modelId, requestedDevice, allowCudaFallback, executeStagedAttempt }) {
        assert.equal(operationId.startsWith("asr-op-"), true);
        assert.equal(new Set(["auto", "cpu"]).has(requestedDevice), true);
        assert.equal(allowCudaFallback, false);
        selectedModelIds.push(modelId);
        const runtime = runtimeFor(modelId);
        return {
          result: await executeStagedAttempt({ device: "cpu", runtime }),
          requestedDevice,
          actualDevice: "cpu",
          runtimeId: runtime.runtimeId,
          runtimeVersion: runtime.runtimeVersion,
          fallbackReason: "cuda_not_ready",
        };
      },
    },
    transcribe: async (payload) => {
      transcribeCalls.push(payload);
      const injectedFailure = typeof transcribeFailure === "function"
        ? await transcribeFailure(payload)
        : transcribeFailure;
      if (injectedFailure) throw injectedFailure;
      const canonicalResultPath = join(payload.workRoot, `${payload.outputName}.canonical.json`);
      writeFileSync(canonicalResultPath, JSON.stringify(result));
      return {
        canonicalResultPath,
        processingDurationMs: 1_250,
        summary: { rawSegmentCount: result.segments?.length ?? 0, wordCount: 2 },
      };
    },
    cancelTranscription: async (operationId) => {
      cancelCalls.push(["asr", operationId]);
      return { cancelled: true };
    },
    makeRunId: (() => {
      let index = 0;
      return () => `asr-run-${++index}`;
    })(),
    now: (() => {
      let tick = 0;
      return () => `2026-07-19T20:00:0${tick++}.000Z`;
    })(),
  });
  return {
    root, service, repo, commits, runs, mediaCalls, transcribeCalls, separationProbeCalls, separationCalls,
    songProbeCalls, songClassificationCalls,
    cancelCalls, selectedModelIds,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("ASR records effective VAD identity and parameters and fingerprints the resolved configuration", async () => {
  const vadSettings = {
    mode: "auto",
    customParameters: {
      threshold: 0.8, minSpeechDurationMs: 90, minSilenceDurationMs: 500,
      maxSpeechDurationSeconds: 20, speechPadMs: 80, samplesOverlapSeconds: 0.2,
    },
  };
  const h = createHarness({ vadSettings });
  const request = {
    projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-vad-auto",
    requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
  };
  try {
    await h.service.run(request);
    const expected = {
      mode: "auto",
      model: { id: "silero-vad-v6.2.0", version: "6.2.0", hash: "c".repeat(64) },
      parameters: {
        threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100,
        maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1,
      },
    };
    assert.deepEqual(h.transcribeCalls[0].vad, expected);
    assert.deepEqual(h.commits[0].run.parameters.vad, expected);
    const fingerprint = h.commits[0].run.cacheFingerprint;

    vadSettings.mode = "custom";
    await assert.rejects(() => h.service.run(request), (error) => error?.code === "CONFLICT");
    await h.service.run({ ...request, operationId: "asr-op-vad-custom" });
    assert.notEqual(h.commits[1].run.cacheFingerprint, fingerprint);
    assert.deepEqual(h.commits[1].run.parameters.vad.parameters, vadSettings.customParameters);
  } finally {
    h.cleanup();
  }
});

test("optional song filtering runs before ASR, records intervals, and preserves uncertain lyrics for QA", async () => {
  const h = createHarness({ songHandlingSetting: "filter" });
  try {
    await h.service.run({
      projectId: "project-asr-service",
      audioStreamId: "s:1",
      operationId: "asr-op-song-filter",
      requestedDevice: "auto",
      allowCudaFallback: false,
      languageMode: "auto",
      languageHint: null,
    });
    assert.equal(h.songProbeCalls.length, 1);
    assert.equal(h.songClassificationCalls.length, 1);
    assert.equal(h.transcribeCalls[0].audioPath, join(h.transcribeCalls[0].workRoot, "song-filtered.wav"));
    assert.equal(h.commits[0].run.parameters.songHandling.actualMode, "filter");
    assert.equal(h.commits[0].run.parameters.songHandling.detector.id, SONG_CLASSIFIER_IDENTITY.detectorId);
    assert.deepEqual(h.commits[0].result.songActivity, {
      detector: SONG_CLASSIFIER_IDENTITY.detectorId,
      mode: "filter",
      filteredIntervals: [{ startMs: 0, endMs: 500 }],
      uncertainIntervals: [{ startMs: 1_000, endMs: 1_500 }],
    });
  } finally {
    h.cleanup();
  }
});

test("a rejected filtered-audio path keeps one safe actionable reason", async () => {
  const h = createHarness({
    songHandlingSetting: "filter",
    transcribeFailure: coded("INVALID_INPUT", "Qwen audio path must use a safe task-local file name"),
  });
  try {
    await assert.rejects(() => h.service.run({
      projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-filtered-path",
      requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
    }), (error) => error?.code === "INVALID_INPUT" &&
      error.message === "Filtered audio could not be prepared for speech recognition");
  } finally {
    h.cleanup();
  }
});

test("enabled VAD fails before media work when its verified model is missing or corrupt, while off stays usable", async (t) => {
  for (const [installState, code] of [["not_installed", "NOT_AVAILABLE"], ["corrupt", "INVALID_ARTIFACT"]]) {
    await t.test(installState, async () => {
      const h = createHarness({
        vadSettings: {
          mode: "auto",
          customParameters: {
            threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100,
            maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1,
          },
        },
        capability: {
          ready: true, engineId: "whisper.cpp", engineVersion: "1.9.1",
          runtime: { installState: "ready" },
          models: [{ id: "small", version: "small-revision", modelHash: "a".repeat(64), installState: "ready" }],
          vadModel: { id: "silero-vad-v6.2.0", version: "6.2.0", modelHash: "c".repeat(64), installState },
        },
      });
      try {
        await assert.rejects(
          () => h.service.run({
            projectId: "project-asr-service", audioStreamId: "s:1", operationId: `asr-op-vad-${installState}`,
            requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
          }),
          (error) => error?.code === code,
        );
        assert.equal(h.mediaCalls.length, 0);
        assert.equal(h.commits.length, 0);
      } finally {
        h.cleanup();
      }
    });
  }

  const off = createHarness({ capability: {
    ready: true, engineId: "whisper.cpp", engineVersion: "1.9.1", runtime: { installState: "ready" },
    models: [{ id: "small", version: "small-revision", modelHash: "a".repeat(64), installState: "ready" }],
  } });
  try {
    await off.service.run({
      projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-vad-off-compatible",
      requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
    });
    assert.deepEqual(off.transcribeCalls[0].vad, { mode: "off", model: null, parameters: null });
  } finally {
    off.cleanup();
  }
});

test("PCM extraction argv is fixed to selected stream and canonical whisper input", () => {
  assert.deepEqual(buildPcmExtractionArgv("C:\\media\\in.mkv", 7, "C:\\project\\cache\\audio.wav"), [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", "C:\\media\\in.mkv", "-map", "0:7",
    "-vn", "-sn", "-dn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    "C:\\project\\cache\\audio.wav",
  ]);
  assert.throws(() => buildPcmExtractionArgv("relative.mkv", 0, "C:\\out.wav"));
  assert.throws(() => buildPcmExtractionArgv("C:\\in.mkv", -1, "C:\\out.wav"));

  assert.deepEqual(buildSeparationExtractionArgv("C:\\media\\in.mkv", 7, "C:\\project\\cache\\hq.wav"), [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", "C:\\media\\in.mkv", "-map", "0:7",
    "-vn", "-sn", "-dn", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le",
    "C:\\project\\cache\\hq.wav",
  ]);
  assert.deepEqual(buildCanonicalPcmArgv("C:\\project\\cache\\vocals.wav", "C:\\project\\cache\\audio.wav"), [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", "C:\\project\\cache\\vocals.wav", "-vn", "-sn", "-dn",
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "C:\\project\\cache\\audio.wav",
  ]);
});

test("enabled vocal separation prepares verified vocals before ASR and records provenance", async () => {
  const h = createHarness({ vocalSeparationSetting: "on" });
  const progress = [];
  try {
    await h.service.run({
      projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-vocal-separation",
      requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
      reportProgress: (value, detail) => progress.push([value, detail]),
    });
    assert.equal(h.separationProbeCalls.length, 1);
    assert.equal(h.separationCalls.length, 1);
    assert.equal(h.mediaCalls.length, 2, "high-quality extraction and final 16 kHz normalization should both run");
    assert.deepEqual(h.mediaCalls[0].argv.slice(-7), [
      "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", h.mediaCalls[0].argv.at(-1),
    ]);
    assert.equal(h.mediaCalls[1].argv.includes(h.separationCalls[0].inputPath), false);
    assert.equal(h.mediaCalls[1].argv.includes(join(h.separationCalls[0].outputDir, "vocals.wav")), true);
    assert.equal(h.separationCalls[0].chunkDurationSeconds, null);
    assert.equal(h.transcribeCalls[0].audioPath.endsWith("audio.wav"), true);
    assert.deepEqual(h.commits[0].run.parameters.vocalSeparation, {
      requestedMode: "on",
      actualMode: "on",
      model: {
        engineId: VOCAL_SEPARATION_IDENTITY.engineId,
        engineVersion: VOCAL_SEPARATION_IDENTITY.engineVersion,
        id: VOCAL_SEPARATION_IDENTITY.modelId,
        revision: VOCAL_SEPARATION_IDENTITY.modelRevision,
        hash: VOCAL_SEPARATION_IDENTITY.modelSha256,
        configHash: VOCAL_SEPARATION_IDENTITY.configSha256,
      },
      device: "cuda",
    });
    assert.deepEqual(progress.map(([value]) => value), [2, 5, 10, 30, 35, 92, 99]);
    const cacheRoot = join(h.root, "cache", "audio-separation");
    assert.equal(existsSync(cacheRoot), true, "verified vocals cache should survive a successful ASR run");
  } finally {
    h.cleanup();
  }
});

test("vocal separation failure is explicit and never silently recognizes the original mix", async () => {
  const h = createHarness({
    vocalSeparationSetting: "on",
    separationFailure: coded("CUDA_INITIALIZATION_FAILED"),
  });
  try {
    await assert.rejects(() => h.service.run({
      projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-vocal-failure",
      requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
    }), (error) => error?.code === "CUDA_INITIALIZATION_FAILED");
    assert.equal(h.separationCalls.length, 1);
    assert.equal(h.transcribeCalls.length, 0);
    assert.equal(h.commits.length, 0);
  } finally {
    h.cleanup();
  }
});

test("an explicit CPU ASR request keeps vocal separation off CUDA", async () => {
  const h = createHarness({
    vocalSeparationSetting: "on",
    separationFailure: coded("PROCESS_FAILED"),
  });
  try {
    await assert.rejects(() => h.service.run({
      projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-vocal-cpu",
      requestedDevice: "cpu", allowCudaFallback: false, languageMode: "auto", languageHint: null,
    }), (error) => error?.code === "PROCESS_FAILED");
    assert.equal(h.separationProbeCalls[0].runtime.device, "cpu");
    assert.equal(h.separationCalls[0].runtime.device, "cpu");
  } finally {
    h.cleanup();
  }
});

test("vocal separation mode changes ASR recovery identity and reuses the separated audio cache", async () => {
  const h = createHarness({ vocalSeparationSetting: "on", transcribeFailure: (() => {
    let failed = false;
    return () => {
      if (failed) return null;
      failed = true;
      return coded("PROCESS_FAILED");
    };
  })() });
  const request = {
    projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-vocal-cache-first",
    requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
  };
  try {
    await assert.rejects(() => h.service.run(request), (error) => error?.code === "PROCESS_FAILED");
    assert.equal(h.separationCalls.length, 1);
    assert.equal(h.mediaCalls.length, 2);
    await h.service.run({ ...request, operationId: "asr-op-vocal-cache-retry" });
    assert.equal(h.separationCalls.length, 1, "retry should reuse verified separated vocals");
    assert.equal(h.mediaCalls.length, 2);
  } finally {
    h.cleanup();
  }
});

test("CPU and CUDA vocal separation never share a misleading audio cache entry", async () => {
  const h = createHarness({ vocalSeparationSetting: "on" });
  const request = {
    projectId: "project-asr-service", audioStreamId: "s:1", allowCudaFallback: false,
    languageMode: "auto", languageHint: null,
  };
  try {
    await h.service.run({ ...request, operationId: "asr-op-vocal-cache-cuda", requestedDevice: "auto" });
    await h.service.run({ ...request, operationId: "asr-op-vocal-cache-cpu", requestedDevice: "cpu" });
    assert.deepEqual(h.separationCalls.map((call) => call.runtime.device), ["cuda", "cpu"]);
    assert.equal(h.mediaCalls.length, 4, "each device should build and normalize its own verified vocals cache");
  } finally {
    h.cleanup();
  }
});

test("ASR resolves the project override once and otherwise uses the global default", async () => {
  const request = {
    projectId: "project-asr-service",
    audioStreamId: "s:1",
    operationId: "asr-op-selection",
    requestedDevice: "auto",
    allowCudaFallback: false,
    languageMode: "auto",
    languageHint: null,
  };
  const overridden = createHarness({
    projectValue: project({ config: { asrModelId: "large-v3-turbo-q5_0" } }),
    globalDefaultModelId: "small",
  });
  try {
    await overridden.service.run(request);
    assert.deepEqual(overridden.selectedModelIds, ["large-v3-turbo-q5_0"]);
    assert.equal(overridden.commits[0].run.modelId, "large-v3-turbo-q5_0");
    assert.equal(overridden.commits[0].run.modelHash, "b".repeat(64));
  } finally {
    overridden.cleanup();
  }

  const inherited = createHarness({ globalDefaultModelId: "large-v3-turbo-q5_0" });
  try {
    await inherited.service.run({ ...request, operationId: "asr-op-global" });
    assert.deepEqual(inherited.selectedModelIds, ["large-v3-turbo-q5_0"]);
    assert.equal(inherited.commits[0].run.modelId, "large-v3-turbo-q5_0");
  } finally {
    inherited.cleanup();
  }
});

test("ASR recovery fingerprint includes model identity and rejects stale operation reuse", async () => {
  const projectValue = project({ config: { asrModelId: "small" } });
  const h = createHarness({ projectValue });
  const request = {
    projectId: "project-asr-service",
    audioStreamId: "s:1",
    operationId: "asr-op-fingerprint",
    requestedDevice: "auto",
    allowCudaFallback: false,
    languageMode: "auto",
    languageHint: null,
  };
  try {
    await h.service.run(request);
    const smallFingerprint = h.commits[0].run.cacheFingerprint;
    assert.match(smallFingerprint, /^[a-f0-9]{64}$/);
    assert.equal((await h.service.run(request)).deduplicated, true);

    projectValue.config.asrModelId = "large-v3-turbo-q5_0";
    await assert.rejects(
      () => h.service.run(request),
      (error) => error?.code === "CONFLICT",
    );
    await h.service.run({ ...request, operationId: "asr-op-fingerprint-turbo" });
    assert.notEqual(h.commits[1].run.cacheFingerprint, smallFingerprint);
  } finally {
    h.cleanup();
  }
});

test("Qwen retries reuse a model-specific checkpoint, report bounded progress, and delete it only after commit", async () => {
  const qwenCapability = {
    ready: true,
    runtime: { installState: "ready" },
    optionalRuntimes: [{ engineId: "qwen3-asr", installState: "ready" }],
    qwenAligner: { installState: "ready" },
    vadModel: {
      id: "silero-vad-v6.2.0", version: "6.2.0", modelHash: "c".repeat(64), installState: "ready",
    },
    models: [{
      id: "qwen3-asr-0.6b", engineId: "qwen3-asr", engineVersion: "0.0.6",
      version: "qwen-revision", modelHash: "d".repeat(64), installState: "ready",
    }],
  };
  let attempt = 0;
  const h = createHarness({
    capability: qwenCapability,
    projectValue: project({ config: { asrModelId: "qwen3-asr-0.6b" } }),
    vadSettings: {
      mode: "auto",
      customParameters: {
        threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100,
        maxSpeechDurationSeconds: 0, speechPadMs: 30, samplesOverlapSeconds: 0.1,
      },
    },
    transcribeFailure: async (payload) => {
      payload.onProgress({ progress: 25, completedChunks: 1, totalChunks: 4 });
      if (attempt++ > 0) return null;
      writeFileSync(payload.checkpointPath, "partial checkpoint");
      const error = coded("INVALID_ASR_RESULT");
      error.safeDetails = { chunkIndex: 1, startMs: 500, endMs: 3_500, text: "must not leak" };
      return error;
    },
  });
  const progress = [];
  const request = {
    projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-qwen-first",
    requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
    reportProgress: (value, detail) => progress.push([value, detail]),
  };
  try {
    await assert.rejects(() => h.service.run(request), (error) =>
      error?.code === "INVALID_ASR_RESULT" &&
      /chunk 2, 500-3500 ms/.test(error.message) &&
      !error.message.includes("must not leak"));
    const checkpoint = h.transcribeCalls[0].checkpointPath;
    assert.equal(h.transcribeCalls[0].vad.mode, "auto");
    assert.match(h.transcribeCalls[0].checkpointFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(checkpoint), true);
    assert.deepEqual(progress.map(([value]) => value), [2, 10, 30]);

    await h.service.run({ ...request, operationId: "asr-op-qwen-retry", reportProgress: () => {} });
    assert.equal(h.transcribeCalls[1].checkpointPath, checkpoint);
    assert.equal(h.mediaCalls.length, 1, "retry should reuse the verified extracted PCM");
    assert.equal(existsSync(checkpoint), false);
  } finally {
    h.cleanup();
  }
});

test("retry removes an orphaned PCM partial left by an interrupted process", async () => {
  let calls = 0;
  let partialPath;
  const h = createHarness({
    mediaFailure: (payload) => {
      calls += 1;
      if (calls === 1) {
        partialPath = payload.argv.at(-1);
        return coded("PROCESS_FAILED");
      }
      assert.equal(payload.argv.at(-1), partialPath);
      assert.equal(existsSync(partialPath), false);
      return null;
    },
  });
  const request = {
    projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-partial-first",
    requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
  };
  try {
    await assert.rejects(() => h.service.run(request), (error) => error?.code === "PROCESS_FAILED");
    writeFileSync(partialPath, "orphaned extraction");
    await h.service.run({ ...request, operationId: "asr-op-partial-retry" });
    assert.equal(existsSync(partialPath), false);
  } finally {
    h.cleanup();
  }
});

test("ASR cleanup unlinks native model aliases without touching the installed model", async () => {
  let modelRoot;
  const h = createHarness({
    transcribeFailure: (payload) => {
      const aliasRoot = join(payload.workRoot, ".native-assets");
      mkdirSync(aliasRoot, { recursive: true });
      symlinkSync(modelRoot, join(aliasRoot, "model"), "junction");
      return coded("PROCESS_FAILED");
    },
  });
  modelRoot = join(h.root, "installed-model");
  mkdirSync(modelRoot);
  const modelFile = join(modelRoot, "model.bin");
  writeFileSync(modelFile, "trusted model");
  try {
    await assert.rejects(() => h.service.run({
      projectId: "project-asr-service", audioStreamId: "s:1", operationId: "asr-op-alias-cleanup",
      requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null,
    }), (error) => error?.code === "PROCESS_FAILED");
    assert.equal(readFileSync(modelFile, "utf8"), "trusted model");
  } finally {
    h.cleanup();
  }
});

test("ASR service validates main-owned inputs, finalizes one raw artifact, and never creates a source track", async () => {
  const h = createHarness();
  try {
    const request = {
      projectId: "project-asr-service",
      audioStreamId: "s:1",
      modelId: "small",
      operationId: "asr-op-success",
      requestedDevice: "auto",
      allowCudaFallback: false,
      languageMode: "auto",
      languageHint: null,
      argv: ["--prompt", "renderer injection"],
      path: "C:\\renderer\\wrong.wav",
    };
    const completed = await h.service.run(request);
    assert.deepEqual(completed, {
      runId: "asr-run-1",
      operationId: "asr-op-success",
      segmentCount: 1,
      wordCount: 2,
      deduplicated: false,
    });
    assert.equal(h.mediaCalls.length, 1);
    assert.equal(h.transcribeCalls.length, 1);
    assert.equal(h.transcribeCalls[0].outputName, "result");
    assert.equal(h.mediaCalls[0].argv.includes("renderer injection"), false);
    assert.equal("argv" in h.transcribeCalls[0], false);
    assert.equal("path" in h.transcribeCalls[0], false);
    assert.equal(h.commits.length, 1);
    assert.equal(h.commits[0].run.audioStreamId, "s:1");
    assert.equal(h.commits[0].run.actualDevice, "cpu");
    assert.equal(h.commits[0].run.fallbackReason, "cuda_not_ready");
    assert.deepEqual(h.commits[0].result, canonicalResult());
    assert.deepEqual(h.repo.loadProject().sourceTracks, []);
    const artifactPath = join(h.root, ...h.commits[0].run.rawArtifactRelativePath.split("/"));
    assert.equal(existsSync(artifactPath), true);
    assert.deepEqual(JSON.parse(readFileSync(artifactPath, "utf8")), canonicalResult());
    assert.equal(existsSync(join(h.root, "cache", "asr", "asr-op-success")), false);

    const duplicate = await h.service.run(request);
    assert.equal(duplicate.runId, "asr-run-1");
    assert.equal(duplicate.deduplicated, true);
    assert.equal(h.mediaCalls.length, 1);

    await h.service.run({ ...request, operationId: "asr-op-rerun" });
    assert.equal(h.commits.length, 2);
    assert.equal(existsSync(artifactPath), true);
  } finally {
    h.cleanup();
  }
});

test("ASR preflight rejects missing media, audio, model, corrupt runtime, oversized input, and low disk", async (t) => {
  const cases = [
    ["missing media", { projectValue: null }, "NOT_FOUND"],
    ["no main media", { projectValue: project({ noSourceMedia: true, mediaSource: null }) }, "NOT_FOUND"],
    ["media unavailable", { projectValue: project({ mediaSource: { ...project().mediaSource, availability: "missing" } }) }, "NOT_FOUND"],
    ["no selected audio", { projectValue: project({ mediaSource: { ...project().mediaSource, selectedAudioStreamId: null } }) }, "INVALID_INPUT"],
    ["audio stream absent", { projectValue: project({ sourceProbeSummary: { media: { ...project().sourceProbeSummary.media, streams: [] } } }) }, "INVALID_INPUT"],
    ["model missing", { capability: { ready: false, runtime: { installState: "ready" }, model: { installState: "not_installed" } } }, "NOT_AVAILABLE"],
    ["runtime corrupt", { capability: { ready: false, runtime: { installState: "corrupt" }, model: { installState: "ready" } } }, "INVALID_ARTIFACT"],
    ["input too long", { projectValue: project({ sourceProbeSummary: { media: { ...project().sourceProbeSummary.media, format: { durationMs: ASR_RESULT_LIMITS.MAX_MEDIA_DURATION_MS + 1, sizeBytes: 1 } } } }) }, "OUTPUT_TOO_LARGE"],
    ["input too large", { projectValue: project({ sourceProbeSummary: { media: { ...project().sourceProbeSummary.media, format: { durationMs: 2_000, sizeBytes: 513 * 1024 ** 3 } } } }) }, "OUTPUT_TOO_LARGE"],
    ["disk too low", { diskFreeBytes: 1 }, "DISK_FULL"],
  ];
  for (const [name, options, expectedCode] of cases) {
    await t.test(name, async () => {
      const h = createHarness(options);
      try {
        await assert.rejects(
          h.service.run({ projectId: "project-asr-service", audioStreamId: "s:1", modelId: "small", operationId: `asr-op-${name.replaceAll(" ", "-")}`, requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null }),
          (error) => error?.code === expectedCode && !/C:\\|--prompt|transcript/i.test(error.message),
        );
        assert.equal(h.commits.length, 0);
        assert.equal(h.mediaCalls.length, 0);
      } finally {
        h.cleanup();
      }
    });
  }
});

test("invalid, oversized, timed out, and crashed worker results never commit or leave partial files", async (t) => {
  const invalid = canonicalResult();
  invalid.segments[0].words[1].startMs = -1;
  const cases = [
    ["invalid canonical result", { result: invalid }, "INVALID_ASR_RESULT"],
    ["worker timeout", { transcribeFailure: coded("TIMEOUT") }, "TIMEOUT"],
    ["worker crash", { transcribeFailure: coded("WORKER_CRASHED") }, "WORKER_CRASHED"],
    ["media failure", { mediaFailure: coded("PROCESS_FAILED") }, "PROCESS_FAILED"],
  ];
  for (const [name, options, expectedCode] of cases) {
    await t.test(name, async () => {
      const h = createHarness(options);
      try {
        await assert.rejects(
          h.service.run({ projectId: "project-asr-service", audioStreamId: "s:1", modelId: "small", operationId: `asr-op-failure-${expectedCode}`, requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null }),
          (error) => error?.code === expectedCode && !/C:\\|--prompt|transcript/i.test(error.message),
        );
        assert.equal(h.commits.length, 0);
        assert.equal(existsSync(join(h.root, "artifacts", "asr")), false);
        assert.equal(existsSync(join(h.root, "cache", "asr", `asr-op-failure-${expectedCode}`)), false);
      } finally {
        h.cleanup();
      }
    });
  }

  await t.test("oversized canonical artifact", async () => {
    const h = createHarness();
    h.service = createAsrService({
      getProjectRepository: () => h.repo,
      resolveMediaPath: () => join(h.root, "source.wav"),
      resolveFfmpegArtifacts: () => ({ ffmpegPath: join(h.root, "ffmpeg.exe") }),
      getAsrCapabilityStatus: async () => ({
        ready: true,
        engineId: "whisper.cpp",
        engineVersion: "1.9.1",
        runtime: { installState: "ready" },
        model: { id: "small", version: "model-revision", modelHash: "a".repeat(64), installState: "ready" },
        models: [{ id: "small", version: "model-revision", modelHash: "a".repeat(64), installState: "ready" }],
      }),
      getDiskFreeBytes: () => 1024 ** 4,
      runMediaProcess: async (payload) => { writeFileSync(payload.argv.at(-1), Buffer.alloc(64_044)); },
      cancelMediaProcess: async () => ({ cancelled: false }),
      deviceSelector: { run: async ({ executeStagedAttempt }) => ({ result: await executeStagedAttempt({ device: "cpu", runtime: { engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeId: "whisper-cpp-cpu-x64", runtimeVersion: "1.9.1", device: "cpu", modelId: "small", modelVersion: "model-revision", modelHash: "a".repeat(64), modelPath: join(h.root, "ggml-small.bin"), executablePath: join(h.root, "whisper-cli.exe"), cwd: h.root } }), requestedDevice: "auto", actualDevice: "cpu", runtimeId: "whisper-cpp-cpu-x64", runtimeVersion: "1.9.1", fallbackReason: null }) },
      transcribe: async (payload) => {
        const path = join(payload.workRoot, "oversized.canonical.json");
        writeFileSync(path, Buffer.alloc(ASR_RESULT_LIMITS.MAX_ARTIFACT_BYTES + 1));
        return { canonicalResultPath: path, processingDurationMs: 1, summary: {} };
      },
      cancelTranscription: async () => ({ cancelled: false }),
      makeRunId: () => "asr-run-oversized",
      now: () => "2026-07-19T20:00:00.000Z",
    });
    try {
      await assert.rejects(h.service.run({ projectId: "project-asr-service", audioStreamId: "s:1", modelId: "small", operationId: "asr-op-oversized", requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null }), (error) => error?.code === "OUTPUT_TOO_LARGE");
      assert.equal(h.commits.length, 0);
    } finally {
      h.cleanup();
    }
  });
});

test("cancellation settles duplicate in-flight requests and cleans both worker stages", async () => {
  const h = createHarness({ holdMedia: true });
  try {
    const request = { projectId: "project-asr-service", audioStreamId: "s:1", modelId: "small", operationId: "asr-op-cancel", requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null };
    const first = h.service.run(request);
    const duplicate = h.service.run(request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await h.service.cancel({ operationId: "asr-op-cancel" }), { cancelled: true });
    await assert.rejects(first, (error) => error?.code === "CANCELLED");
    await assert.rejects(duplicate, (error) => error?.code === "CANCELLED");
    assert.deepEqual(h.cancelCalls, [["media", "asr-op-cancel"], ["asr", "asr-op-cancel"]]);
    assert.equal(h.commits.length, 0);
    assert.equal(existsSync(join(h.root, "cache", "asr", "asr-op-cancel")), false);
  } finally {
    h.cleanup();
  }
});

test("cancellation reaches vocal separation while its model process is active", async () => {
  let rejectSeparation;
  const h = createHarness({
    vocalSeparationSetting: "on",
    separationFailure: () => new Promise((_resolve, reject) => { rejectSeparation = reject; }),
  });
  try {
    const pending = h.service.run({
      projectId: "project-asr-service", audioStreamId: "s:1", modelId: "small",
      operationId: "asr-op-cancel-separation", requestedDevice: "auto", allowCudaFallback: false,
      languageMode: "auto", languageHint: null,
    });
    while (h.separationCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await h.service.cancel({ operationId: "asr-op-cancel-separation" }), { cancelled: true });
    rejectSeparation(coded("CANCELLED"));
    await assert.rejects(() => pending, (error) => error?.code === "CANCELLED");
    assert.deepEqual(h.cancelCalls, [
      ["media", "asr-op-cancel-separation"],
      ["asr", "asr-op-cancel-separation"],
      ["separation", "asr-op-cancel-separation"],
    ]);
  } finally {
    h.cleanup();
  }
});

test("ASR service requires the confirmed audio stream and ignores renderer model fields", async () => {
  const h = createHarness();
  try {
    const base = { projectId: "project-asr-service", operationId: "asr-op-confirm", requestedDevice: "auto", allowCudaFallback: false, languageMode: "auto", languageHint: null };
    await assert.rejects(h.service.run({ ...base, audioStreamId: "s:0", modelId: "small" }), (error) => error?.code === "CONFLICT");
    await h.service.run({ ...base, operationId: "asr-op-model", audioStreamId: "s:1", modelId: "medium" });
    assert.deepEqual(h.selectedModelIds, ["small"]);
    assert.equal(h.commits[0].run.modelId, "small");
  } finally {
    h.cleanup();
  }
});
