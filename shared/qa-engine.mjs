import { QA_BASELINE_DEFAULTS, QA_RULE_IDS } from "./qa-defaults.mjs";
import { getEffectiveTargetText, isStaleTargetLayer } from "./target-text-state.mjs";

function parseDomainTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function issue({ id, ruleId, severity, label, detail, segmentId = null, languageCode = null }) {
  return {
    id,
    ruleId,
    severity,
    label,
    detail,
    segmentId,
    languageCode,
  };
}

function stableIssueId(parts) {
  return parts.filter((part) => part !== null && part !== undefined && part !== "").join(":");
}

function splitDisplayLines(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function durationSec(startMs, endMs) {
  return (endMs - startMs) / 1000;
}

function cpsOf(text, startMs, endMs) {
  const duration = durationSec(startMs, endMs);
  if (!(duration > 0)) return Number.POSITIVE_INFINITY;
  const chars = [...text.replace(/\n/g, "")].length;
  return chars / duration;
}

function getActiveSourceTrack(project) {
  if (!project || !Array.isArray(project.sourceTracks)) return null;
  return (
    project.sourceTracks.find((track) => track.id === project.activeSourceTrackId) ??
    project.sourceTracks.find((track) => track.isActive) ??
    null
  );
}

function getActiveTargetTrack(sourceTrack, languageCode) {
  if (!sourceTrack || !Array.isArray(sourceTrack.targetTracks)) return null;
  if (languageCode) {
    return (
      sourceTrack.targetTracks.find(
        (track) => track.languageCode === languageCode && track.isActive !== false,
      ) ?? sourceTrack.targetTracks.find((track) => track.languageCode === languageCode) ??
      null
    );
  }
  return (
    sourceTrack.targetTracks.find((track) => track.isActive) ??
    sourceTrack.targetTracks[0] ??
    null
  );
}

function normalizeTermRules(termConflictRules) {
  if (!Array.isArray(termConflictRules)) return [];
  return termConflictRules
    .filter((rule) => rule && typeof rule.source === "string" && (
      typeof rule.forbidden === "string" || typeof rule.required === "string"
    ))
    .map((rule) => ({
      id: typeof rule.id === "string"
        ? rule.id
        : `${rule.source}->${rule.required ?? `!${rule.forbidden}`}`,
      source: rule.source,
      ...(typeof rule.forbidden === "string" ? { forbidden: rule.forbidden } : {}),
      ...(typeof rule.required === "string" ? { required: rule.required } : {}),
    }));
}

function pushBasicSegmentIssues(issues, entry, layer, text, languageCode) {
  const { segment, startMs, endMs } = entry;
  if (startMs === null || endMs === null || startMs >= endMs) {
    issues.push(issue({ id: stableIssueId([QA_RULE_IDS.invalidRange, segment.id]), ruleId: QA_RULE_IDS.invalidRange, severity: "error", label: "非法时间轴", detail: `段 ${segment.id} 的起止时间无效（start >= end 或无法解析）。`, segmentId: segment.id, languageCode }));
  }
  const intentionallyBlank = typeof layer?.manual === "string" && layer.manual.trim().length === 0;
  if (!layer || (!intentionallyBlank && text.trim().length === 0)) {
    issues.push(issue({ id: stableIssueId([QA_RULE_IDS.emptyTarget, segment.id, languageCode]), ruleId: QA_RULE_IDS.emptyTarget, severity: "error", label: "目标为空", detail: `段 ${segment.id} 在 ${languageCode} 没有可用译文。`, segmentId: segment.id, languageCode }));
  }
  if (layer && isStaleTargetLayer(layer)) {
    issues.push(issue({ id: stableIssueId([QA_RULE_IDS.stale, segment.id, languageCode]), ruleId: QA_RULE_IDS.stale, severity: "warning", label: "待同步", detail: `段 ${segment.id} 的 ${languageCode} 译文已过期，需要确认或重跑。`, segmentId: segment.id, languageCode }));
  }
  if (layer?.qaFlags?.includes("suspected-lyrics")) {
    issues.push(issue({
      id: stableIssueId([QA_RULE_IDS.suspectedLyrics, segment.id, languageCode]),
      ruleId: QA_RULE_IDS.suspectedLyrics,
      severity: "warning",
      label: "疑似唱词",
      detail: `段 ${segment.id} 位于分类不确定的音乐区间，请确认是对白还是需要保留的唱词。`,
      segmentId: segment.id,
      languageCode,
    }));
  }
}

function pushReadabilityIssues(issues, entry, text, languageCode, defaults) {
  const { segment, startMs, endMs } = entry;
  if (!text.length || startMs === null || endMs === null || endMs <= startMs) return;
  const lines = splitDisplayLines(text);
  if (lines.length > defaults.maxLines) {
    issues.push(issue({ id: stableIssueId([QA_RULE_IDS.maxLines, segment.id, languageCode]), ruleId: QA_RULE_IDS.maxLines, severity: "warning", label: "行数超限", detail: `段 ${segment.id} 有 ${lines.length} 行，超过上限 ${defaults.maxLines}。`, segmentId: segment.id, languageCode }));
  }
  lines.forEach((line, lineIndex) => {
    const length = [...line].length;
    if (length > defaults.maxCharsPerLine) {
      issues.push(issue({ id: stableIssueId([QA_RULE_IDS.maxCharsPerLine, segment.id, languageCode, String(lineIndex)]), ruleId: QA_RULE_IDS.maxCharsPerLine, severity: "warning", label: "单行过长", detail: `段 ${segment.id} 第 ${lineIndex + 1} 行有 ${length} 字符，超过上限 ${defaults.maxCharsPerLine}。`, segmentId: segment.id, languageCode }));
    }
  });
  const cps = cpsOf(text, startMs, endMs);
  if (cps > defaults.maxCps) {
    issues.push(issue({ id: stableIssueId([QA_RULE_IDS.maxCps, segment.id, languageCode]), ruleId: QA_RULE_IDS.maxCps, severity: "warning", label: "CPS 过高", detail: `段 ${segment.id} CPS 为 ${cps.toFixed(2)}，超过上限 ${defaults.maxCps}。`, segmentId: segment.id, languageCode }));
  }
  const duration = durationSec(startMs, endMs);
  if (duration < defaults.minDurationSec) {
    issues.push(issue({ id: stableIssueId([QA_RULE_IDS.minDuration, segment.id]), ruleId: QA_RULE_IDS.minDuration, severity: "warning", label: "时长过短", detail: `段 ${segment.id} 时长 ${duration.toFixed(3)}s，低于 ${defaults.minDurationSec}s。`, segmentId: segment.id, languageCode }));
  }
  if (duration > defaults.maxDurationSec) {
    issues.push(issue({ id: stableIssueId([QA_RULE_IDS.maxDuration, segment.id]), ruleId: QA_RULE_IDS.maxDuration, severity: "warning", label: "时长过长", detail: `段 ${segment.id} 时长 ${duration.toFixed(3)}s，高于 ${defaults.maxDurationSec}s。`, segmentId: segment.id, languageCode }));
  }
}

function pushTermIssues(issues, segment, text, languageCode, termRules) {
  if (!text.length) return;
  const source = segment.sourceText?.manual ?? segment.sourceText?.normalized ?? segment.sourceText?.original ?? "";
  for (const rule of termRules) {
    if (!source.includes(rule.source)) continue;
    const hasForbidden = rule.forbidden && text.includes(rule.forbidden);
    const missingRequired = rule.required && !text.includes(rule.required);
    if (hasForbidden || missingRequired) {
      const detail = missingRequired
        ? `段 ${segment.id} 源含“${rule.source}”但译文未使用术语“${rule.required}”。`
        : `段 ${segment.id} 源含“${rule.source}”但译文出现禁用写法“${rule.forbidden}”。`;
      issues.push(issue({ id: stableIssueId([QA_RULE_IDS.termConflict, segment.id, languageCode, rule.id]), ruleId: QA_RULE_IDS.termConflict, severity: "warning", label: "术语冲突", detail, segmentId: segment.id, languageCode }));
    }
  }
}

function pushTimelinePairIssues(issues, timed, languageCode, defaults) {
  for (let index = 0; index < timed.length - 1; index += 1) {
    const current = timed[index];
    const next = timed[index + 1];
    if ([current.startMs, current.endMs, next.startMs, next.endMs].includes(null) || current.startMs >= current.endMs || next.startMs >= next.endMs) continue;
    if (current.endMs > next.startMs) {
      issues.push(issue({ id: stableIssueId([QA_RULE_IDS.overlap, current.segment.id, next.segment.id]), ruleId: QA_RULE_IDS.overlap, severity: "warning", label: "时间轴重叠", detail: `段 ${current.segment.id} 与 ${next.segment.id} 存在重叠。`, segmentId: current.segment.id, languageCode }));
    }
  }
}

/** Deterministic Phase 5 QA: identical inputs yield identical ids and ordering. */
export function runSubtitleQa(project, options = {}) {
  const defaults = { ...QA_BASELINE_DEFAULTS, ...(options.defaults ?? {}) };
  const languageCode = typeof options.languageCode === "string" && options.languageCode ? options.languageCode : null;
  const sourceTrack = getActiveSourceTrack(project);
  if (!sourceTrack) {
    return { issues: [issue({ id: stableIssueId([QA_RULE_IDS.missingActiveSourceTrack, "project"]), ruleId: QA_RULE_IDS.missingActiveSourceTrack, severity: "error", label: "缺少活动源轨", detail: "项目没有可 QA 的活动 Source Track。" })], defaults };
  }
  const targetTrack = getActiveTargetTrack(sourceTrack, languageCode);
  if (!targetTrack) {
    const detail = languageCode ? `源轨 ${sourceTrack.id} 缺少语言 ${languageCode} 的目标轨。` : `源轨 ${sourceTrack.id} 没有活动目标轨。`;
    return { issues: [issue({ id: stableIssueId([QA_RULE_IDS.missingActiveTargetTrack, sourceTrack.id, languageCode ?? "none"]), ruleId: QA_RULE_IDS.missingActiveTargetTrack, severity: "error", label: "缺少活动目标轨", detail, languageCode })], defaults };
  }
  const resolvedLanguage = targetTrack.languageCode;
  const timed = (Array.isArray(sourceTrack.segments) ? sourceTrack.segments : []).map((segment) => ({ segment, startMs: parseDomainTimestamp(segment.start), endMs: parseDomainTimestamp(segment.end) }));
  const issues = [];
  const termRules = normalizeTermRules(options.termConflictRules);
  for (const entry of timed) {
    const layer = entry.segment.targetTexts?.[resolvedLanguage];
    const text = layer ? getEffectiveTargetText(layer) : "";
    pushBasicSegmentIssues(issues, entry, layer, text, resolvedLanguage);
    if (layer) pushReadabilityIssues(issues, entry, text, resolvedLanguage, defaults);
    if (layer) pushTermIssues(issues, entry.segment, text, resolvedLanguage, termRules);
  }
  pushTimelinePairIssues(issues, timed, resolvedLanguage, defaults);
  issues.sort((left, right) => left.id.localeCompare(right.id));
  return { issues, defaults, languageCode: resolvedLanguage, sourceTrackId: sourceTrack.id };
}

export function partitionQaIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  return {
    warnings: list.filter((entry) => entry.severity === "warning"),
    hardErrors: list.filter((entry) => entry.severity === "error"),
  };
}

export function hasHardQaErrors(issues) {
  return partitionQaIssues(issues).hardErrors.length > 0;
}
