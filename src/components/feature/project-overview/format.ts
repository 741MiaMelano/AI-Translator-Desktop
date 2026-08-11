/**
 * 项目概览页的格式化与文案映射。
 *
 * 通用的「IPC 错误 → 中文」走 src/i18n/errors.ts 这一层，本文件不再重复一套；
 * 这里只补两件它覆盖不到的事：轨道回收站返回的 snake_case 原因码，
 * 以及带动态语言名的目标语言约束错误。
 */
import { localizeIpcErrorText } from "../../../i18n/errors";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 时长格式化。durationMs 缺失或非有限值时返回「时长未知」，
 * 不再退化成看起来像探测出 0 秒文件的 "0s"。
 */
export function formatDuration(durationMs?: number | null): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "时长未知";
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}

/**
 * 系统里存在两种时间戳：
 * - 渲染进程 timestampNow()：`2026-07-26 12:34`（UTC 墙钟，已被截断到分钟）
 * - 后端 asr / run snapshot：完整 ISO `2026-07-26T12:34:56.789Z`
 * 两者都按 UTC 解析，再按本地时区显示。
 */
function parseTimestamp(value: string): Date | null {
  const text = value.trim();
  if (!text) return null;

  const compact = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text);
  if (compact) {
    const [, year, month, day, hour, minute] = compact;
    const parsedCompact = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
    return Number.isNaN(parsedCompact.getTime()) ? null : parsedCompact;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/** 输出「今天 20:34 / 昨天 20:34 / 07-25 20:34 / 2025-12-31 20:34」；解析失败显示「未知」。 */
export function formatUpdatedAt(value: string | undefined | null, now: Date = new Date()): string {
  const date = parseTimestamp(value ?? "");
  if (!date) return "未知";

  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (isSameDay(date, now)) return `今天 ${time}`;

  const yesterday = new Date(now.getTime());
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return `昨天 ${time}`;

  const monthDay = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return date.getFullYear() === now.getFullYear()
    ? `${monthDay} ${time}`
    : `${date.getFullYear()}-${monthDay} ${time}`;
}

const REASON_TEXT: Record<string, string> = {
  source_track_not_found: "找不到这条源轨，可能已经被清空。",
  active_source_protected: "当前主源轨受保护，请先切换主源轨再删除。",
  last_source_protected: "这是最后一条源轨，删除后项目将没有时间轴基准。",
  target_track_not_found: "找不到这条目标轨，可能已经被清空。",
  parent_source_trashed: "请先恢复所属源轨。",
  worker_not_installed: "尚未安装音频分离组件。",
  model_not_installed: "所需模型尚未安装。",
  runtime_not_installed: "所需运行时尚未安装。",
};

/** 把后端 / domain 的 snake_case 原因码换成中文；无法识别时保留原值供排查。 */
export function describeReasonCode(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const mapped = REASON_TEXT[reason];
  if (mapped) return mapped;
  return /^[a-z0-9_]+$/.test(reason) ? `操作未完成（${reason}）` : reason;
}

/**
 * 目标语言约束错误来自 domain 层 throw 的英文 Error.message。
 * 带动态语言名的那条 i18n 层匹配不到（它是拼接出来的，不是稳定常量），
 * 这里先处理掉，其余交给统一映射层。
 */
export function describeTargetLanguageError(message: string | null | undefined): string | null {
  if (!message) return null;

  const protectedEdits = /Cannot remove target language (.+?) \((.+?)\) because protected human edits exist/.exec(
    message,
  );
  if (protectedEdits) {
    return `「${protectedEdits[1]}」已经有受保护的人工译文，取消该语言会丢掉人工成果；请先在字幕编辑里处理这些段。`;
  }

  return localizeIpcErrorText({ message });
}
