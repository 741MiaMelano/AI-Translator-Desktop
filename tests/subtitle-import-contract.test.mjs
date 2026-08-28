import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectRepository } from "../backend/persistence/project-repository.mjs";
import { importSubtitleToProject } from "../backend/subtitle/import-service.mjs";
import { validateIpcEnvelope, IPC_LIMITS } from "../electron/ipc/validate.mjs";

const project = {
  id: "project-subtitle-meta",
  title: "Subtitle metadata smoke",
  sourceFileName: "basic-utf8.srt",
  mediaKind: "subtitle",
  noSourceMedia: true,
  lifecycle: "draft",
  createdAt: "2026-07-13 10:00",
  updatedAt: "2026-07-13 10:00",
  activeSourceTrackId: "source-1",
  pendingConfirmations: [],
  notes: [],
  config: {
    sourceLanguage: "auto",
    targetLanguages: ["zh-CN"],
    provider: "OpenAI",
    model: "GPT-4.1",
    glossary: "glossary-snapshot-1",
    styleGuide: "style-snapshot-1",
    outputFormat: "SRT",
    burnVideo: false,
    copyMediaIntoProject: false,
  },
  sourceTracks: [
    {
      id: "source-1",
      label: "Imported subtitle",
      kind: "external_subtitle",
      languageState: "pending",
      defaultLanguage: "auto",
      isActive: true,
      summary: "2 cues",
      segments: [
        {
          id: "segment-1",
          start: "00:00:01,000",
          end: "00:00:02,000",
          sourceLanguage: "auto",
          sourceText: { original: "hello", normalized: "hello" },
          targetTexts: {
            "zh-CN": { model: "", postProcessed: "", qaFlags: [] },
          },
        },
      ],
      targetTracks: [
        {
          id: "target-zh",
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
  ],
  recentRunIds: [],
  sourceProjectRelativePath: "artifacts/raw/source.srt",
  sourceProbeSummary: {
    subtitleFormat: "srt",
    encoding: "utf-8",
    newline: "lf",
    warnings: [],
  },
};

const tempRoot = mkdtempSync(join(tmpdir(), "translator-subtitle-contract-"));
const containerDir = join(tempRoot, "project-subtitle-meta");
let repository;

try {
  repository = openProjectRepository(containerDir);
  repository.saveProject(project);

  const loaded = repository.loadProject();
  assert.equal(loaded.sourceProjectRelativePath, "artifacts/raw/source.srt");
  assert.deepEqual(loaded.sourceProbeSummary, {
    subtitleFormat: "srt",
    encoding: "utf-8",
    newline: "lf",
    warnings: [],
  });

  const ordinarySave = {
    ...loaded,
    title: "renamed only",
    updatedAt: "2026-07-13 11:00",
  };
  repository.saveProject(ordinarySave);
  const afterOrdinarySave = repository.loadProject();
  assert.equal(
    afterOrdinarySave.sourceProjectRelativePath,
    "artifacts/raw/source.srt",
    "ordinary save must keep raw asset path metadata",
  );
  assert.deepEqual(
    afterOrdinarySave.sourceProbeSummary,
    {
      subtitleFormat: "srt",
      encoding: "utf-8",
      newline: "lf",
      warnings: [],
    },
    "ordinary save must keep probe summary metadata",
  );

  const saveWithoutOptionalMetadata = { ...afterOrdinarySave };
  delete saveWithoutOptionalMetadata.sourceProjectRelativePath;
  delete saveWithoutOptionalMetadata.sourceProbeSummary;
  repository.saveProject(saveWithoutOptionalMetadata);
  const afterMetadataOmission = repository.loadProject();
  assert.equal(
    afterMetadataOmission.sourceProjectRelativePath,
    "artifacts/raw/source.srt",
    "ordinary save must preserve the stored raw asset path when optional fields are omitted",
  );
  assert.equal(
    afterMetadataOmission.sourceProbeSummary.subtitleFormat,
    "srt",
    "ordinary save must preserve the stored probe summary when optional fields are omitted",
  );

  repository.appendExportRecord({
    id: "export-source-1",
    exportKind: "source",
    targetLanguageCode: null,
    format: "srt",
    path: "exports/basic-utf8.srt",
    createdAt: "2026-07-13 12:00",
    sourceTrackId: "source-1",
    targetTrackId: null,
    trackStatus: "source",
    deliveryStatus: "approved",
    destinationKind: "project",
  });

  const db = new DatabaseSync(join(containerDir, "project.sqlite"));
  try {
    const row = db.prepare("SELECT * FROM export_records WHERE id = ?").get("export-source-1");
    assert.equal(row.export_kind, "source");
    assert.equal(row.target_language_code, null);
    assert.equal(row.target_track_id, null);
    assert.equal(row.format, "srt");
    assert.equal(row.path, "exports/basic-utf8.srt");
    assert.equal(row.track_status, "source");
    assert.equal(row.delivery_status, "approved");
    assert.equal(row.destination_kind, "project");
  } finally {
    db.close();
  }

  const oversize = new Uint8Array(IPC_LIMITS.MAX_SUBTITLE_BYTES + 1);
  const rejected = validateIpcEnvelope({
    method: "subtitle.import",
    request: {
      fileName: "too-big.srt",
      bytes: oversize,
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "INVALID_INPUT");
  assert.match(rejected.error.message, /8 MiB|size|limit/i);

  const accepted = validateIpcEnvelope({
    method: "subtitle.import",
    request: {
      fileName: "basic-utf8.srt",
      bytes: new Uint8Array([0x31, 0x0a]),
    },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.method, "subtitle.import");

  const privateDatabasePath = join(tempRoot, "private-project", "project.sqlite");
  const failedImport = importSubtitleToProject({
    fileName: "basic-utf8.srt",
    bytes: readFileSync(join(process.cwd(), "tests", "fixtures", "subtitles", "valid", "basic-utf8.srt")),
    createProject() {
      throw new Error(`cannot open ${privateDatabasePath}`);
    },
    containerPathFor() {
      return join(tempRoot, "failed-project");
    },
  });
  assert.equal(failedImport.ok, false);
  assert.equal(
    failedImport.error.details?.reason?.includes(tempRoot) ?? false,
    false,
    "import errors returned across IPC must not expose absolute internal paths",
  );
} finally {
  repository?.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
