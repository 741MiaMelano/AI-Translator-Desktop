import { CheckCircle2, Clock3 } from "lucide-react";
import {
  countQaIssues,
  isActionableQaIssue,
  type RunSnapshot,
  type TargetTrack,
} from "../../../domain/workspace";
import Badge from "../../ui/Badge";
import Card from "../../ui/Card";
import StatCard from "../../ui/StatCard";
import { formatUpdatedAt } from "./format";

/** QA 摘要：计数 + 明细。计数走 tabular 等宽数字，避免同列宽度跳动。 */
export function QaSummaryCard({ activeTargets }: { activeTargets: TargetTrack[] }) {
  const warningCount = countQaIssues(activeTargets, "warning");
  const errorCount = countQaIssues(activeTargets, "error");
  const approvedCount = activeTargets.filter(
    (track) => track.status === "approved" || track.status === "exported",
  ).length;

  // 按「语言 + 问题类型」聚合并计数，数量多的排前面
  const grouped = Object.values(
    activeTargets.reduce<Record<string, { language: string; label: string; severity: "warning" | "error"; count: number }>>(
      (acc, track) => {
        for (const issue of track.qaIssues.filter(isActionableQaIssue)) {
          const key = `${track.languageLabel}/${issue.severity}/${issue.label}`;
          acc[key] ??= { language: track.languageLabel, label: issue.label, severity: issue.severity, count: 0 };
          acc[key].count += 1;
        }
        return acc;
      },
      {},
    ),
  ).sort((left, right) => right.count - left.count);

  return (
    <Card title="字幕检查" actions={<CheckCircle2 size={16} className="text-gold-dark" />}>
      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1">
        <StatCard label="优化建议" value={String(warningCount)} tone={warningCount > 0 ? "text-warn" : undefined} />
        <StatCard label="必须修复" value={String(errorCount)} tone={errorCount > 0 ? "text-stop" : undefined} />
        <StatCard label="已批准语言" value={String(approvedCount)} />
      </div>

      <p className="mt-2.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        “必须修复”会阻止批准和导出；“优化建议”只影响观看体验，可以按实际画面决定是否调整。
      </p>

      {/*
        按「类型」聚合，不再逐条罗列。
        437 段字幕很容易产生几十上百条同类提醒（例如「时长过长」），
        旧版把每一条都铺出来，右栏被撑成一条望不到头的清单，
        既盖住了下面的内容，也看不出到底有几类问题。
        真要逐条核对，那是字幕编辑器的事，那里能定位、能改。
      */}
      <div className="mt-2.5 space-y-1.5">
        {grouped.length > 0 ? (
          grouped.map((group) => (
            <div
              key={`${group.language}/${group.label}`}
              className="flex items-center gap-2 rounded-[6px] border border-line bg-card-soft px-2.5 py-2 text-[11.5px] leading-5"
            >
              <Badge tone={group.severity === "error" ? "red" : "gold"}>
                {group.severity === "error" ? "必须修复" : "建议"}
              </Badge>
              <span className="min-w-0 flex-1 text-[var(--color-text-muted)]">
                <strong className="font-medium text-[var(--color-text-main)]">{group.language}</strong>
                {" / "}
                {group.label}
              </span>
              <span className="tabular shrink-0 font-medium text-[var(--color-text-main)]">{group.count}</span>
            </div>
          ))
        ) : (
          <div className="rounded-[6px] border border-line bg-card-soft px-2.5 py-2 text-[11.5px] text-[var(--color-text-muted)]">
            当前没有需要处理的字幕问题。
          </div>
        )}
        {grouped.length > 0 ? (
          <p className="px-0.5 pt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
            进入字幕编辑后可查看原因、处理建议并定位到对应字幕。
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** 最近处理记录。createdAt 在后端是 ISO、在渲染层是截断格式，统一交给 formatUpdatedAt。 */
export function RecentRunCard({ latestRun }: { latestRun?: RunSnapshot }) {
  return (
    <Card title="最近处理记录" actions={<Clock3 size={16} className="text-gold-dark" />}>
      {latestRun ? (
        <div className="space-y-2">
          <div className="rounded-[6px] border border-line bg-card-soft px-2.5 py-2">
            <p className="text-[11.5px] text-[var(--color-text-muted)]">最近一次处理</p>
            <p className="mt-0.5 truncate text-[12.5px] font-medium text-[var(--color-text-main)]">
              {latestRun.provider} / {latestRun.model}
            </p>
            <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
              {formatUpdatedAt(latestRun.createdAt)}
            </p>
          </div>
          <StatCard label="缓存命中" value={String(latestRun.cacheHits)} />
        </div>
      ) : (
        <div className="rounded-[6px] border border-line bg-card-soft px-2.5 py-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          这个项目还没有处理记录。开始翻译后会在这里显示服务商、模型和处理时间。
        </div>
      )}
    </Card>
  );
}
