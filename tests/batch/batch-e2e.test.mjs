import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { createMediaService } from "../../backend/media/media-service.mjs";
import { openAppRepository } from "../../backend/persistence/app-repository.mjs";
import { createTaskCoordinator } from "../../backend/tasks/task-coordinator.mjs";
import { createTaskScheduler } from "../../backend/tasks/task-scheduler.mjs";
import { createTaskService } from "../../backend/tasks/task-service.mjs";

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve };
}

function registerBatchExecutor(service, { firstWaveGate, firstWaveProjectIds, failureProjectId }) {
  service.register("translation.start", {
    kind: "translate",
    stage: "translate",
    label: (input) => `Translate ${input.projectId}`,
    pauseCapability: "never",
    execute: async (input, context) => {
      if (firstWaveProjectIds.includes(input.projectId)) await firstWaveGate?.promise;
      if (input.projectId === failureProjectId && context.task.attempt === 0) {
        throw Object.assign(new Error("Injected provider failure"), {
          code: "PROVIDER_SERVER",
          retryable: true,
        });
      }
      context.reportProgress(80, "Persisted project result");
      return { projectId: input.projectId };
    },
  });
}

test("five-item batch isolates failure, persists pause, and recovers after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "phase9-batch-e2e-"));
  const inputs = [
    { name: "one.mkv", mediaKind: "video", duration: 100, body: "video" },
    { name: "two.wav", mediaKind: "audio", duration: 200, body: "audio" },
    { name: "three.srt", mediaKind: "subtitle", duration: 300, body: "1\n00:00:00,000 --> 00:00:01,000\nthree\n" },
    { name: "four.srt", mediaKind: "subtitle", duration: 400, body: "1\n00:00:00,000 --> 00:00:01,000\nfour\n" },
    { name: "five.srt", mediaKind: "subtitle", duration: 500, body: "1\n00:00:00,000 --> 00:00:01,000\nfive\n" },
  ];
  const filePaths = inputs.map((input) => {
    const filePath = join(root, input.name);
    writeFileSync(filePath, input.body);
    return filePath;
  });
  const inputByName = new Map(inputs.map((input) => [input.name, input]));
  const mediaService = createMediaService({
    resolveArtifacts: () => ({ ffprobePath: join(root, "ffprobe.exe"), upstreamVersion: "test" }),
    getProjectRepository: () => { throw new Error("batch E2E must use transactional persistence"); },
    persistBatchProjects: async (entries) => ({
      projectIds: entries.map(({ project }) => project.id),
      projects: entries.map(({ project }) => project),
    }),
    runProcess: async ({ argv }) => {
      const input = inputByName.get(basename(argv.at(-1)));
      const streams = input.mediaKind === "video"
        ? [{ index: 0, codec_type: "video", codec_name: "h264" }, { index: 1, codec_type: "audio", codec_name: "aac" }]
        : input.mediaKind === "audio"
          ? [{ index: 0, codec_type: "audio", codec_name: "pcm_s16le" }]
          : [{ index: 0, codec_type: "subtitle", codec_name: "subrip" }];
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify({
          format: { format_name: input.mediaKind, duration: String(input.duration), size: "32" },
          streams,
        })),
      };
    },
  });
  let repository = openAppRepository(root);
  try {
    const session = await mediaService.createBatchSession({ filePaths });
    assert.equal(session.files.length, 5);
    assert.equal(session.groups.length, 5);
    assert.deepEqual(new Set(session.files.map((file) => file.mediaKind)), new Set(["video", "audio", "subtitle"]));
    const committed = await mediaService.commitBatchSession({
      sessionId: session.id,
      defaults: {
        sourceLanguage: "auto",
        targetLanguages: ["zh-CN"],
        provider: "OpenAI",
        model: "GPT-4.1",
        glossary: "none",
        styleGuide: "none",
        outputFormat: "SRT",
      },
      groups: session.groups.map((group) => ({ ...group, overrides: {} })),
    });
    const projectIds = committed.projectIds;
    const failureProjectId = projectIds[2];
    let coordinator = createTaskCoordinator({ queueRepository: repository });
    const firstWaveGate = deferred();
    let service = createTaskService({
      coordinator,
      scheduler: createTaskScheduler({ apiConcurrency: 2 }),
      idFactory: (_operation, input) => `task-${input.projectId}`,
    });
    const executorOptions = {
      firstWaveGate,
      firstWaveProjectIds: projectIds.slice(0, 2),
      failureProjectId,
    };
    registerBatchExecutor(service, executorOptions);

    const tasks = projectIds.map((projectId) => service.enqueue("translation.start", {
      projectId,
      batchId: "batch-e2e",
      batchEstimatedTokens: 100,
      userConfirmed: true,
    }));
    const pausedTask = tasks.at(-1);
    const paused = service.control({
      taskId: pausedTask.id,
      projectId: pausedTask.projectId,
      action: "pause",
    });
    assert.equal(paused.status, "paused");

    firstWaveGate.resolve();
    await Promise.allSettled(tasks.map((task) => service.waitForIdle(task.id)));
    const beforeRestart = coordinator.list();
    assert.equal(beforeRestart.filter((task) => task.status === "completed").length, 3);
    assert.equal(beforeRestart.filter((task) => task.status === "failed").length, 1);
    assert.equal(beforeRestart.filter((task) => task.status === "paused").length, 1);

    repository.close();
    repository = openAppRepository(root);
    coordinator = createTaskCoordinator({ queueRepository: repository });
    service = createTaskService({
      coordinator,
      scheduler: createTaskScheduler({ apiConcurrency: 2 }),
      idFactory: (_operation, input) => `unexpected-${input.projectId}`,
    });
    registerBatchExecutor(service, {
      ...executorOptions,
      firstWaveGate: null,
      firstWaveProjectIds: [],
    });

    const restoredPaused = coordinator.get(pausedTask.id);
    assert.equal(restoredPaused.status, "paused");
    service.control({
      taskId: restoredPaused.id,
      projectId: restoredPaused.projectId,
      action: "resume",
      userConfirmed: true,
    });
    const failedTask = coordinator.list().find((task) => task.status === "failed");
    service.control({
      taskId: failedTask.id,
      projectId: failedTask.projectId,
      action: "retry",
      userConfirmed: true,
    });
    await Promise.all([
      service.waitForIdle(restoredPaused.id),
      service.waitForIdle(failedTask.id),
    ]);

    const finalTasks = coordinator.list().filter((task) => task.request.input.batchId === "batch-e2e");
    assert.equal(finalTasks.length, 5);
    assert.equal(finalTasks.every((task) => task.status === "completed"), true);
    assert.equal(finalTasks.reduce((total, task) => total + task.request.input.batchEstimatedTokens, 0), 500);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});
