import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createProjectPackage,
  inspectProjectPackage,
  restoreProjectPackage,
} from "../export/project-package.mjs";

const APP_FORMAT = "ai-translator-app-backup";
const MAX_APP_BACKUP_BYTES = 32 * 1024 * 1024;

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeUnique(directory, baseName, bytes) {
  mkdirSync(directory, { recursive: true });
  for (let version = 1; version <= 10_000; version += 1) {
    const fileName = version === 1 ? baseName : baseName.replace(/\.json$/i, `-${version}.json`);
    try {
      writeFileSync(join(directory, fileName), bytes, { flag: "wx" });
      return fileName;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw backupError("CONFLICT", "Application backup version limit was exceeded");
}

function validateAppState(value) {
  if (!value?.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) {
    throw backupError("INVALID_ARCHIVE", "Application backup settings are invalid");
  }
  if (!Array.isArray(value.resources) || value.resources.length > 10_000) {
    throw backupError("INVALID_ARCHIVE", "Application backup resources are invalid");
  }
  for (const resource of value.resources) {
    if (
      !resource
      || typeof resource !== "object"
      || typeof resource.id !== "string"
      || !/^[A-Za-z0-9._-]{1,128}$/.test(resource.id)
      || typeof resource.kind !== "string"
      || typeof resource.name !== "string"
      || typeof resource.revision !== "number"
      || resource.revision < 1
      || !resource.payload
      || typeof resource.payload !== "object"
      || Array.isArray(resource.payload)
    ) {
      throw backupError("INVALID_ARCHIVE", "Application backup resource is invalid");
    }
  }
  return structuredClone(value);
}

function readAppBackup(filePath) {
  if (!isAbsolute(filePath)) throw backupError("INVALID_INPUT", "Backup path must be absolute");
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_APP_BACKUP_BYTES) {
    throw backupError("INVALID_ARCHIVE", "Application backup file is invalid");
  }
  let wrapper;
  try {
    wrapper = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw backupError("INVALID_ARCHIVE", "Application backup is invalid JSON");
  }
  const payloadJson = JSON.stringify(wrapper?.payload);
  if (
    wrapper?.format !== APP_FORMAT
    || wrapper?.schemaVersion !== 1
    || typeof wrapper?.createdAt !== "string"
    || typeof wrapper?.payloadSha256 !== "string"
    || sha256(payloadJson) !== wrapper.payloadSha256
  ) {
    throw backupError("INVALID_ARCHIVE", "Application backup checksum is invalid");
  }
  return { state: validateAppState(wrapper.payload), createdAt: wrapper.createdAt };
}

function safeProjectDestination(projectsDir, projectId) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(projectId) || projectId === "." || projectId === "..") {
    throw backupError("INVALID_ARCHIVE", "Project backup id is invalid");
  }
  const root = resolve(projectsDir);
  const destination = resolve(root, projectId);
  const escaped = relative(root, destination);
  if (!escaped || escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw backupError("INVALID_ARCHIVE", "Project restore destination is unsafe");
  }
  return destination;
}

export function createBackupService({
  backupPath,
  projectsDir,
  getAppState,
  restoreAppState,
  selectBackupFile,
  beforeProjectRestore = () => {},
  onProjectRestored = () => {},
  now = () => new Date(),
}) {
  const selections = new Map();
  return {
    createAppBackup() {
      const state = validateAppState(getAppState());
      const payloadJson = JSON.stringify(state);
      const wrapper = {
        format: APP_FORMAT,
        schemaVersion: 1,
        createdAt: now().toISOString(),
        payloadSha256: sha256(payloadJson),
        payload: state,
      };
      const bytes = Buffer.from(`${JSON.stringify(wrapper)}\n`, "utf8");
      if (bytes.length > MAX_APP_BACKUP_BYTES) throw backupError("OUTPUT_TOO_LARGE", "Application backup is too large");
      const fileName = writeUnique(backupPath(), "ai-translator-app-backup.json", bytes);
      return { fileName, sizeBytes: bytes.length, sha256: sha256(bytes) };
    },
    async selectRestore({ kind }) {
      if (kind !== "app" && kind !== "project") throw backupError("INVALID_INPUT", "Backup kind is invalid");
      const selection = await selectBackupFile({ kind });
      if (selection?.canceled || !selection?.filePath) return { canceled: true };
      const token = randomUUID();
      if (kind === "app") {
        const backup = readAppBackup(selection.filePath);
        selections.set(token, { kind, filePath: selection.filePath, backup });
        return {
          kind,
          token,
          fileName: basename(selection.filePath),
          summary: { createdAt: backup.createdAt, resourceCount: backup.state.resources.length },
        };
      }
      const summary = inspectProjectPackage(selection.filePath);
      selections.set(token, { kind, filePath: selection.filePath, summary });
      return { kind, token, fileName: basename(selection.filePath), summary };
    },
    async restore({ token, userConfirmed }) {
      if (userConfirmed !== true) throw backupError("CONFIRMATION_REQUIRED", "Restore confirmation is required");
      const selected = selections.get(token);
      if (!selected) throw backupError("NOT_FOUND", "Restore selection expired");
      if (selected.kind === "app") {
        await restoreAppState(selected.backup.state);
        selections.delete(token);
        return { kind: "app", restored: true, restartRequired: true };
      }

      const destinationDir = safeProjectDestination(projectsDir, selected.summary.projectId);
      await beforeProjectRestore(selected.summary.projectId);
      let safetyPackage = null;
      let restoreSource = selected.filePath;
      if (existsSync(destinationDir)) {
        const outputRoot = resolve(backupPath());
        const overlap = relative(resolve(destinationDir), outputRoot);
        if (!overlap || (!overlap.startsWith(`..${sep}`) && overlap !== ".." && !isAbsolute(overlap))) {
          throw backupError("CONFLICT", "Backup directory must be outside the project being restored");
        }
        const selectedRelative = relative(resolve(destinationDir), resolve(selected.filePath));
        if (!selectedRelative.startsWith(`..${sep}`) && selectedRelative !== ".." && !isAbsolute(selectedRelative)) {
          mkdirSync(outputRoot, { recursive: true });
          restoreSource = join(outputRoot, `restore-input-${token}.aitranslator-project.zip`);
          copyFileSync(selected.filePath, restoreSource, fsConstants.COPYFILE_EXCL);
        }
        safetyPackage = createProjectPackage({
          containerDir: destinationDir,
          outputDir: backupPath(),
          kind: "archive",
          includeTrash: true,
          now,
        });
        rmSync(destinationDir, { recursive: true, force: false });
      }
      try {
        const restored = restoreProjectPackage({ packagePath: restoreSource, destinationDir });
        await onProjectRestored(restored.projectId);
        selections.delete(token);
        return { kind: "project", restored: true, projectId: restored.projectId, safetyBackupFileName: safetyPackage?.fileName ?? null };
      } catch (error) {
        rmSync(destinationDir, { recursive: true, force: true });
        if (safetyPackage) {
          restoreProjectPackage({ packagePath: safetyPackage.outputPath, destinationDir });
          await onProjectRestored(selected.summary.projectId);
        }
        throw error;
      }
    },
  };
}
