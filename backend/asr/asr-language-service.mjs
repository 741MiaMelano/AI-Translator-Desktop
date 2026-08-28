import { classifySegmentLanguages } from "./language-detection.mjs";

const MESSAGES = Object.freeze({
  INVALID_INPUT: "ASR language request is invalid",
  NOT_FOUND: "ASR candidate not found",
  NOT_AVAILABLE: "A required ASR component is not installed",
  INVALID_ARTIFACT: "A verified ASR or media artifact is invalid",
  PROCESS_FAILED: "ASR language subprocess failed",
  OUTPUT_TOO_LARGE: "Language detection input exceeds the supported limit",
  CONFLICT: "ASR language state conflicts with the project",
  CANCELLED: "ASR language detection was cancelled",
  TIMEOUT: "ASR language detection timed out",
  WORKER_CRASHED: "ASR language worker stopped unexpectedly",
  CUDA_UNAVAILABLE: "CUDA ASR is unavailable",
  INVALID_ASR_RESULT: "ASR language evidence is invalid",
  INTERNAL: "ASR language operation failed",
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

function milliseconds(value) {
  const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(value ?? "");
  if (!match) throw fail("INVALID_INPUT");
  const [, hours, minutes, seconds, ms] = match.map(Number);
  if (minutes > 59 || seconds > 59) throw fail("INVALID_INPUT");
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + ms;
}

function candidate(repo, projectId, sourceTrackId) {
  const project = repo.loadProject();
  const track = project?.sourceTracks?.find((item) => item.id === sourceTrackId);
  if (!project || project.id !== projectId || !track || track.kind !== "asr" || !track.asrRunId) throw fail("NOT_FOUND");
  return { project, track };
}

function storedEvidence(segments) {
  return segments.map((segment) => {
    if (!segment.detectedLanguage || !segment.languageDetectionMethod || !segment.languageDetectionVersion || !segment.languageOverlapStatus) {
      throw fail("INVALID_INPUT");
    }
    return {
      segmentId: segment.id,
      detectedLanguage: segment.detectedLanguage,
      confidence: segment.languageConfidence,
      detectionMethod: segment.languageDetectionMethod,
      detectionVersion: segment.languageDetectionVersion,
      overlapStatus: segment.languageOverlapStatus,
    };
  });
}

export function createAsrLanguageService({
  getProjectRepository,
  detectRegion,
  now = () => new Date().toISOString(),
}) {
  if (typeof getProjectRepository !== "function" || typeof detectRegion !== "function" || typeof now !== "function") {
    throw fail("INVALID_INPUT");
  }

  function commit(repo, track, classified) {
    return repo.commitAsrLanguageState({
      sourceTrackId: track.id,
      segments: classified.segments,
      languageState: classified.languageState,
      defaultLanguage: classified.defaultLanguage,
      updatedAt: now(),
    });
  }

  return {
    async detect(request) {
      try {
        const projectId = safeId(request?.projectId);
        const sourceTrackId = safeId(request?.sourceTrackId);
        const repo = getProjectRepository(projectId);
        const { track } = candidate(repo, projectId, sourceTrackId);
        const evidence = [];
        for (const segment of track.segments) {
          evidence.push(await detectRegion({
            operationId: safeId(request?.operationId ?? `language-${sourceTrackId}`),
            requestedDevice: request?.requestedDevice ?? "cpu",
            allowCudaFallback: request?.allowCudaFallback ?? false,
            projectId,
            asrRunId: track.asrRunId,
            sourceTrackId,
            segmentId: segment.id,
            startMs: milliseconds(segment.start),
            endMs: milliseconds(segment.end),
          }));
        }
        const classified = classifySegmentLanguages({
          segments: track.segments,
          evidence,
          previousLanguageState: track.languageState,
        });
        return { ...commit(repo, track, classified), pendingSegmentIds: classified.pendingSegmentIds };
      } catch (error) {
        throw fail(MESSAGES[error?.code] ? error.code : "INTERNAL");
      }
    },
    updateManual(request) {
      try {
        const projectId = safeId(request?.projectId);
        const sourceTrackId = safeId(request?.sourceTrackId);
        if (!Array.isArray(request?.changes) || !request.changes.length || request.changes.length > 20_000 ||
          typeof request?.confirmTrackConvergence !== "boolean") throw fail("INVALID_INPUT");
        const changeIds = new Set();
        for (const change of request.changes) {
          safeId(change?.segmentId);
          if (changeIds.has(change.segmentId) || (change.manualLanguage !== null && typeof change.manualLanguage !== "string")) {
            throw fail("INVALID_INPUT");
          }
          changeIds.add(change.segmentId);
        }
        const repo = getProjectRepository(projectId);
        const { track } = candidate(repo, projectId, sourceTrackId);
        if ([...changeIds].some((id) => !track.segments.some((segment) => segment.id === id))) throw fail("INVALID_INPUT");
        const segments = track.segments.map((segment) => {
          const change = request.changes.find((item) => item.segmentId === segment.id);
          if (!change) return segment;
          const value = { ...segment };
          if (change.manualLanguage === null) delete value.manualLanguage;
          else value.manualLanguage = change.manualLanguage;
          return value;
        });
        const classified = classifySegmentLanguages({
          segments,
          evidence: storedEvidence(track.segments),
          previousLanguageState: track.languageState,
          confirmTrackConvergence: request.confirmTrackConvergence,
        });
        return {
          ...commit(repo, track, classified),
          affectedSegmentIds: request.changes.map((change) => change.segmentId),
          pendingSegmentIds: classified.pendingSegmentIds,
        };
      } catch (error) {
        throw fail(MESSAGES[error?.code] ? error.code : "INTERNAL");
      }
    },
  };
}
