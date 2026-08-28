import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityService } from "../../backend/capabilities/capability-service.mjs";

test("projects real global probes into global and project readiness", async () => {
  const service = createCapabilityService({
    getAsrCapability: async () => ({ ready: true }),
    getProviderReadinesses: () => [{ status: "ready" }],
    getVideoCapability: () => ({ available: true }),
    getProject: () => ({
      id: "project-1",
      mediaKind: "video",
      noSourceMedia: false,
      activeSourceTrackId: "source-1",
      sourceTracks: [{ id: "source-1", targetTracks: [{ id: "target-1" }] }],
      config: { targetLanguages: ["zh-CN"] },
    }),
    now: () => new Date("2026-07-23T12:00:00.000Z"),
  });

  const status = await service.getStatus({ projectId: "project-1" });
  assert.equal(status.probedAt, "2026-07-23T12:00:00.000Z");
  assert.equal(status.global.capabilities.find(({ id }) => id === "asr").available, true);
  assert.equal(status.project.capabilities.find(({ id }) => id === "video_export").available, true);
  assert.deepEqual(status.global.capabilities.map(({ id }) => id), ["translation", "asr", "subtitle_export", "video_export"]);
});

test("a globally ready capability explains project-only blockers", async () => {
  const service = createCapabilityService({
    getAsrCapability: async () => ({ ready: true }),
    getProviderReadinesses: () => [{ status: "ready" }],
    getVideoCapability: () => ({ available: true }),
    getProject: () => ({
      id: "project-missing-media",
      mediaKind: "video",
      noSourceMedia: true,
      activeSourceTrackId: "source-1",
      sourceTracks: [{ id: "source-1", targetTracks: [] }],
      config: { targetLanguages: [] },
    }),
  });

  const status = await service.getStatus({ projectId: "project-missing-media" });
  const video = status.project.capabilities.find(({ id }) => id === "video_export");
  const translation = status.project.capabilities.find(({ id }) => id === "translation");
  assert.deepEqual(video, {
    id: "video_export",
    label: "视频后处理",
    available: false,
    reason: "当前项目需要重新关联源媒体",
    repairAction: "relink_media",
  });
  assert.equal(translation.available, false);
  assert.equal(translation.reason, "当前项目尚未选择目标语言");
});

test("first-run readiness distinguishes a missing ASR model from a broken runtime", async () => {
  const create = (asr) => createCapabilityService({
    getAsrCapability: async () => asr,
    getProviderReadinesses: () => [],
    getVideoCapability: () => ({ available: true }),
    getProject: () => null,
  });

  const missingModel = await create({
    ready: false,
    runtime: { installState: "ready" },
    model: { installState: "not_installed" },
  }).getStatus();
  assert.equal(missingModel.global.capabilities.find(({ id }) => id === "asr").reason, "语音识别模型尚未安装");

  const brokenRuntime = await create({
    ready: false,
    runtime: { installState: "invalid" },
    model: { installState: "ready" },
  }).getStatus();
  assert.equal(brokenRuntime.global.capabilities.find(({ id }) => id === "asr").reason, "本地语音识别组件不可用");
});

test("a saved provider awaiting first-use verification is operationally available", async () => {
  const service = createCapabilityService({
    getAsrCapability: async () => ({ ready: false }),
    getProviderReadinesses: () => [{ status: "untested" }],
    getVideoCapability: () => ({ available: true }),
    getProject: () => null,
  });
  const status = await service.getStatus();
  assert.equal(status.global.capabilities.find(({ id }) => id === "translation").available, true);
});

test("an untested provider remains available when an earlier provider failed", async () => {
  const service = createCapabilityService({
    getAsrCapability: async () => ({ ready: false }),
    getProviderReadinesses: () => [{ status: "failed" }, { status: "untested" }],
    getVideoCapability: () => ({ available: true }),
    getProject: () => null,
  });
  const status = await service.getStatus();
  assert.equal(status.global.capabilities.find(({ id }) => id === "translation").available, true);
});
