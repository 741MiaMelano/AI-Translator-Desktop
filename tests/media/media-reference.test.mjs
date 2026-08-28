import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { MEDIA_ERROR_CODES } from "../../backend/media/constants.mjs";
import { createMediaService } from "../../backend/media/media-service.mjs";
import { openProjectRepository } from "../../backend/persistence/project-repository.mjs";
import { resolveVerifiedArtifactPaths } from "../../backend/media/ffmpeg-artifact-manifest.mjs";
import { runManagedProcess } from "../../backend/media/process-runner.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = join(repoRoot, "docs/third-party/ffmpeg/manifest.json");
const stagedRoot = join(process.env.TEMP || tmpdir(), "desktop-ai-translator-p06-t00b-minimal-v2", "staged");

test("dialog cancel does not create project; unsafe paths rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "p06-t06-ref-"));
  const service = createMediaService({
    resolveArtifacts: () => {
      throw Object.assign(new Error("na"), { code: "not_available" });
    },
    getProjectRepository: () => {
      throw new Error("should not open repo");
    },
    openFileDialog: async () => ({ canceled: true }),
  });
  await assert.rejects(() => service.selectSource({}), (e) => e.code === MEDIA_ERROR_CODES.CANCELLED);

  assert.throws(() => service.assertSafeMediaFile(root), (e) => e.code === MEDIA_ERROR_CODES.INVALID_INPUT);
  rmSync(root, { recursive: true, force: true });
});

test("media service routes process work and cancellation through the injected worker boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "p06-worker-boundary-"));
  const mediaPath = join(root, "clip.mkv");
  writeFileSync(mediaPath, "fixture");
  const calls = [];
  const repos = new Map();
  const service = createMediaService({
    resolveArtifacts: () => ({
      ffprobePath: join(root, "ffprobe.exe"),
      ffmpegPath: join(root, "ffmpeg.exe"),
      upstreamVersion: "test",
    }),
    openFileDialog: async () => ({ canceled: false, filePath: mediaPath }),
    getProjectRepository: (projectId) => {
      if (!repos.has(projectId)) {
        const containerDir = join(root, "projects", projectId);
        const repo = openProjectRepository(containerDir);
        repos.set(projectId, { ...repo, containerDir });
      }
      return repos.get(projectId);
    },
    runProcess: async (payload) => {
      calls.push(payload);
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({
          format: { format_name: "matroska", duration: "1", size: "7" },
          streams: [{ index: 0, codec_type: "video", codec_name: "ffv1", width: 64, height: 64 }],
        })),
        stdoutBytes: 1,
        stderrSummary: "",
      };
    },
    cancelProcess: async (operationId) => ({ cancelled: operationId === "op-probe" }),
  });
  try {
    await service.selectSource({ operationId: "op-probe" });
    assert.equal(calls[0].operationId, "op-probe");
    assert.deepEqual(await service.cancelOperation({ operationId: "op-probe" }), { cancelled: true });
  } finally {
    for (const repo of repos.values()) repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reference import probes without copying; copy mode stores project-relative media", async (t) => {
  let tools;
  try {
    tools = resolveVerifiedArtifactPaths(JSON.parse(readFileSync(manifestPath, "utf8")), {
      artifactRootDir: stagedRoot,
    });
  } catch (error) {
    t.skip(`staged candidate unavailable: ${error.message}`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "p06-t06-import-"));
  const mediaDir = join(root, "media 中文 &()");
  mkdirSync(mediaDir, { recursive: true });
  const wav = join(mediaDir, "tone.wav");
  await runManagedProcess({
    absoluteExe: tools.ffmpegPath,
    argv: ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1", wav],
    timeoutMs: 20_000,
  });

  const projects = new Map();
  const service = createMediaService({
    resolveArtifacts: () => tools,
    openFileDialog: async () => ({ canceled: false, filePath: wav }),
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

  const referenced = await service.selectSource({ copyIntoProject: false });
  assert.equal(referenced.project.noSourceMedia, false);
  assert.equal(referenced.project.activeSourceTrackId, null);
  assert.equal(referenced.project.sourceTracks.length, 0);
  assert.equal(referenced.project.mediaSource.availability, "available");
  assert.ok(!JSON.stringify(referenced.project).includes(wav.replaceAll("\\", "\\\\")));
  assert.ok(!String(JSON.stringify(referenced.project)).includes("Users"));

  const copied = await service.selectSource({ copyIntoProject: true });
  assert.ok(copied.project.sourceProjectRelativePath?.startsWith("artifacts/media/"));
  const copyRepo = projects.get(copied.project.id);
  assert.ok(existsSync(join(copyRepo.containerDir, ...copied.project.sourceProjectRelativePath.split("/"))));

  for (const entry of projects.values()) entry.close();
  rmSync(root, { recursive: true, force: true });
});
