import { createTranslateService } from "./translate-service.mjs";
import { buildEmptyResourceSnapshot } from "./run-snapshot.mjs";
import { getEffectiveTargetText } from "../../shared/target-text-state.mjs";

/**
 * Runs independent per-target-language translation tasks.
 * One language failure does not roll back another language's persisted results.
 * No automatic paid retry.
 */
export function createLanguageTaskRunner({
  translateService = createTranslateService(),
  persistLanguageResult,
  now = () => new Date().toISOString(),
  taskIdFactory = (language) => `task-translate-${language}-${Date.now()}`,
} = {}) {
  async function runLanguages({
    projectId,
    sourceTrackId,
    targetLanguages,
    providerId,
    providerProfile,
    model,
    baseUrl,
    transportMode,
    apiKey,
    segments,
    projectSegments,
    contextSegments = [],
    existingTargetLayersByLanguage = {},
    resumeExistingTargetText = false,
    parameters,
    resourceSnapshot = buildEmptyResourceSnapshot(),
    resourceContextsByLanguage = {},
    operationId,
    signal,
    onTaskEvent,
    persistResult = persistLanguageResult,
  }) {
    const results = [];

    for (const [languageIndex, targetLanguage] of targetLanguages.entries()) {
      const taskId = taskIdFactory(targetLanguage);
      const startedAt = now();
      const resourceContext = resourceContextsByLanguage[targetLanguage] ?? {};
      onTaskEvent?.({
        taskId,
        targetLanguage,
        status: "running",
        progress: 0,
        stage: "translate",
        timestamp: startedAt,
        languageIndex,
        languageCount: targetLanguages.length,
      });

      try {
        const existingTargetLayers = existingTargetLayersByLanguage[targetLanguage] ?? {};
        const requestedSegments = resumeExistingTargetText
          ? segments.filter((segment) => {
              const segmentId = segment.id ?? segment.segmentId;
              return !getEffectiveTargetText(existingTargetLayers[segmentId]).trim();
            })
          : segments;
        const outcome = await translateService.translateLanguage({
          projectId,
          sourceTrackId,
          targetLanguage,
          providerId,
          providerProfile,
          model,
          baseUrl,
          transportMode,
          apiKey,
          segments: requestedSegments,
          projectSegments,
          contextSegments,
          existingTargetLayers,
          parameters,
          resourceSnapshot: resourceContext.resourceSnapshot ?? resourceSnapshot,
          glossaryHint: resourceContext.glossaryHint ?? "",
          styleHint: resourceContext.styleHint ?? "",
          operationId,
          signal,
          /*
           * 逐批回报进度。
           *
           * 在这之前，一个语言只发两次事件：开始 0、结束 1。
           * 单语言项目（绝大多数）因此整轮都停在 0%，用户看到的就是一条
           * 永远不动的进度条，无法判断它是在跑还是卡死了。
           *
           * 返回值要 await：暂停时上层返回的是「等用户点继续」的 promise，
           * 吞掉它翻译就会照常跑下去。
           */
          onBatch: ({ batchIndex, batchCount }) => onTaskEvent?.({
            taskId,
            targetLanguage,
            status: "running",
            progress: batchCount > 0 ? Math.min(1, (batchIndex + 1) / batchCount) : 1,
            stage: "translate",
            timestamp: now(),
            languageIndex,
            languageCount: targetLanguages.length,
          }),
        });

        if (typeof persistResult === "function") {
          await persistResult({
            projectId,
            targetLanguage,
            translations: outcome.translations,
            snapshot: outcome.snapshot,
            taskId,
            status: "completed",
            termConflictRules: resourceContext.termConflictRules ?? [],
          });
        }

        onTaskEvent?.({
          taskId,
          targetLanguage,
          status: "completed",
          progress: 1,
          stage: "translate",
          cacheHits: outcome.cacheHits,
          timestamp: now(),
          languageIndex,
          languageCount: targetLanguages.length,
        });
        results.push({ taskId, targetLanguage, ...outcome });
      } catch (error) {
        const partial = error?.partialOutcome;
        let partialPersisted = false;
        if (partial?.snapshot && typeof persistResult === "function") {
          await persistResult({
            projectId,
            targetLanguage,
            translations: partial.translations,
            snapshot: partial.snapshot,
            taskId,
            status: "failed",
            errorClass: error?.providerErrorClass ?? "unknown",
            termConflictRules: resourceContext.termConflictRules ?? [],
          });
          partialPersisted = true;
        }
        onTaskEvent?.({
          taskId,
          targetLanguage,
          status: "failed",
          progress: 0,
          stage: "translate",
          errorClass: error?.providerErrorClass ?? "unknown",
          message: error?.message ?? "Translation failed",
          persisted: partialPersisted,
          timestamp: now(),
          languageIndex,
          languageCount: targetLanguages.length,
        });
        results.push({
          taskId,
          targetLanguage,
          ...(partial ?? { status: "failed" }),
          error,
        });
        // Continue other languages; do not auto-retry paid work.
      }
    }

    return { results };
  }

  return { runLanguages };
}
