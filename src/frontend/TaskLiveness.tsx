import { useEffect, useState } from "react";
import type { ProjectTask } from "../domain/workspace";
import { formatElapsed } from "./format";

const LIVE = new Set(["pending", "running", "pausing", "cancelling"]);
/** 超过这么久没有新进度就明说，而不是让用户自己猜任务是不是死了。 */
const STALE_AFTER_MS = 90_000;

/**
 * 任务活性读数。
 *
 * 本机识别的进度是按块上报的：长音频里两次上报可能隔好几分钟，界面上那个百分比
 * 就"不动"，而用户判断任务死了的唯一依据恰恰就是它不动。所以这里不靠百分比证明
 * 活着，而是每秒自己走一格：已运行多久、最后一次进度是多久之前。
 *
 * 这不是伪造进度——显示的都是真实时间戳算出来的事实。
 */
export function TaskLiveness({ task }: { task: ProjectTask }) {
  const [now, setNow] = useState(() => Date.now());
  const live = LIVE.has(task.status);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);

  if (!live) return null;

  const startedAt = Date.parse(task.createdAt);
  const updatedAt = Date.parse(task.updatedAt);
  const elapsed = Number.isFinite(startedAt) ? now - startedAt : Number.NaN;
  const sinceUpdate = Number.isFinite(updatedAt) ? now - updatedAt : Number.NaN;
  const stale = Number.isFinite(sinceUpdate) && sinceUpdate > STALE_AFTER_MS;

  return (
    <p className={`task-liveness ${stale ? "is-stale" : ""}`} role="status">
      <span className="task-liveness-pulse" aria-hidden="true"/>
      {Number.isFinite(elapsed) ? <span>已运行 {formatElapsed(elapsed)}</span> : null}
      {Number.isFinite(sinceUpdate) ? (
        <span>
          {sinceUpdate < 5_000 ? "刚刚有新进度" : `最后进度 ${formatElapsed(sinceUpdate)} 前`}
        </span>
      ) : null}
      {stale ? <span>长音频的识别是按块上报的，间隔久是正常的</span> : null}
    </p>
  );
}
