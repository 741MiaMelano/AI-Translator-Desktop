import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeProviderBaseUrl } from "../provider/base-url.mjs";
import { toSafeProviderError } from "../provider/errors.mjs";
import {
  describeModelListError,
  normalizeModelListBaseUrl,
  resolveModelListStyle,
} from "../provider/model-list-client.mjs";
import { createLanguageTaskRunner } from "./language-task-runner.mjs";
import { buildEmptyResourceSnapshot } from "./run-snapshot.mjs";
import { buildTranslationResourceContext } from "./resource-context.mjs";
import { getTranslationProviderByName, resolveTranslationModelId } from "./provider-lookup.mjs";
import {
  planSelectedSegmentRerun,
  withSelectedSegmentCoverage,
} from "../../shared/selected-segment-rerun.mjs";

function hashProfile(profile) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

function resolveExecutionClient({ workerClient, client, translateService, modelsClient }) {
  if (workerClient) return workerClient;
  if (client && translateService) {
    const models = modelsClient ?? client;
    return {
      testConnection: (request) => client.testConnection(request),
      translateLanguage: (request) => translateService.translateLanguage(request),
      ...(typeof models?.listModels === "function"
        ? { listModels: (request) => models.listModels(request) }
        : {}),
    };
  }
  throw new Error("Translation worker is unavailable");
}

function createProjectRepoOpener({ openProjectRepository, projectsDir, projectMigrationsDir }) {
  const projectsRoot = resolve(projectsDir);
  const repoOptions = projectMigrationsDir ? { migrationsDir: projectMigrationsDir } : {};
  return (projectId) => {
    if (typeof projectId !== "string" || !/^[A-Za-z0-9._-]+$/.test(projectId)) {
      const error = new Error("Invalid project id");
      error.code = "INVALID_INPUT";
      throw error;
    }
    const projectDir = join(projectsRoot, projectId);
    if (!existsSync(join(projectDir, "project.sqlite"))) {
      const error = new Error("Project not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    return openProjectRepository(projectDir, repoOptions);
  };
}

function connectionProfile(definition, request, allowLoopbackHttp) {
  const credentialId = request.credentialId || definition.credentialId;
  const requestedModel = request.model || definition.models[0]?.label;
  const modelId = resolveTranslationModelId(definition, requestedModel);
  const baseUrl = request.baseUrl || definition.defaultBaseUrl;
  const transportMode = request.transportMode || definition.defaultTransport || "responses";
  const baseUrlDisplay = normalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp }).display;
  /**
   * 连接凭证只标识「这个接口地址 + 这把钥匙 + 这种传输方式，能不能通」。
   *
   * 模型**不参与**哈希。旧版把 requestedModel / modelId 也算进去，于是用户在项目里
   * 换一个模型，之前测过的连接立刻作废，又被要求去测一次——每换一次模型就得多花一次
   * token，而这次测试并不能验证任何新东西：钥匙和地址都没变。
   *
   * 模型是否可用，由第一次真实翻译请求暴露；那条路径会归类成 PROVIDER_* 错误，
   * 经 src/i18n/errors.ts 给出中文原因和可点的出口。
   */
  const endpoint = { providerId: definition.id, credentialId, baseUrlDisplay, transportMode };
  return {
    ...endpoint,
    requestedModel,
    modelId,
    profileKey: hashProfile(endpoint),
  };
}

function persistLanguageResult(openProjectRepo, payload) {
  const repo = openProjectRepo(payload.projectId);
  try {
    const snapshot = payload.selectedSegmentIds
      ? withSelectedSegmentCoverage(payload.snapshot, {
          mode: "selected_segments",
          segmentIds: payload.selectedSegmentIds,
        })
      : payload.snapshot;
    repo.commitTranslationResult({
      languageCode: payload.targetLanguage,
      translations: payload.translations,
      snapshot,
      selectedSegmentIds: payload.selectedSegmentIds,
      candidateTrackId: payload.candidateTrackId,
      task: payload.managedTaskId ? null : {
        id: `${payload.taskId}-history`,
        queueTaskId: payload.taskId,
        label: `Translate ${payload.targetLanguage}`,
        detail:
          payload.status === "failed"
            ? `failed:${payload.errorClass ?? "unknown"};partial=${Object.keys(payload.translations).length}`
            : `cacheHits=${snapshot.cacheHits}`,
        stage: "translate",
        status: payload.status,
        progress: payload.status === "completed" ? 1 : 0,
        targetLanguageCode: payload.targetLanguage,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt,
      },
      termConflictRules: payload.termConflictRules,
    });
  } finally {
    repo.close();
  }
}

function persistNonCompletedTask(openProjectRepo, projectId, event) {
  if (event.status !== "failed" || event.persisted) return;
  const repo = openProjectRepo(projectId);
  try {
    repo.appendTaskHistory({
      id: `${event.taskId}-history`,
      queueTaskId: event.taskId,
      label: `Translate ${event.targetLanguage}`,
      detail: `failed:${event.errorClass ?? "unknown"}`,
      stage: "translate",
      status: event.status,
      progress: event.progress,
      targetLanguageCode: event.targetLanguage,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    });
  } finally {
    repo.close();
  }
}

function loadProjectState(openProjectRepo, projectId) {
  const repo = openProjectRepo(projectId);
  try {
    return {
      project: repo.loadProject(),
      projectResourceSnapshots: repo.listResourceSnapshots(),
    };
  } finally {
    repo.close();
  }
}

async function testProviderConnection(runtime, request) {
  try {
    const definition = getTranslationProviderByName(request.provider);
    if (!definition?.v1TranslationEnabled) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Provider is not available",
          details: { providerErrorClass: "invalid_config" },
        },
      };
    }
    const profile = connectionProfile(definition, request, runtime.allowLoopbackHttp);
    const result = await runtime.executionClient.testConnection({
      baseUrl: request.baseUrl || definition.defaultBaseUrl,
      apiKey: runtime.revealSecret(profile.credentialId),
      transportMode: profile.transportMode,
      // 执行侧按 profile 选择客户端（Anthropic Messages / OpenAI 兼容）。
      providerProfile: definition.profile,
      model: profile.modelId,
      timeoutMs: request.timeoutMs ?? 15_000,
    });
    // 保留此前「拉取模型」的结果。
    // 仓储层写的是 configuredModels ?? [modelId]，不带上它的话，
    // 测一次连接就会把整份型号列表替换成刚测的那一个模型。
    const previous = runtime.loadProviderReadiness(definition.id);
    runtime.saveProviderReadiness({
      ...profile,
      providerName: definition.name,
      status: "ready",
      testedAt: new Date().toISOString(),
      configuredModels: previous?.configuredModels ?? [],
    });
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: toSafeProviderError(error) };
  }
}

function modelListError(code, message, providerErrorClass) {
  return { ok: false, error: { code, message, details: { providerErrorClass } } };
}

/**
 * Fetches the provider's own model catalog so users never hand-type a model id.
 * The base URL is validated before any secret is revealed, and the secret only
 * travels to the execution client — never into a result, log, or error message.
 */
async function listProviderModels(runtime, request) {
  try {
    const definition = getTranslationProviderByName(request.provider);
    if (!definition?.v1TranslationEnabled) {
      return modelListError("INVALID_INPUT", "该服务商当前不可用", "invalid_config");
    }
    const style = resolveModelListStyle(definition);
    if (!style) {
      return modelListError("INVALID_INPUT", "该服务商不支持自动获取模型列表", "invalid_config");
    }
    if (typeof runtime.executionClient.listModels !== "function") {
      return modelListError("INTERNAL", "模型列表服务不可用", "unknown");
    }
    const baseUrl = request.baseUrl || definition.defaultBaseUrl;
    const normalized = normalizeModelListBaseUrl(baseUrl, {
      allowLoopbackHttp: runtime.allowLoopbackHttp,
    });
    const credentialId = request.credentialId || definition.credentialId;
    let apiKey;
    try {
      apiKey = runtime.revealSecret(credentialId);
    } catch (error) {
      if (error?.code !== "NOT_FOUND") throw error;
      return modelListError("INVALID_INPUT", "尚未保存该服务商的 API 密钥", "auth");
    }
    const result = await runtime.executionClient.listModels({
      baseUrl,
      apiKey,
      style,
      timeoutMs: request.timeoutMs ?? 15_000,
    });
    const models = Array.isArray(result?.models) ? result.models : [];

    /*
     * 把拉到的模型写进该服务商的 readiness。
     *
     * 旧版拉取结果只活在「模型与连接」页的局部 state 里，一离开页面就没了，
     * 于是项目页的模型下拉永远只有注册表里那几个内置兜底型号——
     * 用户拉到了 deepseek-v4，回到项目里却只能选 deepseek-chat。
     *
     * buildTranslationCapabilityCatalog 会优先用 configuredModels，
     * 所以写到这里之后，渲染层各处的下拉就都能看到真实型号。
     */
    if (models.length > 0) {
      const previous = runtime.loadProviderReadiness(definition.id);
      runtime.saveProviderReadiness({
        ...(previous ?? { providerId: definition.id, providerName: definition.name, status: "untested" }),
        configuredModels: models.map((model) => model.id).filter(Boolean),
        modelsFetchedAt: new Date().toISOString(),
      });
    }

    return {
      ok: true,
      data: {
        providerId: definition.id,
        providerName: definition.name,
        baseUrlDisplay: result?.baseUrlDisplay ?? normalized.display,
        models,
        truncated: Boolean(result?.truncated),
      },
    };
  } catch (error) {
    const safe = toSafeProviderError(error);
    return {
      ok: false,
      error: {
        ...safe,
        message: describeModelListError(safe.details.providerErrorClass, safe.message),
      },
    };
  }
}

function buildExistingLayers(sourceTrack, targetLanguages) {
  return Object.fromEntries(
    targetLanguages.map((language) => [
      language,
      Object.fromEntries(
        sourceTrack.segments.map((segment) => [segment.id, segment.targetTexts?.[language] ?? null]),
      ),
    ]),
  );
}

function summarizeResults(results) {
  return results.map((result) => ({
    targetLanguage: result.targetLanguage,
    status: result.status,
    cacheHits: result.cacheHits ?? 0,
    networkCalls: result.networkCalls ?? 0,
    snapshotId: result.snapshot?.id ?? null,
    reason: result.reason ?? null,
    errorClass: result.error?.providerErrorClass ?? null,
  }));
}

function resourceContextsForProject(project, snapshots, targetLanguages) {
  return Object.fromEntries(targetLanguages.map((targetLanguage) => [
    targetLanguage,
    buildTranslationResourceContext({
      snapshots,
      glossarySelection: project.config.glossary,
      styleGuideSelection: project.config.styleGuide,
      sourceLanguageCode: project.config.sourceLanguage,
      targetLanguageCode: targetLanguage,
    }),
  ]));
}

function prepareTranslationScope({ request, sourceTrack, targetLanguages }) {
  if ((request.segmentIds || request.candidateTrackId) && targetLanguages.length !== 1) {
    return { ok: false, message: "Focused translation requires exactly one target language" };
  }
  if (request.segmentIds && request.candidateTrackId) {
    return { ok: false, message: "Selected rerun cannot target a candidate track" };
  }
  let segments = sourceTrack.segments;
  let contextSegments = [];
  let selectedSegmentIds = null;
  let existingTargetLayersByLanguage = buildExistingLayers(sourceTrack, targetLanguages);
  let parameters = request.parameters ?? { temperature: 0.2 };
  if (request.segmentIds) {
    const plan = planSelectedSegmentRerun({
      segments: sourceTrack.segments,
      selectedSegmentIds: request.segmentIds,
      languageCode: targetLanguages[0],
    });
    if (!plan.ok) return { ok: false, message: plan.reason };
    segments = plan.requestSegments;
    contextSegments = plan.contextSegments;
    selectedSegmentIds = plan.requestSegmentIds;
    existingTargetLayersByLanguage = {
      [targetLanguages[0]]: Object.fromEntries(selectedSegmentIds.map((id) => [id, null])),
    };
    parameters = { ...parameters, coverage: plan.coverage };
  }
  if (request.candidateTrackId) {
    const candidate = sourceTrack.targetTracks.find(
      (track) => track.id === request.candidateTrackId && track.role === "candidate",
    );
    if (!candidate || candidate.languageCode !== targetLanguages[0]) {
      return { ok: false, message: "Candidate target track not found" };
    }
    existingTargetLayersByLanguage = { [targetLanguages[0]]: {} };
  }
  return {
    ok: true,
    segments,
    contextSegments,
    selectedSegmentIds,
    existingTargetLayersByLanguage,
    parameters,
  };
}

async function translateProject(runtime, request) {
  try {
    const { project, projectResourceSnapshots } = loadProjectState(runtime.openProjectRepo, request.projectId);
    if (!project) return { ok: false, error: { code: "NOT_FOUND", message: "Project not found" } };
    const definition = getTranslationProviderByName(request.provider || project.config.provider);
    if (!definition?.v1TranslationEnabled) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Provider is not available for translation",
          details: { providerErrorClass: "invalid_config" },
        },
      };
    }
    const profile = connectionProfile(
      definition,
      { ...request, model: request.model || project.config.model },
      runtime.allowLoopbackHttp,
    );
    /*
     * 连接未验证时**自动验证一次**，而不是把用户打发去另一个页面。
     *
     * 用户点的是「开始翻译」——这本来就是一次付费动作，替他先发一个很短的
     * 探测请求完全在他的授权范围内。旧版在这里直接拒绝，用户要跳到「模型与连接」
     * 手动点一次测试再跳回来，等于为了一次探测走了三个页面。
     *
     * 保护作用没有丢：探测失败依旧不会开跑，只是失败原因来自真实响应
     * （PROVIDER_AUTH / PROVIDER_NETWORK 等），比"你还没测过"有用得多。
     */
    let readiness = runtime.loadProviderReadiness(definition.id);
    if (readiness?.status !== "ready" || readiness.profileKey !== profile.profileKey) {
      const verified = await testProviderConnection(runtime, {
        provider: definition.name,
        credentialId: profile.credentialId,
        baseUrl: request.baseUrl,
        model: profile.modelId,
        transportMode: profile.transportMode,
      });
      if (!verified.ok) return verified;
      readiness = runtime.loadProviderReadiness(definition.id);
    }
    const sourceTrack = project.sourceTracks.find((track) => track.id === project.activeSourceTrackId)
      || project.sourceTracks[0];
    if (!sourceTrack) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Source track missing" } };
    }
    const targetLanguages = request.targetLanguages ?? project.config.targetLanguages;
    const scope = prepareTranslationScope({ request, sourceTrack, targetLanguages });
    if (!scope.ok) return { ok: false, error: { code: "INVALID_INPUT", message: scope.message } };
    const {
      segments, contextSegments, selectedSegmentIds, existingTargetLayersByLanguage, parameters,
    } = scope;
    const resourceContextsByLanguage = resourceContextsForProject(project, projectResourceSnapshots, targetLanguages);
    const { results } = await runtime.runner.runLanguages({
      projectId: project.id,
      sourceTrackId: sourceTrack.id,
      targetLanguages,
      providerId: definition.id,
      // 执行侧按 profile 选择客户端（Anthropic Messages / OpenAI 兼容）。
      providerProfile: definition.profile,
      model: profile.modelId,
      baseUrl: request.baseUrl || definition.defaultBaseUrl,
      transportMode: profile.transportMode,
      apiKey: runtime.revealSecret(profile.credentialId),
      segments,
      projectSegments: sourceTrack.segments,
      contextSegments,
      existingTargetLayersByLanguage,
      resumeExistingTargetText: request.resumeExistingTargetText === true,
      parameters,
      resourceSnapshot: buildEmptyResourceSnapshot(),
      resourceContextsByLanguage,
      operationId: request.operationId,
      // 返回值要原样透出：暂停时上层返回的是一个「等到用户点继续」的 promise。
      onTaskEvent: (event) => {
        const pending = request.onTaskEvent?.(event);
        if (!request.managedTaskId) persistNonCompletedTask(runtime.openProjectRepo, project.id, event);
        return pending;
      },
      persistResult: (payload) => persistLanguageResult(runtime.openProjectRepo, {
        ...payload,
        managedTaskId: request.managedTaskId,
        selectedSegmentIds,
        candidateTrackId: request.candidateTrackId ?? null,
      }),
    });
    return { ok: true, data: { projectId: project.id, results: summarizeResults(results) } };
  } catch (error) {
    return { ok: false, error: toSafeProviderError(error) };
  }
}

/**
 * project_task_history 是**追加式**的：一个任务每换一次状态就多一行
 * （pending「Queued」→ running「Running」→ completed「Completed」），
 * 行的主键是 `${taskId}:${sequence}`，不是任务本身的 id。
 *
 * 直接把这些行当成任务返回，界面上一个任务会变成三个，
 * 其中两个永远停在 pending / running 0%——这就是「翻译早就完了，
 * 进度条还在转」的成因。这里按 queueTaskId 归并，只保留 sequence 最大的那一行，
 * 并把 id 还原成队列里的任务 id，好让暂停/继续/取消能找得到它。
 */
function collapseTaskHistory(rows, projectId) {
  const latest = new Map();
  for (const row of rows) {
    const taskId = row.queueTaskId || row.id;
    const previous = latest.get(taskId);
    const isNewer = !previous
      || (row.sequence ?? 0) > (previous.sequence ?? 0)
      || ((row.sequence ?? 0) === (previous.sequence ?? 0)
        && String(row.recordedAt ?? row.updatedAt ?? "") > String(previous.recordedAt ?? previous.updatedAt ?? ""));
    if (isNewer) latest.set(taskId, { ...row, id: taskId, projectId });
  }
  return [...latest.values()].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getProjectRuntimeState(openProjectRepo, { projectId }) {
  const repo = openProjectRepo(projectId);
  try {
    return {
      ok: true,
      data: {
        projectId,
        runSnapshots: repo.listRunSnapshots(),
        tasks: collapseTaskHistory(repo.listTaskHistory(), projectId),
      },
    };
  } finally {
    repo.close();
  }
}

function getProviderRuntimeState(loadProviderReadiness, { provider }) {
  const definition = getTranslationProviderByName(provider);
  if (!definition) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Provider is not available" } };
  }
  return {
    ok: true,
    data: loadProviderReadiness(definition.id) ?? {
      providerId: definition.id,
      providerName: definition.name,
      status: "untested",
    },
  };
}

/** Application service; secrets are revealed only after exact-profile readiness passes. */
export function createDesktopTranslationPort(options) {
  const executionClient = resolveExecutionClient(options);
  const openProjectRepo = createProjectRepoOpener(options);
  const runner = createLanguageTaskRunner({
    translateService: { translateLanguage: (request) => executionClient.translateLanguage(request) },
    persistLanguageResult: (payload) => persistLanguageResult(openProjectRepo, payload),
  });
  const runtime = {
    executionClient,
    openProjectRepo,
    runner,
    revealSecret: options.revealSecret,
    allowLoopbackHttp: options.allowLoopbackHttp ?? false,
    loadProviderReadiness: options.loadProviderReadiness ?? (() => null),
    saveProviderReadiness: options.saveProviderReadiness ?? (() => {}),
  };
  return {
    testProviderConnection: (request) => testProviderConnection(runtime, request),
    listProviderModels: (request) => listProviderModels(runtime, request),
    translateProject: (request) => translateProject(runtime, request),
    getProjectRuntimeState: (request) => getProjectRuntimeState(openProjectRepo, request),
    getProviderRuntimeState: (request) =>
      getProviderRuntimeState(runtime.loadProviderReadiness, request),
  };
}
