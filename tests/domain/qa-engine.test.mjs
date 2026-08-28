import test from "node:test";
import assert from "node:assert/strict";

import { QA_BASELINE_DEFAULTS, QA_RULE_IDS } from "../../shared/qa-defaults.mjs";
import {
  hasHardQaErrors,
  partitionQaIssues,
  runSubtitleQa,
} from "../../shared/qa-engine.mjs";

function layer(overrides = {}) {
  return {
    model: "你好",
    postProcessed: "你好",
    qaFlags: [],
    ...overrides,
  };
}

function segment(overrides = {}) {
  return {
    id: overrides.id ?? "seg-1",
    start: overrides.start ?? "00:00:01,000",
    end: overrides.end ?? "00:00:03,000",
    sourceLanguage: "en",
    sourceText: overrides.sourceText ?? {
      original: "Hello",
      normalized: "Hello",
    },
    targetTexts: overrides.targetTexts ?? {
      "zh-CN": layer(overrides.target),
    },
  };
}

function project(segments, trackOverrides = {}) {
  return {
    id: "p1",
    activeSourceTrackId: "src-1",
    sourceTracks: [
      {
        id: "src-1",
        isActive: true,
        segments,
        targetTracks: [
          {
            id: "tgt-zh",
            languageCode: "zh-CN",
            languageLabel: "简体中文",
            isActive: true,
            status: "in_review",
            ...trackOverrides,
          },
        ],
      },
    ],
  };
}

function ids(result) {
  return result.issues.map((issue) => issue.id);
}

function byRule(result, ruleId) {
  return result.issues.filter((issue) => issue.ruleId === ruleId);
}

test("baseline defaults are centralized", () => {
  assert.equal(QA_BASELINE_DEFAULTS.maxLines, 2);
  assert.equal(QA_BASELINE_DEFAULTS.maxCharsPerLine, 42);
  assert.equal(QA_BASELINE_DEFAULTS.maxCps, 20);
  assert.equal(QA_BASELINE_DEFAULTS.minDurationSec, 0.8);
  assert.equal(QA_BASELINE_DEFAULTS.maxDurationSec, 7);
});

test("clean fixture produces no issues", () => {
  const result = runSubtitleQa(
    project([
      segment({
        id: "a",
        start: "00:00:01,000",
        end: "00:00:03,000",
        target: { model: "你好", postProcessed: "你好" },
      }),
      segment({
        id: "b",
        start: "00:00:03,200",
        end: "00:00:05,000",
        target: { model: "世界", postProcessed: "世界" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  assert.deepEqual(result.issues, []);
});

test("an explicit empty manual subtitle is treated as an intentional omission", () => {
  const result = runSubtitleQa(
    project([
      segment({
        id: "filler",
        target: { model: "呃。", postProcessed: "呃。", manual: "" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  assert.equal(byRule(result, QA_RULE_IDS.emptyTarget).length, 0);
});

test("suspected lyrics stay a review warning instead of blocking export", () => {
  const result = runSubtitleQa(
    project([segment({ id: "lyrics", target: { qaFlags: ["suspected-lyrics"] } })]),
    { languageCode: "zh-CN" },
  );
  const issues = byRule(result, QA_RULE_IDS.suspectedLyrics);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "warning");
  assert.equal(hasHardQaErrors(issues), false);
});

test("max lines warning is deterministic", () => {
  const result = runSubtitleQa(
    project([
      segment({
        id: "lines",
        target: { model: "一行\n二行\n三行", postProcessed: "一行\n二行\n三行" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  const issues = byRule(result, QA_RULE_IDS.maxLines);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "warning");
  assert.equal(issues[0].id, "qa.max_lines:lines:zh-CN");
  assert.equal(issues[0].segmentId, "lines");
});

test("max chars per line warning includes line index in id", () => {
  const long = "字".repeat(43);
  const result = runSubtitleQa(
    project([
      segment({
        id: "long",
        target: { model: long, postProcessed: long },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  const issues = byRule(result, QA_RULE_IDS.maxCharsPerLine);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, "qa.max_chars_per_line:long:zh-CN:0");
  assert.equal(issues[0].severity, "warning");
});

test("cps warning uses effective text and duration", () => {
  // 40 chars in 1 second => CPS 40 > 20
  const text = "a".repeat(40);
  const result = runSubtitleQa(
    project([
      segment({
        id: "cps",
        start: "00:00:01,000",
        end: "00:00:02,000",
        target: { model: text, postProcessed: text },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  const issues = byRule(result, QA_RULE_IDS.maxCps);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, "qa.max_cps:cps:zh-CN");
  assert.equal(issues[0].severity, "warning");
});

test("duration warnings for too short and too long", () => {
  const short = runSubtitleQa(
    project([
      segment({
        id: "short",
        start: "00:00:01,000",
        end: "00:00:01,500",
        target: { model: "短", postProcessed: "短" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  assert.equal(byRule(short, QA_RULE_IDS.minDuration)[0].id, "qa.min_duration:short");

  const long = runSubtitleQa(
    project([
      segment({
        id: "long",
        start: "00:00:01,000",
        end: "00:00:09,000",
        target: { model: "长", postProcessed: "长" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  assert.equal(byRule(long, QA_RULE_IDS.maxDuration)[0].id, "qa.max_duration:long");
});

test("overlap is reported while ordinary silence between subtitles is allowed", () => {
  const overlap = runSubtitleQa(
    project([
      segment({
        id: "a",
        start: "00:00:01,000",
        end: "00:00:03,000",
        target: { model: "A", postProcessed: "A" },
      }),
      segment({
        id: "b",
        start: "00:00:02,500",
        end: "00:00:04,000",
        target: { model: "B", postProcessed: "B" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  assert.equal(byRule(overlap, QA_RULE_IDS.overlap)[0].id, "qa.overlap:a:b");
  assert.equal(byRule(overlap, QA_RULE_IDS.overlap)[0].segmentId, "a");

  const gap = runSubtitleQa(
    project([
      segment({
        id: "a",
        start: "00:00:01,000",
        end: "00:00:02,000",
        target: { model: "A", postProcessed: "A" },
      }),
      segment({
        id: "b",
        start: "00:00:05,000",
        end: "00:00:06,500",
        target: { model: "B", postProcessed: "B" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  assert.deepEqual(gap.issues, []);
});

test("stale and term conflict are warnings", () => {
  const result = runSubtitleQa(
    project([
      segment({
        id: "term",
        sourceText: { original: "OpenAI", normalized: "OpenAI" },
        target: {
          model: "OpenAI公司",
          postProcessed: "OpenAI公司",
          stale: true,
        },
      }),
    ]),
    {
      languageCode: "zh-CN",
      termConflictRules: [{ id: "openai-brand", source: "OpenAI", forbidden: "OpenAI公司" }],
    },
  );
  assert.equal(byRule(result, QA_RULE_IDS.stale)[0].id, "qa.stale:term:zh-CN");
  assert.equal(byRule(result, QA_RULE_IDS.termConflict)[0].id, "qa.term_conflict:term:zh-CN:openai-brand");
  assert.equal(byRule(result, QA_RULE_IDS.stale)[0].severity, "warning");
  assert.equal(byRule(result, QA_RULE_IDS.termConflict)[0].severity, "warning");
});

test("glossary required translation reports a warning without rewriting human text", () => {
  const fixture = project([
    segment({
      id: "required-term",
      sourceText: { original: "Open workspace", normalized: "Open workspace" },
      target: { model: "打开空间", postProcessed: "打开空间", manual: "打开我的空间", locked: true },
    }),
  ]);
  const before = structuredClone(fixture);
  const result = runSubtitleQa(fixture, {
    languageCode: "zh-CN",
    termConflictRules: [{ source: "workspace", required: "工作区" }],
  });
  assert.equal(byRule(result, QA_RULE_IDS.termConflict).length, 1);
  assert.match(byRule(result, QA_RULE_IDS.termConflict)[0].detail, /工作区/);
  assert.deepEqual(fixture, before, "QA must remain read-only for manual and locked layers");
});

test("hard errors: invalid range, empty target, missing tracks", () => {
  const invalid = runSubtitleQa(
    project([
      segment({
        id: "bad",
        start: "00:00:03,000",
        end: "00:00:02,000",
        target: { model: "x", postProcessed: "x" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  assert.equal(byRule(invalid, QA_RULE_IDS.invalidRange)[0].severity, "error");

  const empty = runSubtitleQa(
    project([
      segment({
        id: "empty",
        target: { model: "", postProcessed: "" },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  assert.equal(byRule(empty, QA_RULE_IDS.emptyTarget)[0].severity, "error");

  const noSource = runSubtitleQa({ id: "p", activeSourceTrackId: "missing", sourceTracks: [] });
  assert.equal(byRule(noSource, QA_RULE_IDS.missingActiveSourceTrack)[0].severity, "error");

  const noTarget = runSubtitleQa({
    id: "p",
    activeSourceTrackId: "src",
    sourceTracks: [{ id: "src", isActive: true, segments: [], targetTracks: [] }],
  });
  assert.equal(byRule(noTarget, QA_RULE_IDS.missingActiveTargetTrack)[0].severity, "error");
});

test("same input yields identical issue ids and order", () => {
  const fixture = project([
    segment({
      id: "a",
      start: "00:00:01,000",
      end: "00:00:01,200",
      target: { model: "一行\n二行\n三行", postProcessed: "一行\n二行\n三行", stale: true },
    }),
    segment({
      id: "b",
      start: "00:00:01,100",
      end: "00:00:02,000",
      target: { model: "", postProcessed: "" },
    }),
  ]);

  const first = ids(runSubtitleQa(fixture, { languageCode: "zh-CN" }));
  const second = ids(runSubtitleQa(structuredClone(fixture), { languageCode: "zh-CN" }));
  assert.deepEqual(first, second);
  assert.deepEqual(first, [...first].sort((a, b) => a.localeCompare(b)));
});

test("warnings do not count as hard errors; hard errors are detected", () => {
  const warnOnly = runSubtitleQa(
    project([
      segment({
        id: "stale",
        target: { model: "还行", postProcessed: "还行", stale: true },
      }),
    ]),
    { languageCode: "zh-CN" },
  );
  const parts = partitionQaIssues(warnOnly.issues);
  assert.equal(parts.warnings.length > 0, true);
  assert.equal(parts.hardErrors.length, 0);
  assert.equal(hasHardQaErrors(warnOnly.issues), false);

  const hard = runSubtitleQa(
    project([segment({ id: "empty", target: { model: "", postProcessed: "" } })]),
    { languageCode: "zh-CN" },
  );
  assert.equal(hasHardQaErrors(hard.issues), true);
});
