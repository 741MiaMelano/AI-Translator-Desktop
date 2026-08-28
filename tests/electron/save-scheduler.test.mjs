import assert from "node:assert/strict";
import test from "node:test";
import { ProjectSaveScheduler } from "../../src/services/project-save-scheduler.ts";

test("scheduler saves latest revision and serializes per project", async () => {
  const saves = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted = false;

  const scheduler = new ProjectSaveScheduler(async (project) => {
    saves.push(project.title);
    if (!firstStarted) {
      firstStarted = true;
      await firstGate;
    }
    return { ok: true, data: { ok: true } };
  });

  scheduler.markDirty({ id: "p1", title: "v1" });
  await new Promise((resolve) => setTimeout(resolve, 420));
  scheduler.markDirty({ id: "p1", title: "v2" });
  releaseFirst();
  const flushed = await scheduler.flushAll();

  assert.deepEqual(saves, ["v1", "v2"]);
  assert.equal(flushed, true);
  assert.equal(scheduler.isDirty("p1"), false);
});

test("failed flush reports failure and keeps dirty state", async () => {
  const scheduler = new ProjectSaveScheduler(async () => ({
    ok: false,
    error: { code: "INTERNAL", message: "disk full" },
  }));
  let lastError = null;
  scheduler.onSettle((_id, error) => {
    lastError = error;
  });

  scheduler.markDirty({ id: "p2", title: "x" });
  const flushed = await scheduler.flushAll();

  assert.equal(flushed, false);
  assert.equal(lastError, "disk full");
  assert.equal(scheduler.isDirty("p2"), true);
});

test("external worker snapshot wins after an older renderer save is already in flight", async () => {
  const saves = [];
  let releaseStale;
  const staleGate = new Promise((resolve) => {
    releaseStale = resolve;
  });
  const scheduler = new ProjectSaveScheduler(async (project) => {
    saves.push(project.title);
    if (project.title === "stale renderer") await staleGate;
    return { ok: true, data: { ok: true } };
  });

  scheduler.markDirty({ id: "p3", title: "stale renderer" });
  await new Promise((resolve) => setTimeout(resolve, 420));
  const accepted = scheduler.acceptExternal({ id: "p3", title: "worker result" });
  releaseStale();

  assert.equal(await accepted, true);
  assert.deepEqual(saves, ["stale renderer", "worker result"]);
  assert.equal(scheduler.isDirty("p3"), false);
});

test("external worker snapshot blocks stale renderer autosave after a queued conflict", async () => {
  const saves = [];
  const settleEvents = [];
  let releaseOld;
  const oldGate = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const scheduler = new ProjectSaveScheduler(async (project) => {
    saves.push(project.title);
    if (project.title === "old renderer") await oldGate;
    return { ok: true, data: { ok: true } };
  });
  scheduler.onSettle((_projectId, errorMessage) => settleEvents.push(errorMessage));

  scheduler.markDirty({ id: "p4", title: "old renderer" });
  await new Promise((resolve) => setTimeout(resolve, 420));
  const accepted = scheduler.acceptExternal({ id: "p4", title: "worker result" });
  scheduler.markDirty({ id: "p4", title: "new renderer based on stale state" });
  releaseOld();

  assert.equal(await accepted, false);
  assert.deepEqual(saves, ["old renderer", "worker result"]);
  assert.equal(scheduler.isDirty("p4"), true);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(saves, ["old renderer", "worker result"]);
  assert.equal(scheduler.isDirty("p4"), true);
  assert.equal(await scheduler.flushAll(), false);
  assert.deepEqual(settleEvents, []);
});

test("main-persisted project replaces pending renderer state without a duplicate save", async () => {
  const saves = [];
  const scheduler = new ProjectSaveScheduler(async (project) => {
    saves.push(project.title);
    return { ok: true, data: { ok: true } };
  });
  scheduler.markDirty({ id: "p5", title: "renderer state" });

  scheduler.acceptPersisted({ id: "p5", title: "main result" });

  assert.equal(scheduler.isDirty("p5"), false);
  assert.equal(await scheduler.flush("p5"), true);
  assert.deepEqual(saves, []);
});
