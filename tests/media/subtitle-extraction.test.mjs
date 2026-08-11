import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MEDIA_ERROR_CODES } from "../../backend/media/constants.mjs";
import {
  activateSourceTrack,
  attachCandidateSourceTrack,
  buildExtractArgv,
  extractEmbeddedSubtitle,
  resolveExtractableStream,
} from "../../backend/media/extract-subtitle.mjs";
import { resolveVerifiedArtifactPaths } from "../../backend/media/ffmpeg-artifact-manifest.mjs";
import { probeMediaFile } from "../../backend/media/probe.mjs";
import { runManagedProcess } from "../../backend/media/process-runner.mjs";
import { createMediaService } from "../../backend/media/media-service.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = join(repoRoot, "docs/third-party/ffmpeg/manifest.json");
const stagedRoot = join(process.env.TEMP || tmpdir(), "desktop-ai-translator-p06-t00b-minimal-v2", "staged");

const sampleProbe = {
  mediaKind: "video",
  format: { formatName: "matroska", durationMs: 1000, sizeBytes: 10 },
  streams: [
    { streamId: "s:0", index: 0, kind: "video", codec: "ffv1", language: null, title: null, default: true, forced: false, extractable: false, width: 64, height: 64, channels: null, sampleRate: null },
    { streamId: "s:1", index: 1, kind: "audio", codec: "pcm_s16le", language: "eng", title: null, default: true, forced: false, extractable: false, width: null, height: null, channels: 1, sampleRate: 44100 },
    { streamId: "s:2", index: 2, kind: "subtitle", codec: "subrip", language: "eng", title: null, default: true, forced: false, extractable: true, width: null, height: null, channels: null, sampleRate: null },
    { streamId: "s:3", index: 3, kind: "subtitle", codec: "hdmv_pgs_subtitle", language: "jpn", title: null, default: false, forced: false, extractable: false, width: null, height: null, channels: null, sampleRate: null },
  ],
  warnings: [],
  probeVersion: 1,
  artifact: { upstreamVersion: null, ffprobeSha256: null },
};

test("rejects missing bitmap and free-form stream ids", () => {
  assert.throws(() => resolveExtractableStream(sampleProbe, "s:99"), (e) => e.code === MEDIA_ERROR_CODES.NOT_FOUND);
  assert.throws(() => resolveExtractableStream(sampleProbe, "s:3"), (e) => e.code === MEDIA_ERROR_CODES.UNSUPPORTED);
  assert.throws(() => resolveExtractableStream(sampleProbe, "2"), (e) => e.code === MEDIA_ERROR_CODES.INVALID_INPUT);
  const argv = buildExtractArgv("C:\\\\in.mkv", 2, { ext: "srt", ffmpegCodec: "copy" }, "C:\\\\out.srt");
  assert.ok(argv.includes("-map"));
  assert.ok(argv.includes("0:2"));
  assert.equal(argv.at(-1), "C:\\\\out.srt");
});

test("attach keeps previous active and activate switches without moving old targets", () => {
  const project = {
    id: "p1",
    activeSourceTrackId: "old",
    sourceProjectRelativePath: "artifacts/media/source.mkv",
    sourceTracks: [
      {
        id: "old",
        isActive: true,
        segments: [{ id: "a" }],
        targetTracks: [{ id: "t-old", languageCode: "zh-CN", isActive: true }],
      },
    ],
  };
  const candidate = {
    id: "new",
    isActive: false,
    segments: [{ id: "b" }],
    targetTracks: [{ id: "t-new", languageCode: "zh-CN", isActive: true }],
  };
  const attached = attachCandidateSourceTrack(project, candidate, "artifacts/raw/new.srt");
  assert.equal(attached.activeSourceTrackId, "old");
  assert.equal(attached.sourceProjectRelativePath, "artifacts/media/source.mkv");
  assert.equal(attached.sourceTracks.length, 2);
  assert.deepEqual(
    {
      isActive: attached.sourceTracks.find((t) => t.id === "new").isActive,
      rawAssetRelativePath: attached.sourceTracks.find((t) => t.id === "new").rawAssetRelativePath,
    },
    { isActive: false, rawAssetRelativePath: "artifacts/raw/new.srt" },
  );
  const activated = activateSourceTrack(attached, "new");
  assert.equal(activated.activeSourceTrackId, "new");
  assert.equal(activated.sourceTracks.find((t) => t.id === "old").isActive, false);
  assert.equal(activated.sourceTracks.find((t) => t.id === "old").targetTracks[0].id, "t-old");
});

test("real extract from multi-track matroska creates candidate and raw asset", async (t) => {
  let resolved;
  try {
    resolved = resolveVerifiedArtifactPaths(JSON.parse(readFileSync(manifestPath, "utf8")), {
      artifactRootDir: stagedRoot,
    });
  } catch (error) {
    t.skip(`staged candidate unavailable: ${error.message}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "p06-t05-"));
  const projectDir = join(dir, "project");
  const srtPath = join(dir, "cues.srt");
  writeFileSync(
    srtPath,
    "1\n00:00:00,000 --> 00:00:00,800\nHello extract\n\n2\n00:00:00,800 --> 00:00:01,000\nSecond line\n",
    "utf8",
  );
  const mkv = join(dir, "multi 中文 &().mkv");
  const repos = new Map();
  try {
    await runManagedProcess({
      absoluteExe: resolved.ffmpegPath,
      argv: [
        "-hide_banner",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=1",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=mono",
        "-i",
        srtPath,
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_s16le",
        "-c:s",
        "srt",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "2:s:0",
        "-metadata:s:s:0",
        "language=eng",
        "-disposition:s:0",
        "default",
        "-shortest",
        mkv,
      ],
      timeoutMs: 30_000,
    });

    const probe = await probeMediaFile({
      ffprobePath: resolved.ffprobePath,
      inputPath: mkv,
    });
    const sub = probe.streams.find((s) => s.kind === "subtitle" && s.extractable);
    assert.ok(sub);

    const result = await extractEmbeddedSubtitle({
      ffmpegPath: resolved.ffmpegPath,
      inputPath: mkv,
      probe,
      streamId: sub.streamId,
      projectContainerDir: projectDir,
      targetLanguages: ["zh-CN"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.sourceTrack.isActive, false);
    assert.equal(result.sourceTrack.sourceStreamId, sub.streamId);
    assert.ok(result.sourceTrack.segments.length >= 1);
    assert.ok(existsSync(join(projectDir, ...result.rawRelativePath.split("/"))));

    await assert.rejects(
      () =>
        extractEmbeddedSubtitle({
          ffmpegPath: resolved.ffmpegPath,
          inputPath: mkv,
          probe,
          streamId: "s:999",
          projectContainerDir: projectDir,
        }),
      (error) => error.code === MEDIA_ERROR_CODES.NOT_FOUND,
    );

    const service = createMediaService({
      resolveArtifacts: () => resolved,
      openFileDialog: async () => ({ canceled: false, filePath: mkv }),
      getProjectRepository: (projectId) => {
        if (!repos.has(projectId)) {
          const containerDir = join(dir, "projects", projectId);
          const repo = openProjectRepository(containerDir);
          repos.set(projectId, { ...repo, containerDir });
        }
        return repos.get(projectId);
      },
    });
    const selected = await service.selectSource();
    const extracted = await service.extractSubtitle({ projectId: selected.project.id, streamId: sub.streamId });
    assert.equal(service.resolveMediaAbsolutePath(selected.project.id), mkv);
    assert.ok(extracted.project.sourceTracks[0].rawAssetRelativePath.startsWith("artifacts/raw/"));
  } finally {
    for (const repo of repos.values()) repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
