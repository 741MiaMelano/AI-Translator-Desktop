import type { Project } from "../src/domain/workspace";

type LifecycleFailure = { ok: false; reason: string; project: Project };
type LifecycleSuccess = { ok: true; project: Project };

export function trashSourceTrack(
  project: Project,
  sourceTrackId: string,
  trashedAt?: string,
): LifecycleSuccess | LifecycleFailure;

export function restoreSourceTrack(
  project: Project,
  sourceTrackId: string,
): LifecycleSuccess | LifecycleFailure;

export function trashTargetTrack(
  project: Project,
  targetTrackId: string,
  trashedAt?: string,
): LifecycleSuccess | LifecycleFailure;

export function restoreTargetTrack(
  project: Project,
  targetTrackId: string,
): LifecycleSuccess | LifecycleFailure;

export function emptyTrackTrash(project: Project): LifecycleSuccess & {
  removedSourceTracks: number;
  removedTargetTracks: number;
};

export function archiveProject(project: Project, archivedAt?: string): LifecycleSuccess;

export function autoUnarchiveProject(
  project: Project,
  reason: "edit" | "export" | string,
): LifecycleSuccess & { changed: boolean };
