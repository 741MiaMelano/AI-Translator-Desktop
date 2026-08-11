import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { canonicalizeWhisperCppResult } from "../../backend/asr/whisper-cpp-canonicalizer.mjs";
import { createAsrRuntimeProcess } from "../../backend/asr/runtime-process.mjs";

const assetArg = (kind, path) => join(".native-assets", kind, basename(path));

function rawWhisperResult() {
  return {
    systeminfo: "must not persist",
    model: { type: "small", path: "C:\\private\\model.bin" },
    params: { model: "C:\\private\\model.bin", language: "auto" },
    result: { language: "en" },
    transcription: [
      {
        offsets: { from: 0, to: 0 },
        text: "",
        tokens: [{ text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 1 }],
      },
      {
        offsets: { from: 0, to: 1_000 },
        text: " Hello world.",
        tokens: [
          { text: " Hello", offsets: { from: 0, to: 500 }, p: 0.9 },
          { text: " world", offsets: { from: 500, to: 900 }, p: 0.8 },
          { text: ".", offsets: { from: 900, to: 900 }, p: 0.7 },
          { text: "[_TT_50]", offsets: { from: 1_000, to: 1_000 }, p: 0.1 },
        ],
      },
      {
        offsets: { from: 1_000, to: 2_210 },
        text: " Next line.",
        tokens: [
          { text: " Next", offsets: { from: 1_000, to: 1_000 }, p: 0.85 },
          { text: " line", offsets: { from: 1_050, to: 1_800 }, p: 0.95 },
          { text: ".", offsets: { from: 1_800, to: 2_210 }, p: 0.9 },
        ],
      },
    ],
  };
}

test("whisper.cpp canonicalizer strips raw metadata and deterministically repairs word timing", () => {
  const first = canonicalizeWhisperCppResult(rawWhisperResult(), { mediaDurationMs: 2_000 });
  const second = canonicalizeWhisperCppResult(rawWhisperResult(), { mediaDurationMs: 2_000 });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes("private"), false);
  assert.equal(Object.hasOwn(first, "systeminfo"), false);
  assert.equal(first.detectedLanguage, "en");
  assert.equal(first.languageProbability, null);
  assert.deepEqual(first.warnings, [
    "language_probability_unavailable",
    "terminal_timestamp_clamped",
    "zero_duration_tokens_partitioned",
  ]);
  assert.deepEqual(first.segments[0].words[1], {
    startMs: 500,
    endMs: 900,
    text: " world.",
    probability: 0.7,
  });
  assert.deepEqual(first.segments[1].words[0], {
    startMs: 1_000,
    endMs: 1_001,
    text: " Next",
    probability: 0.85,
    rawStartMs: 1_000,
    rawEndMs: 1_000,
    repairCodes: ["zero_duration_tokens_partitioned"],
  });
  assert.deepEqual(first.segments[1].words[1], {
    startMs: 1_050,
    endMs: 2_000,
    text: " line.",
    probability: 0.9,
    rawStartMs: 1_050,
    rawEndMs: 2_210,
    repairCodes: ["terminal_timestamp_clamped"],
  });
});

test("canonicalizer repairs only bounded leading timestamps emitted by Turbo models", () => {
  const turbo = {
    result: { language: "en" },
    transcription: [{
      offsets: { from: 100, to: 1_000 },
      text: " Listen",
      tokens: [{ text: " Listen", offsets: { from: 0, to: 700 }, p: 0.9 }],
    }, {
      offsets: { from: 1_600, to: 2_200 },
      text: " The door is",
      tokens: [
        { text: " The", offsets: { from: 1_600, to: 1_100 }, p: 0.8 },
        { text: " door", offsets: { from: 1_600, to: 1_550 }, p: 0.9 },
        { text: " is", offsets: { from: 1_600, to: 2_000 }, p: 0.95 },
      ],
    }],
  };
  const result = canonicalizeWhisperCppResult(turbo, { mediaDurationMs: 2_500 });
  assert.deepEqual(result.warnings, [
    "language_probability_unavailable",
    "leading_timestamp_clamped",
    "zero_duration_tokens_partitioned",
  ]);
  assert.deepEqual(result.segments[0].words[0], {
    startMs: 100,
    endMs: 800,
    text: " Listen",
    probability: 0.9,
    rawStartMs: 0,
    rawEndMs: 700,
    repairCodes: ["leading_timestamp_clamped"],
  });
  assert.deepEqual(result.segments[1].words.map(({ startMs, endMs, rawStartMs, rawEndMs, repairCodes }) => ({
    startMs, endMs, rawStartMs, rawEndMs, repairCodes,
  })), [{
    startMs: 1_600,
    endMs: 1_601,
    rawStartMs: 1_600,
    rawEndMs: 1_100,
    repairCodes: ["leading_timestamp_clamped", "zero_duration_tokens_partitioned"],
  }, {
    startMs: 1_601,
    endMs: 1_602,
    rawStartMs: 1_600,
    rawEndMs: 1_550,
    repairCodes: ["leading_timestamp_clamped", "zero_duration_tokens_partitioned"],
  }, {
    startMs: 1_602,
    endMs: 2_000,
    rawStartMs: 1_600,
    rawEndMs: 2_000,
    repairCodes: ["zero_duration_tokens_partitioned"],
  }]);

  const excessive = structuredClone(turbo);
  excessive.transcription = [{
    offsets: { from: 1_001, to: 2_000 },
    text: " Listen",
    tokens: [{ text: " Listen", offsets: { from: 0, to: 1_800 }, p: 0.9 }],
  }];
  assert.throws(
    () => canonicalizeWhisperCppResult(excessive, { mediaDurationMs: 2_500 }),
    (error) => error?.code === "INVALID_ASR_RESULT",
  );
});

test("canonicalizer rebases the bounded segment-wide timestamp drift emitted by whisper.cpp VAD", () => {
  const value = {
    result: { language: "zh" },
    transcription: [{
      offsets: { from: 247_360, to: 250_240 },
      text: "hello 大家",
      tokens: [
        { text: "he", offsets: { from: 245_130, to: 245_500 }, p: 0.9 },
        { text: "llo", offsets: { from: 245_500, to: 246_000 }, p: 0.9 },
        { text: " ", offsets: { from: 246_000, to: 246_000 }, p: 0.8 },
        { text: "大家", offsets: { from: 246_000, to: 248_120 }, p: 0.9 },
      ],
    }],
  };
  const result = canonicalizeWhisperCppResult(value, { mediaDurationMs: 251_000 });
  const words = result.segments[0].words;
  assert.equal(words[0].startMs, 247_360);
  assert.equal(words.at(-1).endMs, 250_240);
  assert.deepEqual(words.map(({ text }) => text), ["hello", " 大家"]);
  assert.ok(words.every((word, index) => word.endMs > word.startMs && (!index || word.startMs >= words[index - 1].endMs)));
  assert.ok(words.every((word) => word.repairCodes.includes("leading_timestamp_clamped")));
});

test("canonicalizer drops whisper.cpp VAD short prefixes superseded at the same timestamp", () => {
  const segment = (from, to, text) => ({
    offsets: { from, to },
    text,
    tokens: [{ text, offsets: { from, to }, p: 0.9 }],
  });
  const result = canonicalizeWhisperCppResult({
    result: { language: "en" },
    transcription: [
      segment(100, 200, " Stale."),
      segment(100, 200, " Actual."),
      segment(100, 1_000, " Actual."),
    ],
  }, { mediaDurationMs: 1_000 });

  assert.deepEqual(result.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), [
    { startMs: 100, endMs: 1_000, text: " Actual." },
  ]);
});

test("canonicalizer rejects a reversed continuation token hidden inside a word", () => {
  const value = {
    result: { language: "en" },
    transcription: [{
      offsets: { from: 100, to: 1_500 },
      text: " HelloWorld",
      tokens: [
        { text: " Hello", offsets: { from: 100, to: 1_000 }, p: 0.9 },
        { text: "World", offsets: { from: 1_000, to: 700 }, p: 0.9 },
      ],
    }],
  };
  assert.throws(
    () => canonicalizeWhisperCppResult(value, { mediaDurationMs: 2_000 }),
    (error) => error?.code === "INVALID_ASR_RESULT",
  );
});

test("canonicalizer rejects malformed raw segments instead of silently dropping content", () => {
  for (const mutate of [
    (value) => { value.transcription = null; },
    (value) => { value.transcription[1].offsets.to = Number.NaN; },
    (value) => { value.transcription[1].offsets.from = -1; },
    (value) => { value.transcription[1].offsets.to = 2_001; },
    (value) => { value.transcription[2].offsets.from = 999; },
    (value) => { value.transcription[1].tokens[0].offsets = null; },
    (value) => { value.transcription[1].tokens[1].offsets.to = 1_210; },
    (value) => { value.transcription[1].tokens[1].offsets.from = 400; },
    (value) => { delete value.transcription[1].tokens; },
    (value) => { value.transcription[1].tokens = [{ text: "[_TT_50]", offsets: { from: 0, to: 0 }, p: 1 }]; },
    (value) => { value.transcription[1].tokens[0].text = " Goodbye"; },
    (value) => { value.transcription[2].offsets.to = 2_501; value.transcription[2].tokens[2].offsets.to = 2_501; },
    (value) => {
      value.transcription[2].tokens = [
        { text: " One", offsets: { from: 1_000, to: 1_000 }, p: 0.9 },
        { text: " two", offsets: { from: 1_000, to: 1_000 }, p: 0.9 },
        { text: " three", offsets: { from: 1_001, to: 1_800 }, p: 0.9 },
      ];
    },
  ]) {
    const value = rawWhisperResult();
    mutate(value);
    assert.throws(
      () => canonicalizeWhisperCppResult(value, { mediaDurationMs: 2_000 }),
      (error) => error?.code === "INVALID_ASR_RESULT",
    );
  }
});

test("canonicalizer minimally borrows from the next word for zero-duration words at a segment boundary", () => {
  const value = {
    result: { language: "ko" },
    transcription: [{
      offsets: { from: 0, to: 1_000 },
      text: " - 우리 말",
      tokens: [
        { text: " -", offsets: { from: 0, to: 0 }, p: 0.9 },
        { text: " 우리", offsets: { from: 0, to: 0 }, p: 0.8 },
        { text: " 말", offsets: { from: 0, to: 500 }, p: 0.7 },
      ],
    }],
  };
  const result = canonicalizeWhisperCppResult(value, { mediaDurationMs: 1_000 });
  assert.deepEqual(result.segments[0].words.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), [
    { startMs: 0, endMs: 1, text: " -" },
    { startMs: 1, endMs: 2, text: " 우리" },
    { startMs: 2, endMs: 500, text: " 말" },
  ]);
  assert.equal(result.segments[0].words.every((word) =>
    word.repairCodes?.includes("zero_duration_tokens_partitioned")), true);
});

test("canonicalizer minimally borrows from the previous word for trailing zero-duration words", () => {
  const value = {
    result: { language: "en" },
    transcription: [{
      offsets: { from: 3_240, to: 5_200 },
      text: " Oh this. I love it.",
      tokens: [
        { text: " Oh", offsets: { from: 3_240, to: 4_800 }, p: 0.9 },
        { text: " this", offsets: { from: 4_800, to: 5_200 }, p: 0.9 },
        { text: ".", offsets: { from: 5_200, to: 5_200 }, p: 0.9 },
        { text: " I", offsets: { from: 5_200, to: 5_200 }, p: 0.9 },
        { text: " love", offsets: { from: 5_200, to: 5_200 }, p: 0.9 },
        { text: " it", offsets: { from: 5_200, to: 5_200 }, p: 0.9 },
        { text: ".", offsets: { from: 5_200, to: 5_200 }, p: 0.9 },
      ],
    }],
  };

  const result = canonicalizeWhisperCppResult(value, { mediaDurationMs: 5_200 });
  assert.deepEqual(result.segments[0].words.slice(-3).map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), [
    { startMs: 5_197, endMs: 5_198, text: " I" },
    { startMs: 5_198, endMs: 5_199, text: " love" },
    { startMs: 5_199, endMs: 5_200, text: " it." },
  ]);
});

test("canonicalizer does not stretch a zero-duration word across a long silent gap", () => {
  const result = canonicalizeWhisperCppResult({
    result: { language: "en" },
    transcription: [{
      offsets: { from: 0, to: 10_000 },
      text: " Yes. Oh, come.",
      tokens: [
        { text: " Yes.", offsets: { from: 0, to: 160 }, p: 0.9 },
        { text: " Oh,", offsets: { from: 7_120, to: 7_120 }, p: 0.9 },
        { text: " come.", offsets: { from: 8_160, to: 9_000 }, p: 0.9 },
      ],
    }],
  }, { mediaDurationMs: 10_000 });

  assert.deepEqual(result.segments[0].words.map(({ startMs, endMs }) => ({ startMs, endMs })), [
    { startMs: 0, endMs: 160 },
    { startMs: 7_120, endMs: 7_121 },
    { startMs: 8_160, endMs: 9_000 },
  ]);
});

test("runtime transcription enables GPU only for the verified CUDA runtime", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "asr-runtime-cuda-argv-"));
  const audioPath = join(workRoot, "input.wav");
  writeFileSync(audioPath, "synthetic wav placeholder");
  let observed;
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async (spec) => {
      observed = spec;
      const outputPrefix = spec.argv[spec.argv.indexOf("-of") + 1];
      writeFileSync(join(spec.cwd, `${outputPrefix}.json`), JSON.stringify(rawWhisperResult()));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  try {
    await runtimeProcess.transcribe({
      operationId: "transcribe-cuda",
      runtime: {
        engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeId: "whisper-cpp-cuda-12.4-x64",
        runtimeVersion: "1.9.1", device: "cuda",
        executablePath: "C:\\managed-asr\\cuda\\whisper-cli.exe",
        modelPath: "C:\\managed-asr\\models\\small\\ggml-small.bin",
        modelId: "small", modelVersion: "model-revision", modelHash: "a".repeat(64),
        cwd: "C:\\managed-asr\\cuda",
      },
      workRoot,
      audioPath,
      outputName: "cuda-result",
      mediaDurationMs: 2_000,
      languageMode: "auto",
      languageHint: null,
    });
    assert.equal(observed.argv.includes("-ng"), false);
  } finally {
    runtimeProcess.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("terminal overshoot uses whisper.cpp 20ms timestamp quantization without loosening 500ms", () => {
  const accepted = rawWhisperResult();
  accepted.transcription[2].offsets.to = 2_520;
  accepted.transcription[2].tokens[2].offsets.to = 2_520;
  const canonical = canonicalizeWhisperCppResult(accepted, { mediaDurationMs: 2_005 });
  assert.equal(canonical.segments.at(-1).endMs, 2_005);
  assert.equal(canonical.segments.at(-1).words.at(-1).rawEndMs, 2_520);

  const rejected = rawWhisperResult();
  rejected.transcription[2].offsets.to = 2_521;
  rejected.transcription[2].tokens[2].offsets.to = 2_521;
  assert.throws(
    () => canonicalizeWhisperCppResult(rejected, { mediaDurationMs: 2_005 }),
    (error) => error?.code === "INVALID_ASR_RESULT",
  );
});

test("runtime transcription uses the selected model in fixed internal argv and returns a bounded result", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "asr-runtime-transcribe-"));
  const audioPath = join(workRoot, "input.wav");
  writeFileSync(audioPath, "synthetic wav placeholder");
  let observed = null;
  const runtimeProcess = createAsrRuntimeProcess({
    now: (() => { let value = 1_000; return () => (value += 25); })(),
    runProcess: async (spec) => {
      observed = spec;
      const outputPrefix = spec.argv[spec.argv.indexOf("-of") + 1];
      writeFileSync(join(spec.cwd, `${outputPrefix}.json`), JSON.stringify(rawWhisperResult()));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  const runtime = {
    engineId: "whisper.cpp",
    engineVersion: "1.9.1",
    runtimeId: "whisper-cpp-cpu-x64",
    runtimeVersion: "1.9.1",
    device: "cpu",
    executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe",
    modelPath: "C:\\managed-asr\\models\\large-v3-turbo-q5_0\\ggml-large-v3-turbo-q5_0.bin",
    modelId: "large-v3-turbo-q5_0",
    modelVersion: "turbo-revision",
    modelHash: "b".repeat(64),
    cwd: "C:\\managed-asr\\runtime",
  };
  try {
    const response = await runtimeProcess.transcribe({
      operationId: "transcribe-fixed",
      runtime,
      workRoot,
      audioPath,
      outputName: "raw-result",
      mediaDurationMs: 2_000,
      languageMode: "auto",
      languageHint: null,
      vad: { mode: "off", model: null, parameters: null },
      argv: ["--prompt", "bad"],
    });
    assert.deepEqual(observed.argv, [
      "-m", assetArg("model", runtime.modelPath),
      "-f", "input.wav",
      "-l", "auto",
      "-t", "6",
      "-bs", "5",
      "-bo", "5",
      "-tp", "0",
      "-ojf",
      "-of", "raw-result",
      "-np",
      "-ng",
    ]);
    assert.equal(observed.absoluteExe, runtime.executablePath);
    assert.equal(observed.cwd, workRoot);
    assert.equal(observed.argv.every((arg) => !arg.includes(workRoot)), true);
    assert.equal(observed.shell, undefined);
    assert.equal(response.canonicalResultPath, join(workRoot, "raw-result.canonical.json"));
    assert.deepEqual(response.summary, {
      schemaVersion: 1,
      mediaDurationMs: 2_000,
      rawSegmentCount: 2,
      wordCount: 4,
      detectedLanguage: "en",
      warningCodes: ["language_probability_unavailable", "terminal_timestamp_clamped", "zero_duration_tokens_partitioned"],
    });
    assert.equal(response.processingDurationMs, 25);
    assert.equal(existsSync(join(workRoot, "raw-result.json")), false);
    const canonical = readFileSync(response.canonicalResultPath, "utf8");
    assert.equal(/systeminfo|private|model\.bin/i.test(canonical), false);
  } finally {
    runtimeProcess.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("runtime transcription derives bounded VAD argv from verified structured configuration", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "asr-runtime-vad-argv-"));
  const audioPath = join(workRoot, "input.wav");
  writeFileSync(audioPath, "synthetic wav placeholder");
  let observed;
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async (spec) => {
      observed = spec;
      const outputPrefix = spec.argv[spec.argv.indexOf("-of") + 1];
      writeFileSync(join(spec.cwd, `${outputPrefix}.json`), JSON.stringify(rawWhisperResult()));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  const vadModel = {
    id: "silero-vad-v6.2.0",
    version: "6.2.0",
    hash: "c".repeat(64),
  };
  const runtime = {
    engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeId: "whisper-cpp-cpu-x64",
    runtimeVersion: "1.9.1", device: "cpu",
    executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe",
    modelPath: join(dirname(tmpdir()), "managed-asr-tests", "中文模型", "small", "ggml-small.bin"),
    modelId: "small", modelVersion: "model-revision", modelHash: "a".repeat(64),
    vadModelPath: join(dirname(tmpdir()), "managed-asr-tests", "中文模型", "vad", "ggml-silero-v6.2.0.bin"),
    vadModelId: vadModel.id, vadModelVersion: vadModel.version, vadModelHash: vadModel.hash,
    cwd: "C:\\managed-asr\\runtime",
  };
  const vad = {
    mode: "custom",
    model: vadModel,
    parameters: {
      threshold: 0.65,
      minSpeechDurationMs: 80,
      minSilenceDurationMs: 450,
      maxSpeechDurationSeconds: 0,
      speechPadMs: 120,
      samplesOverlapSeconds: 0.25,
    },
  };
  try {
    await runtimeProcess.transcribe({
      operationId: "transcribe-vad",
      runtime,
      vad,
      workRoot,
      audioPath,
      outputName: "vad-result",
      mediaDurationMs: 2_000,
      languageMode: "auto",
      languageHint: null,
    });
    assert.deepEqual(observed.argv.slice(observed.argv.indexOf("--vad")), [
      "--vad",
      "--vad-model", assetArg("vad", runtime.vadModelPath),
      "--vad-threshold", "0.65",
      "--vad-min-speech-duration-ms", "80",
      "--vad-min-silence-duration-ms", "450",
      "--vad-max-speech-duration-s", "0",
      "--vad-speech-pad-ms", "120",
      "--vad-samples-overlap", "0.25",
    ]);
    assert.equal(observed.argv.some((arg) => /[^\x00-\x7f]/.test(arg)), false);
    assert.equal(
      resolve(readlinkSync(join(workRoot, ".native-assets", "model"))),
      resolve(dirname(runtime.modelPath)),
    );
    assert.equal(
      resolve(readlinkSync(join(workRoot, ".native-assets", "vad"))),
      resolve(dirname(runtime.vadModelPath)),
    );

    observed = null;
    await assert.rejects(
      () => runtimeProcess.transcribe({
        operationId: "transcribe-vad-invalid",
        runtime,
        vad: { ...vad, parameters: { ...vad.parameters, threshold: "0.5 --prompt bad" } },
        workRoot,
        audioPath,
        outputName: "vad-invalid",
        mediaDurationMs: 2_000,
        languageMode: "auto",
        languageHint: null,
      }),
      (error) => error?.code === "INVALID_INPUT",
    );
    assert.equal(observed, null);
  } finally {
    runtimeProcess.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("runtime transcription distinguishes no speech from invalid engine output without a finalized result", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "asr-runtime-invalid-"));
  const audioPath = join(workRoot, "input.wav");
  writeFileSync(audioPath, "synthetic wav placeholder");
  let outputPrefix = null;
  let engineResult = { result: { language: "en" }, transcription: [] };
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async (spec) => {
      outputPrefix = join(spec.cwd, spec.argv[spec.argv.indexOf("-of") + 1]);
      writeFileSync(`${outputPrefix}.json`, JSON.stringify(engineResult));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "" };
    },
  });
  const base = {
    operationId: "invalid-output",
    runtime: {
      engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeId: "whisper-cpp-cpu-x64",
      runtimeVersion: "1.9.1", device: "cpu",
      executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe",
      modelPath: "C:\\managed-asr\\models\\small\\ggml-small.bin",
      modelId: "small", modelVersion: "model-revision", modelHash: "a".repeat(64),
      cwd: "C:\\managed-asr\\runtime",
    },
    workRoot,
    audioPath,
    outputName: "invalid-result",
    mediaDurationMs: 2_000,
    languageMode: "auto",
    languageHint: null,
  };
  try {
    await assert.rejects(
      () => runtimeProcess.transcribe({ ...base, languageMode: "fixed", languageHint: "--prompt" }),
      (error) => error?.code === "INVALID_INPUT",
    );
    await assert.rejects(
      () => runtimeProcess.transcribe({ ...base, runtime: { ...base.runtime, modelHash: "renderer-value" } }),
      (error) => error?.code === "INVALID_ARTIFACT",
    );
    await assert.rejects(
      () => runtimeProcess.transcribe(base),
      (error) => error?.code === "NO_SPEECH_DETECTED",
    );
    engineResult = { transcription: null };
    await assert.rejects(
      () => runtimeProcess.transcribe(base),
      (error) => error?.code === "INVALID_ASR_RESULT",
    );
    assert.equal(existsSync(`${outputPrefix}.json`), false);
    assert.equal(existsSync(`${outputPrefix}.canonical.json`), false);
  } finally {
    runtimeProcess.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("runtime language detection uses a bounded region and returns only cross-checked evidence", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "asr-runtime-language-"));
  const audioPath = join(workRoot, "input.wav");
  writeFileSync(audioPath, "synthetic wav placeholder");
  let observed;
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async (spec) => {
      observed = spec;
      const prefix = spec.argv[spec.argv.indexOf("-of") + 1];
      writeFileSync(join(spec.cwd, `${prefix}.json`), JSON.stringify({ result: { language: "en" }, transcription: [] }));
      return {
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderrSummary: "[redacted]",
        stderr: Buffer.from("whisper_full_with_state: auto-detected language: en (p = 0.987654)"),
      };
    },
  });
  const runtime = {
    engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeId: "whisper-cpp-cpu-x64",
    runtimeVersion: "1.9.1", device: "cpu",
    executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe",
    modelPath: join(dirname(tmpdir()), "managed-asr-tests", "中文模型", "small", "ggml-small.bin"),
    modelId: "small", modelVersion: "model-revision", modelHash: "a".repeat(64),
    cwd: "C:\\managed-asr\\runtime",
  };
  try {
    const value = await runtimeProcess.detectLanguageRegion({
      operationId: "detect-region-1",
      runtime,
      workRoot,
      audioPath,
      outputName: "language-segment-1",
      mediaDurationMs: 2_000,
      segmentId: "segment-1",
      startMs: 100,
      endMs: 900,
    });
    assert.deepEqual(observed.argv, [
      "-m", assetArg("model", runtime.modelPath), "-f", "input.wav", "-l", "auto", "-dl",
      "-ot", "100", "-d", "800", "-t", "6", "-ojf", "-of", "language-segment-1",
    ]);
    assert.equal(observed.cwd, workRoot);
    assert.equal(observed.includeRawStderr, true);
    assert.equal(observed.argv.some((arg) => /[^\x00-\x7f]/.test(arg)), false);
    assert.equal(
      resolve(readlinkSync(join(workRoot, ".native-assets", "model"))),
      resolve(dirname(runtime.modelPath)),
    );
    assert.deepEqual(value, {
      segmentId: "segment-1",
      detectedLanguage: "en",
      confidence: 0.987654,
      detectionMethod: "whisper.cpp-region-auto",
      detectionVersion: "whisper.cpp-1.9.1-small-v1",
      overlapStatus: "none",
    });
    assert.equal(/stderr|path|argv|transcript/i.test(JSON.stringify(value)), false);
    assert.equal(existsSync(join(workRoot, "language-segment-1.json")), false);
  } finally {
    runtimeProcess.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("runtime language detection rejects mismatched JSON and confidence evidence", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "asr-runtime-language-invalid-"));
  const audioPath = join(workRoot, "input.wav");
  writeFileSync(audioPath, "synthetic wav placeholder");
  const runtimeProcess = createAsrRuntimeProcess({
    runProcess: async (spec) => {
      const prefix = spec.argv[spec.argv.indexOf("-of") + 1];
      writeFileSync(join(spec.cwd, `${prefix}.json`), JSON.stringify({ result: { language: "zh" }, transcription: [] }));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderrSummary: "", stderr: Buffer.from("auto-detected language: en (p = 2.0)") };
    },
  });
  try {
    await assert.rejects(
      runtimeProcess.detectLanguageRegion({
        operationId: "detect-invalid",
        runtime: {
          engineId: "whisper.cpp", engineVersion: "1.9.1", runtimeId: "whisper-cpp-cpu-x64", runtimeVersion: "1.9.1", device: "cpu",
          executablePath: "C:\\managed-asr\\runtime\\whisper-cli.exe", cwd: "C:\\managed-asr\\runtime",
          modelPath: "C:\\managed-asr\\models\\small\\ggml-small.bin", modelId: "small", modelVersion: "model-revision", modelHash: "a".repeat(64),
        },
        workRoot, audioPath, outputName: "invalid-language", mediaDurationMs: 2_000,
        segmentId: "segment-1", startMs: 0, endMs: 1_000,
      }),
      (error) => error?.code === "INVALID_ASR_RESULT",
    );
    assert.equal(existsSync(join(workRoot, "invalid-language.json")), false);
  } finally {
    runtimeProcess.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
});
