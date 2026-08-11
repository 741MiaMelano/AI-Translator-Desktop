import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { openDesktopPersistencePort } from "../backend/persistence/desktop-persistence-port.mjs";

const project = {
  id: "project-ipc-test",
  title: "IPC persistence smoke",
  sourceFileName: "clip.mp4",
  mediaKind: "video",
  noSourceMedia: false,
  lifecycle: "draft",
  createdAt: "2026-07-09 16:00",
  updatedAt: "2026-07-09 16:00",
  activeSourceTrackId: "source-ipc-test",
  pendingConfirmations: [],
  notes: [],
  config: {
    sourceLanguage: "auto",
    targetLanguages: ["zh-CN"],
    provider: "OpenAI",
    model: "GPT-4.1",
    glossary: "glossary-snapshot-1",
    styleGuide: "style-snapshot-1",
    outputFormat: "SRT",
    burnVideo: false,
    copyMediaIntoProject: false,
  },
  sourceTracks: [
    {
      id: "source-ipc-test",
      label: "Main source",
      kind: "embedded_subtitle",
      languageState: "pending",
      defaultLanguage: "auto",
      isActive: true,
      summary: "source track",
      segments: [
        {
          id: "segment-ipc-1",
          start: "00:00:01,000",
          end: "00:00:03,000",
          sourceLanguage: "auto",
          sourceText: {
            original: "hello",
            normalized: "hello",
          },
          targetTexts: {
            "zh-CN": {
              model: "ni hao",
              postProcessed: "ni hao",
              qaFlags: [],
            },
          },
        },
      ],
      targetTracks: [
        {
          id: "target-ipc-zh",
          languageCode: "zh-CN",
          languageLabel: "Simplified Chinese",
          status: "draft",
          isActive: true,
          qaIssues: [],
          snapshotIds: [],
          deliveryLabel: "not started",
          lastHumanAction: "waiting",
        },
      ],
    },
  ],
  recentRunIds: [],
};

const rootDir = mkdtempSync(join(tmpdir(), "translator-desktop-"));
const appDir = join(rootDir, "app");
const projectsDir = join(rootDir, "projects");
const absoluteEscapeId = resolve(rootDir, "absolute-escape");

let port;

try {
  port = openDesktopPersistencePort({ appDir, projectsDir });
  const glossary = port.saveResource({
    id: project.config.glossary,
    kind: "glossary",
    name: "Project glossary",
    description: "",
    payload: {
      languagePairs: [{
        sourceLanguageCode: "en-US",
        targetLanguageCode: "zh-CN",
        entries: [{ id: "term-1", source: "hello", target: "你好", enabled: true }],
      }],
    },
  });
  port.saveResource({
    id: project.config.styleGuide,
    kind: "style_guide",
    name: "Project style",
    description: "",
    payload: {
      targetLanguageCode: "zh-CN",
      tags: [],
      scenes: [],
      rules: [{ id: "rule-1", title: "Tone", instruction: "Use concise wording", enabled: true }],
    },
  });
  const created = port.createProject(project);
  const containerPath = resolve(projectsDir, project.id);

  assert.deepEqual(created, {
    projectId: project.id,
    containerPath,
  });
  assert.equal(resolve(dirname(created.containerPath)), resolve(projectsDir));
  assert.equal(relative(resolve(projectsDir), resolve(created.containerPath)), project.id);
  assert.notEqual(resolve(created.containerPath), resolve(projectsDir));
  assert.ok(existsSync(join(appDir, "app.sqlite")), "app.sqlite is created");
  assert.ok(existsSync(join(containerPath, "project.sqlite")), "project.sqlite is created");
  assert.deepEqual(port.openProject(project.id), project);
  const initialResourceSnapshots = port.listProjectResourceSnapshots(project.id);
  assert.equal(initialResourceSnapshots.length, 2);
  assert.deepEqual(
    initialResourceSnapshots.sort((left, right) => left.kind.localeCompare(right.kind)).map((snapshot) => snapshot.source),
    [
      { kind: "global", resourceId: project.config.glossary, revision: 1 },
      { kind: "global", resourceId: project.config.styleGuide, revision: 1 },
    ],
  );
  assert.deepEqual(port.listRecentProjects(), [
    {
      id: project.id,
      title: project.title,
      containerPath,
      sourceFileName: project.sourceFileName,
      mediaKind: project.mediaKind,
      lifecycle: project.lifecycle,
      updatedAt: project.updatedAt,
      latestRunSummary: "",
    },
  ]);

  const updatedProject = {
    ...project,
    title: "IPC persistence smoke updated",
    lifecycle: "needs_review",
    updatedAt: "2026-07-09 16:30",
    recentRunIds: ["run-ipc-1"],
  };
  port.saveProject(updatedProject);

  const glossaryRevision2 = port.saveResource(
    { ...glossary, description: "Changed after project creation" },
    { expectedRevision: 1 },
  );
  assert.equal(port.listProjectResourceSnapshots(project.id).length, 2, "ordinary saves must not auto-sync resources");
  const refreshed = port.refreshProjectResourceSnapshot({
    projectId: project.id,
    resourceId: glossary.id,
  });
  assert.equal(refreshed.source.revision, glossaryRevision2.revision);
  assert.equal(port.listProjectResourceSnapshots(project.id).length, 3);

  assert.deepEqual(port.openProject(project.id), updatedProject);
  assert.equal(port.listRecentProjects()[0].latestRunSummary, "run-ipc-1");

  const asrDeviceState = {
    requestedDevice: "auto",
    allowCudaFallback: false,
    actualDevice: "cpu",
    actualRuntimeId: "whisper-cpp-cpu-x64",
    actualRuntimeVersion: "1.9.1",
    fallbackReason: "cuda_not_ready",
    detection: {
      cpu: { status: "available", runtimeId: "whisper-cpp-cpu-x64", runtimeVersion: "1.9.1" },
      cuda: { status: "unavailable", runtimeId: "whisper-cpp-cuda-12.4-x64", runtimeVersion: "1.9.1", reason: "runtime_not_ready" },
    },
    updatedAt: "2026-07-19T20:00:00.000Z",
  };
  port.saveAsrDeviceState(asrDeviceState);
  assert.deepEqual(port.loadAsrDeviceState(), asrDeviceState);

  const backgroundProjection = {
    ...updatedProject,
    title: "Background ASR index projection",
    updatedAt: "2026-07-20 12:30",
  };
  port.refreshProjectIndex(backgroundProjection);
  assert.equal(port.listRecentProjects()[0].title, "Background ASR index projection");
  assert.equal(port.openProject(project.id).title, updatedProject.title);

  const invalidIds = [
    ".",
    "..",
    "",
    null,
    absoluteEscapeId,
    "nested/project",
    "nested\\project",
    "../escape",
  ];

  for (const invalidId of invalidIds) {
    assert.throws(
      () => port.openProject(invalidId),
      /Invalid project id/,
    );
  }

  assert.throws(
    () => port.createProject({ ...project, id: ".." }),
    /Invalid project id/,
  );
  assert.throws(
    () => port.saveProject({ ...project, id: ".." }),
    /Invalid project id/,
  );
  assert.throws(
    () => port.openProject(".."),
    /Invalid project id/,
  );

  assert.equal(existsSync(join(rootDir, "project.sqlite")), false);
  assert.equal(existsSync(join(projectsDir, "project.sqlite")), false);
  assert.deepEqual(
    port.listRecentProjects().map((entry) => entry.id),
    [project.id],
  );
  assert.deepEqual(port.openProject(project.id), updatedProject);
  const trashedProject = {
    ...updatedProject,
    trashedAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T12:00:00.000Z",
  };
  port.saveProject(trashedProject);
  const deleted = port.deleteProjectPermanently(project.id);
  assert.deepEqual(deleted, { ok: true, projectId: project.id });
  assert.equal(existsSync(join(projectsDir, project.id)), false);
  assert.deepEqual(port.listRecentProjects(), []);
} finally {
  port?.close();
  rmSync(rootDir, { recursive: true, force: true });
}
