import type { Project, QaIssue, TargetTrack } from "../src/domain/workspace";

export function approveTargetTrack(
  track: TargetTrack,
  qaIssues: QaIssue[],
  options?: { actor?: string },
):
  | { ok: true; track: TargetTrack }
  | { ok: false; reason: string; track: TargetTrack };

export function degradeTrackAfterSourceChange(
  track: TargetTrack,
  options?: { reason?: string },
): { ok: true; track: TargetTrack; degraded: boolean };

export function refreshTrackQaIssues(
  project: Project,
  track: TargetTrack,
  options?: { languageCode?: string },
): { ok: true; track: TargetTrack; issues: QaIssue[]; hasHardErrors: boolean };
