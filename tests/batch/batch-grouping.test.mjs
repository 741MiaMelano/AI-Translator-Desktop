import assert from "node:assert/strict";
import test from "node:test";

import { planBatchGroups, suggestBatchGroups } from "../../shared/batch-grouping.mjs";

function file(id, name, mediaKind, durationMs) {
  return { id, name, probe: { mediaKind, format: { durationMs } } };
}

test("real probe duration groups only an unambiguous media/subtitle match", () => {
  const video = file("video", "unrelated-title.mkv", "video", 120_000);
  const subtitle = file("subtitle", "different-name.srt", "subtitle", 120_500);

  assert.deepEqual(suggestBatchGroups([video, subtitle]), [
    { confidence: "high", fileIds: ["video", "subtitle"] },
  ]);
  assert.deepEqual(suggestBatchGroups([subtitle, video]), [
    { confidence: "high", fileIds: ["video", "subtitle"] },
  ]);

  const ambiguousVideo = file("other-video", "another.mkv", "video", 120_400);
  assert.deepEqual(suggestBatchGroups([video, ambiguousVideo, subtitle]), [
    { confidence: "low", fileIds: ["video"] },
    { confidence: "low", fileIds: ["other-video"] },
    { confidence: "low", fileIds: ["subtitle"] },
  ]);
});

test("batch plan reports only the subtitle whose media match needs confirmation", () => {
  const firstVideo = file("video-1", "episode-a.mp4", "video", 120_000);
  const secondVideo = file("video-2", "episode-b.mp4", "video", 120_500);
  const ambiguousSubtitle = file("subtitle", "captions.srt", "subtitle", 120_300);
  const unrelatedSubtitle = file("standalone", "notes.srt", "subtitle", 30_000);

  assert.deepEqual(
    planBatchGroups([firstVideo, secondVideo, ambiguousSubtitle, unrelatedSubtitle]),
    {
      groups: [
        { confidence: "low", fileIds: ["video-1"] },
        { confidence: "low", fileIds: ["video-2"] },
        { confidence: "low", fileIds: ["subtitle"] },
        { confidence: "low", fileIds: ["standalone"] },
      ],
      ambiguities: [{
        kind: "media_match",
        fileId: "subtitle",
        candidateMediaFileIds: ["video-1", "video-2"],
      }],
    },
  );
});
