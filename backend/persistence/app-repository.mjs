import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "./migration-runner.mjs";
import { normalizeResourceWrite } from "../../shared/resource-library.mjs";

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const appMigrationsDir = join(rootDir, "migrations", "app");

function optional(value) {
  return value ?? null;
}

function setOptional(target, key, value) {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function upsertProjectIndex(db, project) {
  const supportsArchive = hasColumn(db, "project_index", "archived_at");
  db.prepare(supportsArchive
    ?
    `INSERT INTO project_index (
      id, title, container_path, source_file_name, media_kind, lifecycle,
      updated_at, latest_run_summary, trashed_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      container_path = excluded.container_path,
      source_file_name = excluded.source_file_name,
      media_kind = excluded.media_kind,
      lifecycle = excluded.lifecycle,
      updated_at = excluded.updated_at,
      latest_run_summary = excluded.latest_run_summary,
      trashed_at = excluded.trashed_at,
      archived_at = excluded.archived_at`
    :
    `INSERT INTO project_index (
      id, title, container_path, source_file_name, media_kind, lifecycle,
      updated_at, latest_run_summary, trashed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      container_path = excluded.container_path,
      source_file_name = excluded.source_file_name,
      media_kind = excluded.media_kind,
      lifecycle = excluded.lifecycle,
      updated_at = excluded.updated_at,
      latest_run_summary = excluded.latest_run_summary,
      trashed_at = excluded.trashed_at`,
  ).run(...[
    project.id,
    project.title,
    project.containerPath,
    project.sourceFileName,
    project.mediaKind,
    project.lifecycle,
    project.updatedAt,
    project.latestRunSummary,
    optional(project.trashedAt),
    ...(supportsArchive ? [optional(project.archivedAt)] : []),
  ]);
}

function listProjectIndex(db) {
  return db
    .prepare("SELECT * FROM project_index ORDER BY updated_at DESC, id ASC")
    .all()
    .map((row) => {
      const project = {
        id: row.id,
        title: row.title,
        containerPath: row.container_path,
        sourceFileName: row.source_file_name,
        mediaKind: row.media_kind,
        lifecycle: row.lifecycle,
        updatedAt: row.updated_at,
        latestRunSummary: row.latest_run_summary,
      };
      setOptional(project, "trashedAt", row.trashed_at);
      setOptional(project, "archivedAt", row.archived_at);
      return project;
    });
}

function deleteProjectIndex(db, projectId) {
  return db.prepare("DELETE FROM project_index WHERE id = ?").run(projectId).changes > 0;
}

function upsertProjectIndexes(db, projects) {
  db.exec("BEGIN IMMEDIATE");
  try {
    projects.forEach((project) => upsertProjectIndex(db, project));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function upsertProviderReadiness(db, readiness, now) {
  const updatedAt = readiness.testedAt ?? readiness.modelsFetchedAt ?? now().toISOString();
  db.prepare(
    `INSERT INTO capability_config (
      id, provider_id, provider_name, kind, status, model_list_json,
      config_json, credential_ref, updated_at
    ) VALUES (?, ?, ?, 'llm', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider_id = excluded.provider_id,
      provider_name = excluded.provider_name,
      status = excluded.status,
      model_list_json = excluded.model_list_json,
      config_json = excluded.config_json,
      credential_ref = excluded.credential_ref,
      updated_at = excluded.updated_at`,
  ).run(
    `translation:${readiness.providerId}`,
    readiness.providerId,
    readiness.providerName,
    readiness.status,
    // model_list_json 存该服务商「拉取模型」得到的完整列表；
    // 没拉取过时退回当前选中的单个模型，保证列非空。
    JSON.stringify(
      Array.isArray(readiness.configuredModels) && readiness.configuredModels.length > 0
        ? readiness.configuredModels
        : readiness.modelId ? [readiness.modelId] : [],
    ),
    JSON.stringify({
      profileKey: readiness.profileKey,
      requestedModel: readiness.requestedModel,
      modelId: readiness.modelId,
      baseUrlDisplay: readiness.baseUrlDisplay,
      transportMode: readiness.transportMode,
      testedAt: readiness.testedAt,
      modelsFetchedAt: readiness.modelsFetchedAt,
    }),
    optional(readiness.credentialId),
    updatedAt,
  );
}

function getProviderReadiness(db, providerId) {
  const row = db.prepare("SELECT * FROM capability_config WHERE id = ?").get(`translation:${providerId}`);
  if (!row) return null;
  const config = JSON.parse(row.config_json || "{}");
  return {
    providerId: row.provider_id,
    providerName: row.provider_name,
    status: row.status,
    credentialId: row.credential_ref,
    profileKey: config.profileKey,
    requestedModel: config.requestedModel,
    modelId: config.modelId,
    baseUrlDisplay: config.baseUrlDisplay,
    transportMode: config.transportMode,
    testedAt: config.testedAt ?? (row.status === "ready" ? row.updated_at : undefined),
    modelsFetchedAt: config.modelsFetchedAt,
    // 「拉取模型」的完整列表。渲染层用它替换注册表内置兜底型号，
    // 否则用户拉到的新型号在项目里根本选不到。
    configuredModels: JSON.parse(row.model_list_json || "[]"),
  };
}

function clearProviderReadiness(db, providerId) {
  db.prepare("DELETE FROM capability_config WHERE id = ?").run(`translation:${providerId}`);
}

function clearProviderReadinessByCredentialId(db, credentialId) {
  db.prepare(
    "DELETE FROM capability_config WHERE credential_ref = ? AND id LIKE 'translation:%'",
  ).run(credentialId);
}

/**
 * 换了 API Key 时用：作废「已验证」状态，但**保留**已拉取的模型列表。
 *
 * 换钥匙确实需要重新验证连通性，但模型列表是这个服务商提供什么型号的事实，
 * 跟哪把钥匙无关。旧版在保存凭据时直接 DELETE 整行，于是
 * 「拉取 → 测试 → 保存」这个顺序会把刚拉到的型号一起抹掉，
 * 用户回到项目里又只剩注册表那几个内置兜底型号。
 *
 * 凭据被**删除**时仍然走 clearProviderReadiness 整行删除 —— 那是真的不要了。
 */
function invalidateProviderReadiness(db, providerId) {
  db.prepare(
    `UPDATE capability_config
     SET status = 'untested', config_json = '{}', updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), `translation:${providerId}`);
}

function upsertAsrDeviceState(db, state) {
  db.prepare(
    `INSERT INTO capability_config (
      id, provider_id, provider_name, kind, status, model_list_json,
      config_json, credential_ref, updated_at
    ) VALUES ('asr:device', 'whisper.cpp', 'Whisper.cpp', 'asr', ?, '[]', ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at`,
  ).run(
    state.actualDevice ? "ready" : "not_detected",
    JSON.stringify(state),
    state.updatedAt,
  );
}

function getAsrDeviceState(db) {
  const row = db.prepare("SELECT config_json FROM capability_config WHERE id = 'asr:device'").get();
  if (!row) return null;
  try {
    const value = JSON.parse(row.config_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function taskFromRow(row) {
  let request = {};
  try {
    const parsed = JSON.parse(row.request_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) request = parsed;
  } catch {
    const error = new Error("Task request snapshot is invalid");
    error.code = "INVALID_TASK";
    throw error;
  }
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    label: row.label,
    detail: row.detail,
    stage: row.stage,
    status: row.status,
    progress: row.progress,
    targetLanguageCode: row.target_language_code,
    checkpointStage: row.checkpoint_stage,
    lastErrorCode: row.last_error_code,
    retryable: Boolean(row.retryable),
    runSnapshotId: row.run_snapshot_id,
    priority: row.priority,
    sequence: row.sequence,
    attempt: row.attempt,
    request,
    pauseCapability: row.pause_capability,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertTask(db, task) {
  db.prepare(
    `INSERT INTO task_queue (
      id, project_id, kind, label, detail, stage, status, progress,
      target_language_code, checkpoint_stage, last_error_code, retryable, run_snapshot_id,
      priority, sequence, attempt, request_json, pause_capability, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.projectId,
    task.kind,
    task.label,
    task.detail,
    task.stage,
    task.status,
    task.progress,
    optional(task.targetLanguageCode),
    optional(task.checkpointStage),
    optional(task.lastErrorCode),
    task.retryable ? 1 : 0,
    optional(task.runSnapshotId),
    task.priority,
    task.sequence,
    task.attempt,
    JSON.stringify(task.request ?? {}),
    task.pauseCapability,
    task.createdAt,
    task.updatedAt,
  );
}

function updateTask(db, task, { expectedSequence }) {
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
    const error = new Error("Expected task sequence is invalid");
    error.code = "INVALID_INPUT";
    throw error;
  }
  const result = db.prepare(
    `UPDATE task_queue SET
      project_id = ?, kind = ?, label = ?, detail = ?, stage = ?, status = ?, progress = ?,
      target_language_code = ?, checkpoint_stage = ?, last_error_code = ?, retryable = ?, run_snapshot_id = ?,
      priority = ?, sequence = ?, attempt = ?, request_json = ?, pause_capability = ?, updated_at = ?
     WHERE id = ? AND sequence = ?`,
  ).run(
    task.projectId,
    task.kind,
    task.label,
    task.detail,
    task.stage,
    task.status,
    task.progress,
    optional(task.targetLanguageCode),
    optional(task.checkpointStage),
    optional(task.lastErrorCode),
    task.retryable ? 1 : 0,
    optional(task.runSnapshotId),
    task.priority,
    task.sequence,
    task.attempt,
    JSON.stringify(task.request ?? {}),
    task.pauseCapability,
    task.updatedAt,
    task.id,
    expectedSequence,
  );
  if (result.changes !== 1) {
    const error = new Error("Task changed before this update");
    error.code = "TASK_CONFLICT";
    throw error;
  }
}

function listTasks(db) {
  return db
    .prepare("SELECT * FROM task_queue ORDER BY updated_at DESC, id ASC")
    .all()
    .map(taskFromRow);
}

function getTask(db, taskId) {
  const row = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(taskId);
  return row ? taskFromRow(row) : null;
}

// 只有终态任务可以删。运行中、暂停中、以及 recoverable（还能重试）都必须留下——
// 删掉一条 recoverable 就等于悄悄拿走用户的恢复能力。
const PURGEABLE_TASK_STATUSES = ["completed", "failed", "cancelled"];

function purgeTerminalTasks(db, { projectId = null } = {}) {
  const placeholders = PURGEABLE_TASK_STATUSES.map(() => "?").join(", ");
  const scope = projectId ? " AND project_id = ?" : "";
  const params = projectId ? [...PURGEABLE_TASK_STATUSES, projectId] : PURGEABLE_TASK_STATUSES;
  // keptCount 的口径是"本次范围内、因为还活着而被保留的任务数"，所以状态取反、
  // 但项目范围照旧。写成 NOT (status IN ... AND project_id = ?) 会把别的项目的
  // 终态任务也算成"已保留"，那句提示就成了假话。
  const kept = db
    .prepare(`SELECT COUNT(*) AS count FROM task_queue WHERE status NOT IN (${placeholders})${scope}`)
    .get(...params);
  const result = db.prepare(`DELETE FROM task_queue WHERE status IN (${placeholders})${scope}`).run(...params);
  return { deletedCount: result.changes, keptCount: kept?.count ?? 0 };
}

function resourceFromRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    scope: "global",
    schemaVersion: row.schema_version,
    revision: row.revision,
    updatedAt: row.updated_at,
    payload: JSON.parse(row.payload_json),
  };
}

function getResource(db, resourceId) {
  const row = db.prepare("SELECT * FROM resource_library WHERE id = ?").get(resourceId);
  return row ? resourceFromRow(row) : null;
}

function listResources(db, { kind } = {}) {
  const rows = kind
    ? db.prepare("SELECT * FROM resource_library WHERE kind = ? ORDER BY updated_at DESC, id ASC").all(kind)
    : db.prepare("SELECT * FROM resource_library ORDER BY kind ASC, updated_at DESC, id ASC").all();
  return rows.map(resourceFromRow);
}

function resourceConflict(message) {
  const error = new Error(message);
  error.code = "RESOURCE_CONFLICT";
  return error;
}

function saveResource(db, input, { expectedRevision } = {}, now = () => new Date()) {
  const resource = normalizeResourceWrite(input);
  const current = getResource(db, resource.id);
  if (current && expectedRevision !== current.revision) {
    throw resourceConflict("Resource changed before this update");
  }
  if (!current && expectedRevision !== undefined && expectedRevision !== null) {
    throw resourceConflict("Resource no longer exists");
  }
  const revision = current ? current.revision + 1 : 1;
  const updatedAt = now().toISOString();
  db.prepare(
    `INSERT INTO resource_library (
      id, kind, name, description, schema_version, revision, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      name = excluded.name,
      description = excluded.description,
      revision = excluded.revision,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`,
  ).run(
    resource.id,
    resource.kind,
    resource.name,
    resource.description,
    revision,
    JSON.stringify(resource.payload),
    updatedAt,
  );
  return getResource(db, resource.id);
}

function deleteResource(db, resourceId, { expectedRevision } = {}) {
  const current = getResource(db, resourceId);
  if (!current) return false;
  if (expectedRevision !== current.revision) {
    throw resourceConflict("Resource changed before this delete");
  }
  db.prepare("DELETE FROM resource_library WHERE id = ?").run(resourceId);
  return true;
}

function getAppSettings(db) {
  const row = db.prepare("SELECT value FROM settings WHERE id = 'phase12.system'").get();
  if (!row) return null;
  try {
    const value = JSON.parse(row.value);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error("Stored application settings are invalid");
    error.code = "INVALID_SETTINGS";
    throw error;
  }
}

function saveAppSettings(db, settings, updatedAt) {
  db.prepare(
    `INSERT INTO settings (id, group_name, label, value, updated_at)
     VALUES ('phase12.system', 'system', 'Application settings', ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(settings), updatedAt);
  return getAppSettings(db);
}

function restoreAppState(db, state, updatedAt) {
  if (!state || typeof state !== "object" || !Array.isArray(state.resources)) {
    const error = new Error("Application backup state is invalid");
    error.code = "INVALID_INPUT";
    throw error;
  }
  const resources = state.resources.map((input) => {
    const normalized = normalizeResourceWrite(input);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.schemaVersion !== 1) {
      const error = new Error("Application backup resource revision is invalid");
      error.code = "INVALID_INPUT";
      throw error;
    }
    return { ...normalized, revision: input.revision, updatedAt: input.updatedAt || updatedAt };
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM settings WHERE id = 'phase12.system'").run();
    db.prepare("DELETE FROM resource_library").run();
    saveAppSettings(db, state.settings, updatedAt);
    const insert = db.prepare(
      `INSERT INTO resource_library (
        id, kind, name, description, schema_version, revision, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    for (const resource of resources) {
      insert.run(
        resource.id,
        resource.kind,
        resource.name,
        resource.description,
        resource.revision,
        JSON.stringify(resource.payload),
        resource.updatedAt,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { settings: getAppSettings(db), resources: listResources(db) };
}

export function openAppRepository(appDir, options = {}) {
  mkdirSync(appDir, { recursive: true });
  const db = new DatabaseSync(join(appDir, "app.sqlite"));
  const migrationsDir = options.migrationsDir ?? appMigrationsDir;

  try {
    migrateDatabase(db, {
      databaseName: "app",
      migrationsDir,
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const now = options.now ?? (() => new Date());
  return {
    upsertProjectIndex: (project) => upsertProjectIndex(db, project),
    upsertProjectIndexes: (projects) => upsertProjectIndexes(db, projects),
    listProjectIndex: () => listProjectIndex(db),
    deleteProjectIndex: (projectId) => deleteProjectIndex(db, projectId),
    upsertProviderReadiness: (readiness) => upsertProviderReadiness(db, readiness, now),
    getProviderReadiness: (providerId) => getProviderReadiness(db, providerId),
    clearProviderReadiness: (providerId) => clearProviderReadiness(db, providerId),
    invalidateProviderReadiness: (providerId) => invalidateProviderReadiness(db, providerId),
    clearProviderReadinessByCredentialId: (credentialId) =>
      clearProviderReadinessByCredentialId(db, credentialId),
    upsertAsrDeviceState: (state) => upsertAsrDeviceState(db, state),
    getAsrDeviceState: () => getAsrDeviceState(db),
    insertTask: (task) => insertTask(db, task),
    updateTask: (task, options) => updateTask(db, task, options),
    listTasks: () => listTasks(db),
    getTask: (taskId) => getTask(db, taskId),
    purgeTerminalTasks: (options) => purgeTerminalTasks(db, options),
    saveResource: (resource, writeOptions) => saveResource(db, resource, writeOptions, now),
    getResource: (resourceId) => getResource(db, resourceId),
    listResources: (filter) => listResources(db, filter),
    deleteResource: (resourceId, writeOptions) => deleteResource(db, resourceId, writeOptions),
    getAppSettings: () => getAppSettings(db),
    saveAppSettings: (settings) => saveAppSettings(db, settings, now().toISOString()),
    restoreAppState: (state) => restoreAppState(db, state, now().toISOString()),
    close: () => db.close(),
  };
}
