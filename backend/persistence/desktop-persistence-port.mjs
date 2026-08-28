import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { exportSubtitleMatrix } from "../export/project-export.mjs";
import { createProjectPackage as buildProjectPackage } from "../export/project-package.mjs";
import { exportSourceSubtitle } from "../subtitle/export.mjs";
import { importSubtitleToProject } from "../subtitle/import-service.mjs";
import { openAppRepository } from "./app-repository.mjs";
import { openProjectRepository } from "./project-repository.mjs";

function invalidProjectIdError(projectId) {
  return new Error(`Invalid project id: ${String(projectId)}`);
}

function isSafeProjectId(projectId) {
  return (
    typeof projectId === "string" &&
    projectId !== "." &&
    projectId !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(projectId)
  );
}

function assertSafeProjectId(projectId) {
  if (!isSafeProjectId(projectId)) {
    throw invalidProjectIdError(projectId);
  }
}

function latestRunSummary(project) {
  // ponytail: store the latest run id until a real run-summary projection exists.
  return project.recentRunIds[0] ?? "";
}

function projectIndexFromProject(project, containerPath) {
  return {
    id: project.id,
    title: project.title,
    containerPath,
    sourceFileName: project.sourceFileName,
    mediaKind: project.mediaKind,
    lifecycle: project.lifecycle,
    updatedAt: project.updatedAt,
    latestRunSummary: latestRunSummary(project),
    ...(project.trashedAt ? { trashedAt: project.trashedAt } : {}),
    ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
  };
}

export function openDesktopPersistencePort({
  appDir,
  projectsDir,
  appMigrationsDir,
  projectMigrationsDir,
}) {
  const projectsRoot = resolve(projectsDir);
  mkdirSync(projectsRoot, { recursive: true });
  const appRepository = openAppRepository(appDir, {
    migrationsDir: appMigrationsDir,
  });
  const projectRepoOptions = projectMigrationsDir
    ? { migrationsDir: projectMigrationsDir }
    : {};

  function containerPathFor(projectId) {
    assertSafeProjectId(projectId);

    const containerPath = resolve(projectsRoot, projectId);
    const relativePath = relative(projectsRoot, containerPath);
    const escaped =
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath);

    if (escaped) {
      throw invalidProjectIdError(projectId);
    }

    return containerPath;
  }

  function resourceForSelection(kind, selection) {
    if (typeof selection !== "string" || selection.length === 0 || /关闭|none|disabled/i.test(selection)) {
      return null;
    }
    return appRepository.listResources({ kind }).find(
      (resource) => resource.id === selection || resource.name === selection,
    ) ?? null;
  }

  function appendGlobalResourceSnapshot(projectRepository, resource) {
    const snapshot = {
      id: `resource-snapshot-${randomUUID()}`,
      kind: resource.kind,
      name: resource.name,
      scope: "project_snapshot",
      schemaVersion: 1,
      source: { kind: "global", resourceId: resource.id, revision: resource.revision },
      capturedAt: new Date().toISOString(),
      payload: structuredClone(resource.payload),
    };
    projectRepository.appendResourceSnapshot(snapshot);
    return snapshot;
  }

  function captureConfiguredResources(projectRepository, config) {
    const selections = [
      ["glossary", config?.glossary],
      ["style_guide", config?.styleGuide],
    ];
    return selections.flatMap(([kind, selection]) => {
      const resource = resourceForSelection(kind, selection);
      return resource ? [appendGlobalResourceSnapshot(projectRepository, resource)] : [];
    });
  }

  function saveProjectAt(project, containerPath, { captureInitialResources = false } = {}) {
    const projectRepository = openProjectRepository(containerPath, projectRepoOptions);
    try {
      projectRepository.saveProject(project);
      if (captureInitialResources) captureConfiguredResources(projectRepository, project.config);
    } finally {
      projectRepository.close();
    }
    appRepository.upsertProjectIndex(projectIndexFromProject(project, containerPath));
  }

  function createProjects(entries) {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 200) {
      throw new Error("Batch projects are invalid");
    }
    const projectIds = entries.map(({ project }) => project?.id);
    if (new Set(projectIds).size !== projectIds.length) {
      throw new Error("Batch project ids must be unique");
    }
    const existingIds = new Set(appRepository.listProjectIndex().map(({ id }) => id));
    const prepared = entries.map(({ project, artifacts = [] }) => {
      const finalPath = containerPathFor(project?.id);
      if (existingIds.has(project.id) || existsSync(finalPath)) {
        throw new Error("Batch project already exists");
      }
      if (!Array.isArray(artifacts) || artifacts.some(({ relativePath, bytes }) =>
        typeof relativePath !== "string"
        || !relativePath.startsWith("artifacts/")
        || relativePath.includes("\\")
        || relativePath.split("/").includes("..")
        || !(bytes instanceof Uint8Array)
        || bytes.byteLength > 8 * 1024 * 1024
      )) {
        throw new Error("Batch project artifacts are invalid");
      }
      return {
        project,
        artifacts,
        finalPath,
        stagingPath: join(projectsRoot, `.batch-${randomUUID()}`),
      };
    });

    const committedPaths = new Set();
    try {
      for (const entry of prepared) {
        for (const artifact of entry.artifacts) {
          const artifactPath = join(entry.stagingPath, ...artifact.relativePath.split("/"));
          mkdirSync(dirname(artifactPath), { recursive: true });
          writeFileSync(artifactPath, artifact.bytes);
        }
        const projectRepository = openProjectRepository(entry.stagingPath, projectRepoOptions);
        try {
          projectRepository.saveProject(entry.project);
          captureConfiguredResources(projectRepository, entry.project.config);
        } finally {
          projectRepository.close();
        }
      }
      prepared.forEach((entry) => {
        renameSync(entry.stagingPath, entry.finalPath);
        committedPaths.add(entry.finalPath);
      });
      appRepository.upsertProjectIndexes(
        prepared.map(({ project, finalPath }) => projectIndexFromProject(project, finalPath)),
      );
      return {
        projectIds,
        projects: prepared.map(({ finalPath }) => openProjectAt(finalPath)),
      };
    } catch (error) {
      for (const { stagingPath, finalPath } of prepared) {
        rmSync(stagingPath, { recursive: true, force: true });
        if (committedPaths.has(finalPath)) {
          rmSync(finalPath, { recursive: true, force: true });
        }
      }
      throw error;
    }
  }

  function indexFor(projectId) {
    assertSafeProjectId(projectId);
    return appRepository.listProjectIndex().find((project) => project.id === projectId);
  }

  function openProjectAt(containerPath) {
    if (!existsSync(containerPath)) {
      return null;
    }
    const projectRepository = openProjectRepository(containerPath, projectRepoOptions);
    try {
      return projectRepository.loadProject();
    } finally {
      projectRepository.close();
    }
  }

  function isSafeDirectProjectDir(entryName) {
    if (!isSafeProjectId(entryName)) return false;
    const containerPath = join(projectsRoot, entryName);
    try {
      const stat = lstatSync(containerPath);
      return (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        Number(stat.reparseTag || 0) === 0 &&
        existsSync(join(containerPath, "project.sqlite"))
      );
    } catch {
      return false;
    }
  }

  function rebuildProjectIndex() {
    let entries;
    try {
      entries = readdirSync(projectsRoot, { withFileTypes: true });
    } catch {
      return { rebuilt: 0, diagnostics: ["projects directory is unreadable"] };
    }

    const diagnostics = [];
    let rebuilt = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeDirectProjectDir(entry.name)) {
        diagnostics.push("skipped unsafe or incomplete project entry");
        continue;
      }
      try {
        const containerPath = containerPathFor(entry.name);
        const project = openProjectAt(containerPath);
        if (!project) {
          diagnostics.push("skipped unreadable project entry");
          continue;
        }
        appRepository.upsertProjectIndex(projectIndexFromProject(project, containerPath));
        rebuilt += 1;
      } catch {
        diagnostics.push("skipped damaged project entry");
      }
    }
    return { rebuilt, diagnostics };
  }

  function exportProjectSubtitleMatrix({ projectId, requests, destinationDir }) {
    const projectIndex = indexFor(projectId);
    if (!projectIndex || !existsSync(projectIndex.containerPath)) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "Project not found" },
      };
    }
    const project = openProjectAt(projectIndex.containerPath);
    if (!project) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "Project not found" },
      };
    }
    const summary = exportSubtitleMatrix({
      project,
      containerDir: projectIndex.containerPath,
      destinationDir,
      requests,
    });
    const projectRepository = openProjectRepository(projectIndex.containerPath, projectRepoOptions);
    try {
      for (const item of summary.succeeded) {
        projectRepository.appendExportRecord(item.exportRecord);
      }
    } finally {
      projectRepository.close();
    }
    return {
      ok: true,
      summary: {
        ok: summary.ok,
        partial: summary.partial,
        succeeded: summary.succeeded.map((item) => ({
          request: item.request,
          exportRecordId: item.exportRecord.id,
          fileName: item.fileName,
          format: item.exportRecord.format,
          deliveryStatus: item.exportRecord.deliveryStatus,
          warnings: item.warnings,
        })),
        failed: summary.failed,
      },
    };
  }

  function approvedTargetRequests(project) {
    const sourceTrack = project?.sourceTracks?.find(
      (track) => track.id === project.activeSourceTrackId && track.isActive !== false,
    ) ?? project?.sourceTracks?.find((track) => track.isActive && !track.trashedAt);
    return (sourceTrack?.targetTracks ?? [])
      .filter((track) =>
        track.isActive !== false
        && track.role !== "candidate"
        && !track.trashedAt
        && ["approved", "exported"].includes(track.status),
      )
      .map((track) => ({
        id: `target-${track.languageCode}`,
        exportKind: "target",
        targetLanguageCode: track.languageCode,
        format: "srt",
      }));
  }

  // ponytail: Electron handlers can delegate here once the desktop runtime exists.
  return {
    createProject(project) {
      const containerPath = containerPathFor(project.id);
      saveProjectAt(project, containerPath, { captureInitialResources: true });
      return { projectId: project.id, containerPath };
    },
    createProjects,
    saveProject(project) {
      saveProjectAt(project, indexFor(project.id)?.containerPath ?? containerPathFor(project.id));
    },
    refreshProjectIndex(project) {
      const containerPath = containerPathFor(project.id);
      if (!existsSync(join(containerPath, "project.sqlite"))) {
        throw new Error("Project not found");
      }
      appRepository.upsertProjectIndex(projectIndexFromProject(project, containerPath));
    },
    openProject(projectId) {
      const projectIndex = indexFor(projectId);
      if (!projectIndex) {
        return null;
      }
      if (!existsSync(projectIndex.containerPath)) {
        return null;
      }
      return openProjectAt(projectIndex.containerPath);
    },
    openProjectFromContainer(projectId) {
      const containerPath = containerPathFor(projectId);
      return openProjectAt(containerPath);
    },
    rebuildProjectIndex,
    listRecentProjects: () => appRepository.listProjectIndex(),
    getAppSettings: () => appRepository.getAppSettings(),
    saveAppSettings: (settings) => appRepository.saveAppSettings(settings),
    getAppBackupState: () => ({
      settings: appRepository.getAppSettings(),
      resources: appRepository.listResources(),
    }),
    restoreAppState: (state) => appRepository.restoreAppState(state),
    deleteProjectPermanently(projectId) {
      const projectIndex = indexFor(projectId);
      if (!projectIndex) return { ok: false, error: { code: "NOT_FOUND", message: "Project not found" } };
      if (!projectIndex.trashedAt) {
        return { ok: false, error: { code: "CONFLICT", message: "Project must be in trash before permanent deletion" } };
      }
      const expectedPath = containerPathFor(projectId);
      if (resolve(projectIndex.containerPath) !== expectedPath) {
        return { ok: false, error: { code: "CONFLICT", message: "Project container identity mismatch" } };
      }
      rmSync(expectedPath, { recursive: true, force: false });
      appRepository.deleteProjectIndex(projectId);
      return { ok: true, projectId };
    },
    listResources: (filter) => appRepository.listResources(filter),
    saveResource: (resource, options) => appRepository.saveResource(resource, options),
    deleteResource: (resourceId, options) => appRepository.deleteResource(resourceId, options),
    listProjectResourceSnapshots(projectId, filter) {
      const projectIndex = indexFor(projectId);
      if (!projectIndex || !existsSync(projectIndex.containerPath)) {
        const error = new Error("Project not found");
        error.code = "NOT_FOUND";
        throw error;
      }
      const projectRepository = openProjectRepository(projectIndex.containerPath, projectRepoOptions);
      try {
        return projectRepository.listResourceSnapshots(filter);
      } finally {
        projectRepository.close();
      }
    },
    refreshProjectResourceSnapshot({ projectId, resourceId }) {
      const resource = appRepository.getResource(resourceId);
      if (!resource) {
        const error = new Error("Resource not found");
        error.code = "NOT_FOUND";
        throw error;
      }
      const projectIndex = indexFor(projectId);
      if (!projectIndex || !existsSync(projectIndex.containerPath)) {
        const error = new Error("Project not found");
        error.code = "NOT_FOUND";
        throw error;
      }
      const projectRepository = openProjectRepository(projectIndex.containerPath, projectRepoOptions);
      try {
        return appendGlobalResourceSnapshot(projectRepository, resource);
      } finally {
        projectRepository.close();
      }
    },
    captureInitialProjectResources(projectId, config) {
      const projectIndex = indexFor(projectId);
      if (!projectIndex || !existsSync(projectIndex.containerPath)) return [];
      const projectRepository = openProjectRepository(projectIndex.containerPath, projectRepoOptions);
      try {
        if (projectRepository.listResourceSnapshots().length > 0) return [];
        return captureConfiguredResources(projectRepository, config);
      } finally {
        projectRepository.close();
      }
    },
    saveProviderReadiness: (readiness) => appRepository.upsertProviderReadiness(readiness),
    loadProviderReadiness: (providerId) => appRepository.getProviderReadiness(providerId),
    clearProviderReadiness: (providerId) => appRepository.clearProviderReadiness(providerId),
    invalidateProviderReadiness: (providerId) => appRepository.invalidateProviderReadiness(providerId),
    clearProviderReadinessByCredentialId: (credentialId) =>
      appRepository.clearProviderReadinessByCredentialId(credentialId),
    saveAsrDeviceState: (state) => appRepository.upsertAsrDeviceState(state),
    loadAsrDeviceState: () => appRepository.getAsrDeviceState(),
    insertTask: (task) => appRepository.insertTask(task),
    updateTask: (task, options) => appRepository.updateTask(task, options),
    listTasks: () => appRepository.listTasks(),
    getTask: (taskId) => appRepository.getTask(taskId),
    purgeTerminalTasks: (options) => appRepository.purgeTerminalTasks(options),
    importSubtitle({ fileName, bytes, encoding, defaults }) {
      return importSubtitleToProject({
        fileName,
        bytes,
        encoding,
        defaults,
        createProject: (project) => {
          const containerPath = containerPathFor(project.id);
          saveProjectAt(project, containerPath, { captureInitialResources: true });
          return { projectId: project.id, containerPath };
        },
        containerPathFor,
      });
    },
    exportSourceSubtitle({ projectId, mode, format, destinationPath }) {
      const projectIndex = indexFor(projectId);
      if (!projectIndex || !existsSync(projectIndex.containerPath)) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "Project not found" },
        };
      }
      const project = openProjectAt(projectIndex.containerPath);
      if (!project) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "Project not found" },
        };
      }
      const exported = exportSourceSubtitle({
        project,
        containerDir: projectIndex.containerPath,
        mode,
        format,
        destinationPath,
      });
      if (!exported.ok) {
        return exported;
      }
      const projectRepository = openProjectRepository(projectIndex.containerPath, projectRepoOptions);
      try {
        projectRepository.appendExportRecord(exported.exportRecord);
      } finally {
        projectRepository.close();
      }
      return {
        ok: true,
        exportRecordId: exported.exportRecord.id,
        fileName: exported.fileName,
        format: exported.format,
        warnings: exported.warnings,
      };
    },
    exportSubtitleMatrix: exportProjectSubtitleMatrix,
    exportApprovedBatch({ projectIds, destinationDir }) {
      const projects = [];
      const skippedProjectIds = [];
      const failedProjects = [];
      for (const projectId of projectIds) {
        const projectIndex = indexFor(projectId);
        const project = projectIndex ? openProjectAt(projectIndex.containerPath) : null;
        const requests = approvedTargetRequests(project);
        if (requests.length === 0) {
          skippedProjectIds.push(projectId);
          continue;
        }
        const exported = exportProjectSubtitleMatrix({ projectId, requests, destinationDir });
        if (!exported.ok) {
          failedProjects.push({
            projectId,
            error: { ...exported.error, retryable: false },
          });
          continue;
        }
        projects.push({ projectId, summary: exported.summary });
      }
      return { ok: true, summary: { projects, skippedProjectIds, failedProjects } };
    },
    createProjectPackage({ projectId, kind, includeTrash = false, outputDir }) {
      const projectIndex = indexFor(projectId);
      if (!projectIndex || !existsSync(projectIndex.containerPath)) {
        return { ok: false, error: { code: "NOT_FOUND", message: "Project not found" } };
      }
      const project = openProjectAt(projectIndex.containerPath);
      const sourceTrack = project?.sourceTracks?.find((track) => track.id === project.activeSourceTrackId)
        ?? project?.sourceTracks?.find((track) => track.isActive);
      if (!project || !sourceTrack) {
        return { ok: false, error: { code: "INVALID_INPUT", message: "Project source track is missing" } };
      }
      const packaged = buildProjectPackage({
        containerDir: projectIndex.containerPath,
        ...(outputDir ? { outputDir } : {}),
        kind,
        includeTrash,
      });
      const external = Boolean(outputDir);
      const exportRecord = {
        id: `export-${packaged.sha256.slice(0, 16)}`,
        exportKind: kind === "lightweight" ? "lightweight_package" : "archive_package",
        targetLanguageCode: null,
        format: "aitranslator-project.zip",
        path: external ? packaged.outputPath : `exports/${packaged.fileName}`,
        createdAt: packaged.createdAt,
        sourceTrackId: sourceTrack.id,
        targetTrackId: null,
        trackStatus: "source",
        deliveryStatus: "approved",
        destinationKind: external ? "external" : "project",
      };
      const projectRepository = openProjectRepository(projectIndex.containerPath, projectRepoOptions);
      try {
        projectRepository.appendExportRecord(exportRecord);
      } finally {
        projectRepository.close();
      }
      return {
        ok: true,
        package: {
          exportRecordId: exportRecord.id,
          fileName: packaged.fileName,
          kind: packaged.kind,
          sizeBytes: packaged.sizeBytes,
          sha256: packaged.sha256,
          includesTrash: includeTrash,
          outputPath: packaged.outputPath,
        },
      };
    },
    close: () => appRepository.close(),
  };
}
