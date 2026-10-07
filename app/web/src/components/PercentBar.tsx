import { formatPercent } from '../lib/format.js';

interface PercentBarProps {
  value: number;
  max?: number;
  label?: string;
  warnAt?: number;
  dangerAt?: number;
  overQuota?: boolean;
}

export function PercentBar({
  value,
  max = 100,
  label,
  warnAt = 85,
  dangerAt = 95,
  overQuota,
}: PercentBarProps) {
  const displayPct = max > 0 ? (value / max) * 100 : 0;
  const barPct = Math.min(100, displayPct);
  const isOver = overQuota ?? displayPct > 100;
  const color = isOver || displayPct >= dangerAt ? 'bg-danger' : displayPct >= warnAt ? 'bg-warn' : 'bg-accent';

  return (
    <div className="space-y-1">
      {label ? (
        <div className="flex justify-between text-xs text-muted">
          <span>{label}</span>
          <span>{formatPercent(displayPct, 1)}</span>
        </div>
      ) : null}
      <div className="h-2 overflow-hidden rounded-full bg-border">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${barPct}%` }} />
      </div>
    </div>
  );
}
