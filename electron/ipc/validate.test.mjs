import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  IPC_LIMITS,
  IPC_PROJECT_VALUES,
  isSafeProjectId,
  mapPortError,
  measureJsonBytes,
  validateIpcEnvelope,
} from "./validate.mjs";
import {
  TARGET_LANGUAGE_REGISTRY,
  TRANSLATION_PROVIDER_REGISTRY,
} from "../../src/domain/workspace.ts";

const baseProject = {
  id: "project-ok",
  title: "Demo",
  sourceFileName: "a.srt",
  mediaKind: "subtitle",
  noSourceMedia: true,
  lifecycle: "draft",
  createdAt: "2026-07-13 10:00",
  updatedAt: "2026-07-13 10:00",
  activeSourceTrackId: "source-1",
  pendingConfirmations: [],
  notes: [],
  config: {
    sourceLanguage: "auto",
    targetLanguages: ["zh-CN"],
    provider: "OpenAI",
    model: "GPT-4.1",
    asrModelId: "large-v3-turbo-q8_0",
    glossary: "g",
    styleGuide: "s",
    outputFormat: "SRT",
    burnVideo: false,
    copyMediaIntoProject: false,
  },
  sourceTracks: [
    {
      id: "source-1",
      label: "Main",
      kind: "external_subtitle",
      languageState: "pending",
      defaultLanguage: "auto",
      isActive: true,
      summary: "fixture",
      segments: [
        {
          id: "segment-1",
          start: "00:00:01,000",
          end: "00:00:02,000",
          sourceLanguage: "auto",
          sourceText: { original: "hello", normalized: "hello" },
          targetTexts: {
            "zh-CN": { model: "你好", postProcessed: "你好", qaFlags: [] },
          },
        },
      ],
      targetTracks: [
        {
          id: "target-1",
          languageCode: "zh-CN",
          languageLabel: "简体中文",
          status: "draft",
          isActive: true,
          qaIssues: [],
          snapshotIds: [],
          deliveryLabel: "draft",
          lastHumanAction: "none",
        },
      ],
    },
  ],
  recentRunIds: [],
};

const subtitleStyle = {
  format: "ass",
  bilingualLayout: "target_only",
  primary: {
    fontFamily: "Arial", fontSizePx: 36, textColor: "#FFFFFF",
    outlineColor: "#000000", outlineWidthPx: 2, shadowColor: "#000000",
    shadowDepthPx: 0, position: "bottom",
  },
  secondary: {
    fontFamily: "Arial", fontSizePx: 20, textColor: "#EEEEEE",
    outlineColor: "#111111", outlineWidthPx: 1, shadowColor: "#000000",
    shadowDepthPx: 0, position: "bottom",
  },
  preview: { sourceText: "Source", targetText: "目标", direction: "auto", backgroundColor: "#25211D" },
};

test("unknown method is rejected", () => {
  const result = validateIpcEnvelope({ method: "project.drop", request: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_INPUT");
});

test("unsafe project ids are rejected", () => {
  for (const projectId of [".", "..", "a/b", "C:\\x", 12, null]) {
    const result = validateIpcEnvelope({
      method: "project.open",
      request: { projectId },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_INPUT");
  }
  assert.equal(isSafeProjectId("project-ok"), true);
});

test("payload over 8 MiB is rejected", () => {
  const huge = "x".repeat(IPC_LIMITS.MAX_PAYLOAD_BYTES + 1);
  const result = validateIpcEnvelope({
    method: "project.save",
    request: { project: { ...baseProject, notes: [huge] } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_INPUT");
  assert.ok(measureJsonBytes({ project: { notes: [huge] } }) > IPC_LIMITS.MAX_PAYLOAD_BYTES);
});

test("valid create envelope is accepted", () => {
  const result = validateIpcEnvelope({
    method: "project.create",
    request: { project: baseProject },
  });
  assert.equal(result.ok, true);
});

test("waveform request accepts only a project id and optional safe operation id", () => {
  assert.equal(validateIpcEnvelope({
    method: "media.waveform",
    request: { projectId: "project-ok", operationId: "waveform-project-ok" },
  }).ok, true);
  assert.equal(validateIpcEnvelope({
    method: "media.waveform",
    request: { projectId: "project-ok", path: "C:\\secret.mp4" },
  }).ok, false);
});

test("pending task prioritization is a bounded task control action", () => {
  assert.equal(validateIpcEnvelope({
    method: "tasks.control",
    request: { taskId: "task-1", projectId: "project-ok", action: "prioritize" },
  }).ok, true);
});

test("project save accepts bounded timeline undo history", () => {
  const project = structuredClone(baseProject);
  const before = structuredClone(project.sourceTracks[0].segments[0]);
  const after = structuredClone(before);
  after.start = "00:00:01,100";
  after.end = "00:00:02,100";
  project.sourceTracks[0].segments[0] = after;
  project.editorHistory = {
    undoStack: [{ kind: "timeline", index: 0, beforeSegments: [before], afterSegments: [after] }],
    redoStack: [],
  };

  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, true);

  project.editorHistory.undoStack[0].index = -1;
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, false);
});

test("runtime project allowlists stay synchronized with domain registries", () => {
  const targetLanguages = TARGET_LANGUAGE_REGISTRY
    .flatMap((language) => [language.label, language.code])
    .sort();
  const providerModels = Object.fromEntries(
    TRANSLATION_PROVIDER_REGISTRY.map((provider) => [provider.name, [...provider.models]]),
  );

  assert.deepEqual([...IPC_PROJECT_VALUES.targetLanguages].sort(), targetLanguages);
  assert.deepEqual(IPC_PROJECT_VALUES.providerModels, providerModels);
});

test("malformed nested project data is rejected before persistence", () => {
  const cases = [
    ["unknown media kind", (project) => { project.mediaKind = "document"; }],
    ["missing config field", (project) => { delete project.config.provider; }],
    ["illegal provider model pair", (project) => { project.config.provider = "DeepL"; project.config.model = "GPT-4.1"; }],
    ["unsupported target language", (project) => { project.config.targetLanguages = ["Klingon"]; }],
    ["unsupported ASR model", (project) => { project.config.asrModelId = "medium"; }],
    ["non-string list item", (project) => { project.notes = [{}]; }],
    ["null source track", (project) => { project.sourceTracks = [null]; }],
    ["invalid target text", (project) => { project.sourceTracks[0].segments[0].targetTexts["zh-CN"].qaFlags = [1]; }],
    ["reversed timestamp", (project) => { project.sourceTracks[0].segments[0].end = "00:00:00,500"; }],
  ];

  for (const [label, mutate] of cases) {
    const project = structuredClone(baseProject);
    mutate(project);
    const result = validateIpcEnvelope({ method: "project.save", request: { project } });
    assert.equal(result.ok, false, label);
  }
});

test("port errors are sanitized", () => {
  const mapped = mapPortError(new Error("Invalid project id: ../escape at C:\\\\Users\\\\secret"));
  assert.equal(mapped.code, "INVALID_INPUT");
  assert.equal(mapped.message, "Invalid project id");
  assert.equal(mapped.message.includes("Users"), false);
});

test("subtitle export matrix accepts bounded delivery requests and rejects renderer paths", () => {
  const accepted = validateIpcEnvelope({
    method: "subtitle.exportMatrix",
    request: {
      projectId: "project-ok",
      destination: "user",
      requests: [
        { id: "source-srt", exportKind: "source", format: "srt" },
        { id: "target-zh", exportKind: "target", targetLanguageCode: "zh-CN", format: "ass" },
        { id: "bilingual-zh", exportKind: "bilingual", targetLanguageCode: "zh-CN", format: "vtt" },
      ],
    },
  });
  assert.equal(accepted.ok, true);

  for (const request of [
    { projectId: "project-ok", requests: [] },
    { projectId: "project-ok", requests: [{ exportKind: "target", format: "srt" }] },
    { projectId: "project-ok", requests: [{ exportKind: "source", format: "txt" }] },
    { projectId: "project-ok", destination: "elsewhere", requests: [{ exportKind: "source", format: "srt" }] },
    {
      projectId: "project-ok",
      destinationDir: "C:\\Users\\secret",
      requests: [{ exportKind: "source", format: "srt" }],
    },
  ]) {
    const result = validateIpcEnvelope({ method: "subtitle.exportMatrix", request });
    assert.equal(result.ok, false);
  }
});

test("approved batch export accepts only unique project ids and no renderer path", () => {
  assert.equal(validateIpcEnvelope({
    method: "subtitle.exportApprovedBatch",
    request: { projectIds: ["project-1", "project-2"] },
  }).ok, true);

  for (const request of [
    { projectIds: [] },
    { projectIds: ["project-1", "project-1"] },
    { projectIds: ["../project"] },
    { projectIds: ["project-1"], destinationDir: "C:\\private" },
  ]) {
    assert.equal(validateIpcEnvelope({ method: "subtitle.exportApprovedBatch", request }).ok, false);
  }
});

test("project subtitle style is bounded and validated at the save boundary", () => {
  const valid = structuredClone(baseProject);
  valid.config.subtitleStyle = subtitleStyle;
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project: valid } }).ok, true);

  const invalid = structuredClone(valid);
  invalid.config.subtitleStyle.primary.textColor = "red; background:url(file:///secret)";
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project: invalid } }).ok, false);
});

test("subtitle video export accepts only recorded subtitle ids and managed operation ids", () => {
  assert.equal(validateIpcEnvelope({
    method: "subtitle.videoExport",
    request: {
      projectId: "project-ok",
      subtitleExportRecordId: "export-abc123",
      mode: "burn_ass",
      operationId: "video-export:123",
    },
  }).ok, true);
  for (const request of [
    { projectId: "project-ok", subtitleExportRecordId: "../escape", mode: "burn_ass", operationId: "op-1" },
    { projectId: "project-ok", subtitleExportRecordId: "export-1", mode: "replace_source", operationId: "op-1" },
    { projectId: "project-ok", subtitleExportRecordId: "export-1", mode: "soft_subtitle" },
  ]) {
    assert.equal(validateIpcEnvelope({ method: "subtitle.videoExport", request }).ok, false);
  }
});

test("audio separation exposes a fixed artifact task without speaker or path controls", () => {
  assert.equal(validateIpcEnvelope({
    method: "audio.separation.capability",
    request: {},
  }).ok, true);
  assert.equal(validateIpcEnvelope({
    method: "audio.separation.start",
    request: { projectId: "project-ok", operationId: "separation-123" },
  }).ok, true);
  for (const request of [
    { projectId: "project-ok", operationId: "separation-123", speakerId: "person-1" },
    { projectId: "project-ok", operationId: "separation-123", outputDir: "C:\\secret" },
    { projectId: "project-ok", operationId: "../escape" },
  ]) {
    assert.equal(validateIpcEnvelope({ method: "audio.separation.start", request }).ok, false);
  }
});

test("resource CRUD accepts contract values and rejects mixed style/export fields", () => {
  const glossary = {
    id: "glossary-ui",
    kind: "glossary",
    name: "UI terms",
    description: "",
    payload: {
      languagePairs: [{
        sourceLanguageCode: "en-US",
        targetLanguageCode: "zh-CN",
        entries: [{ id: "term-1", source: "workspace", target: "工作区", enabled: true }],
      }],
    },
  };
  assert.equal(validateIpcEnvelope({ method: "resource.list", request: { kind: "glossary" } }).ok, true);
  assert.equal(validateIpcEnvelope({ method: "resource.save", request: { resource: glossary } }).ok, true);
  assert.equal(validateIpcEnvelope({
    method: "resource.delete",
    request: { resourceId: glossary.id, expectedRevision: 2 },
  }).ok, true);
  assert.equal(validateIpcEnvelope({
    method: "resource.snapshot.list",
    request: { projectId: "project-ok", kind: "glossary" },
  }).ok, true);
  assert.equal(validateIpcEnvelope({
    method: "resource.snapshot.refresh",
    request: { projectId: "project-ok", resourceId: glossary.id },
  }).ok, true);

  const mixedStyle = {
    id: "style-invalid",
    kind: "subtitle_style",
    name: "Invalid",
    description: "",
    payload: {
      format: "ass",
      bilingualLayout: "target_only",
      primary: {},
      secondary: {},
      preview: {},
      burnVideo: true,
    },
  };
  assert.equal(validateIpcEnvelope({ method: "resource.save", request: { resource: mixedStyle } }).ok, false);
});

test("ASR installation errors retain actionable code and retryability without path leakage", () => {
  const error = new Error("There is not enough disk space at C:\\Users\\secret\\model.partial");
  error.code = "DISK_FULL";
  error.retryable = true;
  const mapped = mapPortError(error);
  assert.deepEqual(mapped, {
    code: "DISK_FULL",
    message: "There is not enough disk space at [path]",
    retryable: true,
  });
});

test("ASR unsegmentable input keeps its actionable public error code", () => {
  const error = new Error("ASR words cannot satisfy the subtitle limits");
  error.code = "UNSEGMENTABLE_INPUT";
  assert.deepEqual(mapPortError(error), {
    code: "UNSEGMENTABLE_INPUT",
    message: "ASR words cannot satisfy the subtitle limits",
  });
});

test("ASR result validation errors are not mislabeled as persistence failures", () => {
  const error = new Error("ASR result failed validation at C:\\Users\\secret\\result.json");
  error.code = "INVALID_ASR_RESULT";
  assert.deepEqual(mapPortError(error), {
    code: "INVALID_ASR_RESULT",
    message: "ASR result failed validation at [path]",
  });
});

test("project runtime state request is accepted for a safe project id", () => {
  const result = validateIpcEnvelope({
    method: "project.runtimeState",
    request: { projectId: "project-ok" },
  });
  assert.equal(result.ok, true);
});

test("ASR candidate provenance is bounded and paired on project save", () => {
  const project = structuredClone(baseProject);
  const candidate = structuredClone(project.sourceTracks[0]);
  candidate.id = "asr-candidate-1";
  candidate.kind = "asr";
  candidate.isActive = false;
  candidate.asrRunId = "asr-run-1";
  candidate.segmentationConfigVersion = "asr-segmentation-v2";
  candidate.segments[0].id = "asr-segment-1";
  candidate.targetTracks[0].id = "asr-target-1";
  project.sourceTracks.push(candidate);
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, true);

  Object.assign(candidate.segments[0], {
    detectedLanguage: "en",
    languageConfidence: 0.99,
    languageDetectionMethod: "whisper.cpp-region-auto",
    languageDetectionVersion: "whisper.cpp-1.9.1-small-v1",
    languageOverlapStatus: "none",
    sourceLanguage: "en",
  });
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, true);
  candidate.segments[0].languageConfidence = 0.1;
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, false);
  candidate.segments[0].languageConfidence = 0.99;

  delete candidate.segmentationConfigVersion;
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, false);
  candidate.segmentationConfigVersion = "../../future";
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, false);
});

test("ASR capability IPC accepts no renderer-controlled path URL or argv", () => {
  assert.equal(validateIpcEnvelope({ method: "asr.capability", request: {} }).ok, true);

  for (const request of [
    { path: "C:\\temp\\whisper-cli.exe" },
    { executable: "whisper-cli.exe" },
    { url: "https://example.test/model.bin" },
    { argv: ["--model", "x"] },
    { cwd: "C:\\temp" },
    { runtimeId: "../../escape" },
  ]) {
    const result = validateIpcEnvelope({ method: "asr.capability", request });
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, "INVALID_INPUT");
  }
});

test("ASR model management IPC is bounded and never accepts renderer paths URLs or hashes", () => {
  const modelIds = JSON.parse(readFileSync(
    new URL("../../docs/third-party/asr/manifest.json", import.meta.url),
    "utf8",
  )).models.map((model) => model.id);
  for (const assetId of modelIds) {
    assert.equal(validateIpcEnvelope({
      method: "asr.model.install",
      request: { assetId, source: "official", operationId: `install-${assetId}` },
    }).ok, true, assetId);
    assert.equal(validateIpcEnvelope({
      method: "asr.model.import",
      request: { assetId, operationId: `import-${assetId}` },
    }).ok, true, assetId);
    assert.equal(validateIpcEnvelope({
      method: "asr.model.uninstall",
      request: { assetId, operationId: `uninstall-${assetId}` },
    }).ok, true, assetId);
  }
  for (const envelope of [
    { method: "asr.model.install", request: { assetId: "small", source: "official", operationId: "install-1" } },
    { method: "asr.model.install", request: { assetId: "small", source: "mirror", operationId: "install-2" } },
    { method: "asr.model.import", request: { assetId: "small", operationId: "import-1" } },
    { method: "asr.model.uninstall", request: { assetId: "small", operationId: "uninstall-1" } },
    { method: "asr.model.cancel", request: { operationId: "cancel-1" } },
    { method: "asr.runtime.install", request: { assetId: "whisper-cpp-cuda-12.4-x64", source: "official", operationId: "runtime-install-1" } },
    { method: "asr.runtime.import", request: { assetId: "whisper-cpp-cuda-12.4-x64", operationId: "runtime-import-1" } },
    { method: "asr.runtime.uninstall", request: { assetId: "whisper-cpp-cuda-12.4-x64", operationId: "runtime-uninstall-1" } },
    { method: "asr.runtime.cancel", request: { operationId: "runtime-cancel-1" } },
    { method: "asr.songClassifier.install", request: { assetId: "ina-speech-music-noise-v1", source: "official", operationId: "song-install-1" } },
    { method: "asr.songClassifier.uninstall", request: { assetId: "ina-speech-music-noise-v1", operationId: "song-uninstall-1" } },
    { method: "asr.songClassifier.cancel", request: { operationId: "song-cancel-1" } },
  ]) {
    assert.equal(validateIpcEnvelope(envelope).ok, true, JSON.stringify(envelope));
  }

  for (const [method, request] of [
    ["asr.model.install", { assetId: "medium", source: "official", operationId: "x" }],
    ["asr.model.install", { assetId: "small", source: "https://bad.test/model", operationId: "x" }],
    ["asr.model.import", { assetId: "small", operationId: "x", path: "C:\\private\\model.bin" }],
    ["asr.model.import", { assetId: "small", operationId: "x", url: "https://bad.test" }],
    ["asr.model.install", { assetId: "small", source: "official", operationId: "x", sha256: "a".repeat(64) }],
    ["asr.model.cancel", { operationId: "../escape" }],
    ["asr.runtime.install", { assetId: "whisper-cpp-cuda-12.4-x64", source: "mirror", operationId: "x" }],
    ["asr.runtime.install", { assetId: "other-runtime", source: "official", operationId: "x" }],
    ["asr.runtime.import", { assetId: "whisper-cpp-cuda-12.4-x64", operationId: "x", path: "C:\\private\\runtime.zip" }],
    ["asr.runtime.cancel", { operationId: "../escape" }],
    ["asr.songClassifier.install", { assetId: "other", source: "official", operationId: "x" }],
    ["asr.songClassifier.install", { assetId: "ina-speech-music-noise-v1", source: "mirror", operationId: "x" }],
    ["asr.songClassifier.uninstall", { assetId: "ina-speech-music-noise-v1", operationId: "x", path: "C:\\private" }],
    ["asr.songClassifier.cancel", { operationId: "../escape" }],
  ]) {
    const result = validateIpcEnvelope({ method, request });
    assert.equal(result.ok, false, `${method} ${JSON.stringify(request)}`);
    assert.equal(result.error.code, "INVALID_INPUT");
  }
});

test("ASR device IPC accepts only bounded preferences and operation ids", () => {
  for (const envelope of [
    { method: "asr.device.status", request: {} },
    { method: "asr.device.preference", request: { requestedDevice: "auto", allowCudaFallback: false } },
    { method: "asr.device.preference", request: { requestedDevice: "cpu", allowCudaFallback: true } },
    { method: "asr.device.preference", request: { requestedDevice: "cuda", allowCudaFallback: false } },
    { method: "asr.device.detect", request: { operationId: "detect-1" } },
    { method: "asr.device.cancel", request: { operationId: "detect-1" } },
  ]) {
    assert.equal(validateIpcEnvelope(envelope).ok, true, JSON.stringify(envelope));
  }
  for (const [method, request] of [
    ["asr.device.status", { path: "C:\\private" }],
    ["asr.device.preference", { requestedDevice: "--gpu=0", allowCudaFallback: false }],
    ["asr.device.preference", { requestedDevice: "cuda", allowCudaFallback: false, argv: ["--gpu"] }],
    ["asr.device.detect", { operationId: "../escape" }],
    ["asr.device.cancel", { operationId: "x", pid: 42 }],
  ]) {
    const result = validateIpcEnvelope({ method, request });
    assert.equal(result.ok, false, `${method} ${JSON.stringify(request)}`);
  }
});

test("ASR project workflow IPC is exact, bounded, and never accepts renderer paths URLs or argv", () => {
  const valid = [
    { method: "asr.project.status", request: { projectId: "project-ok" } },
    { method: "asr.transcribe", request: { projectId: "project-ok", audioStreamId: "s:1", languageMode: "auto", languageHint: null, requestedDevice: "cpu", allowCudaFallback: false, operationId: "asr-run-1" } },
    { method: "asr.segment", request: { projectId: "project-ok", asrRunId: "asr-run-1", configVersion: "asr-segmentation-v2", operationId: "segment-1" } },
    { method: "asr.language.detect", request: { projectId: "project-ok", sourceTrackId: "asr-candidate-1", requestedDevice: "cpu", allowCudaFallback: false, operationId: "language-1" } },
    { method: "asr.language.update", request: { projectId: "project-ok", sourceTrackId: "asr-candidate-1", changes: [{ segmentId: "asr-seg-1", manualLanguage: "en" }], confirmTrackConvergence: false } },
    { method: "asr.cancel", request: { projectId: "project-ok", operationId: "asr-run-1" } },
    { method: "asr.info.open", request: { target: "model-source", modelId: "large-v3-turbo-q5_0" } },
    { method: "asr.info.open", request: { target: "vad-source" } },
    { method: "asr.info.open", request: { target: "vad-license" } },
    { method: "asr.info.open", request: { target: "engine-source", modelId: "qwen3-asr-0.6b" } },
  ];
  for (const envelope of valid) {
    assert.equal(validateIpcEnvelope(envelope).ok, true, JSON.stringify(envelope));
  }

  const invalid = [
    ["asr.project.status", { projectId: "project-ok", path: "C:\\private\\media.wav" }],
    ["asr.transcribe", { ...valid[1].request, audioStreamId: "s:1", url: "https://bad.test/model" }],
    ["asr.transcribe", { ...valid[1].request, modelId: "small" }],
    ["asr.transcribe", { ...valid[1].request, argv: ["--prompt", "secret"] }],
    ["asr.segment", { ...valid[2].request, configVersion: "../../future" }],
    ["asr.language.detect", { ...valid[3].request, executable: "whisper-cli.exe" }],
    ["asr.language.update", { ...valid[4].request, changes: [{ segmentId: "asr-seg-1", manualLanguage: "not a language" }] }],
    ["asr.cancel", { projectId: "project-ok", operationId: "../escape" }],
    ["asr.info.open", { target: "https://example.test" }],
    ["asr.info.open", { target: "model-source", modelId: "medium" }],
  ];
  for (const [method, request] of invalid) {
    const result = validateIpcEnvelope({ method, request });
    assert.equal(result.ok, false, `${method} ${JSON.stringify(request)}`);
    assert.equal(result.error.code, "INVALID_INPUT");
  }
});

test("media IPC rejects invalid defaults and unbounded persisted probe data", () => {
  const invalidDefaults = validateIpcEnvelope({
    method: "media.selectSource",
    request: { defaults: { provider: "DeepL", model: "GPT-4.1", targetLanguages: ["Klingon"] } },
  });
  assert.equal(invalidDefaults.ok, false);

  const project = structuredClone(baseProject);
  project.mediaKind = "video";
  project.noSourceMedia = false;
  project.mediaSource = {
    assetId: "primary",
    displayName: "clip.mkv",
    availability: "available",
    identity: { sizeBytes: 1, mtimeMs: 1, fingerprint: "abc" },
    selectedAudioStreamId: null,
    selectedSubtitleStreamId: "s:0",
  };
  project.sourceProbeSummary = {
    media: {
      mediaKind: "video",
      format: {},
      streams: [{ streamId: "s:0", kind: "video", tags: { private: "leak" } }],
      warnings: [],
      probeVersion: 1,
      artifact: {},
    },
  };
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, false);

  const invalidIdentity = structuredClone(baseProject);
  invalidIdentity.mediaSource = {
    assetId: "primary",
    displayName: "clip.mkv",
    availability: "available",
    identity: { sizeBytes: "1", mtimeMs: 1, fingerprint: "abc" },
    selectedAudioStreamId: null,
    selectedSubtitleStreamId: null,
  };
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project: invalidIdentity } }).ok, false);
});

test("batch session IPC accepts only bounded absolute file selections", () => {
  const valid = validateIpcEnvelope({
    method: "batch.createSession",
    request: { filePaths: ["C:\\Media\\captions.srt"] },
  });
  assert.equal(valid.ok, true);
  assert.equal(validateIpcEnvelope({
    method: "batch.discardSession",
    request: { sessionId: "batch-session-1" },
  }).ok, true);
  assert.equal(validateIpcEnvelope({
    method: "batch.commitSession",
    request: {
      sessionId: "batch-session-1",
      defaults: { provider: "OpenAI", model: "GPT-4.1", targetLanguages: ["zh-CN"] },
      groups: [{
        id: "group-1",
        title: "Project 1",
        fileIds: ["file-1", "file-2"],
        overrides: { targetLanguages: ["ja-JP"] },
      }],
      fileEncodings: [{ fileId: "file-2", encoding: "gbk" }],
    },
  }).ok, true);

  for (const filePaths of [
    ["relative\\clip.mkv", "C:\\Media\\captions.srt"],
    ["https://example.test/clip.mkv", "C:\\Media\\captions.srt"],
  ]) {
    const result = validateIpcEnvelope({ method: "batch.createSession", request: { filePaths } });
    assert.equal(result.ok, false, JSON.stringify(filePaths));
  }

  for (const fileEncodings of [
    [{ fileId: "file-2", encoding: "utf-32" }],
    [{ fileId: "../file", encoding: "utf-8" }],
    [{ fileId: "file-missing", encoding: "utf-8" }],
    [{ fileId: "file-2", encoding: "gbk", secret: "must-not-pass" }],
  ]) {
    const result = validateIpcEnvelope({
      method: "batch.commitSession",
      request: {
        sessionId: "batch-session-1",
        defaults: {},
        groups: [{ id: "group-1", title: "Project 1", fileIds: ["file-2"], overrides: {} }],
        fileEncodings,
      },
    });
    assert.equal(result.ok, false, JSON.stringify(fileEncodings));
  }
});

test("application settings accept only a declared global ASR default", () => {
  const settings = {
    schemaVersion: 1,
    startupPage: "resume",
    translationProvider: null,
    translationModel: null,
    asrDefaultModelId: "large-v3-turbo-q5_0",
    asrVad: {
      mode: "custom",
      customParameters: {
        threshold: 0.6,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 400,
        maxSpeechDurationSeconds: 30,
        speechPadMs: 80,
        samplesOverlapSeconds: 0.2,
      },
    },
    asrVocalSeparation: "off",
    asrSongHandling: "preserve",
    cachePath: "C:\\cache",
    modelPath: "C:\\models",
    backupPath: "C:\\backups",
    downloadSource: "official",
    customDownloadUrl: "",
    notifications: { taskDone: true, error: true, release: true, system: true },
  };
  assert.equal(validateIpcEnvelope({ method: "settings.save", request: { settings } }).ok, true);
  assert.equal(validateIpcEnvelope({ method: "settings.save", request: { settings: { ...settings, asrVocalSeparation: "on" } } }).ok, true);
  assert.equal(validateIpcEnvelope({ method: "settings.save", request: { settings: { ...settings, asrSongHandling: "filter" } } }).ok, true);
  assert.equal(validateIpcEnvelope({
    method: "settings.save",
    request: { settings: { ...settings, translationProvider: "DeepSeek", translationModel: "deepseek-v4-flash" } },
  }).ok, true);
  assert.equal(validateIpcEnvelope({
    method: "settings.save",
    request: { settings: { ...settings, translationProvider: "DeepSeek" } },
  }).ok, false);
  assert.equal(validateIpcEnvelope({
    method: "settings.save",
    request: { settings: { ...settings, asrDefaultModelId: "medium" } },
  }).ok, false);
  for (const asrVad of [
    { ...settings.asrVad, mode: "unsafe" },
    { ...settings.asrVad, customParameters: { ...settings.asrVad.customParameters, threshold: -0.01 } },
    { ...settings.asrVad, customParameters: { ...settings.asrVad.customParameters, minSpeechDurationMs: 60_001 } },
    { ...settings.asrVad, customParameters: { ...settings.asrVad.customParameters, maxSpeechDurationSeconds: "0 --prompt bad" } },
    { ...settings.asrVad, customParameters: { ...settings.asrVad.customParameters, argv: ["--prompt", "bad"] } },
  ]) {
    assert.equal(validateIpcEnvelope({ method: "settings.save", request: { settings: { ...settings, asrVad } } }).ok, false);
  }
  for (const asrVocalSeparation of ["smart", true, { mode: "on" }]) {
    assert.equal(validateIpcEnvelope({ method: "settings.save", request: { settings: { ...settings, asrVocalSeparation } } }).ok, false);
  }
  for (const asrSongHandling of ["auto", true, { mode: "filter" }]) {
    assert.equal(validateIpcEnvelope({ method: "settings.save", request: { settings: { ...settings, asrSongHandling } } }).ok, false);
  }
});

test("audio extraction IPC accepts only project and stream ids, never renderer paths", () => {
  assert.equal(validateIpcEnvelope({
    method: "media.extractAudio",
    request: { projectId: "project-ok", streamId: "s:2", operationId: "audio-export-1" },
  }).ok, true);
  for (const request of [
    { projectId: "project-ok", streamId: "s:2", destinationPath: "C:\\private\\audio.wav" },
    { projectId: "../escape", streamId: "s:2" },
    { projectId: "project-ok", streamId: "" },
  ]) {
    assert.equal(validateIpcEnvelope({ method: "media.extractAudio", request }).ok, false);
  }
});

test("batch start requires explicit confirmation and unique projects", () => {
  const valid = validateIpcEnvelope({
    method: "batch.start",
    request: {
      batchId: "batch-session-1",
      projectIds: ["project-1", "project-2"],
      userConfirmed: true,
      provider: "OpenAI",
      model: "GPT-4.1",
    },
  });
  assert.equal(valid.ok, true);

  for (const request of [
    { batchId: "batch-1", projectIds: ["project-1"], userConfirmed: false },
    { batchId: "batch-1", projectIds: ["project-1", "project-1"], userConfirmed: true },
    { batchId: "batch-1", projectIds: ["../project"], userConfirmed: true },
    { batchId: "batch-1", projectIds: ["project-1"], userConfirmed: true, batchBudgetUsd: 5 },
    { batchId: "batch-1", projectIds: ["project-1"], userConfirmed: true, secret: "must-not-pass" },
  ]) {
    const result = validateIpcEnvelope({ method: "batch.start", request });
    assert.equal(result.ok, false, JSON.stringify(request));
  }
});

test("translation start rejects unsafe paid request configuration", () => {
  assert.equal(validateIpcEnvelope({
    method: "translation.start",
    request: { projectId: "project-ok", userConfirmed: true, batchId: "batch-1" },
  }).ok, true);

  for (const request of [
    {
      projectId: "project-ok",
      userConfirmed: true,
      parameters: { temperature: "hot" },
    },
    {
      projectId: "project-ok",
      userConfirmed: true,
      targetLanguages: ["Klingon"],
    },
    {
      projectId: "project-ok",
      userConfirmed: true,
      batchId: "../batch",
    },
  ]) {
    const result = validateIpcEnvelope({ method: "translation.start", request });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_INPUT");
  }
});

test("focused translation validates selected ids and candidate destination", () => {
  const valid = validateIpcEnvelope({
    method: "translation.start",
    request: {
      projectId: "project-ok",
      userConfirmed: true,
      targetLanguages: ["zh-CN"],
      segmentIds: ["segment-1"],
    },
  });
  assert.equal(valid.ok, true);

  for (const request of [
    { segmentIds: ["segment-1", "segment-1"] },
    { segmentIds: ["../segment"] },
    { candidateTrackId: "../candidate" },
    { segmentIds: ["segment-1"], candidateTrackId: "candidate-1" },
  ]) {
    const result = validateIpcEnvelope({
      method: "translation.start",
      request: {
        projectId: "project-ok",
        userConfirmed: true,
        targetLanguages: ["zh-CN"],
        ...request,
      },
    });
    assert.equal(result.ok, false, JSON.stringify(request));
  }
});

test("candidate tracks reference their own source segments and base track", () => {
  const candidateProject = structuredClone(baseProject);
  candidateProject.sourceTracks[0].targetTracks.push({
    id: "candidate-1",
    languageCode: "zh-CN",
    languageLabel: "简体中文候选",
    status: "in_review",
    isActive: false,
    role: "candidate",
    baseTrackId: "target-1",
    candidateTexts: {
      "segment-1": { model: "候选", postProcessed: "候选", qaFlags: [] },
    },
    qaIssues: [],
    snapshotIds: [],
    deliveryLabel: "候选",
    lastHumanAction: "created",
  });
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project: candidateProject } }).ok, true);

  for (const mutate of [
    (project) => { project.sourceTracks[0].targetTracks[1].baseTrackId = "missing-track"; },
    (project) => { project.sourceTracks[0].targetTracks[1].candidateTexts = { missing: { model: "x", qaFlags: [] } }; },
  ]) {
    const project = structuredClone(candidateProject);
    mutate(project);
    assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, false);
  }
});

test("subtitle import defaults reject invalid project configuration", () => {
  const bytes = new Uint8Array([0x31, 0x0a]);
  const invalidDefaults = [
    { targetLanguages: ["zh-CN", "zh-CN"] },
    { provider: "DeepL", model: "GPT-4.1" },
    { budgetUsd: 1 },
    { sourceLanguage: "" },
  ];

  for (const defaults of invalidDefaults) {
    const result = validateIpcEnvelope({
      method: "subtitle.import",
      request: { fileName: "basic-utf8.srt", bytes, defaults },
    });
    assert.equal(result.ok, false, JSON.stringify(defaults));
    assert.equal(result.error.code, "INVALID_INPUT");
  }
});

test("provider.listModels accepts a provider with optional overrides only", () => {
  const accepted = [
    { provider: "OpenAI" },
    { provider: "OpenAI", credentialId: "openai-default" },
    { provider: "OpenAI Compatible", baseUrl: "https://proxy.example.com/v1" },
    { provider: "OpenAI", credentialId: "openai-default", baseUrl: "https://a.example/v1", timeoutMs: 5000 },
  ];
  for (const request of accepted) {
    const result = validateIpcEnvelope({ method: "provider.listModels", request });
    assert.equal(result.ok, true, JSON.stringify(request));
  }

  const rejected = [
    undefined,
    null,
    "OpenAI",
    {},
    { provider: "" },
    { provider: 42 },
    { provider: "x".repeat(65) },
    { provider: "OpenAI", credentialId: ".." },
    { provider: "OpenAI", credentialId: "bad/id" },
    { provider: "OpenAI", credentialId: 7 },
    { provider: "OpenAI", baseUrl: "" },
    { provider: "OpenAI", baseUrl: 7 },
    { provider: "OpenAI", baseUrl: `https://a.example/${"p".repeat(2100)}` },
    { provider: "OpenAI", timeoutMs: 0 },
    { provider: "OpenAI", timeoutMs: -1 },
    { provider: "OpenAI", timeoutMs: Number.NaN },
    { provider: "OpenAI", timeoutMs: 60_001 },
    { provider: "OpenAI", apiKey: "sk-should-never-cross-ipc" },
    { provider: "OpenAI", secret: "sk-nope" },
    { provider: "OpenAI", style: "anthropic" },
  ];
  for (const request of rejected) {
    const result = validateIpcEnvelope({ method: "provider.listModels", request });
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, "INVALID_INPUT");
  }
});

test("source subtitle export accepts a picker intent but never a renderer path", () => {
  assert.equal(validateIpcEnvelope({
    method: "subtitle.exportSource",
    request: { projectId: "project-ok", mode: "normalized", format: "srt", destination: "user" },
  }).ok, true);
  for (const request of [
    { projectId: "project-ok", mode: "normalized", format: "srt", destination: "elsewhere" },
    { projectId: "project-ok", mode: "normalized", format: "srt", destinationPath: "C:\\Users\\secret.srt" },
  ]) {
    assert.equal(validateIpcEnvelope({ method: "subtitle.exportSource", request }).ok, false);
  }
});

test("filesystem exhaustion and permission failures keep actionable public error codes", () => {
  const disk = Object.assign(new Error("ENOSPC while writing C:\\private\\project.sqlite"), { code: "ENOSPC" });
  assert.deepEqual(mapPortError(disk), {
    code: "DISK_FULL",
    message: "There is not enough disk space",
    retryable: true,
  });
  const sqlite = Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR" });
  assert.equal(mapPortError(sqlite).code, "DISK_FULL");
  const permission = Object.assign(new Error("EACCES C:\\private\\file"), { code: "EACCES" });
  assert.deepEqual(mapPortError(permission), {
    code: "PERMISSION_DENIED",
    message: "The selected file or directory is not writable",
  });
  assert.doesNotMatch(JSON.stringify(mapPortError(disk)), /private|project\.sqlite/i);
});
