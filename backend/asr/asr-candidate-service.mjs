import { createHash } from "node:crypto";
import { segmentAsrResultAsync } from "./segmentation.mjs";

const PUBLIC_MESSAGES = Object.freeze({
  INVALID_INPUT: "ASR segmentation request is invalid",
  INVALID_ASR_RESULT: "Stored ASR result is invalid",
  UNSEGMENTABLE_INPUT: "ASR words cannot satisfy the subtitle limits",
  NOT_FOUND: "Completed ASR run not found",
  CONFLICT: "ASR candidate conflicts with existing project data",
  CANCELLED: "ASR segmentation was cancelled",
  INTERNAL: "ASR segmentation failed",
});

function fail(code) {
  const error = new Error(PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES.INTERNAL);
  error.code = PUBLIC_MESSAGES[code] ? code : "INTERNAL";
  return error;
}

function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw fail("INVALID_INPUT");
  return value;
}

function stableId(prefix, ...parts) {
  return `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20)}`;
}

function timestamp(ms) {
  const milliseconds = ms % 1_000;
  const secondsTotal = Math.floor(ms / 1_000);
  const seconds = secondsTotal % 60;
  const minutesTotal = Math.floor(secondsTotal / 60);
  const minutes = minutesTotal % 60;
  const hours = Math.floor(minutesTotal / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function materialize({ asrRun, segmentation, targetLanguages }) {
  const trackId = stableId("asr-candidate", asrRun.run.id, segmentation.configVersion);
  const targetTracks = targetLanguages.map((language) => ({
    id: stableId("asr-target", trackId, language),
    languageCode: language,
    languageLabel: language,
    status: "draft",
    isActive: true,
    qaIssues: [],
    snapshotIds: [],
    deliveryLabel: "未翻译",
    lastHumanAction: "asr_segmented",
  }));
  const uncertainSongIntervals = asrRun.result?.songActivity?.uncertainIntervals ?? [];
  const emptyTargets = (segment) => Object.fromEntries(targetLanguages.map((language) => [language, {
    model: "",
    postProcessed: "",
    qaFlags: uncertainSongIntervals.some((interval) =>
      segment.startMs < interval.endMs && segment.endMs > interval.startMs)
      ? ["suspected-lyrics"]
      : [],
  }]));
  const qwenLanguages = asrRun.run.engineId === "qwen3-asr"
    ? new Set(segmentation.segments.map((segment) => segment.sourceLanguage).filter((language) => language !== "und"))
    : new Set();
  const qwenLanguageState = qwenLanguages.size > 1 ? "multilingual" : qwenLanguages.size === 1 ? "known" : "pending";
  return {
    id: trackId,
    label: `ASR candidate · ${segmentation.configVersion}`,
    kind: "asr",
    languageState: qwenLanguageState,
    defaultLanguage: qwenLanguageState === "known" ? qwenLanguages.values().next().value : "auto",
    isActive: false,
    summary: `${segmentation.segments.length} segments · ${asrRun.run.modelId} · ${asrRun.run.actualDevice}`,
    sourceStreamId: asrRun.run.audioStreamId,
    asrRunId: asrRun.run.id,
    segmentationConfigVersion: segmentation.configVersion,
    segments: segmentation.segments.map((segment) => ({
      id: segment.id,
      start: timestamp(segment.startMs),
      end: timestamp(segment.endMs),
      sourceLanguage: segment.sourceLanguage,
      sourceText: segment.sourceText,
      targetTexts: emptyTargets(segment),
    })),
    targetTracks,
  };
}

export function createAsrCandidateService({
  getProjectRepository,
  now = () => new Date().toISOString(),
}) {
  if (typeof getProjectRepository !== "function" || typeof now !== "function") throw fail("INVALID_INPUT");
  const active = new Map();
  return {
    async segment(request) {
      let operationId;
      let token;
      try {
        const projectId = safeId(request?.projectId);
        const asrRunId = safeId(request?.asrRunId);
        operationId = safeId(request?.operationId ?? `segment-${asrRunId}`);
        if (active.has(operationId)) throw fail("CONFLICT");
        token = { cancelled: false };
        active.set(operationId, { projectId, token });
        const repo = getProjectRepository(projectId);
        const project = repo.loadProject();
        const asrRun = repo.getAsrRun(asrRunId);
        if (!project || project.id !== projectId || !asrRun || asrRun.run.projectId !== projectId) throw fail("NOT_FOUND");
        const segmentation = await segmentAsrResultAsync({
          runId: asrRunId,
          result: asrRun.result,
          configVersion: request?.configVersion,
          isCancelled: () => token.cancelled,
        });
        return repo.commitAsrCandidate({
          asrRunId,
          configVersion: segmentation.configVersion,
          sourceTrack: materialize({ asrRun, segmentation, targetLanguages: project.config.targetLanguages }),
          updatedAt: now(),
        });
      } catch (error) {
        throw fail(PUBLIC_MESSAGES[error?.code] ? error.code : "INTERNAL");
      } finally {
        if (operationId && active.get(operationId)?.token === token) active.delete(operationId);
      }
    },
    async cancel({ operationId }) {
      safeId(operationId);
      const current = active.get(operationId);
      if (!current) return { cancelled: false };
      current.token.cancelled = true;
      return { cancelled: true };
    },
  };
}
