interface ProgressRingProps {
  value: number;
  size?: number;
}

export default function ProgressRing({ value, size = 104 }: ProgressRingProps) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="-rotate-90">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(70,55,40,0.16)" strokeWidth="9" />
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--color-gold)" strokeWidth="9" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} />
      </svg>
      <span className="absolute text-xl font-black text-[var(--color-text-main)]">{value}%</span>
    </div>
  );
}
