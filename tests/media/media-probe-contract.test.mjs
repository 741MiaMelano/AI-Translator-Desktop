import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import { normalizeMediaProbe, validateMediaProbe } from "../../shared/media-probe.mjs";
import { validateIpcEnvelope } from "../../electron/ipc/validate.mjs";

function baseProject(overrides = {}) {
  return {
    id: "proj_media_draft_1",
    title: "Media draft",
    sourceFileName: "clip.mkv",
    mediaKind: "video",
    noSourceMedia: false,
    lifecycle: "draft",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    activeSourceTrackId: null,
    pendingConfirmations: [],
    notes: [],
    recentRunIds: [],
    config: {
      sourceLanguage: "auto",
      targetLanguages: ["zh-CN"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "none",
      styleGuide: "none",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [],
    mediaSource: {
      assetId: "primary",
      displayName: "clip.mkv",
      availability: "available",
      identity: { sizeBytes: 1000, mtimeMs: 1_700_000_000_000, fingerprint: "abc" },
      selectedAudioStreamId: "s:1",
      selectedSubtitleStreamId: null,
    },
    sourceProbeSummary: {
      media: normalizeMediaProbe({
        format: { format_name: "matroska", duration: "1", size: "1000" },
        streams: [
          { index: 0, codec_type: "video", codec_name: "ffv1", width: 64, height: 64 },
          { index: 1, codec_type: "audio", codec_name: "pcm_s16le", channels: 1, sample_rate: "44100", tags: { language: "eng" } },
        ],
      }),
    },
    ...overrides,
  };
}

function subtitleProject() {
  return {
    ...baseProject({
      id: "proj_sub_only_1",
      title: "Subtitle only",
      sourceFileName: "a.srt",
      mediaKind: "subtitle",
      noSourceMedia: true,
      activeSourceTrackId: "source-1",
      mediaSource: null,
      sourceProbeSummary: { subtitleFormat: "srt", encoding: "utf-8" },
      sourceTracks: [
        {
          id: "source-1",
          label: "Main",
          kind: "external_subtitle",
          languageState: "pending",
          defaultLanguage: "auto",
          isActive: true,
          summary: "1 cue",
          segments: [
            {
              id: "seg-1",
              start: "00:00:00,000",
              end: "00:00:01,000",
              sourceLanguage: "auto",
              sourceText: { original: "Hello", normalized: "Hello" },
              targetTexts: {
                "zh-CN": { model: "", postProcessed: "", qaFlags: [] },
              },
            },
          ],
          targetTracks: [
            {
              id: "target-zh",
              languageCode: "zh-CN",
              languageLabel: "简体中文",
              status: "draft",
              isActive: true,
              deliveryLabel: "草稿",
              lastHumanAction: "created",
              snapshotIds: [],
              qaIssues: [],
            },
          ],
        },
      ],
    }),
  };
}

test("media probe contract rejects raw ffprobe fields and oversize stream lists", () => {
  const probe = normalizeMediaProbe({
    format: { format_name: "mp4", duration: "2", size: "10" },
    streams: [{ index: 0, codec_type: "audio", codec_name: "aac", tags: { language: "und", extra: "nope" } }],
  });
  validateMediaProbe(probe);
  assert.equal(probe.streams[0].language, null);
  assert.throws(() => validateMediaProbe({ ...probe, streams: [{ ...probe.streams[0], tags: { a: 1 } }] }));
});

test("media draft with empty sourceTracks and null active round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "p06-t03-draft-"));
  const repo = openProjectRepository(dir);
  try {
    const project = baseProject();
    const validated = validateIpcEnvelope({ method: "project.save", request: { project } });
    assert.equal(validated.ok, true, validated.error?.message);
    repo.saveProject(project);
    const loaded = repo.loadProject();
    assert.equal(loaded.activeSourceTrackId, null);
    assert.deepEqual(loaded.sourceTracks, []);
    assert.equal(loaded.mediaSource.assetId, "primary");
    assert.equal(loaded.mediaSource.selectedAudioStreamId, "s:1");
    assert.equal(loaded.sourceProbeSummary.media.mediaKind, "video");
    assert.ok(!JSON.stringify(loaded).includes("original_path"));
    assert.ok(!JSON.stringify(loaded).includes("C:\\\\"));
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media draft may persist an inactive extracted candidate before activation", () => {
  const candidate = {
    ...subtitleProject().sourceTracks[0],
    id: "source-candidate-1",
    kind: "embedded_subtitle",
    isActive: false,
    rawAssetRelativePath: "artifacts/raw/source-candidate-1.srt",
    sourceStreamId: "s:2",
  };
  const project = baseProject({ sourceTracks: [candidate] });
  const validated = validateIpcEnvelope({ method: "project.save", request: { project } });
  assert.equal(validated.ok, true, validated.error?.message);
  const dir = mkdtempSync(join(tmpdir(), "p06-candidate-raw-"));
  const repo = openProjectRepository(dir);
  try {
    repo.saveProject(project);
    const loaded = repo.loadProject();
    assert.equal(loaded.sourceTracks[0].rawAssetRelativePath, "artifacts/raw/source-candidate-1.srt");
    assert.equal(loaded.sourceTracks[0].sourceStreamId, "s:2");
    assert.equal(repo.getPrimaryMediaInternal().projectRelativePath, null);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const invalidOrigin = baseProject({
    sourceTracks: [{ ...candidate, sourceStreamId: "../../outside" }],
  });
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project: invalidOrigin } }).ok, false);
});

test("empty tracks without media source and no-source-media misuse are rejected", () => {
  const missingMedia = baseProject({ mediaSource: null });
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project: missingMedia } }).ok, false);

  const noSource = baseProject({ noSourceMedia: true });
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project: noSource } }).ok, false);

  const wrongActive = baseProject({ activeSourceTrackId: "ghost" });
  assert.equal(validateIpcEnvelope({ method: "project.save", request: { project: wrongActive } }).ok, false);
});

test("subtitle-only project still requires real source track and survives v6", () => {
  const dir = mkdtempSync(join(tmpdir(), "p06-t03-sub-"));
  const repo = openProjectRepository(dir);
  try {
    const project = subtitleProject();
    assert.equal(validateIpcEnvelope({ method: "project.save", request: { project } }).ok, true);
    repo.saveProject(project);
    const loaded = repo.loadProject();
    assert.equal(loaded.activeSourceTrackId, "source-1");
    assert.equal(loaded.sourceTracks.length, 1);
    assert.equal(loaded.noSourceMedia, true);
    const internal = repo.getPrimaryMediaInternal();
    assert.equal(internal.originalPath, null);
    repo.updatePrimaryMediaInternal({
      originalPath: "C:\\\\Users\\\\secret\\\\clip.mkv",
      relinkState: "available",
      identity: { sizeBytes: 9, mtimeMs: 1, fingerprint: "f" },
    });
    const again = repo.loadProject();
    assert.ok(!JSON.stringify(again).includes("Users\\\\secret"));
    assert.equal(repo.getPrimaryMediaInternal().originalPath, "C:\\\\Users\\\\secret\\\\clip.mkv");
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary save preserves internal path identity selected streams and probe", () => {
  const dir = mkdtempSync(join(tmpdir(), "p06-t03-preserve-"));
  const repo = openProjectRepository(dir);
  try {
    const project = baseProject();
    project._internalMediaOriginalPath = "D:\\\\media\\\\中文 &().mkv";
    repo.saveProject(project);
    const mutated = repo.loadProject();
    mutated.title = "Renamed";
    delete mutated._internalMediaOriginalPath;
    repo.saveProject(mutated);
    const internal = repo.getPrimaryMediaInternal();
    assert.equal(internal.originalPath, "D:\\\\media\\\\中文 &().mkv");
    assert.equal(internal.selectedAudioStreamId, "s:1");
    assert.equal(internal.identity.sizeBytes, 1000);
    assert.equal(internal.probeSummary.media.mediaKind, "video");
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
