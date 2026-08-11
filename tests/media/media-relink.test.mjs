import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MEDIA_ERROR_CODES } from "../../backend/media/constants.mjs";
import { createMediaService } from "../../backend/media/media-service.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import { resolveVerifiedArtifactPaths } from "../../backend/media/ffmpeg-artifact-manifest.mjs";
import { runManagedProcess } from "../../backend/media/process-runner.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = join(repoRoot, "docs/third-party/ffmpeg/manifest.json");
const stagedRoot = join(process.env.TEMP || tmpdir(), "desktop-ai-translator-p06-t00b-minimal-v2", "staged");

test("missing source rejects wrong content and restores only the original media", async (t) => {
  let tools;
  try {
    tools = resolveVerifiedArtifactPaths(JSON.parse(readFileSync(manifestPath, "utf8")), {
      artifactRootDir: stagedRoot,
    });
  } catch (error) {
    t.skip(`staged candidate unavailable: ${error.message}`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "p06-t06-relink-"));
  const wav = join(root, "a.wav");
  const otherWav = join(root, "b.wav");
  await runManagedProcess({
    absoluteExe: tools.ffmpegPath,
    argv: ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1", wav],
    timeoutMs: 20_000,
  });
  await runManagedProcess({
    absoluteExe: tools.ffmpegPath,
    argv: ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "1", otherWav],
    timeoutMs: 20_000,
  });
  const fakeVideoName = join(root, "not-audio.mp4");
  writeFileSync(fakeVideoName, "not media");

  let dialogPath = wav;
  const projects = new Map();
  const service = createMediaService({
    resolveArtifacts: () => tools,
    openFileDialog: async () => ({ canceled: false, filePath: dialogPath }),
    getProjectRepository: (projectId, { create } = {}) => {
      if (!projects.has(projectId)) {
        if (!create) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
        const containerDir = join(root, "projects", projectId);
        const repo = openProjectRepository(containerDir);
        projects.set(projectId, { ...repo, containerDir });
      }
      return projects.get(projectId);
    },
  });

  const created = await service.selectSource({ copyIntoProject: false });
  const projectId = created.project.id;
  const moved = join(root, "moved.wav");
  renameSync(wav, moved);
  const missing = service.markMissingIfNeeded(projectId);
  assert.equal(missing.mediaSource.availability, "missing");
  assert.equal(missing.sourceTracks.length, 0);

  dialogPath = fakeVideoName;
  await assert.rejects(() => service.relink({ projectId }), (e) => {
    return e.code === MEDIA_ERROR_CODES.CORRUPT_INPUT || e.code === MEDIA_ERROR_CODES.UNSUPPORTED || e.code === MEDIA_ERROR_CODES.INVALID_INPUT;
  });
  const afterBad = projects.get(projectId).loadProject();
  assert.equal(afterBad.mediaSource.availability, "missing");

  dialogPath = otherWav;
  await assert.rejects(
    () => service.relink({ projectId }),
    (error) => error.code === MEDIA_ERROR_CODES.CONFLICT,
  );
  assert.equal(projects.get(projectId).loadProject().mediaSource.availability, "missing");

  dialogPath = moved;
  const restored = await service.relink({ projectId });
  assert.equal(restored.project.mediaSource.availability, "available");
  assert.ok(restored.project.sourceProbeSummary.media.mediaKind === "audio");

  const copied = await service.selectSource({ copyIntoProject: true });
  const copiedRepo = projects.get(copied.project.id);
  const oldCopy = copiedRepo.getPrimaryMediaInternal().projectRelativePath;
  rmSync(join(copiedRepo.containerDir, ...oldCopy.split("/")), { force: true });
  assert.equal(service.markMissingIfNeeded(copied.project.id).mediaSource.availability, "missing");
  const relinkedCopy = await service.relink({ projectId: copied.project.id });
  const newCopy = copiedRepo.getPrimaryMediaInternal().projectRelativePath;
  assert.ok(newCopy.startsWith("artifacts/media/"));
  assert.equal(relinkedCopy.project.mediaSource.availability, "available");
  assert.ok(service.resolveMediaAbsolutePath(copied.project.id));

  for (const entry of projects.values()) entry.close();
  rmSync(root, { recursive: true, force: true });
});
