import { planTranslationBatches } from "../translation/batching.mjs";
import { estimateTokensForBatch } from "../translation/budget.mjs";

function batchPlanError(code, message, details = {}) {
  const error = Object.assign(new Error(message), { code }, details);
  return error;
}

function sourceText(segment) {
  return segment?.sourceText?.normalized
    ?? segment?.sourceText?.original
    ?? segment?.text
    ?? "";
}

function estimateProject(project) {
  const sourceTrack = project?.sourceTracks?.find(
    (track) => track.id === project.activeSourceTrackId,
  ) ?? project?.sourceTracks?.[0];
  const targetLanguages = Array.isArray(project?.config?.targetLanguages)
    ? project.config.targetLanguages
    : [];
  const segments = Array.isArray(sourceTrack?.segments)
    ? sourceTrack.segments.map((segment) => ({
        segmentId: segment.id ?? segment.segmentId,
        text: String(sourceText(segment)),
      })).filter((segment) => typeof segment.segmentId === "string" && segment.segmentId)
    : [];
  const batches = planTranslationBatches(segments);
  const perLanguageTokens = batches.reduce(
    (total, batch) => total + estimateTokensForBatch(batch).totalTokens,
    0,
  );
  return {
    projectId: project.id,
    targetLanguages,
    estimatedTokens: perLanguageTokens * targetLanguages.length,
  };
}

/**
 * 批量翻译计划：只做去重与 token 上界估算，不做任何计费或额度控制。
 * 持久化的任务请求快照让重启/幂等是安全的，无需额外的批次数据库。
 */
export function planBatchTranslation({
  batchId,
  projects,
  existingTasks,
}) {
  if (typeof batchId !== "string" || !batchId || !Array.isArray(projects) || !Array.isArray(existingTasks)) {
    throw batchPlanError("INVALID_INPUT", "Batch translation plan is invalid");
  }
  const batchTasks = existingTasks.filter((task) =>
    task?.request?.operation === "translation.start"
    && task.request?.input?.batchId === batchId,
  );
  const existingByProject = new Map(batchTasks.map((task) => [task.projectId, task]));
  const selectedExisting = [];
  const starts = [];
  const seenProjects = new Set();

  for (const project of projects) {
    if (!project?.id || seenProjects.has(project.id)) {
      throw batchPlanError("INVALID_INPUT", "Batch projects must be unique and valid");
    }
    seenProjects.add(project.id);
    const existing = existingByProject.get(project.id);
    if (existing) {
      selectedExisting.push(existing);
    } else {
      starts.push(estimateProject(project));
    }
  }

  const existingTokens = batchTasks.reduce((total, task) => {
    const value = task.request?.input?.batchEstimatedTokens;
    return total + (Number.isFinite(value) && value >= 0 ? value : 0);
  }, 0);
  const newTokens = starts.reduce((total, entry) => total + entry.estimatedTokens, 0);
  const estimatedTokens = existingTokens + newTokens;

  return { batchId, estimatedTokens, starts, existingTasks: selectedExisting };
}
