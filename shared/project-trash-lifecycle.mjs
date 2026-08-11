function cloneProject(project) {
  return structuredClone(project);
}

function fail(project, reason) {
  return { ok: false, reason, project: cloneProject(project) };
}

export function trashSourceTrack(project, sourceTrackId, trashedAt = new Date().toISOString()) {
  const next = cloneProject(project);
  const source = next.sourceTracks?.find((track) => track.id === sourceTrackId);
  if (!source || source.trashedAt) return fail(project, "source_track_not_found");
  if (next.activeSourceTrackId === sourceTrackId || source.isActive) {
    return fail(project, "active_source_protected");
  }
  const liveSources = next.sourceTracks.filter((track) => !track.trashedAt);
  if (liveSources.length <= 1) return fail(project, "last_source_protected");
  source.trashedAt = trashedAt;
  source.isActive = false;
  source.targetTracks = source.targetTracks.map((track) => track.trashedAt
    ? track
    : {
        ...track,
        isActive: false,
        trashedAt,
        trashedWithSource: true,
      });
  return { ok: true, project: next };
}

export function restoreSourceTrack(project, sourceTrackId) {
  const next = cloneProject(project);
  const source = next.sourceTracks?.find((track) => track.id === sourceTrackId);
  if (!source?.trashedAt) return fail(project, "source_track_not_found");
  delete source.trashedAt;
  source.targetTracks = source.targetTracks.map((track) => {
    if (!track.trashedWithSource) return track;
    const restored = { ...track };
    delete restored.trashedAt;
    delete restored.trashedWithSource;
    return restored;
  });
  return { ok: true, project: next };
}

export function trashTargetTrack(project, targetTrackId, trashedAt = new Date().toISOString()) {
  const next = cloneProject(project);
  for (const source of next.sourceTracks ?? []) {
    const target = source.targetTracks?.find((track) => track.id === targetTrackId);
    if (!target || target.trashedAt) continue;
    target.trashedAt = trashedAt;
    target.isActive = false;
    delete target.trashedWithSource;
    return { ok: true, project: next };
  }
  return fail(project, "target_track_not_found");
}

export function restoreTargetTrack(project, targetTrackId) {
  const next = cloneProject(project);
  for (const source of next.sourceTracks ?? []) {
    const target = source.targetTracks?.find((track) => track.id === targetTrackId);
    if (!target?.trashedAt) continue;
    if (source.trashedAt) return fail(project, "parent_source_trashed");
    delete target.trashedAt;
    delete target.trashedWithSource;
    return { ok: true, project: next };
  }
  return fail(project, "target_track_not_found");
}

export function emptyTrackTrash(project) {
  const next = cloneProject(project);
  let removedSourceTracks = 0;
  let removedTargetTracks = 0;
  next.sourceTracks = (next.sourceTracks ?? []).flatMap((source) => {
    if (source.trashedAt) {
      removedSourceTracks += 1;
      removedTargetTracks += source.targetTracks?.length ?? 0;
      return [];
    }
    const before = source.targetTracks?.length ?? 0;
    source.targetTracks = (source.targetTracks ?? []).filter((track) => !track.trashedAt);
    removedTargetTracks += before - source.targetTracks.length;
    return [source];
  });
  return { ok: true, project: next, removedSourceTracks, removedTargetTracks };
}

export function archiveProject(project, archivedAt = new Date().toISOString()) {
  return {
    ok: true,
    project: { ...cloneProject(project), archivedAt },
  };
}

export function autoUnarchiveProject(project, reason) {
  const next = cloneProject(project);
  if (!next.archivedAt || !["edit", "export"].includes(reason)) {
    return { ok: true, changed: false, project: next };
  }
  delete next.archivedAt;
  return { ok: true, changed: true, project: next };
}
