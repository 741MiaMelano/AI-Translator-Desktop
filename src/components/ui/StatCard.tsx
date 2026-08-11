interface StatCardProps {
  label: string;
  value: string;
  tone?: string;
}

/**
 * 数值卡。旧版 text-2xl font-black 会把「4,737」在窄列里挤断行；
 * 现在缩到 18px、tabular 等宽数字、强制不换行。
 */
export default function StatCard({ label, value, tone = "text-[var(--color-text-main)]" }: StatCardProps) {
  return (
    <div className="min-w-0 rounded-[6px] border border-line bg-card-soft px-3 py-2.5">
      <p className="truncate text-[11.5px] text-[var(--color-text-muted)]">{label}</p>
      <p className={`tabular mt-1 truncate text-[18px] font-semibold leading-tight ${tone}`} title={value}>
        {value}
      </p>
    </div>
  );
}
