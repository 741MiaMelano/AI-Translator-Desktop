import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MEDIA_ERROR_CODES } from "../../backend/media/constants.mjs";
import { buildFfprobeArgv, parseFfprobeStdout, probeMediaFile } from "../../backend/media/probe.mjs";
import { normalizeMediaProbe } from "../../shared/media-probe.mjs";
import { resolveVerifiedArtifactPaths } from "../../backend/media/ffmpeg-artifact-manifest.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = join(repoRoot, "docs/third-party/ffmpeg/manifest.json");
const stagedRoot = join(process.env.TEMP || tmpdir(), "desktop-ai-translator-p06-t00b-minimal-v2", "staged");

function syntheticProbe(overrides = {}) {
  return {
    format: { format_name: "matroska,webm", duration: "1.0", size: "1234", ...overrides.format },
    streams: overrides.streams ?? [
      {
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 320,
        height: 240,
        disposition: { default: 1 },
        tags: { language: "und" },
      },
      {
        index: 1,
        codec_type: "audio",
        codec_name: "aac",
        channels: 2,
        sample_rate: "48000",
        disposition: { default: 1 },
        tags: { language: "eng" },
      },
    ],
  };
}

test("extension-looking mp4 that is only subtitle streams is classified subtitle", () => {
  const probe = normalizeMediaProbe(
    syntheticProbe({
      format: { format_name: "srt", duration: null, size: "20" },
      streams: [{ index: 0, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } }],
    }),
  );
  assert.equal(probe.mediaKind, "subtitle");
  assert.equal(probe.format.durationMs, null);
  assert.ok(probe.warnings.some((w) => w.code === "MISSING_DURATION"));
});

test("missing extension real video/audio classification follows streams", () => {
  const video = normalizeMediaProbe(
    syntheticProbe({
      streams: [{ index: 0, codec_type: "video", codec_name: "ffv1", width: 64, height: 64 }],
    }),
  );
  assert.equal(video.mediaKind, "video");
  const audio = normalizeMediaProbe({
    format: { format_name: "wav", duration: "1.5", size: "100" },
    streams: [{ index: 0, codec_type: "audio", codec_name: "pcm_s16le", channels: 1, sample_rate: "44100" }],
  });
  assert.equal(audio.mediaKind, "audio");
  assert.equal(audio.format.durationMs, 1500);
});

test("malformed JSON shape errors non-finite values and oversize fail closed", () => {
  assert.throws(() => parseFfprobeStdout("{"), (error) => error.code === MEDIA_ERROR_CODES.CORRUPT_INPUT);
  assert.throws(() => normalizeMediaProbe([]), (error) => error.code === MEDIA_ERROR_CODES.CORRUPT_INPUT);
  assert.throws(
    () => normalizeMediaProbe({ format: {}, streams: { not: "array" } }),
    (error) => error.code === MEDIA_ERROR_CODES.CORRUPT_INPUT,
  );
  assert.throws(
    () =>
      normalizeMediaProbe({
        format: { duration: Infinity, size: 1 },
        streams: [{ index: 0, codec_type: "audio", codec_name: "aac" }],
      }),
    (error) => error.code === MEDIA_ERROR_CODES.INVALID_INPUT,
  );
  const huge = Buffer.alloc(4 * 1024 * 1024 + 1, 0x30);
  assert.throws(() => parseFfprobeStdout(huge), (error) => error.code === MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE);
});

test("raw ffprobe fields and internal paths never enter contract", () => {
  const probe = normalizeMediaProbe(syntheticProbe());
  const json = JSON.stringify(probe);
  assert.ok(!json.includes("codec_type"));
  assert.ok(!json.includes("disposition"));
  assert.ok(!("tags" in probe.streams[0]));
  assert.equal(probe.streams[0].streamId, "s:0");
  assert.equal(probe.streams[0].language, null);
  assert.equal(probe.streams[1].language, "eng");
});

test("bitmap subtitle is not extractable; text subtitle is", () => {
  const probe = normalizeMediaProbe({
    format: { format_name: "matroska", duration: "1", size: "10" },
    streams: [
      { index: 0, codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle", tags: { language: "jpn" } },
      { index: 1, codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } },
    ],
  });
  assert.equal(probe.streams[0].extractable, false);
  assert.equal(probe.streams[1].extractable, true);
  const captions = normalizeMediaProbe({
    format: {},
    streams: [{ index: 2, codec_type: "subtitle", codec_name: "eia_608" }],
  });
  assert.equal(captions.streams[0].extractable, false);
});

test("buildFfprobeArgv keeps input last and rejects protocol URLs", () => {
  const argv = buildFfprobeArgv("C:\\\\media\\\\a b.mkv");
  assert.equal(argv.at(-1), "C:\\\\media\\\\a b.mkv");
  assert.ok(argv.includes("-print_format"));
  assert.throws(() => buildFfprobeArgv("https://example.com/a.mp4"), (error) => {
    assert.equal(error.code, MEDIA_ERROR_CODES.INVALID_INPUT);
    return true;
  });
});

test("probeMediaFile maps process failures to stable codes without leaking stderr", async () => {
  await assert.rejects(
    () =>
      probeMediaFile({
        ffprobePath: process.execPath,
        inputPath: "C:\\\\media\\\\x.mp4",
        runProcess: async () => {
          const error = new Error("fail path=C:\\\\Users\\\\secret\\\\x.mp4");
          error.code = MEDIA_ERROR_CODES.PROCESS_FAILED;
          throw error;
        },
      }),
    (error) => {
      assert.equal(error.code, MEDIA_ERROR_CODES.CORRUPT_INPUT);
      assert.ok(!String(error.message).includes("Users\\\\secret"));
      return true;
    },
  );
});

test("real staged ffprobe smoke classifies generated sample when candidate is present", async (t) => {
  let resolved;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    resolved = resolveVerifiedArtifactPaths(raw, { artifactRootDir: stagedRoot });
  } catch (error) {
    t.skip(`staged candidate unavailable: ${error.message}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "p06-t02-smoke-"));
  const sample = join(dir, "sample no-ext");
  const { runManagedProcess } = await import("../../backend/media/process-runner.mjs");
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
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_s16le",
        "-shortest",
        join(dir, "sample.mkv"),
      ],
      timeoutMs: 30_000,
    });
    copyFileSync(join(dir, "sample.mkv"), sample);
    const fakeExt = join(dir, "not-video.srt");
    copyFileSync(sample, fakeExt);

    const probe = await probeMediaFile({
      ffprobePath: resolved.ffprobePath,
      inputPath: sample,
      upstreamVersion: resolved.upstreamVersion,
    });
    assert.equal(probe.mediaKind, "video");
    assert.ok(probe.streams.some((s) => s.kind === "video"));
    assert.ok(probe.streams.some((s) => s.kind === "audio"));

    const misnamed = await probeMediaFile({
      ffprobePath: resolved.ffprobePath,
      inputPath: fakeExt,
    });
    assert.equal(misnamed.mediaKind, "video");

    const corrupt = join(dir, "corrupt.mp4");
    writeFileSync(corrupt, Buffer.from("not a media file"));
    await assert.rejects(
      () => probeMediaFile({ ffprobePath: resolved.ffprobePath, inputPath: corrupt }),
      (error) =>
        error.code === MEDIA_ERROR_CODES.CORRUPT_INPUT || error.code === MEDIA_ERROR_CODES.PROCESS_FAILED,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
