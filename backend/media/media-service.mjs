import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { MEDIA_ERROR_CODES } from "./constants.mjs";
import { probeMediaFile } from "./probe.mjs";
import { recommendStreams } from "./stream-recommendation.mjs";
import {
  activateSourceTrack,
  attachCandidateSourceTrack,
  extractEmbeddedSubtitle,
} from "./extract-subtitle.mjs";
import { validateMediaProbe } from "../../shared/media-probe.mjs";
import { planBatchGroups } from "../../shared/batch-grouping.mjs";
import { buildImportedSubtitleProject } from "../subtitle/project-factory.mjs";
import { parseSubtitleBytes } from "../subtitle/parse.mjs";
import { extractAudioTrack } from "./extract-audio.mjs";
import { extractWaveform } from "./waveform.mjs";

const SUBTITLE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

function mediaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fingerprintFromProbe(probe) {
  const canonical = {
    mediaKind: probe.mediaKind,
    formatName: probe.format?.formatName ?? null,
    durationMs: probe.format?.durationMs ?? null,
    streams: (probe.streams || []).map((s) => ({
      index: s.index,
      kind: s.kind,
      codec: s.codec,
      language: s.language,
      default: s.default,
      forced: s.forced,
      width: s.width,
      height: s.height,
      channels: s.channels,
      sampleRate: s.sampleRate,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

function assertSafeMediaFile(absolutePath) {
  if (typeof absolutePath !== "string" || !isAbsolute(absolutePath)) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Media path is invalid");
  }
  let st;
  try {
    st = lstatSync(absolutePath);
  } catch {
    throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Media file is not readable");
  }
  if (st.isSymbolicLink?.() || st.isDirectory()) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Media path must be a regular file");
  }
  // Windows reparse/junction: reject if realpath escapes oddly via read failure
  try {
    st = statSync(absolutePath);
  } catch {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Media path is not readable");
  }
  if (!st.isFile()) {
    throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Media path must be a regular file");
  }
  return st;
}

async function copyFileStreaming(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  const temp = `${to}.${randomUUID()}.partial`;
  try {
    await pipeline(createReadStream(from), createWriteStream(temp));
    renameSync(temp, to);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function validStreamId(probe, streamId, kind) {
  return streamId && probe?.streams?.some((stream) => stream.streamId === streamId && stream.kind === kind)
    ? streamId
    : null;
}

function toMediaSourceSummary({
  displayName,
  availability,
  identity,
  selectedAudioStreamId,
  selectedSubtitleStreamId,
  confirmedAudioStreamId,
  confirmedSubtitleStreamId,
}) {
  return {
    assetId: "primary",
    displayName,
    availability,
    identity,
    selectedAudioStreamId: selectedAudioStreamId ?? null,
    selectedSubtitleStreamId: selectedSubtitleStreamId ?? null,
    confirmedAudioStreamId: confirmedAudioStreamId ?? null,
    confirmedSubtitleStreamId: confirmedSubtitleStreamId ?? null,
  };
}

export function createMediaService({
  resolveArtifacts,
  getProjectRepository,
  openFileDialog,
  persistProject = null,
  persistBatchProjects = null,
  runProcess,
  cancelProcess,
}) {
  const batchSessions = new Map();
  const waveformCache = new Map();

  function commitProject(repo, project) {
    repo.saveProject(project);
    if (typeof persistProject === "function") {
      const loaded = repo.loadProject();
      persistProject(loaded || project);
    }
  }
  async function resolveTools() {
    try {
      return resolveArtifacts();
    } catch (error) {
      if (error?.code === "not_available" || error?.code === MEDIA_ERROR_CODES.NOT_AVAILABLE) {
        throw mediaError(MEDIA_ERROR_CODES.NOT_AVAILABLE, "Managed FFmpeg artifacts are not available");
      }
      if (error?.code === "invalid_artifact" || error?.code === MEDIA_ERROR_CODES.INVALID_ARTIFACT) {
        throw mediaError(MEDIA_ERROR_CODES.INVALID_ARTIFACT, "Managed FFmpeg artifacts failed verification");
      }
      throw mediaError(MEDIA_ERROR_CODES.NOT_AVAILABLE, "Managed FFmpeg artifacts are not available");
    }
  }

  function operationRunner(operationId) {
    return runProcess
      ? (payload) => runProcess({ ...payload, ...(operationId ? { operationId } : {}) })
      : undefined;
  }

  async function probePath(absolutePath, tools, operationId) {
    assertSafeMediaFile(absolutePath);
    const probe = await probeMediaFile({
      ffprobePath: tools.ffprobePath,
      inputPath: absolutePath,
      upstreamVersion: tools.upstreamVersion,
      runProcess: operationRunner(operationId),
    });
    return validateMediaProbe(probe);
  }

  function buildMediaDraft({ sourcePath, sourceStat, probe, defaults = {}, title }) {
    const displayName = basename(sourcePath);
    const recommendation = recommendStreams(probe, {
      preferredSourceLanguage: defaults.sourceLanguage || null,
    });
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const project = {
      id: `project-${randomUUID()}`,
      title: title || displayName.replace(/\.[^.]+$/, "") || displayName,
      sourceFileName: displayName,
      mediaKind: probe.mediaKind,
      noSourceMedia: false,
      lifecycle: "draft",
      createdAt: stamp,
      updatedAt: stamp,
      activeSourceTrackId: null,
      pendingConfirmations: recommendation.subtitle.requiresConfirmation
        ? ["confirm subtitle stream selection"]
        : [],
      notes: [],
      recentRunIds: [],
      config: {
        sourceLanguage: defaults.sourceLanguage || "auto",
        targetLanguages: defaults.targetLanguages?.length ? defaults.targetLanguages : ["zh-CN"],
        provider: defaults.provider || "OpenAI",
        model: defaults.model || "GPT-4.1",
        glossary: defaults.glossary || "default-glossary",
        styleGuide: defaults.styleGuide || "default-style",
        outputFormat: defaults.outputFormat || "SRT",
        burnVideo: false,
        copyMediaIntoProject: false,
      },
      sourceTracks: [],
      sourceProbeSummary: { media: probe },
      mediaSource: toMediaSourceSummary({
        displayName,
        availability: "available",
        identity: {
          sizeBytes: sourceStat.size,
          mtimeMs: Math.trunc(sourceStat.mtimeMs),
          fingerprint: fingerprintFromProbe(probe),
        },
        selectedAudioStreamId: recommendation.audio.streamId,
        selectedSubtitleStreamId: recommendation.subtitle.streamId,
      }),
      _internalMediaOriginalPath: sourcePath,
    };
    return { project, recommendation };
  }

  async function createBatchSession({ filePaths }) {
    if (!Array.isArray(filePaths) || filePaths.length < 1 || filePaths.length > 200) {
      throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "File selection must contain 1 to 200 files");
    }
    const sessionId = `batch-${randomUUID()}`;
    const tools = await resolveTools();
    const privatePaths = new Map();
    const files = [];

    for (const [index, absolutePath] of filePaths.entries()) {
      const sourceStat = assertSafeMediaFile(absolutePath);
      const probe = await probePath(absolutePath, tools, `${sessionId}-probe-${index + 1}`);
      if (!["video", "audio", "subtitle"].includes(probe.mediaKind)) {
        throw mediaError(MEDIA_ERROR_CODES.UNSUPPORTED, "Selected batch contains an unsupported file");
      }
      const id = `batch-file-${randomUUID()}`;
      privatePaths.set(id, absolutePath);
      let encodingCandidates;
      if (probe.mediaKind === "subtitle") {
        if (sourceStat.size > SUBTITLE_IMPORT_MAX_BYTES) {
          throw mediaError(MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE, "Subtitle file is too large");
        }
        const parsed = parseSubtitleBytes({
          fileName: basename(absolutePath),
          bytes: readFileSync(absolutePath),
        });
        if (!parsed.ok && parsed.needsEncodingConfirmation) {
          encodingCandidates = parsed.encodingCandidates;
        }
      }
      files.push({
        id,
        name: basename(absolutePath),
        mediaKind: probe.mediaKind,
        probe,
        ...(encodingCandidates?.length ? { encodingCandidates } : {}),
      });
    }

    const plan = planBatchGroups(files);
    const groups = plan.groups.map((suggestion) => {
      const groupedFiles = suggestion.fileIds.map((id) => files.find((file) => file.id === id));
      const primary = groupedFiles.find((file) => file.mediaKind === "video")
        ?? groupedFiles.find((file) => file.mediaKind === "audio")
        ?? groupedFiles[0];
      return {
        id: `batch-group-${randomUUID()}`,
        title: primary.name.replace(/\.[^.]+$/, "") || primary.name,
        ...suggestion,
      };
    });
    const session = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      files,
      groups,
      ambiguities: [
        ...plan.ambiguities,
        ...files.flatMap((file) => file.encodingCandidates?.length ? [{
          kind: "subtitle_encoding",
          fileId: file.id,
          encodingCandidates: file.encodingCandidates,
        }] : []),
      ],
    };
    batchSessions.set(sessionId, { session, privatePaths });
    return structuredClone(session);
  }

  async function commitBatchSession({ sessionId, defaults, groups, fileEncodings = [] }) {
    const stored = batchSessions.get(sessionId);
    if (!stored) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Batch session was not found");
    if (typeof persistBatchProjects !== "function") {
      throw mediaError(MEDIA_ERROR_CODES.NOT_AVAILABLE, "Batch persistence is unavailable");
    }
    if (!Array.isArray(groups) || groups.length === 0 || groups.length > stored.session.files.length) {
      throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Batch groups are invalid");
    }
    const submittedIds = groups.flatMap((group) => Array.isArray(group?.fileIds) ? group.fileIds : []);
    const expectedIds = stored.session.files.map(({ id }) => id);
    if (
      submittedIds.length !== expectedIds.length
      || new Set(submittedIds).size !== submittedIds.length
      || expectedIds.some((id) => !submittedIds.includes(id))
    ) {
      throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Every batch file must belong to exactly one project");
    }

    const fileById = new Map(stored.session.files.map((file) => [file.id, file]));
    const encodingByFileId = new Map();
    for (const selection of fileEncodings) {
      const file = fileById.get(selection?.fileId);
      if (!file?.encodingCandidates?.includes(selection.encoding)) {
        throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Subtitle encoding selection is invalid");
      }
      encodingByFileId.set(selection.fileId, selection.encoding);
    }
    const entries = groups.map((group) => {
      const files = group.fileIds.map((id) => fileById.get(id));
      const mainFiles = files.filter(({ mediaKind }) => mediaKind === "video" || mediaKind === "audio");
      const subtitleFiles = files.filter(({ mediaKind }) => mediaKind === "subtitle");
      if (mainFiles.length > 1 || (mainFiles.length === 0 && subtitleFiles.length !== 1)) {
        throw mediaError(MEDIA_ERROR_CODES.CONFLICT, "A batch project must contain at most one media file");
      }
      const effectiveDefaults = {
        ...defaults,
        ...(group.overrides || {}),
        targetLanguages: group.overrides?.targetLanguages ?? defaults.targetLanguages,
      };
      const artifacts = [];
      let project;

      if (mainFiles.length === 1) {
        const mediaFile = mainFiles[0];
        const mediaPath = stored.privatePaths.get(mediaFile.id);
        const sourceStat = assertSafeMediaFile(mediaPath);
        ({ project } = buildMediaDraft({
          sourcePath: mediaPath,
          sourceStat,
          probe: mediaFile.probe,
          defaults: effectiveDefaults,
          title: String(group.title || "").trim(),
        }));
        const sourceTracks = subtitleFiles.map((subtitleFile, index) => {
          const subtitlePath = stored.privatePaths.get(subtitleFile.id);
          const subtitleStat = assertSafeMediaFile(subtitlePath);
          if (subtitleStat.size > SUBTITLE_IMPORT_MAX_BYTES) {
            throw mediaError(MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE, "Subtitle file is too large");
          }
          const bytes = readFileSync(subtitlePath);
          const built = buildImportedSubtitleProject({
            fileName: subtitleFile.name,
            bytes,
            encoding: encodingByFileId.get(subtitleFile.id),
            defaults: effectiveDefaults,
          });
          if (!built.ok) {
            throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Subtitle encoding requires confirmation");
          }
          const rawRelativePath = `artifacts/source/${index + 1}-${basename(built.rawRelativePath)}`;
          artifacts.push({ relativePath: rawRelativePath, bytes: built.rawBytes });
          return {
            ...built.project.sourceTracks[0],
            rawAssetRelativePath: rawRelativePath,
            isActive: index === 0,
          };
        });
        if (sourceTracks.length > 0) {
          project.sourceTracks = sourceTracks;
          project.activeSourceTrackId = sourceTracks[0].id;
          project.notes = [`批量导入附带 ${sourceTracks.length} 个外部字幕源。`];
          if (sourceTracks.length > 1) {
            project.pendingConfirmations = [
              "confirm external subtitle source",
              ...project.pendingConfirmations,
            ];
          }
        }
      } else {
        const subtitleFile = subtitleFiles[0];
        const subtitlePath = stored.privatePaths.get(subtitleFile.id);
        const subtitleStat = assertSafeMediaFile(subtitlePath);
        if (subtitleStat.size > SUBTITLE_IMPORT_MAX_BYTES) {
          throw mediaError(MEDIA_ERROR_CODES.OUTPUT_TOO_LARGE, "Subtitle file is too large");
        }
        const built = buildImportedSubtitleProject({
          fileName: subtitleFile.name,
          bytes: readFileSync(subtitlePath),
          encoding: encodingByFileId.get(subtitleFile.id),
          defaults: effectiveDefaults,
        });
        if (!built.ok) {
          throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Subtitle encoding requires confirmation");
        }
        project = { ...built.project, title: String(group.title || "").trim() || built.project.title };
        artifacts.push({ relativePath: built.rawRelativePath, bytes: built.rawBytes });
      }
      return { project, artifacts };
    });

    const result = await persistBatchProjects(entries);
    batchSessions.delete(sessionId);
    return { batchId: sessionId, ...result };
  }

  async function selectSource({ copyIntoProject = false, defaults = {}, operationId } = {}) {
    const picked = await openFileDialog({
      title: "选择视频或音频",
      filters: [
        { name: "Media", extensions: ["mkv", "mp4", "mov", "webm", "wav", "mp3", "m4a", "aac", "flac"] },
      ],
    });
    if (!picked || picked.canceled || !picked.filePath) {
      const error = mediaError(MEDIA_ERROR_CODES.CANCELLED, "Media selection was cancelled");
      throw error;
    }
    const sourcePath = picked.filePath;
    const st = assertSafeMediaFile(sourcePath);
    const tools = await resolveTools();
    const probe = await probePath(sourcePath, tools, operationId);
    if (probe.mediaKind !== "video" && probe.mediaKind !== "audio") {
      throw mediaError(MEDIA_ERROR_CODES.UNSUPPORTED, "Selected file is not a video or audio media source");
    }

    const { project, recommendation } = buildMediaDraft({
      sourcePath,
      sourceStat: st,
      probe,
      defaults,
    });
    project.config.copyMediaIntoProject = Boolean(copyIntoProject);
    const projectId = project.id;
    let projectRelativePath = null;

    const repo = getProjectRepository(projectId, { create: true });
    if (copyIntoProject) {
      const container = repo.containerDir;
      projectRelativePath = `artifacts/media/${randomUUID()}${extname(sourcePath)}`;
      const dest = join(container, ...projectRelativePath.split("/"));
      await copyFileStreaming(sourcePath, dest);
      project.sourceProjectRelativePath = projectRelativePath;
      // Keep original path for diagnostics only when reference is not primary.
      project._internalMediaOriginalPath = sourcePath;
    }

    commitProject(repo, project);
    const loaded = repo.loadProject();
    return {
      project: loaded,
      recommendation,
      probeSummary: {
        mediaKind: probe.mediaKind,
        durationMs: probe.format.durationMs,
        streamCount: probe.streams.length,
        artifactVersion: tools.upstreamVersion,
      },
    };
  }

  async function probe({ projectId, operationId }) {
    const repo = getProjectRepository(projectId);
    const internal = repo.getPrimaryMediaInternal();
    if (!internal || internal.noSourceMedia) {
      throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Project has no media source");
    }
    const mediaPath = resolveMediaAbsolutePath(repo, internal);
    if (!mediaPath) {
      repo.updatePrimaryMediaInternal({ relinkState: "missing" });
      const project = repo.loadProject();
      return { project, availability: "missing" };
    }
    try {
      const tools = await resolveTools();
      const probeResult = await probePath(mediaPath, tools, operationId);
      const st = statSync(mediaPath);
      const identity = {
        sizeBytes: st.size,
        mtimeMs: Math.trunc(st.mtimeMs),
        fingerprint: fingerprintFromProbe(probeResult),
      };
      const project = repo.loadProject();
      const next = {
        ...project,
        mediaKind: probeResult.mediaKind,
        sourceProbeSummary: {
          ...(project.sourceProbeSummary || {}),
          media: probeResult,
        },
        mediaSource: toMediaSourceSummary({
          displayName: project.sourceFileName,
          availability: "available",
          identity,
          selectedAudioStreamId: validStreamId(probeResult, project.mediaSource?.selectedAudioStreamId, "audio"),
          selectedSubtitleStreamId: validStreamId(probeResult, project.mediaSource?.selectedSubtitleStreamId, "subtitle"),
          confirmedAudioStreamId: validStreamId(probeResult, project.mediaSource?.confirmedAudioStreamId, "audio"),
          confirmedSubtitleStreamId: validStreamId(probeResult, project.mediaSource?.confirmedSubtitleStreamId, "subtitle"),
        }),
      };
      commitProject(repo, next);
      repo.updatePrimaryMediaInternal({
        relinkState: "available",
        identity,
        probeSummary: next.sourceProbeSummary,
        mediaKind: probeResult.mediaKind,
        noSourceMedia: false,
      });
      return { project: repo.loadProject(), availability: "available", recommendation: recommendStreams(probeResult, {}) };
    } catch (error) {
      if (error?.code === MEDIA_ERROR_CODES.CORRUPT_INPUT) {
        repo.updatePrimaryMediaInternal({ relinkState: "invalid" });
      }
      throw error;
    }
  }

  function resolveMediaAbsolutePath(repo, internal) {
    if (internal.projectRelativePath) {
      const abs = join(repo.containerDir, ...internal.projectRelativePath.split("/"));
      if (!existsSync(abs)) return null;
      const artifactsRoot = join(repo.containerDir, "artifacts");
      try {
        assertSafeMediaFile(abs);
      } catch {
        return null;
      }
      const resolved = realpathSync(abs);
      const rel = relative(realpathSync(artifactsRoot), resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
      return resolved;
    }
    if (internal.originalPath && existsSync(internal.originalPath)) {
      try {
        assertSafeMediaFile(internal.originalPath);
        return realpathSync(internal.originalPath);
      } catch {
        return null;
      }
    }
    return null;
  }

  function selectStreams({ projectId, audioStreamId, subtitleStreamId }) {
    const repo = getProjectRepository(projectId);
    const project = repo.loadProject();
    if (!project) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Project not found");
    const probeData = project.sourceProbeSummary?.media;
    if (!probeData) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Probe is required before selecting streams");
    const audioProvided = audioStreamId !== undefined;
    const subtitleProvided = subtitleStreamId !== undefined;
    if (!audioProvided && !subtitleProvided) {
      throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "At least one stream selection is required");
    }
    if (audioProvided && audioStreamId) {
      const stream = probeData.streams.find((s) => s.streamId === audioStreamId && s.kind === "audio");
      if (!stream) throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Audio stream is invalid");
    }
    if (subtitleProvided && subtitleStreamId) {
      const stream = probeData.streams.find((s) => s.streamId === subtitleStreamId && s.kind === "subtitle");
      if (!stream) throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Subtitle stream is invalid");
    }
    const next = {
      ...project,
      mediaSource: {
        ...(project.mediaSource || {
          assetId: "primary",
          displayName: project.sourceFileName,
          availability: "available",
          identity: null,
        }),
        selectedAudioStreamId: audioProvided ? audioStreamId : project.mediaSource?.selectedAudioStreamId ?? null,
        selectedSubtitleStreamId: subtitleProvided ? subtitleStreamId : project.mediaSource?.selectedSubtitleStreamId ?? null,
        confirmedAudioStreamId: audioProvided ? audioStreamId : project.mediaSource?.confirmedAudioStreamId ?? null,
        confirmedSubtitleStreamId: subtitleProvided ? subtitleStreamId : project.mediaSource?.confirmedSubtitleStreamId ?? null,
      },
      pendingConfirmations: subtitleProvided
        ? (project.pendingConfirmations || []).filter((item) => item !== "confirm subtitle stream selection")
        : project.pendingConfirmations,
    };
    commitProject(repo, next);
    return { project: repo.loadProject() };
  }

  async function extractSubtitle({ projectId, streamId, operationId }) {
    const repo = getProjectRepository(projectId);
    const project = repo.loadProject();
    const internal = repo.getPrimaryMediaInternal();
    if (!project || !internal) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Project not found");
    const mediaPath = resolveMediaAbsolutePath(repo, internal);
    if (!mediaPath) {
      repo.updatePrimaryMediaInternal({ relinkState: "missing" });
      throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Media source is missing; relink before extract");
    }
    const probeData = project.sourceProbeSummary?.media;
    if (!probeData) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Probe is required before extract");
    const tools = await resolveTools();
    const extracted = await extractEmbeddedSubtitle({
      ffmpegPath: tools.ffmpegPath,
      inputPath: mediaPath,
      probe: probeData,
      streamId,
      projectContainerDir: repo.containerDir,
      targetLanguages: project.config.targetLanguages,
      sourceLanguage: project.config.sourceLanguage,
      runProcess: operationRunner(operationId),
    });
    let next = attachCandidateSourceTrack(project, extracted.sourceTrack, extracted.rawRelativePath);
    next = {
      ...next,
      mediaSource: {
        ...next.mediaSource,
        selectedSubtitleStreamId: streamId,
      },
    };
    try {
      commitProject(repo, next);
    } catch (error) {
      try {
        rmSync(join(repo.containerDir, ...extracted.rawRelativePath.split("/")), { force: true });
      } catch {
        /* ignore */
      }
      throw error;
    }
    return {
      project: repo.loadProject(),
      candidateSourceTrackId: extracted.sourceTrack.id,
      warnings: extracted.warnings,
    };
  }

  async function extractAudio({ projectId, streamId, operationId, destinationPath }) {
    const repo = getProjectRepository(projectId);
    const project = repo.loadProject();
    const internal = repo.getPrimaryMediaInternal();
    if (!project || !internal) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Project not found");
    const mediaPath = resolveMediaAbsolutePath(repo, internal);
    if (!mediaPath) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Media source is missing; relink before extract");
    const probeData = project.sourceProbeSummary?.media;
    if (!probeData) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Probe is required before extract");
    const tools = await resolveTools();
    return extractAudioTrack({
      ffmpegPath: tools.ffmpegPath,
      inputPath: mediaPath,
      destinationPath,
      streamId,
      probe: probeData,
      runProcess: operationRunner(operationId),
    });
  }

  async function getWaveform({ projectId, operationId }) {
    const repo = getProjectRepository(projectId);
    const project = repo.loadProject();
    const internal = repo.getPrimaryMediaInternal();
    if (!project || !internal) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Project not found");
    const mediaPath = resolveMediaAbsolutePath(repo, internal);
    if (!mediaPath) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Media source is missing; relink before loading waveform");
    const probeData = project.sourceProbeSummary?.media;
    const durationMs = probeData?.format?.durationMs;
    const streamId = project.mediaSource?.confirmedAudioStreamId
      ?? project.mediaSource?.selectedAudioStreamId
      ?? probeData?.streams?.find((entry) => entry.kind === "audio")?.streamId;
    const stream = probeData?.streams?.find((entry) => entry.streamId === streamId && entry.kind === "audio");
    if (!stream || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw mediaError(MEDIA_ERROR_CODES.UNSUPPORTED, "A timed audio stream is required for waveform editing");
    }
    const cacheKey = `${projectId}:${internal.identity?.fingerprint ?? project.updatedAt}:${stream.streamId}:${durationMs}`;
    const cached = waveformCache.get(cacheKey);
    if (cached) return cached;
    const tools = await resolveTools();
    const waveform = await extractWaveform({
      ffmpegPath: tools.ffmpegPath,
      inputPath: mediaPath,
      streamIndex: stream.index,
      durationMs,
      runProcess: operationRunner(operationId),
    });
    waveformCache.set(cacheKey, waveform);
    return waveform;
  }

  function activate({ projectId, sourceTrackId }) {
    const repo = getProjectRepository(projectId);
    const project = repo.loadProject();
    if (!project) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Project not found");
    const next = activateSourceTrack(project, sourceTrackId);
    commitProject(repo, next);
    return { project: repo.loadProject() };
  }

  async function relink({ projectId, operationId }) {
    const repo = getProjectRepository(projectId);
    const project = repo.loadProject();
    const internal = repo.getPrimaryMediaInternal();
    if (!project || !internal) throw mediaError(MEDIA_ERROR_CODES.NOT_FOUND, "Project not found");
    const picked = await openFileDialog({
      title: "重新关联媒体",
      filters: [{ name: "Media", extensions: ["mkv", "mp4", "mov", "webm", "wav", "mp3", "m4a", "aac", "flac"] }],
    });
    if (!picked || picked.canceled || !picked.filePath) {
      throw mediaError(MEDIA_ERROR_CODES.CANCELLED, "Relink was cancelled");
    }
    const nextPath = picked.filePath;
    const st = assertSafeMediaFile(nextPath);
    const tools = await resolveTools();
    const probeResult = await probePath(nextPath, tools, operationId);
    if (probeResult.mediaKind !== project.mediaKind && project.mediaKind !== "unknown") {
      throw mediaError(MEDIA_ERROR_CODES.INVALID_INPUT, "Relink file media kind does not match the project");
    }
    const identity = {
      sizeBytes: st.size,
      mtimeMs: Math.trunc(st.mtimeMs),
      fingerprint: fingerprintFromProbe(probeResult),
    };
    if (
      (internal.identity?.fingerprint && internal.identity.fingerprint !== identity.fingerprint) ||
      (internal.identity?.sizeBytes != null && internal.identity.sizeBytes !== identity.sizeBytes)
    ) {
      throw mediaError(MEDIA_ERROR_CODES.CONFLICT, "Relink file does not match the original media identity");
    }
    let copiedPath = null;
    let copiedAbsolutePath = null;
    if (project.config.copyMediaIntoProject) {
      copiedPath = `artifacts/media/${randomUUID()}${extname(nextPath)}`;
      copiedAbsolutePath = join(repo.containerDir, ...copiedPath.split("/"));
      await copyFileStreaming(nextPath, copiedAbsolutePath);
    }
    const nextProject = {
      ...project,
      sourceFileName: basename(nextPath),
      mediaKind: probeResult.mediaKind,
      sourceProjectRelativePath: copiedPath,
      sourceProbeSummary: { ...(project.sourceProbeSummary || {}), media: probeResult },
      mediaSource: toMediaSourceSummary({
        displayName: basename(nextPath),
        availability: "available",
        identity,
        selectedAudioStreamId: validStreamId(probeResult, project.mediaSource?.selectedAudioStreamId, "audio"),
        selectedSubtitleStreamId: validStreamId(probeResult, project.mediaSource?.selectedSubtitleStreamId, "subtitle"),
        confirmedAudioStreamId: validStreamId(probeResult, project.mediaSource?.confirmedAudioStreamId, "audio"),
        confirmedSubtitleStreamId: validStreamId(probeResult, project.mediaSource?.confirmedSubtitleStreamId, "subtitle"),
      }),
      _internalMediaOriginalPath: nextPath,
    };
    try {
      commitProject(repo, nextProject);
    } catch (error) {
      if (copiedAbsolutePath) rmSync(copiedAbsolutePath, { force: true });
      throw error;
    }
    return { project: repo.loadProject() };
  }

  function markMissingIfNeeded(projectId) {
    const repo = getProjectRepository(projectId);
    const internal = repo.getPrimaryMediaInternal();
    if (!internal || internal.noSourceMedia) return repo.loadProject();
    const path = resolveMediaAbsolutePath(repo, internal);
    if (!path) {
      repo.updatePrimaryMediaInternal({ relinkState: "missing" });
    }
    return repo.loadProject();
  }

  return {
    createBatchSession,
    commitBatchSession,
    discardBatchSession: ({ sessionId }) => ({ discarded: batchSessions.delete(sessionId) }),
    selectSource,
    probe,
    selectStreams,
    extractSubtitle,
    extractAudio,
    getWaveform,
    activateSourceTrack: activate,
    relink,
    cancelOperation: async ({ operationId }) =>
      typeof cancelProcess === "function" ? cancelProcess(operationId) : { cancelled: false },
    markMissingIfNeeded,
    resolveMediaAbsolutePath: (projectId) => {
      const repo = getProjectRepository(projectId);
      return resolveMediaAbsolutePath(repo, repo.getPrimaryMediaInternal());
    },
    fingerprintFromProbe,
    assertSafeMediaFile,
  };
}
