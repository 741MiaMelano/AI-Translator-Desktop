import { randomUUID } from "node:crypto";
import { createOpenAICompatibleClient } from "../provider/openai-compatible-client.mjs";
import { createProviderError } from "../provider/errors.mjs";
import { planTranslationBatches } from "./batching.mjs";
import { estimateTokensForBatch } from "./budget.mjs";
import {
  buildTranslationCacheFingerprint,
  createMemoryTranslationCache,
  isProtectedTargetLayer,
} from "./cache.mjs";
import {
  PROMPT_TEMPLATE_VERSION,
  TRANSLATION_RESPONSE_SCHEMA,
  buildTranslationMessages,
  buildProjectContentSummary,
  validateTranslationResponse,
} from "./prompt-contract.mjs";
import { buildEmptyResourceSnapshot, createRunSnapshotRecord } from "./run-snapshot.mjs";

function segmentVersionOf(segments) {
  return segments.map((segment) => `${segment.segmentId}:${segment.text}`).join("|");
}

function prepareRun(request) {
  const workSegments = request.segments.map((segment) => ({
    segmentId: segment.id ?? segment.segmentId,
    text: segment.sourceText?.normalized ?? segment.sourceText?.original ?? segment.text,
  }));
  const projectWorkSegments = (request.projectSegments ?? request.segments).map((segment) => ({
    segmentId: segment.id ?? segment.segmentId,
    text: segment.sourceText?.normalized ?? segment.sourceText?.original ?? segment.text,
  }));
  const projectSummary = buildProjectContentSummary(projectWorkSegments);
  const batches = planTranslationBatches(workSegments);

  return {
    ...request,
    workSegments,
    batches,
    segmentVersion: segmentVersionOf(projectWorkSegments),
    projectSummary,
    contextSegments: (request.contextSegments ?? []).map((segment) => ({
      segmentId: segment.id ?? segment.segmentId,
      text: segment.sourceText?.normalized ?? segment.sourceText?.original ?? segment.text,
    })),
  };
}

function createRunState() {
  return {
    translations: new Map(),
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    networkCalls: 0,
    baseUrlDisplay: null,
  };
}

function makeSnapshot(runtime, run, state) {
  return createRunSnapshotRecord({
    id: runtime.idFactory(),
    projectId: run.projectId,
    sourceTrackId: run.sourceTrackId,
    targetLanguageCode: run.targetLanguage,
    providerId: run.providerId,
    model: run.model,
    baseUrlDisplay: state.baseUrlDisplay,
    transportMode: run.transportMode,
    parameters: run.parameters,
    resourceSnapshot: run.resourceSnapshot,
    segmentVersion: run.segmentVersion,
    cacheHits: state.cacheHits,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    createdAt: runtime.now(),
  });
}

function buildBatchPlans(run, state, cache) {
  return run.batches.map((batch) => {
    const pending = [];
    for (const item of batch.segments) {
      if (isProtectedTargetLayer(run.existingTargetLayers[item.segmentId])) continue;
      const fingerprint = buildTranslationCacheFingerprint({
        sourceText: item.text,
        targetLanguage: run.targetLanguage,
        providerId: run.providerId,
        model: run.model,
        baseUrl: run.baseUrl,
        transportMode: run.transportMode,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        parameters: run.parameters,
        resourceSnapshot: run.resourceSnapshot,
        segmentVersion: run.segmentVersion,
      });
      const cached = cache.get(fingerprint);
      if (cached) {
        state.translations.set(item.segmentId, cached.text);
        state.cacheHits += 1;
      } else {
        pending.push({ ...item, fingerprint });
      }
    }
    return {
      batch,
      pending,
      paidBatch: {
        ...batch,
        segments: pending,
        projectSummary: run.projectSummary,
        expectedSegmentIds: pending.map((item) => item.segmentId),
      },
    };
  });
}

function recordUsage(response, state) {
  if (typeof response.baseUrlDisplay === "string") state.baseUrlDisplay = response.baseUrlDisplay;
  if (!response.usage) return;
  state.inputTokens += response.usage.inputTokens;
  state.outputTokens += response.usage.outputTokens;
}

async function executePaidBatch(runtime, run, plan, state) {
  const messages = buildTranslationMessages({
    targetLanguage: run.targetLanguage,
    segments: plan.pending.map(({ segmentId, text }) => ({ segmentId, text })),
    contextSegments: [...plan.batch.contextSegments, ...run.contextSegments],
    projectSummary: run.projectSummary,
    glossaryHint: run.glossaryHint,
    styleHint: run.styleHint,
  });
  let validated;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    state.networkCalls += 1;
    const response = await runtime.client.createStructuredTranslation({
      baseUrl: run.baseUrl,
      apiKey: run.apiKey,
      transportMode: run.transportMode,
      model: run.model,
      schema: TRANSLATION_RESPONSE_SCHEMA,
      messages: attempt === 0 ? messages : [
        ...messages,
        {
          role: "user",
          content: `The previous response failed validation (${String(validated.error).slice(0, 160)}). Return exactly ${plan.pending.length} items, preserve every segmentId once, and write every segments[].text in ${run.targetLanguage}. Return only the required JSON object.`,
        },
      ],
      temperature: run.parameters.temperature ?? 0.2,
      maxOutputTokens: estimateTokensForBatch(plan.paidBatch).outputTokens,
      signal: run.signal,
    });
    recordUsage(response, state);
    validated = validateTranslationResponse(response.rawText, {
      targetLanguage: run.targetLanguage,
      expectedSegmentIds: plan.pending.map((item) => item.segmentId),
      sourceSegments: plan.pending,
    });
    if (validated.ok) break;
  }
  if (!validated.ok) {
    throw createProviderError({
      providerErrorClass: "schema_mismatch",
      message: `Structured translation response failed validation: ${validated.error}`,
    });
  }
  for (const item of validated.value.segments) {
    state.translations.set(item.segmentId, item.text);
    const pending = plan.pending.find((entry) => entry.segmentId === item.segmentId);
    if (pending) runtime.cache.set(pending.fingerprint, { text: item.text });
  }
}

/**
 * 批次之间是这条链路上唯一的可观测点，也是唯一的安全点：
 * 已完成的批次结果都在 state 里，停在这里既不丢译文也不浪费已付费的请求。
 * 所以 onBatch 既用来推进度，也用来响应暂停——必须 await。
 */
async function notifyBatch(run, payload, batchIndex, batchCount) {
  await run.onBatch?.({ ...payload, batchIndex, batchCount });
}

async function executePlans(runtime, run, plans, state) {
  for (const [batchIndex, plan] of plans.entries()) {
    if (plan.pending.length === 0) {
      await notifyBatch(run, {
        cacheOnly: true,
        expectedSegmentIds: plan.batch.expectedSegmentIds,
      }, batchIndex, plans.length);
      continue;
    }
    await executePaidBatch(runtime, run, plan, state);
    await notifyBatch(run, {
      cacheOnly: false,
      expectedSegmentIds: plan.pending.map((item) => item.segmentId),
    }, batchIndex, plans.length);
  }
}

async function translateLanguage(runtime, {
  projectId,
  sourceTrackId,
  targetLanguage,
  providerId,
  model,
  baseUrl,
  transportMode = "responses",
  apiKey,
  segments,
  projectSegments,
  contextSegments = [],
  existingTargetLayers = {},
  parameters = { temperature: 0.2 },
  resourceSnapshot = buildEmptyResourceSnapshot(),
  glossaryHint = "",
  styleHint = "",
  signal,
  onBatch,
}) {
  if (!providerId || providerId === "deepl") {
    throw createProviderError({
      providerErrorClass: "invalid_config",
      message: "Provider is not available for translation",
      code: "INVALID_INPUT",
    });
  }
  const run = prepareRun({
    projectId, sourceTrackId, targetLanguage, providerId, model, baseUrl, transportMode,
    apiKey, segments, projectSegments, contextSegments, existingTargetLayers, parameters, resourceSnapshot,
    glossaryHint, styleHint, signal, onBatch,
  });
  const state = createRunState();
  const plans = buildBatchPlans(run, state, runtime.cache);

  try {
    await executePlans(runtime, run, plans, state);
  } catch (error) {
    if (state.networkCalls > 0) {
      const snapshot = makeSnapshot(runtime, run, state);
      error.partialOutcome = {
        status: "failed",
        translations: Object.fromEntries(state.translations),
        snapshot,
        networkCalls: state.networkCalls,
        cacheHits: state.cacheHits,
        usage: {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
        },
      };
    }
    throw error;
  }

  const snapshot = makeSnapshot(runtime, run, state);
  return {
    status: "completed",
    translations: Object.fromEntries(state.translations),
    snapshot,
    networkCalls: state.networkCalls,
    cacheHits: state.cacheHits,
    usage: {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    },
  };
}

/** Network goes through the injected client; credentials never enter events or logs. */
export function createTranslateService({
  client = createOpenAICompatibleClient(),
  cache = createMemoryTranslationCache(),
  now = () => new Date().toISOString(),
  idFactory = () => `run-${randomUUID()}`,
} = {}) {
  const runtime = { client, cache, now, idFactory };
  return { translateLanguage: (request) => translateLanguage(runtime, request) };
}
