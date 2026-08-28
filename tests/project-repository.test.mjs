import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectRepository } from "../backend/persistence/project-repository.mjs";

const project = {
  id: "project-draft-test",
  title: "Draft persistence smoke",
  sourceFileName: "sample.mp4",
  mediaKind: "video",
  noSourceMedia: false,
  lifecycle: "draft",
  createdAt: "2026-07-09 10:00",
  updatedAt: "2026-07-09 10:00",
  archivedAt: "2026-07-09 10:05",
  activeSourceTrackId: "source-draft-test",
  pendingConfirmations: ["confirm source track"],
  notes: ["round-trip core draft state"],
  config: {
    sourceLanguage: "auto",
    targetLanguages: ["zh-CN"],
    provider: "OpenAI",
    model: "GPT-4.1",
    asrModelId: "large-v3-turbo-q8_0",
    glossary: "glossary-snapshot-1",
    styleGuide: "style-snapshot-1",
    outputFormat: "SRT",
    burnVideo: false,
    copyMediaIntoProject: true,
    subtitleStyle: {
      format: "ass",
      bilingualLayout: "source_top_target_bottom",
      primary: {
        fontFamily: "Microsoft YaHei", fontSizePx: 34, textColor: "#FFFFFF",
        outlineColor: "#000000", outlineWidthPx: 2, shadowColor: "#111111",
        shadowDepthPx: 1, position: "bottom",
      },
      secondary: {
        fontFamily: "Arial", fontSizePx: 20, textColor: "#EEEEEE",
        outlineColor: "#222222", outlineWidthPx: 1, shadowColor: "#000000",
        shadowDepthPx: 1, position: "bottom",
      },
      preview: {
        sourceText: "Sample", targetText: "样例", direction: "auto", backgroundColor: "#25211D",
      },
    },
  },
  sourceTracks: [
    {
      id: "source-draft-test",
      label: "Main source",
      kind: "embedded_subtitle",
      languageState: "pending",
      defaultLanguage: "auto",
      isActive: true,
      summary: "first source track",
      segments: [
        {
          id: "segment-1",
          start: "00:00:02,000",
          end: "00:00:05,800",
          sourceLanguage: "auto",
          sourceText: {
            original: "hello",
            normalized: "hello",
          },
          targetTexts: {
            "zh-CN": {
              model: "你好",
              postProcessed: "你好",
              qaFlags: [],
            },
          },
        },
      ],
      targetTracks: [
        {
          id: "target-draft-zh",
          languageCode: "zh-CN",
          languageLabel: "简体中文",
          status: "draft",
          isActive: true,
          qaIssues: [],
          snapshotIds: [],
          deliveryLabel: "未开跑",
          lastHumanAction: "waiting",
        },
      ],
    },
    {
      id: "source-trashed-test",
      label: "Deleted source",
      kind: "external_subtitle",
      languageState: "confirmed",
      defaultLanguage: "en",
      isActive: false,
      summary: "recoverable source track",
      trashedAt: "2026-07-09 10:06",
      segments: [],
      targetTracks: [{
        id: "target-trashed-zh",
        languageCode: "zh-CN",
        languageLabel: "简体中文",
        status: "in_review",
        isActive: false,
        qaIssues: [],
        snapshotIds: [],
        deliveryLabel: "回收站",
        lastHumanAction: "trashed with source",
        trashedAt: "2026-07-09 10:06",
        trashedWithSource: true,
      }],
    },
  ],
  recentRunIds: [],
};

const dbPath = (containerDir) => join(containerDir, "project.sqlite");

function seedIndependentRecords(databasePath, projectId) {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      `INSERT INTO run_snapshots (
        id, project_id, source_track_id, target_language_code, provider_id, model_id,
        glossary_snapshot_id, style_guide_snapshot_id, prompt_template_version, segment_version,
        created_at, cache_hits, input_tokens, output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-snapshot-keep",
      projectId,
      "source-draft-test",
      "zh-CN",
      "OpenAI",
      "GPT-4.1",
      "glossary-snapshot-1",
      "style-snapshot-1",
      "prompt-v1",
      "draft",
      "2026-07-09 10:10",
      3,
      120,
      40,
    );

    db.prepare(
      `INSERT INTO project_task_history (
        id, queue_task_id, label, detail, stage, status, progress,
        target_language_code, created_at, updated_at, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-history-keep",
      "queue-task-1",
      "Translate zh-CN",
      "Completed translation",
      "translate",
      "completed",
      100,
      "zh-CN",
      "2026-07-09 10:10",
      "2026-07-09 10:20",
      "2026-07-09 10:20",
    );

    db.prepare(
      `INSERT INTO export_records (
        id, export_kind, target_language_code, format, path, created_at, source_track_id, target_track_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "export-record-keep",
      "target",
      "zh-CN",
      "SRT",
      "exports/zh-CN.srt",
      "2026-07-09 10:30",
      "source-draft-test",
      "target-draft-zh",
    );

    db.prepare(
      `INSERT INTO resource_snapshots (
        id, resource_kind, resource_name, schema_version,
        source_resource_id, source_revision, payload_json, captured_at
      ) VALUES (?, ?, ?, 1, ?, 1, ?, ?)`,
    ).run(
      "resource-snapshot-keep",
      "glossary",
      "Default glossary",
      "glossary-1",
      JSON.stringify({ terms: ["AI"] }),
      "2026-07-09 10:05",
    );
  } finally {
    db.close();
  }
}

function readIndependentRecords(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return {
      runSnapshots: db.prepare("SELECT * FROM run_snapshots ORDER BY id").all(),
      taskHistory: db.prepare("SELECT * FROM project_task_history ORDER BY id").all(),
      exportRecords: db.prepare("SELECT * FROM export_records ORDER BY id").all(),
      resourceSnapshots: db.prepare("SELECT * FROM resource_snapshots ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

function assertIndependentRecordsPreserved(records) {
  assert.equal(records.runSnapshots.length, 1);
  assert.equal(records.runSnapshots[0].id, "run-snapshot-keep");
  assert.equal(records.runSnapshots[0].model_id, "GPT-4.1");
  assert.equal(records.runSnapshots[0].cache_hits, 3);
  assert.equal(records.runSnapshots[0].input_tokens, 120);
  assert.equal(records.runSnapshots[0].output_tokens, 40);

  assert.equal(records.taskHistory.length, 1);
  assert.equal(records.taskHistory[0].id, "task-history-keep");
  assert.equal(records.taskHistory[0].status, "completed");
  assert.equal(records.taskHistory[0].label, "Translate zh-CN");

  assert.equal(records.exportRecords.length, 1);
  assert.equal(records.exportRecords[0].id, "export-record-keep");
  assert.equal(records.exportRecords[0].path, "exports/zh-CN.srt");
  assert.equal(records.exportRecords[0].format, "SRT");

  assert.equal(records.resourceSnapshots.length, 1);
  assert.equal(records.resourceSnapshots[0].id, "resource-snapshot-keep");
  assert.equal(records.resourceSnapshots[0].payload_json, JSON.stringify({ terms: ["AI"] }));
  assert.equal(records.resourceSnapshots[0].resource_kind, "glossary");
}

function readUserVersion(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare("PRAGMA user_version").get().user_version;
  } finally {
    db.close();
  }
}

function readSchemaVersion(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    return db.prepare("SELECT schema_version FROM project_meta LIMIT 1").get().schema_version;
  } finally {
    db.close();
  }
}

function seedAsrWordTiming(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      `UPDATE segments
       SET asr_word_start_index = 0, asr_word_end_index = 0, timing_validity = 'valid'
       WHERE id = 'segment-1'`,
    ).run();
  } finally {
    db.close();
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "translator-project-"));
const futureRoot = mkdtempSync(join(tmpdir(), "translator-project-future-"));
const containerDir = join(tempRoot, "project-draft-test");
const databasePath = dbPath(containerDir);

let repository;

try {
  repository = openProjectRepository(containerDir);
  repository.saveProject(project);

  assert.ok(existsSync(databasePath), "project.sqlite is created");
  for (const directory of ["artifacts", "exports", "logs", "cache"]) {
    assert.ok(existsSync(join(containerDir, directory)), `${directory}/ is created`);
  }
  assert.deepEqual(repository.loadProject(), project);
  assert.equal(readUserVersion(databasePath), 23);
  assert.equal(readSchemaVersion(databasePath), 23);

  seedAsrWordTiming(databasePath);
  const projectWithTiming = repository.loadProject();
  assert.equal(projectWithTiming.sourceTracks[0].segments[0].timingValidity, "valid");
  assert.equal(projectWithTiming.sourceTracks[0].segments[0].asrWordStartIndex, 0);
  assert.equal(projectWithTiming.sourceTracks[0].segments[0].asrWordEndIndex, 0);

  seedIndependentRecords(databasePath, project.id);

  const updatedProject = {
    ...projectWithTiming,
    title: "Draft persistence updated",
    updatedAt: "2026-07-09 11:00",
    notes: [...projectWithTiming.notes, "saved without deleting history"],
    recentRunIds: ["run-snapshot-keep"],
  };
  repository.saveProject(updatedProject);

  assert.deepEqual(repository.loadProject(), updatedProject);
  assertIndependentRecordsPreserved(readIndependentRecords(databasePath));
  assert.equal(readUserVersion(databasePath), 23);
  assert.equal(readSchemaVersion(databasePath), 23);

  const invalidProject = {
    ...updatedProject,
    title: "should not persist after rollback",
    updatedAt: "2026-07-09 12:00",
    sourceTracks: updatedProject.sourceTracks.map((sourceTrack) => ({
      ...sourceTrack,
      segments: sourceTrack.segments.map((segment, index) =>
        index === 0
          ? {
              ...segment,
              start: "invalid-timestamp",
            }
          : segment,
      ),
    })),
  };

  assert.throws(
    () => repository.saveProject(invalidProject),
    /Invalid subtitle timestamp/,
  );

  const afterRollback = repository.loadProject();
  assert.deepEqual(afterRollback, updatedProject);
  assert.notEqual(afterRollback.title, invalidProject.title);
  assert.notEqual(afterRollback.updatedAt, invalidProject.updatedAt);
  assertIndependentRecordsPreserved(readIndependentRecords(databasePath));

  repository.close();
  repository = undefined;

  repository = openProjectRepository(containerDir);
  assert.deepEqual(repository.loadProject(), updatedProject);
  assertIndependentRecordsPreserved(readIndependentRecords(databasePath));
  assert.equal(readUserVersion(databasePath), 23);
  assert.equal(readSchemaVersion(databasePath), 23);
  repository.close();
  repository = undefined;

  repository = openProjectRepository(containerDir);
  assert.deepEqual(repository.loadProject(), updatedProject);
  assertIndependentRecordsPreserved(readIndependentRecords(databasePath));
  assert.equal(readUserVersion(databasePath), 23);
  assert.equal(readSchemaVersion(databasePath), 23);

  const futureContainer = join(futureRoot, "future-project");
  mkdirSync(futureContainer, { recursive: true });
  const futureDbPath = dbPath(futureContainer);
  const futureDb = new DatabaseSync(futureDbPath);
  futureDb.exec("PRAGMA user_version = 24");
  futureDb.close();

  assert.throws(
    () => openProjectRepository(futureContainer),
    /Unsupported project database version 24/,
  );
  rmSync(futureRoot, { recursive: true, force: true });
} finally {
  repository?.close();
  rmSync(tempRoot, { recursive: true, force: true });
  if (existsSync(futureRoot)) {
    rmSync(futureRoot, { recursive: true, force: true });
  }
}
