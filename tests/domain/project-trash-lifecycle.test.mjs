import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveProject,
  autoUnarchiveProject,
  emptyTrackTrash,
  restoreSourceTrack,
  restoreTargetTrack,
  trashSourceTrack,
  trashTargetTrack,
} from "../../shared/project-trash-lifecycle.mjs";

function fixture() {
  return {
    id: "p1",
    activeSourceTrackId: "source-main",
    archivedAt: undefined,
    sourceTracks: [
      {
        id: "source-main",
        isActive: true,
        segments: [{ id: "segment-main" }],
        targetTracks: [{ id: "target-main", isActive: true }],
      },
      {
        id: "source-alt",
        isActive: false,
        segments: [{ id: "segment-alt" }],
        targetTracks: [
          { id: "target-alt-a", isActive: true },
          { id: "target-alt-b", isActive: false, trashedAt: "2026-07-20T00:00:00.000Z" },
        ],
      },
    ],
  };
}

test("protects the active main source and the last live source", () => {
  const active = trashSourceTrack(fixture(), "source-main", "2026-07-23T00:00:00.000Z");
  assert.equal(active.ok, false);
  assert.equal(active.reason, "active_source_protected");

  const only = fixture();
  only.activeSourceTrackId = null;
  only.sourceTracks = [only.sourceTracks[0]];
  only.sourceTracks[0].isActive = false;
  const last = trashSourceTrack(only, "source-main", "2026-07-23T00:00:00.000Z");
  assert.equal(last.ok, false);
  assert.equal(last.reason, "last_source_protected");
});

test("source trash cascades to live children and restore keeps prior child trash", () => {
  const trashed = trashSourceTrack(fixture(), "source-alt", "2026-07-23T00:00:00.000Z");
  assert.equal(trashed.ok, true);
  const source = trashed.project.sourceTracks[1];
  assert.equal(source.trashedAt, "2026-07-23T00:00:00.000Z");
  assert.equal(source.targetTracks[0].trashedWithSource, true);
  assert.equal(source.targetTracks[1].trashedWithSource, undefined);

  const restored = restoreSourceTrack(trashed.project, "source-alt");
  assert.equal(restored.ok, true);
  assert.equal(restored.project.sourceTracks[1].trashedAt, undefined);
  assert.equal(restored.project.sourceTracks[1].targetTracks[0].trashedAt, undefined);
  assert.equal(restored.project.sourceTracks[1].targetTracks[1].trashedAt, "2026-07-20T00:00:00.000Z");
});

test("target trash restores under a live parent and empty permanently removes trash", () => {
  const trashed = trashTargetTrack(fixture(), "target-main", "2026-07-23T00:00:00.000Z");
  assert.equal(trashed.ok, true);
  assert.equal(trashed.project.sourceTracks[0].targetTracks[0].isActive, false);
  const restored = restoreTargetTrack(trashed.project, "target-main");
  assert.equal(restored.ok, true);
  assert.equal(restored.project.sourceTracks[0].targetTracks[0].trashedAt, undefined);

  const withTrash = trashSourceTrack(fixture(), "source-alt", "2026-07-23T00:00:00.000Z").project;
  const emptied = emptyTrackTrash(withTrash);
  assert.equal(emptied.project.sourceTracks.some((track) => track.id === "source-alt"), false);
  assert.equal(emptied.removedSourceTracks, 1);
  assert.equal(emptied.removedTargetTracks, 2);
});

test("archive remains editable state and real edit/export auto-unarchives", () => {
  const archived = archiveProject(fixture(), "2026-07-23T00:00:00.000Z");
  assert.equal(archived.project.archivedAt, "2026-07-23T00:00:00.000Z");
  const untouched = autoUnarchiveProject(archived.project, "view");
  assert.equal(untouched.changed, false);
  const edited = autoUnarchiveProject(archived.project, "edit");
  assert.equal(edited.changed, true);
  assert.equal(edited.project.archivedAt, undefined);
  const exported = autoUnarchiveProject(archived.project, "export");
  assert.equal(exported.project.archivedAt, undefined);
});
