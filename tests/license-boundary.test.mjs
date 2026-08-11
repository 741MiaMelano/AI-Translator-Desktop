import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VOCAL_SEPARATION_IDENTITY } from "../backend/audio/vocal-separation-process.mjs";
import { SONG_CLASSIFIER_IDENTITY } from "../backend/audio/song-classifier-process.mjs";
import { validateAsrManifest } from "../backend/asr/runtime-registry.mjs";
import { verifyPackagedArtifacts } from "../backend/media/ffmpeg-artifact-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("release dependency and notice boundary stays explicit", () => {
  const packageJson = json("package.json");
  assert.equal(packageJson.author, "741MiaMelano");
  assert.equal(packageJson.license, "MIT");
  assert.match(read("LICENSE"), /Copyright \(c\) 2026 741MiaMelano/);
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    "lucide-react",
    "react",
    "react-dom",
    "react-router-dom",
  ]);
  for (const buildOnly of ["@vitejs/plugin-react", "typescript", "vite"]) {
    assert.equal(packageJson.devDependencies[buildOnly] !== undefined, true);
  }

  const notice = read("THIRD-PARTY-NOTICES.txt");
  for (const component of [
    "lucide-react 0.468.0",
    "react 19.2.7",
    "react-dom 19.2.7",
    "scheduler 0.27.0",
    "react-router 7.18.1",
    "react-router-dom 7.18.1",
    "cookie 1.1.1",
    "set-cookie-parser 2.7.2",
    "Electron 43.1.0",
    "whisper.cpp 1.9.1",
    "FFmpeg 7.1.5-2-g998de74adf",
    "audio-separator 0.44.5",
    "MelBand RoFormer vocals checkpoint by KimberleyJSN",
    "inaSpeechSegmenter speech/music/noise model and architecture",
    "SIDEKIT",
    "h5py 3.15.1",
  ]) {
    assert.match(notice, new RegExp(component.replaceAll(".", "\\.")));
  }
  const builder = read("electron-builder.yml");
  assert.match(builder, /from: LICENSE\s+to: LICENSE/);
  assert.match(builder, /from: THIRD-PARTY-NOTICES\.txt\s+to: THIRD-PARTY-NOTICES\.txt/);
  assert.match(builder, /from: docs\/third-party\/audio-separation\/manifest\.json\s+to: audio-separation\/manifest\.json/);
  assert.match(builder, /from: docs\/third-party\/audio-separation\/licenses\s+to: audio-separation\/licenses/);
  assert.match(builder, /from: docs\/third-party\/song-classifier\/manifest\.json\s+to: song-classifier\/manifest\.json/);
  assert.match(builder, /from: backend\/audio\/song-classifier-sidecar\.py\s+to: backend\/audio\/song-classifier-sidecar\.py/);
  const attributes = read(".gitattributes");
  assert.match(attributes, /resources\/ffmpeg\/win32-x64\/\*\* -text/);
  assert.match(attributes, /docs\/third-party\/asr\/licenses\/\*\* -text/);
  assert.match(attributes, /docs\/third-party\/audio-separation\/licenses\/\*\* -text/);
  assert.match(attributes, /docs\/third-party\/song-classifier\/licenses\/\*\* -text/);
  const ignore = read(".gitignore");
  for (const extension of ["ckpt", "pth", "safetensors", "hdf5"]) {
    assert.match(ignore, new RegExp(`\\*\\.${extension}(?:\\r?\\n|$)`));
  }
});

test("optional song classifier is pinned and the downloadable HDF5 model stays outside Git", () => {
  const manifest = json("docs/third-party/song-classifier/manifest.json");
  assert.equal(manifest.detector.id, SONG_CLASSIFIER_IDENTITY.detectorId);
  assert.equal(manifest.detector.revision, SONG_CLASSIFIER_IDENTITY.engineVersion);
  assert.equal(manifest.detector.license, "MIT");
  assert.equal(manifest.model.fileName, SONG_CLASSIFIER_IDENTITY.modelFileName);
  assert.equal(manifest.model.sizeBytes, SONG_CLASSIFIER_IDENTITY.modelSizeBytes);
  assert.equal(manifest.model.sha256, SONG_CLASSIFIER_IDENTITY.modelSha256);
  assert.equal(manifest.pythonDependency.requirement, `h5py==${SONG_CLASSIFIER_IDENTITY.h5pyVersion}`);
  assert.equal(manifest.pythonDependency.license, "BSD-3-Clause");
  assert.equal(manifest.featureExtraction.license, "LGPL-3.0-or-later");
  assert.equal(existsSync(join(root, "docs", "third-party", "song-classifier", SONG_CLASSIFIER_IDENTITY.modelFileName)), false);
  for (const notice of [
    "INA-SPEECH-SEGMENTER-MIT.txt", "H5PY-BSD-3-CLAUSE.txt",
    "SIDEKIT-LGPL-3.0-NOTICE.txt", "LGPL-3.0.txt", "GPL-3.0.txt",
  ]) {
    assert.equal(existsSync(join(root, "docs", "third-party", "song-classifier", "licenses", notice)), true);
  }
});

test("bundled FFmpeg and ASR license evidence matches pinned manifests", () => {
  const ffmpegManifest = json("docs/third-party/ffmpeg/manifest.json");
  const verified = verifyPackagedArtifacts(ffmpegManifest, join(root, "resources", "ffmpeg", "win32-x64"));
  assert.equal(verified.artifactCount, 14);

  const asrManifest = json("docs/third-party/asr/manifest.json");
  const validated = validateAsrManifest(asrManifest);
  const notices = [
    ...validated.runtime.files,
    ...validated.models.flatMap((model) => model.files),
    ...validated.optionalRuntimes.flatMap((runtime) => runtime.files),
  ].filter((entry) => entry.role === "notice");

  for (const notice of notices) {
    const path = join(root, "docs", "third-party", "asr", notice.relativePath);
    assert.equal(statSync(path).size, notice.sizeBytes, notice.relativePath);
    assert.equal(sha256(path), notice.sha256, notice.relativePath);
  }
});

test("optional vocal-separation downloads stay pinned, licensed, and outside Git", () => {
  const manifest = json("docs/third-party/audio-separation/manifest.json");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.engine.id, VOCAL_SEPARATION_IDENTITY.engineId);
  assert.equal(manifest.engine.version, VOCAL_SEPARATION_IDENTITY.engineVersion);
  assert.equal(manifest.engine.requirement, "audio-separator[cpu]==0.44.5");
  assert.equal(manifest.engine.license, "MIT");
  assert.equal(manifest.sharedRuntime.id, "qwen3-asr-transformers-cu128-x64");
  assert.equal(manifest.sharedRuntime.version, "0.0.6+torch2.11.0-cu128");
  assert.equal(manifest.sharedRuntime.entryPoint, "venv/Scripts/audio-separator.exe");
  assert.equal(manifest.model.id, VOCAL_SEPARATION_IDENTITY.modelId);
  assert.equal(manifest.model.revision, VOCAL_SEPARATION_IDENTITY.modelRevision);
  assert.equal(manifest.model.modelHash, VOCAL_SEPARATION_IDENTITY.modelSha256);
  assert.deepEqual(manifest.model.stems, ["vocals", "other"]);

  const weight = manifest.model.files.find((entry) => entry.role === "weight");
  const config = manifest.model.files.find((entry) => entry.role === "config");
  assert.equal(weight.relativePath, VOCAL_SEPARATION_IDENTITY.modelFileName);
  assert.equal(weight.sizeBytes, VOCAL_SEPARATION_IDENTITY.modelSizeBytes);
  assert.equal(weight.sha256, VOCAL_SEPARATION_IDENTITY.modelSha256);
  assert.equal(config.relativePath, VOCAL_SEPARATION_IDENTITY.configFileName);
  assert.equal(config.sizeBytes, VOCAL_SEPARATION_IDENTITY.configSizeBytes);
  assert.equal(config.sha256, VOCAL_SEPARATION_IDENTITY.configSha256);
  assert.equal(
    manifest.model.sizeBytes,
    manifest.model.files.filter((entry) => entry.role !== "notice")
      .reduce((total, entry) => total + entry.sizeBytes, 0),
  );

  const notices = [
    manifest.engine.notice,
    ...manifest.model.files.filter((entry) => entry.role === "notice"),
  ];
  for (const notice of notices) {
    const path = join(root, "docs", "third-party", "audio-separation", notice.relativePath);
    assert.equal(statSync(path).size, notice.sizeBytes, notice.relativePath);
    assert.equal(sha256(path), notice.sha256, notice.relativePath);
  }

  const requirements = read("docs/third-party/asr/qwen-requirements-cu128.txt");
  for (const requirement of [
    "audio-separator==0.44.5",
    "onnx-weekly==1.23.0.dev20260805",
    "onnxruntime==1.28.0",
    "torchvision==0.26.0+cu128",
  ]) assert.match(requirements, new RegExp(`^${requirement.replaceAll(".", "\\.").replaceAll("+", "\\+")}$`, "m"));

  for (const path of [
    join(root, "docs", "third-party", "audio-separation", VOCAL_SEPARATION_IDENTITY.modelFileName),
    join(root, "docs", "third-party", "audio-separation", VOCAL_SEPARATION_IDENTITY.configFileName),
    join(root, "resources", "audio-separation", "models"),
  ]) assert.equal(existsSync(path), false, `downloadable asset leaked into repository: ${path}`);
});
