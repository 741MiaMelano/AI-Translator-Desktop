import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMediaService } from "../../backend/media/media-service.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";

test("stream confirmation is partial and survives a project reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "stream-confirmation-"));
  let repo = openProjectRepository(root);
  const project = {
    id: "stream-confirmation-project",
    title: "Streams",
    sourceFileName: "fixture.mkv",
    mediaKind: "video",
    noSourceMedia: false,
    lifecycle: "draft",
    createdAt: "2026-07-29 10:00",
    updatedAt: "2026-07-29 10:00",
    activeSourceTrackId: null,
    pendingConfirmations: ["confirm subtitle stream selection"],
    notes: [],
    config: {
      sourceLanguage: "auto",
      targetLanguages: ["zh-CN"],
      provider: "DeepSeek",
      model: "deepseek-v4-flash",
      glossary: "default",
      styleGuide: "default",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [],
    recentRunIds: [],
    sourceProbeSummary: { media: { streams: [
      { streamId: "s:0", kind: "audio" },
      { streamId: "s:1", kind: "audio" },
      { streamId: "s:2", kind: "subtitle" },
      { streamId: "s:3", kind: "subtitle" },
    ] } },
    mediaSource: {
      assetId: "primary",
      displayName: "fixture.mkv",
      availability: "available",
      identity: null,
      selectedAudioStreamId: "s:0",
      selectedSubtitleStreamId: "s:2",
      confirmedAudioStreamId: null,
      confirmedSubtitleStreamId: null,
    },
  };
  try {
    repo.saveProject(project);
    const service = createMediaService({ getProjectRepository: () => repo });
    const audio = service.selectStreams({ projectId: project.id, audioStreamId: "s:1" }).project;
    assert.equal(audio.mediaSource.confirmedAudioStreamId, "s:1");
    assert.equal(audio.mediaSource.selectedSubtitleStreamId, "s:2");
    assert.equal(audio.mediaSource.confirmedSubtitleStreamId, null);

    service.selectStreams({ projectId: project.id, subtitleStreamId: "s:3" });
    repo.close();
    repo = openProjectRepository(root);
    const reopened = repo.loadProject();
    assert.equal(reopened.mediaSource.confirmedAudioStreamId, "s:1");
    assert.equal(reopened.mediaSource.confirmedSubtitleStreamId, "s:3");
    assert.deepEqual(reopened.pendingConfirmations, []);
  } finally {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});
