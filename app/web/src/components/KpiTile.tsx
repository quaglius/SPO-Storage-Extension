import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline.js';

interface KpiTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: { value: string; positive?: boolean } | null;
  sparkline?: number[];
  footer?: ReactNode;
}

export function KpiTile({ label, value, hint, delta, sparkline, footer }: KpiTileProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-ink">{value}</div>
      {hint ? <div className="mt-1 text-sm text-muted">{hint}</div> : null}
      {delta ? (
        <div className={`mt-2 text-xs ${delta.positive ? 'text-ok' : 'text-danger'}`}>{delta.value}</div>
      ) : null}
      {sparkline && sparkline.length > 1 ? (
        <div className="mt-3 h-8">
          <Sparkline data={sparkline} />
        </div>
      ) : null}
      {footer ? <div className="mt-3 border-t border-border pt-3 text-xs text-muted">{footer}</div> : null}
    </div>
  );
}
