const MESSAGES = Object.freeze({
  INVALID_INPUT: "ASR project request is invalid",
  NOT_FOUND: "ASR project was not found",
  CONFLICT: "ASR project operation conflicts with existing work",
  CANCELLED: "ASR project operation was cancelled",
  NOT_AVAILABLE: "ASR project services are unavailable",
  INTERNAL: "ASR project operation failed",
});

function fail(code) {
  const error = new Error(MESSAGES[code] ?? MESSAGES.INTERNAL);
  error.code = MESSAGES[code] ? code : "INTERNAL";
  return error;
}

function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail("INVALID_INPUT");
  return value;
}

function publicRun(run) {
  return {
    id: run.id,
    audioStreamId: run.audioStreamId,
    modelId: run.modelId,
    actualDevice: run.actualDevice,
    fallbackReason: run.fallbackReason,
    mediaDurationMs: run.mediaDurationMs,
    processingDurationMs: run.processingDurationMs,
    rawSegmentCount: run.rawSegmentCount,
    wordCount: run.wordCount,
    detectedLanguage: run.detectedLanguage,
    completedAt: run.completedAt,
  };
}

export function createAsrProjectService({
  getProjectRepository,
  getCapabilityStatus,
  getDeviceStatus,
  asrService,
  candidateService,
  languageService,
  languageRegionDetector,
  persistProject = () => {},
}) {
  const dependencies = [getProjectRepository, getCapabilityStatus, getDeviceStatus, persistProject,
    asrService?.run, asrService?.cancel, candidateService?.segment, candidateService?.cancel,
    languageService?.detect, languageService?.updateManual, languageRegionDetector?.finish, languageRegionDetector?.cancel];
  if (dependencies.some((value) => typeof value !== "function")) throw fail("INVALID_INPUT");
  const activeOwners = new Map();

  function repository(projectId) {
    safeId(projectId);
    const repo = getProjectRepository(projectId);
    const project = repo.loadProject();
    if (!project || project.id !== projectId) throw fail("NOT_FOUND");
    return { repo, project };
  }

  async function withActive(request, work) {
    const projectId = safeId(request?.projectId);
    const operationId = safeId(request?.operationId);
    const owner = activeOwners.get(operationId);
    if (owner && owner.projectId !== projectId) throw fail("CONFLICT");
    const active = owner ?? { projectId, count: 0 };
    active.count += 1;
    activeOwners.set(operationId, active);
    try {
      return await work();
    } finally {
      const current = activeOwners.get(operationId);
      if (current === active) {
        current.count -= 1;
        if (current.count === 0) activeOwners.delete(operationId);
      }
    }
  }

  function refreshed(projectId, result) {
    const { project } = repository(projectId);
    persistProject(project);
    return { ...result, project };
  }

  return {
    isBusy: () => activeOwners.size > 0,
    async getStatus({ projectId }) {
      const { repo, project } = repository(projectId);
      const [capability, device] = await Promise.all([getCapabilityStatus(), getDeviceStatus()]);
      return {
        project,
        capability,
        device,
        runs: repo.listAsrRuns().slice(-100).reverse().map(publicRun),
      };
    },
    transcribe(request) {
      repository(request?.projectId);
      return withActive(request, () => asrService.run(request));
    },
    segment(request) {
      repository(request?.projectId);
      return withActive(request, async () => refreshed(request.projectId, await candidateService.segment(request)));
    },
    detectLanguages(request) {
      repository(request?.projectId);
      return withActive(request, async () => {
        try {
          return refreshed(request.projectId, await languageService.detect(request));
        } finally {
          await languageRegionDetector.finish(request.operationId);
        }
      });
    },
    updateLanguages(request) {
      repository(request?.projectId);
      return Promise.resolve(refreshed(request.projectId, languageService.updateManual(request)));
    },
    async cancel({ projectId, operationId }) {
      safeId(projectId);
      safeId(operationId);
      if (activeOwners.get(operationId)?.projectId !== projectId) return { cancelled: false };
      const results = await Promise.allSettled([
        asrService.cancel({ operationId }),
        candidateService.cancel({ operationId }),
        languageRegionDetector.cancel({ operationId }),
      ]);
      return { cancelled: results.some((result) => result.status === "fulfilled" && result.value?.cancelled) };
    },
  };
}
