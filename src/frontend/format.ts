/**
 * 进度百分比。保留一位小数，因为识别阶段一步只值两三个点，四舍五入之后看起来
 * 就是"不动"——而"看起来不动"正是用户判断任务死了的依据。
 * 整数以及 0 / 100 不显示多余的小数。
 */
export function formatProgress(value: number) {
  if (!Number.isFinite(value)) return "0";
  const bounded = Math.min(100, Math.max(0, value));
  if (bounded === 0 || bounded === 100 || Number.isInteger(bounded)) return String(bounded);
  return bounded.toFixed(1);
}

/** 把毫秒说成 mm:ss / h:mm:ss，用于"已运行多久"。 */
export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export function formatUiDateTime(value: string | null | undefined) {
  if (!value) return "时间未知";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}
