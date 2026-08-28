import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const STEMS = Object.freeze(["vocals", "accompaniment", "background"]);
const SAFE_OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicToken(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : null;
}

function publicCapability(value) {
  return {
    available: value?.available === true,
    workerId: publicToken(value?.workerId, 64),
    modelVersion: publicToken(value?.modelVersion, 64),
    reason: publicToken(value?.reason, 128),
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createAudioSeparationService({
  getProjectRepository,
  resolveMediaPath,
  capabilityProvider,
  runWorker,
  cancelWorker = null,
  now = () => new Date(),
}) {
  if (
    typeof getProjectRepository !== "function"
    || typeof resolveMediaPath !== "function"
    || typeof capabilityProvider !== "function"
    || typeof runWorker !== "function"
  ) {
    throw serviceError("INVALID_INPUT", "Audio separation service dependencies are required");
  }

  const getCapability = async () => publicCapability(await capabilityProvider());

  return {
    getCapability,
    async separate({ projectId, operationId }) {
      if (typeof projectId !== "string" || !SAFE_OPERATION_ID.test(operationId)) {
        throw serviceError("INVALID_INPUT", "Audio separation request is invalid");
      }
      const repo = getProjectRepository(projectId);
      const project = repo.loadProject();
      if (!project) throw serviceError("NOT_FOUND", "Project not found");

      const root = join(repo.containerDir, "artifacts", "audio-separation");
      mkdirSync(root, { recursive: true });
      const capability = await getCapability();
      if (!capability.available) {
        throw serviceError("NOT_AVAILABLE", capability.reason || "Audio separation worker is not installed");
      }
      if (!capability.workerId || !capability.modelVersion) {
        throw serviceError("NOT_AVAILABLE", "Audio separation worker identity is incomplete");
      }
      const mediaPath = resolveMediaPath(projectId);
      if (!mediaPath || !existsSync(mediaPath)) {
        throw serviceError("NOT_FOUND", "Media source must be relinked first");
      }

      const directoryName = createHash("sha256").update(operationId).digest("hex").slice(0, 20);
      const finalDir = join(root, directoryName);
      const tempDir = join(root, `.tmp-${directoryName}`);
      if (existsSync(finalDir) || existsSync(tempDir)) {
        throw serviceError("CONFLICT", "Audio separation operation already exists");
      }
      mkdirSync(tempDir);
      let committed = false;
      try {
        await runWorker({ inputPath: mediaPath, outputDir: tempDir, operationId });
        const artifacts = STEMS.map((stem) => {
          const path = join(tempDir, `${stem}.wav`);
          if (!existsSync(path) || !statSync(path).isFile()) {
            throw serviceError("INVALID_WORKER_OUTPUT", `Audio separation worker omitted ${stem}`);
          }
          return {
            stem,
            fileName: `${stem}.wav`,
            sizeBytes: statSync(path).size,
            sha256: sha256(path),
          };
        });
        const createdAt = now().toISOString();
        const manifest = {
          version: 1,
          projectId,
          operationId,
          workerId: capability.workerId,
          modelVersion: capability.modelVersion,
          createdAt,
          artifacts,
        };
        writeFileSync(join(tempDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        renameSync(tempDir, finalDir);
        committed = true;
        const record = {
          id: `export-${createHash("sha256").update(`${projectId}:audio-separation:${operationId}`).digest("hex").slice(0, 16)}`,
          exportKind: "audio_separation",
          targetLanguageCode: null,
          format: "json",
          path: `artifacts/audio-separation/${directoryName}/manifest.json`,
          createdAt,
          sourceTrackId: project.activeSourceTrackId,
          targetTrackId: null,
          trackStatus: "source",
          deliveryStatus: "artifact",
          destinationKind: "project",
        };
        repo.appendExportRecord(record);
        return {
          ok: true,
          exportRecordId: record.id,
          workerId: capability.workerId,
          modelVersion: capability.modelVersion,
          stems: [...STEMS],
        };
      } catch (error) {
        rmSync(tempDir, { recursive: true, force: true });
        if (committed) rmSync(finalDir, { recursive: true, force: true });
        throw error;
      }
    },
    cancel({ operationId }) {
      return cancelWorker ? cancelWorker(operationId) : false;
    },
  };
}
