import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  applyAutomaticModelText,
  applyExplicitRerunResult,
  isProtectedTargetLayer,
} from "../../shared/target-text-state.mjs";
import { migrateDatabase } from "./migration-runner.mjs";
import { ASR_RESULT_LIMITS, validateAsrResult } from "../asr/asr-contract.mjs";
import { ASR_SEGMENTATION_CONFIG } from "../../shared/asr-segmentation-config.mjs";
import { ASR_LANGUAGE_DETECTION_CONFIG } from "../../shared/asr-language-config.mjs";
import { asrEngineForModelId, isAsrModelId } from "../../shared/asr-model-ids.mjs";
import {
  normalizeProjectResourceSnapshot,
  normalizeSubtitleStylePayload,
} from "../../shared/resource-library.mjs";
import { runSubtitleQa } from "../../shared/qa-engine.mjs";

const rootDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const projectMigrationsDir = join(rootDir, "migrations", "project");
const childDirectories = ["artifacts", "exports", "logs", "cache"];

function boolToInt(value) {
  return value ? 1 : 0;
}

function intToBool(value) {
  return Number(value) === 1;
}

function readJson(value, fallback) {
  return value ? JSON.parse(value) : fallback;
}

function optional(value) {
  return value ?? null;
}

function setOptional(target, key, value) {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function parseSubtitleTime(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid subtitle timestamp: ${value}`);
  }

  const [, hours, minutes, seconds, milliseconds] = match.map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function formatSubtitleTime(value) {
  const milliseconds = value % 1000;
  const totalSeconds = Math.floor(value / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

// Editable Project state is replaced as a whole. Append-only/immutable history tables are not owned here.
function clearEditableProjectState(db) {
  for (const table of [
    "candidate_target_text_layers",
    "candidate_track_metadata",
    "editor_history",
    "target_text_layers",
    "source_text_layers",
    "segments",
    "target_tracks",
    "source_tracks",
    "project_config",
    "source_file",
    "project_meta",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function normalizeRelinkState(value) {
  if (value === "linked") return "available";
  if (value === "available" || value === "missing" || value === "relink_required" || value === "invalid") {
    return value;
  }
  return "available";
}

function saveProject(db, project, schemaVersion) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const storedSourceFile = db
      .prepare(
        `SELECT original_path, project_relative_path, probe_summary_json, identity_json,
                selected_audio_stream_id, selected_subtitle_stream_id,
                confirmed_audio_stream_id, confirmed_subtitle_stream_id, relink_state
         FROM source_file
         WHERE id = 'primary'`,
      )
      .get();
    const sourceProjectRelativePath =
      project.sourceProjectRelativePath !== undefined
        ? project.sourceProjectRelativePath
        : storedSourceFile?.project_relative_path;
    const sourceProbeSummary =
      project.sourceProbeSummary ?? readJson(storedSourceFile?.probe_summary_json, {});
    const identityJson =
      project.mediaSource?.identity != null
        ? {
            sizeBytes: project.mediaSource.identity.sizeBytes ?? null,
            mtimeMs: project.mediaSource.identity.mtimeMs ?? null,
            fingerprint: project.mediaSource.identity.fingerprint ?? null,
          }
        : readJson(storedSourceFile?.identity_json, {});
    const selectedAudioStreamId =
      project.mediaSource?.selectedAudioStreamId !== undefined
        ? project.mediaSource.selectedAudioStreamId
        : storedSourceFile?.selected_audio_stream_id ?? null;
    const selectedSubtitleStreamId =
      project.mediaSource?.selectedSubtitleStreamId !== undefined
        ? project.mediaSource.selectedSubtitleStreamId
        : storedSourceFile?.selected_subtitle_stream_id ?? null;
    const confirmedAudioStreamId =
      project.mediaSource?.confirmedAudioStreamId !== undefined
        ? project.mediaSource.confirmedAudioStreamId
        : storedSourceFile?.confirmed_audio_stream_id ?? null;
    const confirmedSubtitleStreamId =
      project.mediaSource?.confirmedSubtitleStreamId !== undefined
        ? project.mediaSource.confirmedSubtitleStreamId
        : storedSourceFile?.confirmed_subtitle_stream_id ?? null;
    const relinkState = normalizeRelinkState(
      project.mediaSource?.availability ?? storedSourceFile?.relink_state ?? "available",
    );
    const originalPath =
      project._internalMediaOriginalPath !== undefined
        ? project._internalMediaOriginalPath
        : storedSourceFile?.original_path;

    const storedAsrCandidates = db.prepare(
      "SELECT id, asr_run_id, segmentation_config_version FROM source_tracks WHERE asr_run_id IS NOT NULL",
    ).all();
    const requestedTracks = new Map(project.sourceTracks.map((track) => [track.id, track]));
    for (const stored of storedAsrCandidates) {
      const requested = requestedTracks.get(stored.id);
      if (
        !requested || requested.asrRunId !== stored.asr_run_id ||
        requested.segmentationConfigVersion !== stored.segmentation_config_version
      ) {
        throw asrError("CONFLICT", "Ordinary save cannot remove or rewrite ASR candidate provenance");
      }
    }
    const storedAsrIds = new Set(storedAsrCandidates.map((track) => track.id));
    if (project.sourceTracks.some((track) => track.asrRunId !== undefined && !storedAsrIds.has(track.id))) {
      throw asrError("CONFLICT", "ASR candidates must be created through the ASR repository operation");
    }
    const storedLanguageEvidence = db.prepare(
      `SELECT id, detected_language, language_confidence, language_detection_method,
              language_detection_version, manual_language, language_overlap_status
       FROM segments WHERE detected_language IS NOT NULL`,
    ).all();
    const requestedSegments = new Map(project.sourceTracks.flatMap((track) => track.segments).map((segment) => [segment.id, segment]));
    for (const stored of storedLanguageEvidence) {
      const requested = requestedSegments.get(stored.id);
      if (
        !requested || requested.detectedLanguage !== stored.detected_language ||
        requested.languageConfidence !== stored.language_confidence ||
        requested.languageDetectionMethod !== stored.language_detection_method ||
        requested.languageDetectionVersion !== stored.language_detection_version ||
        (requested.manualLanguage ?? null) !== stored.manual_language ||
        requested.languageOverlapStatus !== stored.language_overlap_status
      ) {
        throw asrError("CONFLICT", "Ordinary save cannot remove or rewrite ASR language evidence");
      }
    }
    const storedEvidenceIds = new Set(storedLanguageEvidence.map((segment) => segment.id));
    if ([...requestedSegments.values()].some((segment) => segment.detectedLanguage !== undefined && !storedEvidenceIds.has(segment.id))) {
      throw asrError("CONFLICT", "ASR language evidence must be written through the ASR repository operation");
    }

    // ponytail: replace-whole-project save; move to dirty-row updates when background writers exist.
    clearEditableProjectState(db);

    // ponytail: slice 1 persists the primary source only; import attachments get rows once backend import metadata exists.
    db.prepare(
      `INSERT INTO project_meta (
        id, schema_version, title, media_kind, lifecycle, created_at, updated_at, trashed_at, archived_at,
        active_source_track_id, recent_run_ids_json, notes_json, pending_confirmations_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project.id,
      schemaVersion,
      project.title,
      project.mediaKind,
      project.lifecycle,
      project.createdAt,
      project.updatedAt,
      optional(project.trashedAt),
      optional(project.archivedAt),
      optional(project.activeSourceTrackId),
      JSON.stringify(project.recentRunIds),
      JSON.stringify(project.notes),
      JSON.stringify(project.pendingConfirmations),
    );

    db.prepare(
      `INSERT INTO source_file (
        id, source_file_name, original_path, project_relative_path, media_kind,
        no_source_media, relink_state, probe_summary_json, identity_json,
        selected_audio_stream_id, selected_subtitle_stream_id,
        confirmed_audio_stream_id, confirmed_subtitle_stream_id
      ) VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project.sourceFileName,
      optional(originalPath),
      optional(sourceProjectRelativePath),
      project.mediaKind,
      boolToInt(project.noSourceMedia),
      relinkState,
      JSON.stringify(sourceProbeSummary),
      JSON.stringify(identityJson ?? {}),
      optional(selectedAudioStreamId),
      optional(selectedSubtitleStreamId),
      optional(confirmedAudioStreamId),
      optional(confirmedSubtitleStreamId),
    );

    // budget_usd 是 v1.0.1 遗留列（NOT NULL 且无默认值），已不再承载任何业务含义，恒写 0。
    db.prepare(
      `INSERT INTO project_config (
        source_language, target_languages_json, provider_id, model_id, asr_model_id, glossary_snapshot_id,
        style_guide_snapshot_id, output_format, budget_usd, burn_video, copy_media_into_project,
        subtitle_style_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      project.config.sourceLanguage,
      JSON.stringify(project.config.targetLanguages),
      project.config.provider,
      project.config.model,
      optional(project.config.asrModelId),
      project.config.glossary,
      project.config.styleGuide,
      project.config.outputFormat,
      boolToInt(project.config.burnVideo),
      boolToInt(project.config.copyMediaIntoProject),
      project.config.subtitleStyle
        ? JSON.stringify(normalizeSubtitleStylePayload(project.config.subtitleStyle))
        : null,
    );

    if (project.editorHistory) {
      db.prepare(
        `INSERT INTO editor_history (id, undo_stack_json, redo_stack_json)
         VALUES (1, ?, ?)`,
      ).run(
        JSON.stringify(project.editorHistory.undoStack ?? []),
        JSON.stringify(project.editorHistory.redoStack ?? []),
      );
    }

    const insertSourceTrack = db.prepare(
      `INSERT INTO source_tracks (
        id, label, kind, language_state, default_language, is_active, summary,
        raw_asset_relative_path, source_stream_id, asr_run_id, segmentation_config_version,
        trashed_at, sort_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTargetTrack = db.prepare(
      `INSERT INTO target_tracks (
        id, source_track_id, language_code, language_label, status, is_active,
        delivery_label, last_human_action, snapshot_ids_json, qa_issues_json,
        trashed_at, trashed_with_source, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCandidateMetadata = db.prepare(
      `INSERT INTO candidate_track_metadata (target_track_id, base_track_id)
       VALUES (?, ?)`,
    );
    const insertSegment = db.prepare(
      `INSERT INTO segments (
        id, source_track_id, start_ms, end_ms, source_language, sort_order, segment_version,
        detected_language, language_confidence, language_detection_method,
        language_detection_version, manual_language, language_overlap_status
      ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
    );
    const insertSourceText = db.prepare(
      `INSERT INTO source_text_layers (segment_id, original_text, normalized_text, manual_text)
       VALUES (?, ?, ?, ?)`,
    );
    const insertTargetText = db.prepare(
      `INSERT INTO target_text_layers (
        segment_id, language_code, model_text, post_processed_text, manual_text,
        previous_manual_text, locked, stale, qa_flags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCandidateText = db.prepare(
      `INSERT INTO candidate_target_text_layers (
        target_track_id, segment_id, model_text, post_processed_text, manual_text,
        previous_manual_text, locked, stale, qa_flags_json, origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    project.sourceTracks.forEach((sourceTrack, sourceTrackIndex) => {
      insertSourceTrack.run(
        sourceTrack.id,
        sourceTrack.label,
        sourceTrack.kind,
        sourceTrack.languageState,
        sourceTrack.defaultLanguage,
        boolToInt(sourceTrack.isActive),
        sourceTrack.summary,
        optional(sourceTrack.rawAssetRelativePath),
        optional(sourceTrack.sourceStreamId),
        optional(sourceTrack.asrRunId),
        optional(sourceTrack.segmentationConfigVersion),
        optional(sourceTrack.trashedAt),
        sourceTrackIndex,
        project.createdAt,
      );

      sourceTrack.targetTracks.forEach((targetTrack, targetTrackIndex) => {
        insertTargetTrack.run(
          targetTrack.id,
          sourceTrack.id,
          targetTrack.languageCode,
          targetTrack.languageLabel,
          targetTrack.status,
          boolToInt(targetTrack.isActive),
          targetTrack.deliveryLabel,
          targetTrack.lastHumanAction,
          JSON.stringify(targetTrack.snapshotIds),
          JSON.stringify(targetTrack.qaIssues),
          optional(targetTrack.trashedAt),
          boolToInt(targetTrack.trashedWithSource === true),
          targetTrackIndex,
        );
        if (targetTrack.role === "candidate") {
          insertCandidateMetadata.run(targetTrack.id, optional(targetTrack.baseTrackId));
        }
      });

      sourceTrack.segments.forEach((segment, segmentIndex) => {
        insertSegment.run(
          segment.id,
          sourceTrack.id,
          parseSubtitleTime(segment.start),
          parseSubtitleTime(segment.end),
          segment.sourceLanguage,
          segmentIndex,
          optional(segment.detectedLanguage),
          optional(segment.languageConfidence),
          optional(segment.languageDetectionMethod),
          optional(segment.languageDetectionVersion),
          optional(segment.manualLanguage),
          optional(segment.languageOverlapStatus),
        );
        insertSourceText.run(
          segment.id,
          segment.sourceText.original,
          segment.sourceText.normalized,
          optional(segment.sourceText.manual),
        );

        Object.entries(segment.targetTexts).forEach(([languageCode, targetText]) => {
          insertTargetText.run(
            segment.id,
            languageCode,
            targetText.model,
            targetText.postProcessed,
            optional(targetText.manual),
            optional(targetText.previousManual),
            targetText.locked === undefined ? null : boolToInt(targetText.locked),
            boolToInt(targetText.stale === true),
            JSON.stringify(targetText.qaFlags),
          );
        });
        sourceTrack.targetTracks.forEach((targetTrack) => {
          const candidateText = targetTrack.candidateTexts?.[segment.id];
          if (!candidateText) return;
          insertCandidateText.run(
            targetTrack.id,
            segment.id,
            candidateText.model,
            candidateText.postProcessed,
            optional(candidateText.manual),
            optional(candidateText.previousManual),
            candidateText.locked === undefined ? null : boolToInt(candidateText.locked),
            boolToInt(candidateText.stale === true),
            JSON.stringify(candidateText.qaFlags ?? []),
            optional(candidateText.origin),
          );
        });
      });
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function loadProject(db) {
  const meta = db.prepare("SELECT * FROM project_meta LIMIT 1").get();
  const sourceFile = db.prepare("SELECT * FROM source_file LIMIT 1").get();
  const config = db.prepare("SELECT * FROM project_config LIMIT 1").get();
  if (!meta || !sourceFile || !config) {
    return null;
  }

  const sourceTracks = db.prepare("SELECT * FROM source_tracks ORDER BY sort_order").all().map((sourceTrack) => {
    const targetTracks = db
      .prepare("SELECT * FROM target_tracks WHERE source_track_id = ? ORDER BY sort_order")
      .all(sourceTrack.id)
      .map((targetTrack) => {
        const value = {
          id: targetTrack.id,
          languageCode: targetTrack.language_code,
          languageLabel: targetTrack.language_label,
          status: targetTrack.status,
          isActive: intToBool(targetTrack.is_active),
          qaIssues: readJson(targetTrack.qa_issues_json, []),
          snapshotIds: readJson(targetTrack.snapshot_ids_json, []),
          deliveryLabel: targetTrack.delivery_label,
          lastHumanAction: targetTrack.last_human_action,
        };
        setOptional(value, "trashedAt", targetTrack.trashed_at);
        if (intToBool(targetTrack.trashed_with_source)) value.trashedWithSource = true;
        const candidateMetadata = db
          .prepare("SELECT base_track_id FROM candidate_track_metadata WHERE target_track_id = ?")
          .get(targetTrack.id);
        if (candidateMetadata) {
          value.role = "candidate";
          if (candidateMetadata.base_track_id !== null) {
            value.baseTrackId = candidateMetadata.base_track_id;
          }
        }
        const candidateRows = db
          .prepare(
            `SELECT * FROM candidate_target_text_layers
             WHERE target_track_id = ? ORDER BY segment_id`,
          )
          .all(targetTrack.id);
        if (candidateRows.length > 0) {
          value.candidateTexts = Object.fromEntries(
            candidateRows.map((row) => {
              const layer = {
                model: row.model_text,
                postProcessed: row.post_processed_text,
                qaFlags: readJson(row.qa_flags_json, []),
              };
              setOptional(layer, "manual", row.manual_text);
              setOptional(layer, "previousManual", row.previous_manual_text);
              if (row.locked !== null) layer.locked = intToBool(row.locked);
              if (intToBool(row.stale)) layer.stale = true;
              setOptional(layer, "origin", row.origin);
              return [row.segment_id, layer];
            }),
          );
        }
        return value;
      });

    const segments = db
      .prepare("SELECT * FROM segments WHERE source_track_id = ? ORDER BY sort_order")
      .all(sourceTrack.id)
      .map((segment) => {
        const sourceTextRow = db.prepare("SELECT * FROM source_text_layers WHERE segment_id = ?").get(segment.id);
        const sourceText = {
          original: sourceTextRow.original_text,
          normalized: sourceTextRow.normalized_text,
        };
        setOptional(sourceText, "manual", sourceTextRow.manual_text);

        const targetTexts = Object.fromEntries(
          db
            .prepare("SELECT * FROM target_text_layers WHERE segment_id = ? ORDER BY language_code")
            .all(segment.id)
            .map((targetText) => {
              const value = {
                model: targetText.model_text,
                postProcessed: targetText.post_processed_text,
                qaFlags: readJson(targetText.qa_flags_json, []),
              };
              setOptional(value, "manual", targetText.manual_text);
              setOptional(value, "previousManual", targetText.previous_manual_text);
              if (targetText.locked !== null) {
                value.locked = intToBool(targetText.locked);
              }
              if (intToBool(targetText.stale ?? 0)) {
                value.stale = true;
              }
              return [targetText.language_code, value];
            }),
        );

        const value = {
          id: segment.id,
          start: formatSubtitleTime(segment.start_ms),
          end: formatSubtitleTime(segment.end_ms),
          sourceLanguage: segment.source_language,
          sourceText,
          targetTexts,
        };
        if (segment.detected_language !== null) {
          value.detectedLanguage = segment.detected_language;
          value.languageConfidence = segment.language_confidence;
          value.languageDetectionMethod = segment.language_detection_method;
          value.languageDetectionVersion = segment.language_detection_version;
          value.languageOverlapStatus = segment.language_overlap_status;
          setOptional(value, "manualLanguage", segment.manual_language);
        }
        return value;
      });

    const value = {
      id: sourceTrack.id,
      label: sourceTrack.label,
      kind: sourceTrack.kind,
      languageState: sourceTrack.language_state,
      defaultLanguage: sourceTrack.default_language,
      isActive: intToBool(sourceTrack.is_active),
      summary: sourceTrack.summary,
      segments,
      targetTracks,
    };
    setOptional(value, "rawAssetRelativePath", sourceTrack.raw_asset_relative_path);
    setOptional(value, "sourceStreamId", sourceTrack.source_stream_id);
    setOptional(value, "asrRunId", sourceTrack.asr_run_id);
    setOptional(value, "segmentationConfigVersion", sourceTrack.segmentation_config_version);
    setOptional(value, "trashedAt", sourceTrack.trashed_at);
    return value;
  });

  const project = {
    id: meta.id,
    title: meta.title,
    sourceFileName: sourceFile.source_file_name,
    mediaKind: meta.media_kind,
    noSourceMedia: intToBool(sourceFile.no_source_media),
    lifecycle: meta.lifecycle,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    activeSourceTrackId: meta.active_source_track_id ?? null,
    pendingConfirmations: readJson(meta.pending_confirmations_json, []),
    notes: readJson(meta.notes_json, []),
    config: {
      sourceLanguage: config.source_language,
      targetLanguages: readJson(config.target_languages_json, []),
      provider: config.provider_id,
      model: config.model_id,
      glossary: config.glossary_snapshot_id,
      styleGuide: config.style_guide_snapshot_id,
      outputFormat: config.output_format,
      burnVideo: intToBool(config.burn_video),
      copyMediaIntoProject: intToBool(config.copy_media_into_project),
    },
    sourceTracks,
    recentRunIds: readJson(meta.recent_run_ids_json, []),
  };
  setOptional(project.config, "asrModelId", config.asr_model_id);
  const subtitleStyle = readJson(config.subtitle_style_json, null);
  if (subtitleStyle) {
    setOptional(project.config, "subtitleStyle", normalizeSubtitleStylePayload(subtitleStyle));
  }
  const editorHistory = db
    .prepare("SELECT undo_stack_json, redo_stack_json FROM editor_history WHERE id = 1")
    .get();
  if (editorHistory) {
    project.editorHistory = {
      undoStack: readJson(editorHistory.undo_stack_json, []),
      redoStack: readJson(editorHistory.redo_stack_json, []),
    };
  }
  setOptional(project, "trashedAt", meta.trashed_at);
  setOptional(project, "archivedAt", meta.archived_at);
  setOptional(project, "sourceProjectRelativePath", sourceFile.project_relative_path);
  const probeSummary = readJson(sourceFile.probe_summary_json, {});
  if (probeSummary && typeof probeSummary === "object" && Object.keys(probeSummary).length > 0) {
    project.sourceProbeSummary = probeSummary;
  }
  const identity = readJson(sourceFile.identity_json, {});
  const hasMediaRef =
    !intToBool(sourceFile.no_source_media) &&
    (Boolean(sourceFile.original_path) ||
      Boolean(sourceFile.project_relative_path) ||
      Boolean(probeSummary?.media) ||
      sourceFile.selected_audio_stream_id != null ||
      sourceFile.selected_subtitle_stream_id != null);
  if (hasMediaRef || (identity && Object.keys(identity).length > 0)) {
    project.mediaSource = {
      assetId: "primary",
      displayName: sourceFile.source_file_name,
      availability: normalizeRelinkState(sourceFile.relink_state),
      identity:
        identity && typeof identity === "object" && Object.keys(identity).length > 0
          ? {
              sizeBytes: identity.sizeBytes ?? null,
              mtimeMs: identity.mtimeMs ?? null,
              fingerprint: identity.fingerprint ?? null,
            }
          : null,
      selectedAudioStreamId: sourceFile.selected_audio_stream_id ?? null,
      selectedSubtitleStreamId: sourceFile.selected_subtitle_stream_id ?? null,
      confirmedAudioStreamId: sourceFile.confirmed_audio_stream_id ?? null,
      confirmedSubtitleStreamId: sourceFile.confirmed_subtitle_stream_id ?? null,
    };
  }
  return project;
}

function getPrimaryMediaInternal(db) {
  const row = db.prepare("SELECT * FROM source_file WHERE id = 'primary'").get();
  if (!row) return null;
  return {
    assetId: "primary",
    originalPath: row.original_path ?? null,
    projectRelativePath: row.project_relative_path ?? null,
    mediaKind: row.media_kind,
    noSourceMedia: intToBool(row.no_source_media),
    relinkState: normalizeRelinkState(row.relink_state),
    probeSummary: readJson(row.probe_summary_json, {}),
    identity: readJson(row.identity_json, {}),
    selectedAudioStreamId: row.selected_audio_stream_id ?? null,
    selectedSubtitleStreamId: row.selected_subtitle_stream_id ?? null,
    confirmedAudioStreamId: row.confirmed_audio_stream_id ?? null,
    confirmedSubtitleStreamId: row.confirmed_subtitle_stream_id ?? null,
  };
}

function updatePrimaryMediaInternal(db, patch) {
  const current = getPrimaryMediaInternal(db);
  if (!current) {
    const error = new Error("Primary media source missing");
    error.code = "NOT_FOUND";
    throw error;
  }
  db.prepare(
    `UPDATE source_file
     SET original_path = ?,
         project_relative_path = ?,
         media_kind = ?,
         no_source_media = ?,
         relink_state = ?,
         probe_summary_json = ?,
         identity_json = ?,
         selected_audio_stream_id = ?,
         selected_subtitle_stream_id = ?,
         confirmed_audio_stream_id = ?,
         confirmed_subtitle_stream_id = ?,
         source_file_name = COALESCE(?, source_file_name)
     WHERE id = 'primary'`,
  ).run(
    patch.originalPath !== undefined ? optional(patch.originalPath) : optional(current.originalPath),
    patch.projectRelativePath !== undefined
      ? optional(patch.projectRelativePath)
      : optional(current.projectRelativePath),
    patch.mediaKind ?? current.mediaKind,
    boolToInt(patch.noSourceMedia ?? current.noSourceMedia),
    normalizeRelinkState(patch.relinkState ?? current.relinkState),
    JSON.stringify(patch.probeSummary ?? current.probeSummary ?? {}),
    JSON.stringify(patch.identity ?? current.identity ?? {}),
    patch.selectedAudioStreamId !== undefined
      ? optional(patch.selectedAudioStreamId)
      : optional(current.selectedAudioStreamId),
    patch.selectedSubtitleStreamId !== undefined
      ? optional(patch.selectedSubtitleStreamId)
      : optional(current.selectedSubtitleStreamId),
    patch.confirmedAudioStreamId !== undefined
      ? optional(patch.confirmedAudioStreamId)
      : optional(current.confirmedAudioStreamId),
    patch.confirmedSubtitleStreamId !== undefined
      ? optional(patch.confirmedSubtitleStreamId)
      : optional(current.confirmedSubtitleStreamId),
    patch.displayName ?? null,
  );
  return getPrimaryMediaInternal(db);
}

function appendExportRecord(db, record) {
  const exportKind = record.exportKind;
  if (![
    "source",
    "target",
    "bilingual",
    "soft_subtitle",
    "burned_video",
    "lightweight_package",
    "archive_package",
    "audio_separation",
  ].includes(exportKind)) {
    throw new Error(`Invalid export_kind: ${String(exportKind)}`);
  }
  if (["source", "lightweight_package", "archive_package", "audio_separation"].includes(exportKind)) {
    if (record.targetLanguageCode != null || record.targetTrackId != null) {
      throw new Error(`${exportKind} export must leave target language and track null`);
    }
  } else if (!record.targetLanguageCode || !record.targetTrackId) {
    throw new Error(`${exportKind} export requires target language and track`);
  }

  db.prepare(
    `INSERT INTO export_records (
      id, export_kind, target_language_code, format, path, created_at,
      source_track_id, target_track_id, track_status, delivery_status, destination_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    exportKind,
    optional(record.targetLanguageCode),
    record.format,
    record.path,
    record.createdAt,
    record.sourceTrackId,
    optional(record.targetTrackId),
    record.trackStatus ?? (exportKind === "source" ? "source" : "approved"),
    record.deliveryStatus ?? "approved",
    record.destinationKind ?? "project",
  );
}

function listExportRecords(db) {
  return db
    .prepare("SELECT * FROM export_records ORDER BY created_at, id")
    .all()
    .map((row) => ({
      id: row.id,
      exportKind: row.export_kind,
      targetLanguageCode: row.target_language_code,
      format: row.format,
      path: row.path,
      createdAt: row.created_at,
      sourceTrackId: row.source_track_id,
      targetTrackId: row.target_track_id,
      trackStatus: row.track_status,
      deliveryStatus: row.delivery_status,
      destinationKind: row.destination_kind,
    }));
}

function appendRunSnapshot(db, snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Run snapshot is required");
  }
  for (const field of [
    "id",
    "projectId",
    "sourceTrackId",
    "targetLanguageCode",
    "providerId",
    "model",
    "promptTemplateVersion",
    "segmentVersion",
    "createdAt",
  ]) {
    if (typeof snapshot[field] !== "string" || snapshot[field].length === 0) {
      throw new Error(`Run snapshot field ${field} is required`);
    }
  }

  const existing = db.prepare("SELECT id FROM run_snapshots WHERE id = ?").get(snapshot.id);
  if (existing) {
    const error = new Error("Run snapshots are immutable and cannot be updated");
    error.code = "CONFLICT";
    throw error;
  }

  const glossarySnapshotId =
    snapshot.glossarySnapshotId ??
    snapshot.resourceSnapshot?.glossary?.id ??
    (snapshot.resourceSnapshot?.glossary?.empty ? "empty" : "");
  const styleGuideSnapshotId =
    snapshot.styleGuideSnapshotId ??
    snapshot.resourceSnapshot?.styleGuide?.id ??
    (snapshot.resourceSnapshot?.styleGuide?.empty ? "empty" : "");

  db.prepare(
    `INSERT INTO run_snapshots (
      id, project_id, source_track_id, target_language_code, provider_id, model_id,
      base_url_display, transport_mode, parameters_json,
      glossary_snapshot_id, style_guide_snapshot_id, resource_snapshot_json, resource_fingerprint,
      prompt_template_version, segment_version,
      created_at, cache_hits,
      input_tokens, output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.id,
    snapshot.projectId,
    snapshot.sourceTrackId,
    snapshot.targetLanguageCode,
    snapshot.providerId,
    snapshot.model,
    optional(snapshot.baseUrlDisplay),
    optional(snapshot.transportMode),
    JSON.stringify(snapshot.parameters ?? {}),
    glossarySnapshotId || "empty",
    styleGuideSnapshotId || "empty",
    JSON.stringify(snapshot.resourceSnapshot ?? {}),
    optional(snapshot.resourceFingerprint),
    snapshot.promptTemplateVersion,
    snapshot.segmentVersion,
    snapshot.createdAt,
    Number(snapshot.cacheHits) || 0,
    Number(snapshot.inputTokens) || 0,
    Number(snapshot.outputTokens) || 0,
  );
}

function listRunSnapshots(db) {
  return db
    .prepare("SELECT * FROM run_snapshots ORDER BY created_at ASC, id ASC")
    .all()
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      sourceTrackId: row.source_track_id,
      targetLanguageCode: row.target_language_code,
      provider: row.provider_id,
      model: row.model_id,
      baseUrlDisplay: row.base_url_display,
      transportMode: row.transport_mode,
      parameters: readJson(row.parameters_json, {}),
      glossarySnapshot: row.glossary_snapshot_id,
      styleGuideSnapshot: row.style_guide_snapshot_id,
      resourceSnapshot: readJson(row.resource_snapshot_json, {}),
      resourceFingerprint: row.resource_fingerprint,
      promptTemplateVersion: row.prompt_template_version,
      segmentVersion: row.segment_version,
      createdAt: row.created_at,
      cacheHits: row.cache_hits,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    }));
}

function asrError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireAsrId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw asrError("INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function normalizeAsrRun(run, result) {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw asrError("INVALID_INPUT", "ASR run metadata is required");
  }
  if (!isAsrModelId(run.modelId)) throw asrError("INVALID_INPUT", "modelId is invalid");
  const qwen = asrEngineForModelId(run.modelId) === "qwen3-asr";
  for (const [field, expected] of qwen ? [
    ["engineId", "qwen3-asr"],
    ["engineVersion", "0.0.6"],
    ["runtimeVersion", "0.0.6+torch2.11.0-cu128"],
    ["canonicalizerVersion", "qwen3-asr-0.0.6-v2"],
  ] : [
    ["engineId", "whisper.cpp"],
    ["engineVersion", "1.9.1"],
    ["runtimeVersion", "1.9.1"],
    ["canonicalizerVersion", "whisper.cpp-1.9.1-v2"],
  ]) {
    if (run[field] !== expected) throw asrError("INVALID_INPUT", `${field} is invalid`);
  }
  const requestedDevices = new Set(["auto", "cpu", "cuda"]);
  const actualDevices = new Set(["cpu", "cuda"]);
  const fallbackReasons = new Set(["cuda_not_ready", "cuda_probe_failed", "cuda_initialization_failed"]);
  if (!requestedDevices.has(run.requestedDevice) || !actualDevices.has(run.actualDevice)) {
    throw asrError("INVALID_INPUT", "ASR device provenance is invalid");
  }
  if (run.fallbackReason !== null && !fallbackReasons.has(run.fallbackReason)) {
    throw asrError("INVALID_INPUT", "ASR fallback reason is invalid");
  }
  if (qwen && (run.actualDevice !== "cuda" || run.fallbackReason !== null)) {
    throw asrError("INVALID_INPUT", "Qwen runtime provenance is invalid");
  }
  const expectedRuntimeId = qwen
    ? "qwen3-asr-transformers-cu128-x64"
    : run.actualDevice === "cpu" ? "whisper-cpp-cpu-x64" : "whisper-cpp-cuda-12.4-x64";
  if (run.runtimeId !== expectedRuntimeId) throw asrError("INVALID_INPUT", "ASR runtime identity is invalid");
  if (typeof run.modelVersion !== "string" || run.modelVersion.length === 0 || run.modelVersion.length > 128) {
    throw asrError("INVALID_INPUT", "ASR model version is invalid");
  }
  if (
    !/^[a-f0-9]{64}$/.test(run.modelHash) ||
    !/^[a-f0-9]{64}$/.test(run.cacheFingerprint) ||
    !/^[a-f0-9]{64}$/.test(run.rawArtifactSha256)
  ) {
    throw asrError("INVALID_INPUT", "ASR artifact hash is invalid");
  }
  if (
    typeof run.rawArtifactRelativePath !== "string" ||
    !/^artifacts\/asr\/[A-Za-z0-9._-]{1,128}\.json$/.test(run.rawArtifactRelativePath)
  ) {
    throw asrError("INVALID_INPUT", "ASR artifact path is invalid");
  }
  if (
    !Number.isSafeInteger(run.rawArtifactSizeBytes) ||
    run.rawArtifactSizeBytes <= 0 ||
    run.rawArtifactSizeBytes > ASR_RESULT_LIMITS.MAX_ARTIFACT_BYTES
  ) {
    throw asrError("OUTPUT_TOO_LARGE", "ASR artifact size is invalid");
  }
  if (!Number.isSafeInteger(run.processingDurationMs) || run.processingDurationMs < 0) {
    throw asrError("INVALID_INPUT", "ASR processing duration is invalid");
  }
  if (run.languageMode !== "auto" && run.languageMode !== "fixed") {
    throw asrError("INVALID_INPUT", "ASR language mode is invalid");
  }
  if (run.languageHint !== null && (typeof run.languageHint !== "string" || run.languageHint.length > 32)) {
    throw asrError("INVALID_INPUT", "ASR language hint is invalid");
  }
  if (!run.parameters || typeof run.parameters !== "object" || Array.isArray(run.parameters)) {
    throw asrError("INVALID_INPUT", "ASR parameters are invalid");
  }
  if (Buffer.byteLength(JSON.stringify(run.parameters), "utf8") > 4_096) {
    throw asrError("OUTPUT_TOO_LARGE", "ASR parameters exceed the limit");
  }
  for (const field of ["createdAt", "completedAt"]) {
    if (typeof run[field] !== "string" || run[field].length === 0 || run[field].length > 64) {
      throw asrError("INVALID_INPUT", `${field} is invalid`);
    }
  }
  return {
    ...run,
    id: requireAsrId(run.id, "run.id"),
    operationId: requireAsrId(run.operationId, "run.operationId"),
    projectId: requireAsrId(run.projectId, "run.projectId"),
    audioStreamId: /^s:\d+$/.test(run.audioStreamId) ? run.audioStreamId : (() => { throw asrError("INVALID_INPUT", "audioStreamId is invalid"); })(),
    status: "completed",
    mediaDurationMs: result.mediaDurationMs,
    rawSegmentCount: result.segments.length,
    wordCount: result.segments.reduce((total, segment) => total + segment.words.length, 0),
    detectedLanguage: result.detectedLanguage,
    languageProbability: result.languageProbability,
    warnings: result.warnings,
  };
}

function asrRunSummary(row, deduplicated) {
  return {
    runId: row.id,
    operationId: row.operation_id,
    segmentCount: row.raw_segment_count,
    wordCount: row.word_count,
    deduplicated,
  };
}

function commitAsrRun(db, { run, result: rawResult }) {
  const operationId = requireAsrId(run?.operationId, "run.operationId");
  const existingOperation = db.prepare("SELECT * FROM asr_runs WHERE operation_id = ?").get(operationId);
  if (existingOperation) {
    if (existingOperation.cache_fingerprint !== run?.cacheFingerprint) {
      throw asrError("CONFLICT", "ASR recovery fingerprint does not match the completed run");
    }
    return asrRunSummary(existingOperation, true);
  }
  const result = validateAsrResult(rawResult);
  const value = normalizeAsrRun(run, result);
  if (!db.prepare("SELECT id FROM project_meta WHERE id = ?").get(value.projectId)) {
    throw asrError("NOT_FOUND", "Project not found");
  }
  if (db.prepare("SELECT id FROM asr_runs WHERE id = ?").get(value.id)) {
    throw asrError("CONFLICT", "ASR runs are immutable");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO asr_runs (
        id, operation_id, project_id, audio_stream_id, status, result_schema_version,
        engine_id, engine_version, runtime_id, runtime_version, model_id, model_version, model_hash, cache_fingerprint,
        requested_device, actual_device, fallback_reason, language_mode, language_hint, parameters_json,
        canonicalizer_version, raw_artifact_relative_path, raw_artifact_sha256, raw_artifact_size_bytes,
        media_duration_ms, processing_duration_ms, raw_segment_count, word_count,
        detected_language, language_probability, warning_codes_json, song_activity_json,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'completed', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      value.id, value.operationId, value.projectId, value.audioStreamId,
      value.engineId, value.engineVersion, value.runtimeId, value.runtimeVersion,
      value.modelId, value.modelVersion, value.modelHash, value.cacheFingerprint,
      value.requestedDevice, value.actualDevice, optional(value.fallbackReason),
      value.languageMode, optional(value.languageHint), JSON.stringify(value.parameters),
      value.canonicalizerVersion, value.rawArtifactRelativePath, value.rawArtifactSha256,
      value.rawArtifactSizeBytes, value.mediaDurationMs, value.processingDurationMs,
      value.rawSegmentCount, value.wordCount, value.detectedLanguage,
      optional(value.languageProbability), JSON.stringify(value.warnings),
      result.songActivity ? JSON.stringify(result.songActivity) : null,
      value.createdAt, value.completedAt,
    );
    const insertSegment = db.prepare(
      `INSERT INTO asr_raw_segments (
        run_id, segment_index, start_ms, end_ms, text, language, language_probability
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertWord = db.prepare(
      `INSERT INTO asr_words (
        run_id, segment_index, word_index, start_ms, end_ms, text, probability,
        raw_start_ms, raw_end_ms, repair_codes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    result.segments.forEach((segment, segmentIndex) => {
      insertSegment.run(
        value.id, segmentIndex, segment.startMs, segment.endMs, segment.text,
        segment.language, optional(segment.languageProbability),
      );
      segment.words.forEach((word, wordIndex) => {
        insertWord.run(
          value.id, segmentIndex, wordIndex, word.startMs, word.endMs, word.text,
          optional(word.probability), optional(word.rawStartMs), optional(word.rawEndMs),
          JSON.stringify(word.repairCodes ?? []),
        );
      });
    });
    db.exec("COMMIT");
    return {
      runId: value.id,
      operationId: value.operationId,
      segmentCount: value.rawSegmentCount,
      wordCount: value.wordCount,
      deduplicated: false,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function asrRunFromRow(row) {
  return {
    id: row.id,
    operationId: row.operation_id,
    projectId: row.project_id,
    audioStreamId: row.audio_stream_id,
    status: row.status,
    engineId: row.engine_id,
    engineVersion: row.engine_version,
    runtimeId: row.runtime_id,
    runtimeVersion: row.runtime_version,
    modelId: row.model_id,
    modelVersion: row.model_version,
    modelHash: row.model_hash,
    cacheFingerprint: row.cache_fingerprint,
    requestedDevice: row.requested_device,
    actualDevice: row.actual_device,
    fallbackReason: row.fallback_reason,
    languageMode: row.language_mode,
    languageHint: row.language_hint,
    parameters: readJson(row.parameters_json, {}),
    canonicalizerVersion: row.canonicalizer_version,
    rawArtifactRelativePath: row.raw_artifact_relative_path,
    rawArtifactSha256: row.raw_artifact_sha256,
    rawArtifactSizeBytes: row.raw_artifact_size_bytes,
    mediaDurationMs: row.media_duration_ms,
    processingDurationMs: row.processing_duration_ms,
    rawSegmentCount: row.raw_segment_count,
    wordCount: row.word_count,
    detectedLanguage: row.detected_language,
    languageProbability: row.language_probability,
    warnings: readJson(row.warning_codes_json, []),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function listAsrRuns(db) {
  return db.prepare("SELECT * FROM asr_runs ORDER BY created_at ASC, id ASC").all().map(asrRunFromRow);
}

function reconcileAsrArtifacts(db, containerDir) {
  const root = join(containerDir, "artifacts", "asr");
  mkdirSync(root, { recursive: true });
  const referenced = new Map(db.prepare(
    "SELECT raw_artifact_relative_path, raw_artifact_sha256, raw_artifact_size_bytes FROM asr_runs",
  ).all().flatMap((row) => {
    const name = /^artifacts\/asr\/([A-Za-z0-9._-]{1,128}\.json)$/.exec(row.raw_artifact_relative_path)?.[1];
    return name ? [[name, row]] : [];
  }));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const finalized = /^[A-Za-z0-9._-]{1,128}\.json$/.test(entry.name);
    const partial = entry.name.endsWith(".partial");
    if (!(entry.isFile() || entry.isSymbolicLink()) || (!partial && !finalized)) continue;
    const path = join(root, entry.name);
    const expected = finalized ? referenced.get(entry.name) : null;
    let matches = false;
    if (expected && entry.isFile() && !entry.isSymbolicLink()) {
      const bytes = readFileSync(path);
      matches = bytes.length === expected.raw_artifact_size_bytes &&
        createHash("sha256").update(bytes).digest("hex") === expected.raw_artifact_sha256;
    }
    if (!matches) rmSync(path, { force: true });
  }
}

function getAsrRun(db, runId) {
  requireAsrId(runId, "runId");
  const row = db.prepare("SELECT * FROM asr_runs WHERE id = ?").get(runId);
  if (!row) return null;
  const wordRows = db.prepare(
    "SELECT * FROM asr_words WHERE run_id = ? ORDER BY segment_index ASC, word_index ASC",
  ).all(runId);
  const wordsBySegment = new Map();
  for (const word of wordRows) {
    const values = wordsBySegment.get(word.segment_index) ?? [];
    const item = {
      startMs: word.start_ms,
      endMs: word.end_ms,
      text: word.text,
      probability: word.probability,
    };
    if (word.raw_start_ms !== null) {
      item.rawStartMs = word.raw_start_ms;
      item.rawEndMs = word.raw_end_ms;
    }
    const repairCodes = readJson(word.repair_codes_json, []);
    if (repairCodes.length) item.repairCodes = repairCodes;
    values.push(item);
    wordsBySegment.set(word.segment_index, values);
  }
  const segments = db.prepare(
    "SELECT * FROM asr_raw_segments WHERE run_id = ? ORDER BY segment_index ASC",
  ).all(runId).map((segment) => ({
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    text: segment.text,
    language: segment.language,
    languageProbability: segment.language_probability,
    words: wordsBySegment.get(segment.segment_index) ?? [],
  }));
  const result = {
    schemaVersion: row.result_schema_version,
    mediaDurationMs: row.media_duration_ms,
    detectedLanguage: row.detected_language,
    languageProbability: row.language_probability,
    warnings: readJson(row.warning_codes_json, []),
    segments,
  };
  const songActivity = readJson(row.song_activity_json, null);
  if (songActivity) result.songActivity = songActivity;
  return {
    run: asrRunFromRow(row),
    result,
  };
}

function validateAsrCandidate(sourceTrack, run, configVersion, targetLanguages) {
  requireAsrId(sourceTrack?.id, "sourceTrack.id");
  const detectedLanguages = new Set(sourceTrack?.segments
    ?.map((segment) => segment.sourceLanguage)
    .filter((language) => language !== "und"));
  const expectedLanguageState = run.engine_id === "qwen3-asr"
    ? detectedLanguages.size > 1 ? "multilingual" : detectedLanguages.size === 1 ? "known" : "pending"
    : "pending";
  const expectedDefaultLanguage = expectedLanguageState === "known"
    ? detectedLanguages.values().next().value
    : "auto";
  if (
    sourceTrack.kind !== "asr" || sourceTrack.isActive !== false ||
    sourceTrack.languageState !== expectedLanguageState || sourceTrack.defaultLanguage !== expectedDefaultLanguage ||
    sourceTrack.asrRunId !== run.id || sourceTrack.sourceStreamId !== run.audio_stream_id ||
    sourceTrack.segmentationConfigVersion !== configVersion ||
    typeof sourceTrack.label !== "string" || !sourceTrack.label || sourceTrack.label.length > 256 ||
    typeof sourceTrack.summary !== "string" || sourceTrack.summary.length > 512 ||
    !Array.isArray(sourceTrack.segments) || !sourceTrack.segments.length ||
    !Array.isArray(sourceTrack.targetTracks)
  ) {
    throw asrError("INVALID_INPUT", "ASR candidate track is invalid");
  }
  const targetCodes = sourceTrack.targetTracks.map((target) => target.languageCode);
  if (
    new Set(targetCodes).size !== targetCodes.length ||
    targetCodes.length !== targetLanguages.length ||
    targetLanguages.some((language) => !targetCodes.includes(language))
  ) {
    throw asrError("INVALID_INPUT", "ASR candidate target languages are invalid");
  }
  const targetIds = new Set();
  for (const target of sourceTrack.targetTracks) {
    requireAsrId(target.id, "targetTrack.id");
    if (
      targetIds.has(target.id) || target.status !== "draft" || target.isActive !== true ||
      typeof target.languageLabel !== "string" || !target.languageLabel ||
      !Array.isArray(target.qaIssues) || target.qaIssues.length ||
      !Array.isArray(target.snapshotIds) || target.snapshotIds.length ||
      typeof target.deliveryLabel !== "string" || typeof target.lastHumanAction !== "string"
    ) {
      throw asrError("INVALID_INPUT", "ASR candidate target track is invalid");
    }
    targetIds.add(target.id);
  }
  const segmentIds = new Set();
  let previousEnd = -ASR_SEGMENTATION_CONFIG.minGapMs;
  for (const segment of sourceTrack.segments) {
    requireAsrId(segment.id, "segment.id");
    const startMs = parseSubtitleTime(segment.start);
    const endMs = parseSubtitleTime(segment.end);
    const normalized = segment.sourceText?.normalized;
    const original = segment.sourceText?.original;
    const lines = typeof normalized === "string" ? normalized.split("\n") : [];
    if (
      segmentIds.has(segment.id) || startMs < previousEnd + ASR_SEGMENTATION_CONFIG.minGapMs ||
      endMs > run.media_duration_ms || endMs - startMs < ASR_SEGMENTATION_CONFIG.minDurationMs ||
      endMs - startMs > ASR_SEGMENTATION_CONFIG.maxDurationMs ||
      !/^(?:und|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(segment.sourceLanguage) ||
      typeof original !== "string" || !original.trim() || typeof normalized !== "string" || !normalized.trim() ||
      Object.hasOwn(segment.sourceText, "manual") ||
      original.normalize("NFC").replace(/\s/gu, "") !== normalized.normalize("NFC").replace(/\s/gu, "") ||
      lines.length > ASR_SEGMENTATION_CONFIG.maxLines ||
      lines.some((line) => [...line].length > ASR_SEGMENTATION_CONFIG.maxCharsPerLine) ||
      !segment.targetTexts || Object.keys(segment.targetTexts).length !== targetLanguages.length ||
      targetLanguages.some((language) => {
        const layer = segment.targetTexts[language];
        return !layer || layer.model !== "" || layer.postProcessed !== "" ||
          !Array.isArray(layer.qaFlags) || layer.qaFlags.some((flag) => flag !== "suspected-lyrics") ||
          new Set(layer.qaFlags).size !== layer.qaFlags.length ||
          Object.keys(layer).some((key) => !["model", "postProcessed", "qaFlags"].includes(key));
      })
    ) {
      throw asrError("INVALID_INPUT", "ASR candidate segment is invalid");
    }
    segmentIds.add(segment.id);
    previousEnd = endMs;
  }
}

function commitAsrCandidate(db, { asrRunId, configVersion, sourceTrack, updatedAt }) {
  requireAsrId(asrRunId, "asrRunId");
  if (typeof configVersion !== "string" || !/^asr-segmentation-v[A-Za-z0-9._-]{1,64}$/.test(configVersion)) {
    throw asrError("INVALID_INPUT", "Segmentation config version is invalid");
  }
  const existing = db.prepare(
    `SELECT source_tracks.id,
            (SELECT COUNT(*) FROM segments WHERE segments.source_track_id = source_tracks.id) AS segment_count
     FROM source_tracks WHERE asr_run_id = ? AND segmentation_config_version = ?`,
  ).get(asrRunId, configVersion);
  if (existing) return {
    sourceTrackId: existing.id,
    asrRunId,
    configVersion,
    segmentCount: existing.segment_count,
    deduplicated: true,
  };
  const run = db.prepare("SELECT * FROM asr_runs WHERE id = ? AND status = 'completed'").get(asrRunId);
  if (!run) throw asrError("NOT_FOUND", "Completed ASR run not found");
  const project = db.prepare("SELECT id FROM project_meta WHERE id = ?").get(run.project_id);
  if (!project) throw asrError("NOT_FOUND", "Project not found");
  const targetLanguages = readJson(db.prepare("SELECT target_languages_json FROM project_config").get()?.target_languages_json, []);
  validateAsrCandidate(sourceTrack, run, configVersion, targetLanguages);
  if (typeof updatedAt !== "string" || !updatedAt || updatedAt.length > 64) {
    throw asrError("INVALID_INPUT", "updatedAt is invalid");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const sortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM source_tracks").get().value;
    db.prepare(
      `INSERT INTO source_tracks (
        id, label, kind, language_state, default_language, is_active, summary,
        raw_asset_relative_path, source_stream_id, asr_run_id, segmentation_config_version,
        sort_order, created_at
      ) VALUES (?, ?, 'asr', ?, ?, 0, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(sourceTrack.id, sourceTrack.label, sourceTrack.languageState, sourceTrack.defaultLanguage,
      sourceTrack.summary, sourceTrack.sourceStreamId, asrRunId, configVersion, sortOrder, updatedAt);
    const insertTarget = db.prepare(
      `INSERT INTO target_tracks (
        id, source_track_id, language_code, language_label, status, is_active,
        delivery_label, last_human_action, snapshot_ids_json, qa_issues_json, sort_order
      ) VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, '[]', '[]', ?)`,
    );
    sourceTrack.targetTracks.forEach((target, index) => insertTarget.run(
      target.id, sourceTrack.id, target.languageCode, target.languageLabel,
      target.deliveryLabel, target.lastHumanAction, index,
    ));
    const insertSegment = db.prepare(
      `INSERT INTO segments (id, source_track_id, start_ms, end_ms, source_language, sort_order, segment_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSource = db.prepare(
      "INSERT INTO source_text_layers (segment_id, original_text, normalized_text, manual_text) VALUES (?, ?, ?, NULL)",
    );
    const insertTargetText = db.prepare(
      `INSERT INTO target_text_layers (
        segment_id, language_code, model_text, post_processed_text, manual_text,
        previous_manual_text, locked, stale, qa_flags_json
      ) VALUES (?, ?, '', '', NULL, NULL, NULL, 0, ?)`,
    );
    sourceTrack.segments.forEach((segment, index) => {
      insertSegment.run(segment.id, sourceTrack.id, parseSubtitleTime(segment.start), parseSubtitleTime(segment.end),
        segment.sourceLanguage, index, configVersion);
      insertSource.run(segment.id, segment.sourceText.original, segment.sourceText.normalized);
      targetLanguages.forEach((language) => insertTargetText.run(
        segment.id,
        language,
        JSON.stringify(segment.targetTexts[language].qaFlags),
      ));
    });
    db.prepare("UPDATE project_meta SET updated_at = ? WHERE id = ?").run(updatedAt, run.project_id);
    db.exec("COMMIT");
    return {
      sourceTrackId: sourceTrack.id,
      asrRunId,
      configVersion,
      segmentCount: sourceTrack.segments.length,
      deduplicated: false,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateLanguageStatePayload(track, storedSegments, segments, languageState, defaultLanguage) {
  if (!new Set(["known", "pending", "multilingual"]).has(languageState)) {
    throw asrError("INVALID_INPUT", "ASR track language state is invalid");
  }
  if (!Array.isArray(segments) || segments.length !== storedSegments.length) {
    throw asrError("INVALID_INPUT", "ASR language state must cover every segment");
  }
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  if (byId.size !== segments.length || storedSegments.some((segment) => !byId.has(segment.id))) {
    throw asrError("INVALID_INPUT", "ASR language segment IDs are invalid");
  }
  const code = /^(?:und|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/;
  for (const segment of segments) {
    const manual = segment.manualLanguage ?? null;
    const confident = segment.languageOverlapStatus === "none" && segment.detectedLanguage !== "und" &&
      segment.languageConfidence !== null && segment.languageConfidence >= ASR_LANGUAGE_DETECTION_CONFIG.confidenceThreshold;
    const effective = manual ?? (confident ? segment.detectedLanguage : "und");
    if (
      !code.test(segment.detectedLanguage) ||
      (segment.languageConfidence !== null && (!Number.isFinite(segment.languageConfidence) || segment.languageConfidence < 0 || segment.languageConfidence > 1)) ||
      segment.languageDetectionMethod !== ASR_LANGUAGE_DETECTION_CONFIG.method ||
      segment.languageDetectionVersion !== ASR_LANGUAGE_DETECTION_CONFIG.version ||
      !new Set(["none", "overlap_unsupported"]).has(segment.languageOverlapStatus) ||
      (manual !== null && (manual === "und" || !code.test(manual))) ||
      segment.sourceLanguage !== effective
    ) {
      throw asrError("INVALID_INPUT", "ASR segment language state is invalid");
    }
  }
  const effective = segments.map((segment) => segment.sourceLanguage);
  const languages = new Set(effective.filter((language) => language !== "und"));
  const hasPending = effective.includes("und");
  if (
    (hasPending && languageState !== "pending") ||
    (!hasPending && languages.size > 1 && languageState !== "multilingual") ||
    (!hasPending && languages.size === 1 && !new Set(["known", "multilingual"]).has(languageState)) ||
    (languageState === "known" && defaultLanguage !== languages.values().next().value) ||
    (languageState !== "known" && defaultLanguage !== "auto") ||
    track.kind !== "asr" || track.asr_run_id === null
  ) {
    throw asrError("INVALID_INPUT", "ASR track language summary is invalid");
  }
  return byId;
}

function commitAsrLanguageState(db, { sourceTrackId, segments, languageState, defaultLanguage, updatedAt }) {
  requireAsrId(sourceTrackId, "sourceTrackId");
  const track = db.prepare("SELECT * FROM source_tracks WHERE id = ?").get(sourceTrackId);
  if (!track) throw asrError("NOT_FOUND", "ASR candidate not found");
  const storedSegments = db.prepare(
    "SELECT id, source_language FROM segments WHERE source_track_id = ? ORDER BY sort_order",
  ).all(sourceTrackId);
  const byId = validateLanguageStatePayload(track, storedSegments, segments, languageState, defaultLanguage);
  if (typeof updatedAt !== "string" || !updatedAt || updatedAt.length > 64) throw asrError("INVALID_INPUT", "updatedAt is invalid");
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare(
      `UPDATE segments SET source_language = ?, detected_language = ?, language_confidence = ?,
       language_detection_method = ?, language_detection_version = ?, manual_language = ?,
       language_overlap_status = ? WHERE id = ? AND source_track_id = ?`,
    );
    const stale = db.prepare(
      `UPDATE target_text_layers SET stale = 1
       WHERE segment_id = ? AND (model_text <> '' OR post_processed_text <> '' OR manual_text IS NOT NULL OR previous_manual_text IS NOT NULL)`,
    );
    for (const stored of storedSegments) {
      const segment = byId.get(stored.id);
      update.run(segment.sourceLanguage, segment.detectedLanguage, optional(segment.languageConfidence),
        segment.languageDetectionMethod, segment.languageDetectionVersion, optional(segment.manualLanguage),
        segment.languageOverlapStatus, segment.id, sourceTrackId);
      if (stored.source_language !== segment.sourceLanguage) stale.run(segment.id);
    }
    db.prepare("UPDATE source_tracks SET language_state = ?, default_language = ? WHERE id = ?")
      .run(languageState, defaultLanguage, sourceTrackId);
    db.prepare(
      `UPDATE project_meta SET updated_at = ?
       WHERE id = (SELECT project_id FROM asr_runs WHERE id = ?)`,
    ).run(updatedAt, track.asr_run_id);
    db.exec("COMMIT");
    return { sourceTrackId, languageState, defaultLanguage, segmentCount: segments.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Writes model/postProcessed layers only. Never overwrites manual/previousManual/locked.
 * Uses the shared target-text state machine for protection decisions.
 */
function applyModelTranslations(db, { languageCode, translations }, { manageTransaction = true } = {}) {
  if (typeof languageCode !== "string" || languageCode.length === 0) {
    throw new Error("languageCode is required");
  }
  if (!translations || typeof translations !== "object") {
    throw new Error("translations map is required");
  }
  if (manageTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const select = db.prepare(
      `SELECT model_text, post_processed_text, manual_text, previous_manual_text, locked, stale, qa_flags_json
       FROM target_text_layers
       WHERE segment_id = ? AND language_code = ?`,
    );
    const update = db.prepare(
      `UPDATE target_text_layers
       SET model_text = ?, post_processed_text = ?, stale = 0
       WHERE segment_id = ? AND language_code = ?`,
    );
    const insert = db.prepare(
      `INSERT INTO target_text_layers (
         segment_id, language_code, model_text, post_processed_text, manual_text,
         previous_manual_text, locked, stale, qa_flags_json
       ) VALUES (?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
    );

    let applied = 0;
    let skippedProtected = 0;
    for (const [segmentId, text] of Object.entries(translations)) {
      if (typeof text !== "string") {
        throw new Error(`translation text for ${segmentId} must be a string`);
      }
      const row = select.get(segmentId, languageCode);
      if (row) {
        const currentLayer = {
          model: row.model_text,
          postProcessed: row.post_processed_text,
          qaFlags: readJson(row.qa_flags_json, []),
          stale: intToBool(row.stale ?? 0),
        };
        if (row.manual_text !== null) currentLayer.manual = row.manual_text;
        if (row.previous_manual_text !== null) currentLayer.previousManual = row.previous_manual_text;
        if (row.locked !== null && Number(row.locked) === 1) currentLayer.locked = true;

        if (isProtectedTargetLayer(currentLayer)) {
          skippedProtected += 1;
          continue;
        }

        const transition = applyAutomaticModelText(currentLayer, text);
        if (!transition.ok) {
          skippedProtected += 1;
          continue;
        }
        update.run(transition.layer.model, transition.layer.postProcessed, segmentId, languageCode);
        applied += 1;
      } else {
        insert.run(segmentId, languageCode, text, text, "[]");
        applied += 1;
      }
    }
    if (manageTransaction) db.exec("COMMIT");
    return { applied, skippedProtected };
  } catch (error) {
    if (manageTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function targetLayerFromRow(row) {
  const layer = {
    model: row?.model_text ?? "",
    postProcessed: row?.post_processed_text ?? "",
    qaFlags: readJson(row?.qa_flags_json, []),
  };
  if (row?.manual_text !== null && row?.manual_text !== undefined) layer.manual = row.manual_text;
  if (row?.previous_manual_text !== null && row?.previous_manual_text !== undefined) {
    layer.previousManual = row.previous_manual_text;
  }
  if (row?.locked !== null && row?.locked !== undefined) layer.locked = intToBool(row.locked);
  if (intToBool(row?.stale ?? 0)) layer.stale = true;
  return layer;
}

function applySelectedTranslations(db, { languageCode, translations, selectedSegmentIds }) {
  const allowed = new Set(selectedSegmentIds ?? []);
  const unexpected = Object.keys(translations).filter((segmentId) => !allowed.has(segmentId));
  if (unexpected.length > 0) throw new Error(`Unexpected selected translation ids: ${unexpected.join(",")}`);
  const select = db.prepare(
    `SELECT model_text, post_processed_text, manual_text, previous_manual_text, locked, stale, qa_flags_json
     FROM target_text_layers WHERE segment_id = ? AND language_code = ?`,
  );
  const update = db.prepare(
    `UPDATE target_text_layers SET
       model_text = ?, post_processed_text = ?, manual_text = ?, previous_manual_text = ?,
       locked = ?, stale = ?, qa_flags_json = ?
     WHERE segment_id = ? AND language_code = ?`,
  );
  let applied = 0;
  let skippedProtected = 0;
  for (const [segmentId, text] of Object.entries(translations)) {
    const row = select.get(segmentId, languageCode);
    if (!row) throw new Error(`Target text missing for selected segment ${segmentId}`);
    const transition = applyExplicitRerunResult(targetLayerFromRow(row), text);
    if (!transition.ok) {
      skippedProtected += 1;
      continue;
    }
    const layer = transition.layer;
    update.run(
      layer.model,
      layer.postProcessed,
      optional(layer.manual),
      optional(layer.previousManual),
      layer.locked === undefined ? null : boolToInt(layer.locked),
      boolToInt(layer.stale === true),
      JSON.stringify(layer.qaFlags ?? []),
      segmentId,
      languageCode,
    );
    applied += 1;
  }
  return { applied, skippedProtected };
}

function applyCandidateTranslations(db, { candidateTrackId, translations }) {
  const metadata = db
    .prepare("SELECT target_track_id FROM candidate_track_metadata WHERE target_track_id = ?")
    .get(candidateTrackId);
  if (!metadata) throw new Error("Candidate target track not found");
  const write = db.prepare(
    `INSERT INTO candidate_target_text_layers (
       target_track_id, segment_id, model_text, post_processed_text, manual_text,
       previous_manual_text, locked, stale, qa_flags_json, origin
     ) VALUES (?, ?, ?, ?, NULL, NULL, 0, 0, '[]', 'candidate_full_track')
     ON CONFLICT(target_track_id, segment_id) DO UPDATE SET
       model_text = excluded.model_text,
       post_processed_text = excluded.post_processed_text,
       manual_text = NULL,
       previous_manual_text = NULL,
       locked = 0,
       stale = 0,
       qa_flags_json = '[]',
       origin = 'candidate_full_track'`,
  );
  let applied = 0;
  for (const [segmentId, text] of Object.entries(translations)) {
    if (typeof text !== "string") throw new Error(`translation text for ${segmentId} must be a string`);
    write.run(candidateTrackId, segmentId, text, text);
    applied += 1;
  }
  return { applied, skippedProtected: 0 };
}

function appendTaskHistory(db, task) {
  db.prepare(
    `INSERT INTO project_task_history (
      id, queue_task_id, label, detail, stage, status, progress, target_language_code,
      created_at, updated_at, recorded_at, kind, checkpoint_stage, last_error_code, retryable,
      run_snapshot_id, sequence, attempt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    optional(task.queueTaskId),
    task.label,
    task.detail,
    task.stage,
    task.status,
    Number(task.progress) || 0,
    optional(task.targetLanguageCode),
    task.createdAt,
    task.updatedAt,
    task.recordedAt ?? task.updatedAt,
    task.kind ?? "translate",
    optional(task.checkpointStage),
    optional(task.lastErrorCode),
    task.retryable ? 1 : 0,
    optional(task.runSnapshotId),
    task.sequence ?? 0,
    task.attempt ?? 0,
  );
}

function listTaskHistory(db) {
  return db
    .prepare("SELECT * FROM project_task_history ORDER BY recorded_at DESC, id DESC")
    .all()
    .map((row) => ({
      id: row.id,
      projectId: null,
      queueTaskId: row.queue_task_id,
      label: row.label,
      detail: row.detail,
      stage: row.stage,
      status: row.status,
      progress: row.progress,
      targetLanguageCode: row.target_language_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      recordedAt: row.recorded_at,
      kind: row.kind,
      checkpointStage: row.checkpoint_stage,
      lastErrorCode: row.last_error_code,
      retryable: Boolean(row.retryable),
      runSnapshotId: row.run_snapshot_id,
      sequence: row.sequence,
      attempt: row.attempt,
    }));
}

function commitTranslationResult(db, {
  languageCode,
  translations,
  snapshot,
  task,
  selectedSegmentIds = null,
  candidateTrackId = null,
  termConflictRules = [],
}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const applied = candidateTrackId
      ? applyCandidateTranslations(db, { candidateTrackId, translations })
      : selectedSegmentIds
        ? applySelectedTranslations(db, { languageCode, translations, selectedSegmentIds })
        : applyModelTranslations(
            db,
            { languageCode, translations },
            { manageTransaction: false },
          );
    appendRunSnapshot(db, snapshot);
    if (task) appendTaskHistory(db, task);

    const meta = db
      .prepare("SELECT lifecycle, recent_run_ids_json FROM project_meta WHERE id = ?")
      .get(snapshot.projectId);
    if (!meta) {
      const error = new Error("Project not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    const recentRunIds = [
      snapshot.id,
      ...readJson(meta.recent_run_ids_json, []).filter((id) => id !== snapshot.id),
    ].slice(0, 20);
    const hasAppliedText = applied.applied > 0;
    db.prepare(
      `UPDATE project_meta
       SET lifecycle = ?, updated_at = ?, recent_run_ids_json = ?
       WHERE id = ?`,
    ).run(
      hasAppliedText ? "needs_review" : meta.lifecycle,
      snapshot.createdAt,
      JSON.stringify(recentRunIds),
      snapshot.projectId,
    );

    const targetTrack = candidateTrackId
      ? db.prepare(
          `SELECT id, status, delivery_label, snapshot_ids_json
           FROM target_tracks WHERE id = ?`,
        ).get(candidateTrackId)
      : db.prepare(
          `SELECT id, status, delivery_label, snapshot_ids_json
           FROM target_tracks
           WHERE source_track_id = ? AND language_code = ? AND is_active = 1
           ORDER BY sort_order ASC
           LIMIT 1`,
        ).get(snapshot.sourceTrackId, languageCode);
    if (!targetTrack) {
      const error = new Error("Target track not found");
      error.code = "INVALID_INPUT";
      throw error;
    }
    const snapshotIds = [
      snapshot.id,
      ...readJson(targetTrack.snapshot_ids_json, []).filter((id) => id !== snapshot.id),
    ];
    db.prepare(
      `UPDATE target_tracks
       SET status = ?, delivery_label = ?, snapshot_ids_json = ?
       WHERE id = ?`,
    ).run(
      hasAppliedText ? "in_review" : targetTrack.status,
      hasAppliedText
        ? candidateTrackId ? "候选待比较" : "待校对"
        : targetTrack.delivery_label,
      JSON.stringify(snapshotIds),
      targetTrack.id,
    );

    if (!candidateTrackId) {
      const qa = runSubtitleQa(loadProject(db), { languageCode, termConflictRules });
      db.prepare("UPDATE target_tracks SET qa_issues_json = ? WHERE id = ?").run(
        JSON.stringify(qa.issues),
        targetTrack.id,
      );
    }

    db.exec("COMMIT");
    return applied;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function resourceSnapshotFromRow(row) {
  return {
    id: row.id,
    kind: row.resource_kind,
    name: row.resource_name,
    scope: "project_snapshot",
    schemaVersion: row.schema_version,
    source: row.source_resource_id
      ? { kind: "global", resourceId: row.source_resource_id, revision: row.source_revision }
      : { kind: "project_local" },
    capturedAt: row.captured_at,
    payload: readJson(row.payload_json, {}),
  };
}

function appendResourceSnapshot(db, input) {
  const snapshot = normalizeProjectResourceSnapshot(input);
  try {
    db.prepare(
      `INSERT INTO resource_snapshots (
        id, resource_kind, resource_name, schema_version,
        source_resource_id, source_revision, payload_json, captured_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      snapshot.id,
      snapshot.kind,
      snapshot.name,
      snapshot.source.kind === "global" ? snapshot.source.resourceId : null,
      snapshot.source.kind === "global" ? snapshot.source.revision : null,
      JSON.stringify(snapshot.payload),
      snapshot.capturedAt,
    );
  } catch (error) {
    if (error?.errcode === 1555 || /UNIQUE constraint failed: resource_snapshots\.id/.test(error?.message ?? "")) {
      const conflict = new Error("Resource snapshot already exists");
      conflict.code = "RESOURCE_SNAPSHOT_CONFLICT";
      throw conflict;
    }
    throw error;
  }
  return snapshot;
}

function getResourceSnapshot(db, snapshotId) {
  const row = db.prepare("SELECT * FROM resource_snapshots WHERE id = ?").get(snapshotId);
  return row ? resourceSnapshotFromRow(row) : null;
}

function listResourceSnapshots(db, { kind } = {}) {
  const rows = kind
    ? db.prepare(
        "SELECT * FROM resource_snapshots WHERE resource_kind = ? ORDER BY captured_at DESC, id ASC",
      ).all(kind)
    : db.prepare(
        "SELECT * FROM resource_snapshots ORDER BY captured_at DESC, id ASC",
      ).all();
  return rows.map(resourceSnapshotFromRow);
}

export function openProjectRepository(containerDir, options = {}) {
  mkdirSync(containerDir, { recursive: true });
  for (const directory of childDirectories) {
    mkdirSync(join(containerDir, directory), { recursive: true });
  }

  const db = new DatabaseSync(join(containerDir, "project.sqlite"));
  const migrationsDir = options.migrationsDir ?? projectMigrationsDir;
  let projectSchemaVersion;
  try {
    projectSchemaVersion = migrateDatabase(db, {
      databaseName: "project",
      migrationsDir,
    });
    reconcileAsrArtifacts(db, containerDir);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    containerDir,
    schemaVersion: projectSchemaVersion,
    saveProject: (project) => saveProject(db, project, projectSchemaVersion),
    loadProject: () => loadProject(db),
    getPrimaryMediaInternal: () => getPrimaryMediaInternal(db),
    updatePrimaryMediaInternal: (patch) => updatePrimaryMediaInternal(db, patch),
    appendExportRecord: (record) => appendExportRecord(db, record),
    listExportRecords: () => listExportRecords(db),
    appendRunSnapshot: (snapshot) => appendRunSnapshot(db, snapshot),
    listRunSnapshots: () => listRunSnapshots(db),
    commitAsrRun: (payload) => commitAsrRun(db, payload),
    listAsrRuns: () => listAsrRuns(db),
    getAsrRun: (runId) => getAsrRun(db, runId),
    commitAsrCandidate: (payload) => commitAsrCandidate(db, payload),
    commitAsrLanguageState: (payload) => commitAsrLanguageState(db, payload),
    applyModelTranslations: (payload) => applyModelTranslations(db, payload),
    appendTaskHistory: (task) => appendTaskHistory(db, task),
    listTaskHistory: () => listTaskHistory(db),
    commitTranslationResult: (payload) => commitTranslationResult(db, payload),
    appendResourceSnapshot: (snapshot) => appendResourceSnapshot(db, snapshot),
    getResourceSnapshot: (snapshotId) => getResourceSnapshot(db, snapshotId),
    listResourceSnapshots: (filter) => listResourceSnapshots(db, filter),
    close: () => db.close(),
  };
}
