import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveVerifiedArtifactPaths } from "../../backend/media/ffmpeg-artifact-manifest.mjs";
import { createMediaService } from "../../backend/media/media-service.mjs";
import { runManagedProcess } from "../../backend/media/process-runner.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const defaults = {
  sourceLanguage: "auto",
  targetLanguages: ["zh-CN"],
  provider: "OpenAI",
  model: "GPT-4.1",
  glossary: "g",
  styleGuide: "s",
  outputFormat: "SRT",
};

test("single file uses the same batch session boundary as mixed imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase9-single-import-session-"));
  const videoPath = join(root, "single.mp4");
  writeFileSync(videoPath, "video");
  const service = createMediaService({
    resolveArtifacts: () => ({ ffprobePath: join(root, "ffprobe.exe"), upstreamVersion: "test" }),
    getProjectRepository: () => { throw new Error("session preparation must not create a project"); },
    runProcess: async () => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        format: { format_name: "mov,mp4", duration: "12", size: "5" },
        streams: [{ index: 0, codec_type: "video", codec_name: "h264" }],
      })),
    }),
  });

  try {
    const session = await service.createBatchSession({ filePaths: [videoPath] });
    assert.equal(session.files.length, 1);
    assert.equal(session.groups.length, 1);
    assert.deepEqual(session.ambiguities, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subtitle encoding uncertainty is resolved inside the unified import session", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase9-import-encoding-"));
  const subtitlePath = join(root, "legacy.srt");
  writeFileSync(subtitlePath, Buffer.concat([
    Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n", "ascii"),
    Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
    Buffer.from("\n", "ascii"),
  ]));
  const persisted = [];
  const service = createMediaService({
    resolveArtifacts: () => ({ ffprobePath: join(root, "ffprobe.exe"), upstreamVersion: "test" }),
    getProjectRepository: () => { throw new Error("unified import uses the batch persistence port"); },
    persistBatchProjects: (entries) => {
      persisted.push(...entries);
      return {
        projectIds: entries.map(({ project }) => project.id),
        projects: entries.map(({ project }) => project),
      };
    },
    runProcess: async () => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        format: { format_name: "srt", size: "45" },
        streams: [{ index: 0, codec_type: "subtitle", codec_name: "subrip" }],
      })),
    }),
  });

  try {
    const session = await service.createBatchSession({ filePaths: [subtitlePath] });
    assert.deepEqual(session.ambiguities, [{
      kind: "subtitle_encoding",
      fileId: session.files[0].id,
      encodingCandidates: ["gbk", "shift_jis"],
    }]);
    const result = await service.commitBatchSession({
      sessionId: session.id,
      defaults,
      groups: session.groups.map((group) => ({ ...group, overrides: {} })),
      fileEncodings: [{ fileId: session.files[0].id, encoding: "gbk" }],
    });
    assert.equal(result.projects[0].sourceTracks[0].segments[0].sourceText.original, "你好");
    assert.equal(persisted.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unified import rejects oversized subtitles before reading them into memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase9-import-size-limit-"));
  const subtitlePath = join(root, "oversized.srt");
  writeFileSync(subtitlePath, Buffer.alloc(8 * 1024 * 1024 + 1));
  const service = createMediaService({
    resolveArtifacts: () => ({ ffprobePath: join(root, "ffprobe.exe"), upstreamVersion: "test" }),
    getProjectRepository: () => { throw new Error("session preparation must not create a project"); },
    runProcess: async () => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({
        format: { format_name: "srt", size: String(8 * 1024 * 1024 + 1) },
        streams: [{ index: 0, codec_type: "subtitle", codec_name: "subrip" }],
      })),
    }),
  });

  try {
    await assert.rejects(
      service.createBatchSession({ filePaths: [subtitlePath] }),
      /Subtitle file is too large/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch session probes real files without creating projects or exposing paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase9-batch-session-"));
  const videoPath = join(root, "movie.mkv");
  const subtitlePath = join(root, "captions.srt");
  writeFileSync(videoPath, "video");
  writeFileSync(subtitlePath, "subtitle");
  let repositoryCalls = 0;
  const service = createMediaService({
    resolveArtifacts: () => ({ ffprobePath: join(root, "ffprobe.exe"), upstreamVersion: "test" }),
    getProjectRepository: () => {
      repositoryCalls += 1;
      throw new Error("batch probe must not create a project");
    },
    runProcess: async ({ argv }) => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(
        basename(argv.at(-1)) === "movie.mkv"
          ? {
              format: { format_name: "matroska", duration: "120", size: "5" },
              streams: [{ index: 0, codec_type: "video", codec_name: "h264" }],
            }
          : {
              format: { format_name: "srt", duration: "120.5", size: "8" },
              streams: [{ index: 0, codec_type: "subtitle", codec_name: "subrip" }],
            },
      )),
    }),
  });

  try {
    const session = await service.createBatchSession({ filePaths: [videoPath, subtitlePath] });
    assert.equal(repositoryCalls, 0);
    assert.deepEqual(session.files.map(({ name, mediaKind }) => ({ name, mediaKind })), [
      { name: "movie.mkv", mediaKind: "video" },
      { name: "captions.srt", mediaKind: "subtitle" },
    ]);
    assert.equal(session.groups.length, 1);
    assert.equal(session.groups[0].confidence, "high");
    assert.equal(session.groups[0].fileIds.length, 2);
    assert.deepEqual(session.ambiguities, []);
    assert.equal(JSON.stringify(session).includes(root), false);
    assert.deepEqual(service.discardBatchSession({ sessionId: session.id }), { discarded: true });
    assert.deepEqual(service.discardBatchSession({ sessionId: session.id }), { discarded: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real ffprobe batch session derives SRT duration and keeps ambiguous matches separate", async (t) => {
  let tools;
  try {
    tools = resolveVerifiedArtifactPaths(
      JSON.parse(readFileSync(join(repoRoot, "docs/third-party/ffmpeg/manifest.json"), "utf8")),
      { artifactRootDir: join(repoRoot, "resources/ffmpeg/win32-x64") },
    );
  } catch (error) {
    t.skip(`verified ffmpeg unavailable: ${error.message}`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "phase9-real-subtitle-duration-"));
  const audioPath = join(root, "audio.wav");
  const duplicateAudioPath = join(root, "duplicate.wav");
  const subtitlePath = join(root, "captions.srt");
  try {
    await runManagedProcess({
      absoluteExe: tools.ffmpegPath,
      argv: [
        "-hide_banner", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
        "-t", "6.5", "-c:a", "pcm_s16le", audioPath,
      ],
      timeoutMs: 30_000,
    });
    copyFileSync(audioPath, duplicateAudioPath);
    copyFileSync(join(repoRoot, "tests/fixtures/subtitles/valid/basic-utf8.srt"), subtitlePath);

    const service = createMediaService({
      resolveArtifacts: () => tools,
      getProjectRepository: () => { throw new Error("batch probe must not create a project"); },
    });
    const matched = await service.createBatchSession({ filePaths: [audioPath, subtitlePath] });
    assert.equal(matched.files.find(({ mediaKind }) => mediaKind === "subtitle").probe.format.durationMs, 6_500);
    assert.deepEqual(matched.groups.map(({ confidence, fileIds }) => ({ confidence, size: fileIds.length })), [
      { confidence: "high", size: 2 },
    ]);

    const ambiguous = await service.createBatchSession({
      filePaths: [audioPath, duplicateAudioPath, subtitlePath],
    });
    assert.deepEqual(ambiguous.groups.map(({ confidence, fileIds }) => ({ confidence, size: fileIds.length })), [
      { confidence: "low", size: 1 },
      { confidence: "low", size: 1 },
      { confidence: "low", size: 1 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirmed batch creates real media projects and consumes the private session", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase9-batch-commit-"));
  const videoPath = join(root, "movie.mkv");
  const subtitlePath = join(root, "captions.srt");
  writeFileSync(videoPath, "video");
  writeFileSync(subtitlePath, "1\n00:00:00,000 --> 00:02:00,500\nhello\n");
  const persisted = [];
  const service = createMediaService({
    resolveArtifacts: () => ({ ffprobePath: join(root, "ffprobe.exe"), upstreamVersion: "test" }),
    getProjectRepository: () => { throw new Error("batch commit uses the persistence batch port"); },
    persistBatchProjects: (entries) => {
      persisted.push(...entries);
      return {
        projectIds: entries.map(({ project }) => project.id),
        projects: entries.map(({ project }) => {
          const { _internalMediaOriginalPath: _private, ...publicProject } = project;
          return publicProject;
        }),
      };
    },
    runProcess: async ({ argv }) => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(
        basename(argv.at(-1)) === "movie.mkv"
          ? {
              format: { format_name: "matroska", duration: "120", size: "5" },
              streams: [
                { index: 0, codec_type: "video", codec_name: "h264" },
                { index: 1, codec_type: "audio", codec_name: "aac" },
              ],
            }
          : {
              format: { format_name: "srt", duration: "120.5", size: "45" },
              streams: [{ index: 0, codec_type: "subtitle", codec_name: "subrip" }],
            },
      )),
    }),
  });

  try {
    const session = await service.createBatchSession({ filePaths: [videoPath, subtitlePath] });
    const result = await service.commitBatchSession({
      sessionId: session.id,
      defaults,
      groups: session.groups.map((group) => ({
        id: group.id,
        title: "Confirmed title",
        fileIds: group.fileIds,
        overrides: { targetLanguages: ["ja-JP"] },
      })),
    });
    assert.equal(result.batchId, session.id);
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].title, "Confirmed title");
    assert.deepEqual(result.projects[0].config.targetLanguages, ["ja-JP"]);
    assert.equal(result.projects[0].mediaKind, "video");
    assert.equal(result.projects[0].sourceTracks[0].kind, "external_subtitle");
    assert.equal(persisted[0].artifacts.length, 1);
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.deepEqual(service.discardBatchSession({ sessionId: session.id }), { discarded: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
