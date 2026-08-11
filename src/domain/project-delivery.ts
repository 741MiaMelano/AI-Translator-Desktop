import { approveProjectTargetTrack, refreshProjectTargetQa } from "./project-editor.ts";
import {
  getActiveTargetTracks,
  isActionableQaIssue,
  type Project,
  type QaIssue,
} from "./workspace.ts";

export interface ProjectDeliveryIssueGroup {
  key: string;
  languageCode: string;
  languageLabel: string;
  label: string;
  count: number;
  firstSegmentId: string | null;
}

export interface ProjectDeliveryInspection {
  state: "empty" | "blocked" | "ready" | "approved" | "exported";
  targetCount: number;
  warningCount: number;
  errorCount: number;
  errorGroups: ProjectDeliveryIssueGroup[];
}

export function inspectProjectDelivery(project: Project): ProjectDeliveryInspection {
  const targets = getActiveTargetTracks(project);
  const errorGroups = new Map<string, ProjectDeliveryIssueGroup>();
  let warningCount = 0;
  let errorCount = 0;

  for (const track of targets) {
    for (const issue of track.qaIssues.filter(isActionableQaIssue)) {
      if (issue.severity === "warning") {
        warningCount += 1;
        continue;
      }
      errorCount += 1;
      const key = `${track.languageCode}/${issue.ruleId ?? issue.label}`;
      const group = errorGroups.get(key) ?? {
        key,
        languageCode: track.languageCode,
        languageLabel: track.languageLabel,
        label: issue.label,
        count: 0,
        firstSegmentId: issueSegmentId(issue),
      };
      group.count += 1;
      group.firstSegmentId ??= issueSegmentId(issue);
      errorGroups.set(key, group);
    }
  }

  const state = targets.length === 0
    ? "empty"
    : errorCount > 0
      ? "blocked"
      : targets.some((track) => track.status === "draft")
        ? "empty"
      : targets.every((track) => track.status === "exported")
        ? "exported"
        : targets.every((track) => track.status === "approved" || track.status === "exported")
          ? "approved"
          : "ready";

  return {
    state,
    targetCount: targets.length,
    warningCount,
    errorCount,
    errorGroups: [...errorGroups.values()].sort(
      (left, right) => right.count - left.count || left.languageLabel.localeCompare(right.languageLabel),
    ),
  };
}

/** Refresh every active target, then approve the clean set from one explicit user action. */
export function approveProjectDelivery(project: Project) {
  const languageCodes = getActiveTargetTracks(project).map((track) => track.languageCode);
  if (languageCodes.length === 0) {
    return { ok: false as const, reason: "track_required", project, inspection: inspectProjectDelivery(project) };
  }

  let nextProject = project;
  for (const languageCode of languageCodes) {
    const refreshed = refreshProjectTargetQa(nextProject, languageCode);
    if (!refreshed.ok) {
      return { ok: false as const, reason: refreshed.reason, project: nextProject, inspection: inspectProjectDelivery(nextProject) };
    }
    nextProject = refreshed.project;
  }

  const inspection = inspectProjectDelivery(nextProject);
  if (inspection.state === "blocked") {
    return { ok: false as const, reason: "hard_qa_errors", project: nextProject, inspection };
  }

  const approvedLanguageCodes: string[] = [];
  for (const track of getActiveTargetTracks(nextProject)) {
    if (track.status === "approved" || track.status === "exported") continue;
    const approved = approveProjectTargetTrack(nextProject, track.languageCode);
    if (!approved.ok) {
      return { ok: false as const, reason: approved.reason, project: approved.project, inspection: inspectProjectDelivery(approved.project) };
    }
    nextProject = approved.project;
    approvedLanguageCodes.push(track.languageCode);
  }

  return {
    ok: true as const,
    project: nextProject,
    approvedLanguageCodes,
    inspection: inspectProjectDelivery(nextProject),
  };
}

function issueSegmentId(issue: QaIssue): string | null {
  return typeof issue.segmentId === "string" && issue.segmentId.length > 0 ? issue.segmentId : null;
}
