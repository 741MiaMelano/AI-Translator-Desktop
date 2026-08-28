import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildAssBurnArgv,
  buildSoftSubtitleMuxArgv,
  runSubtitleVideoExport,
} from "../../backend/export/media-export.mjs";
import { resolveVerifiedArtifactPaths } from "../../backend/media/ffmpeg-artifact-manifest.mjs";
import { runManagedProcess } from "../../backend/media/process-runner.mjs";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("soft subtitle mux copies media streams, adds one selectable subtitle, and never targets source", () => {
  const argv = buildSoftSubtitleMuxArgv({
    mediaPath: "C:\\media\\source.mp4",
    subtitlePath: "C:\\exports\\zh-CN.ass",
    outputPath: "C:\\exports\\source-zh-CN-soft.mkv",
    languageCode: "zh-CN",
  });
  assert.deepEqual(argv.slice(0, 6), ["-hide_banner", "-nostdin", "-n", "-i", "C:\\media\\source.mp4", "-i"]);
  assert.ok(argv.includes("-c"));
  assert.ok(argv.includes("copy"));
  assert.ok(argv.includes("-c:s"));
  assert.ok(argv.includes("ass"));
  assert.ok(argv.includes("language=zh-CN"));
  assert.equal(argv.at(-1), "C:\\exports\\source-zh-CN-soft.mkv");
  assert.throws(
    () => buildSoftSubtitleMuxArgv({
      mediaPath: "C:\\media\\same.mkv",
      subtitlePath: "C:\\exports\\x.ass",
      outputPath: "C:\\media\\same.mkv",
      languageCode: "zh-CN",
    }),
    /different|source/i,
  );
});

test("ASS burn escapes a Windows filter path and re-encodes video while copying audio", () => {
  const argv = buildAssBurnArgv({
    mediaPath: "C:\\media\\source.mp4",
    subtitlePath: "C:\\exports\\中 文's.ass",
    outputPath: "C:\\exports\\source-zh-CN-burned.mkv",
  });
  const filter = argv[argv.indexOf("-vf") + 1];
  assert.match(filter, /^ass=filename='/);
  assert.match(filter, /C\\:\/exports\/中 文\\'s\.ass/);
  assert.equal(argv[argv.indexOf("-c:v") + 1], "mpeg4");
  assert.equal(argv[argv.indexOf("-c:a") + 1], "copy");
});

test("runner reports one failed video without deleting an independent subtitle result", async () => {
  const subtitleResult = { fileName: "zh-CN.ass", ok: true };
  await assert.rejects(
    () => runSubtitleVideoExport({
      mode: "burn_ass",
      ffmpegPath: "C:\\managed\\ffmpeg.exe",
      mediaPath: "C:\\media\\source.mp4",
      subtitlePath: "C:\\exports\\zh-CN.ass",
      outputPath: "C:\\exports\\burned.mkv",
      runProcess: async () => { throw Object.assign(new Error("encoder failed"), { code: "PROCESS_FAILED" }); },
    }),
    (error) => error.code === "PROCESS_FAILED",
  );
  assert.deepEqual(subtitleResult, { fileName: "zh-CN.ass", ok: true });
});

test("real managed runtime produces selectable soft subtitles and an ASS-burned frame", async () => {
  const manifest = JSON.parse(readFileSync(resolve("docs/third-party/ffmpeg/manifest.json"), "utf8"));
  const tools = resolveVerifiedArtifactPaths(manifest, {
    artifactRootDir: resolve("resources/ffmpeg/win32-x64"),
  });
  const dir = mkdtempSync(join(tmpdir(), "phase11-media-export-"));
  const mediaPath = join(dir, "source.mkv");
  const subtitlePath = resolve("tests/fixtures/subtitles/valid/basic.ass");
  const softPath = join(dir, "soft.mkv");
  const burnedPath = join(dir, "burned.mkv");
  try {
    await runManagedProcess({
      absoluteExe: tools.ffmpegPath,
      argv: [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc=size=160x90:rate=5",
        "-t", "2", "-c:v", "mpeg4", mediaPath,
      ],
      timeoutMs: 30_000,
    });
    const before = sha256(mediaPath);
    await runSubtitleVideoExport({
      mode: "soft_subtitle",
      ffmpegPath: tools.ffmpegPath,
      mediaPath,
      subtitlePath,
      outputPath: softPath,
      languageCode: "zh-CN",
      runProcess: runManagedProcess,
    });
    await runSubtitleVideoExport({
      mode: "burn_ass",
      ffmpegPath: tools.ffmpegPath,
      mediaPath,
      subtitlePath,
      outputPath: burnedPath,
      languageCode: "zh-CN",
      runProcess: runManagedProcess,
    });
    assert.equal(sha256(mediaPath), before);
    assert.equal(existsSync(softPath), true);
    assert.equal(existsSync(burnedPath), true);

    const probe = await runManagedProcess({
      absoluteExe: tools.ffprobePath,
      argv: ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", softPath],
      timeoutMs: 10_000,
    });
    const streams = JSON.parse(probe.stdout.toString("utf8")).streams;
    assert.ok(streams.some((stream) => stream.codec_type === "subtitle" && stream.codec_name === "ass"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
