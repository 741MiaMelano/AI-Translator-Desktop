import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildExtractAudioArgv, extractAudioTrack } from "../../backend/media/extract-audio.mjs";

test("audio extraction maps one verified stream and atomically replaces the chosen WAV", async () => {
  const root = mkdtempSync(join(tmpdir(), "extract-audio-"));
  try {
    const inputPath = join(root, "source.mp4");
    const destinationPath = join(root, "source-audio.wav");
    writeFileSync(inputPath, "media");
    writeFileSync(destinationPath, "old");

    assert.deepEqual(buildExtractAudioArgv(inputPath, 2, destinationPath), [
      "-hide_banner", "-nostdin", "-y", "-i", inputPath,
      "-map", "0:2", "-vn", "-c:a", "pcm_s16le", destinationPath,
    ]);

    const result = await extractAudioTrack({
      ffmpegPath: join(root, "ffmpeg.exe"),
      inputPath,
      destinationPath,
      streamId: "s:2",
      probe: {
        streams: [
          { streamId: "s:1", index: 1, kind: "video" },
          { streamId: "s:2", index: 2, kind: "audio" },
        ],
      },
      runProcess: async ({ argv }) => writeFileSync(argv.at(-1), "new-wave"),
    });

    assert.equal(result.fileName, "source-audio.wav");
    assert.equal(result.streamId, "s:2");
    assert.equal(readFileSync(destinationPath, "utf8"), "new-wave");
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".partial.wav")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
