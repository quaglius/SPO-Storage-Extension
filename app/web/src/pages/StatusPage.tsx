import { Link } from 'react-router-dom';
import type { V2EngineState, V2StatusEvent } from '@spostorage/shared';
import { formatBytes } from '@spostorage/shared';
import {
  useV2PauseEngine,
  useV2ResumeEngine,
  useV2RetryFailed,
  useV2Status,
} from '../api/v2.js';
import { ByteText } from '../components/ByteText.js';
import { ChartCard } from '../components/ChartCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { KpiTile } from '../components/KpiTile.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { Sparkline } from '../components/Sparkline.js';
import { formatNumber, formatRelativeDate, formatUsd } from '../lib/format.js';
import { NoticesPanel } from '../components/NoticesPanel.js';

const ENGINE_LABELS: Record<V2EngineState, string> = {
  working: 'Working',
  idle: 'Idle',
  paused: 'Paused',
  no_signal: 'No signal',
};

const ENGINE_TONE: Record<V2EngineState, string> = {
  working: 'bg-ok/15 text-ok border-ok/30',
  idle: 'bg-accent/10 text-accent border-accent/30',
  paused: 'bg-warn/15 text-warn border-warn/30',
  no_signal: 'bg-danger/15 text-danger border-danger/30',
};

const EVENT_TONE: Record<V2StatusEvent['level'], string> = {
  info: 'text-muted',
  warn: 'text-warn',
  error: 'text-danger',
};

function formatTb(bytes: number): string {
  const tb = bytes / 1024 ** 4;
  return `${tb.toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
}

function minutesAgo(iso: string | null): string {
  if (!iso) return 'not measured';
  return formatRelativeDate(iso);
}

export function StatusPage() {
  const { data, isLoading, isError, error } = useV2Status();
  const pause = useV2PauseEngine();
  const resume = useV2ResumeEngine();
  const retry = useV2RetryFailed();

  if (isLoading && !data) return <PageSkeleton />;
  if (isError) {
    return (
      <EmptyState
        title="Could not load status"
        description={error instanceof Error ? error.message : 'Unknown error'}
      />
    );
  }
  if (!data) {
    return (
      <EmptyState
        title="No measurements yet"
        description="When the engine starts crawling, you will see quota, reconciliation, and activity here."
      />
    );
  }

  const { tenant, sites, reconciliation, savings, engine } = data;
  const hasTenant = tenant != null;
  const quota = tenant?.quotaBytes ?? 0;
  const used = tenant?.usedBytes ?? 0;
  const excess = tenant?.excessBytes ?? 0;
  const versions = tenant?.versionsBytes;
  const currentBytes = versions != null && used > 0 ? Math.max(0, used - versions) : null;
  const spark = engine.lastHour.perMinute.map((m) => m.items);
  const failedCount = engine.queue.failed;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Status</h1>
        <p className="mt-1 text-sm text-muted">
          How are we doing and what is happening? Updates every 10 s.
        </p>
      </div>

      <NoticesPanel />

      {/* Cuota */}
      <ChartCard
        title="Tenant quota"
        subtitle={
          hasTenant
            ? `Source: ${tenant.source} · measured ${minutesAgo(tenant.capturedAt)}`
            : 'No measurements yet de cuota'
        }
      >
        {hasTenant && quota > 0 ? (
          <div className="space-y-4">
            <p className="text-lg text-ink">
              Current usage <span className="font-semibold">{formatTb(used)}</span> of quota{' '}
              <span className="font-semibold">{formatTb(quota)}</span>
              {excess > 0 ? (
                <>
                  {' '}
                  — overage <span className="font-semibold text-danger">{formatTb(excess)}</span>
                </>
              ) : null}
            </p>
            <div className="relative h-4 overflow-hidden rounded-full bg-border">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-accent"
                style={{ width: `${Math.min(100, (Math.min(used, quota) / quota) * 100)}%` }}
              />
              {excess > 0 ? (
                <div
                  className="absolute inset-y-0 rounded-full bg-danger"
                  style={{
                    left: `${Math.min(100, (quota / Math.max(used, quota)) * 100)}%`,
                    width: `${Math.min(100, (excess / Math.max(used, quota)) * 100)}%`,
                  }}
                />
              ) : null}
            </div>
            {tenant.estimatedMonthlyCostUsd != null && excess > 0 ? (
              <p className="text-sm text-muted">
                If Microsoft charged for overage: ~{formatUsd(tenant.estimatedMonthlyCostUsd)}/mo
              </p>
            ) : (
              <p className="text-sm text-ok">Within quota.</p>
            )}
            {versions != null && currentBytes != null ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border px-3 py-2 text-sm">
                  <div className="text-muted">Current version</div>
                  <div className="font-medium text-ink">
                    <ByteText bytes={currentBytes} />
                  </div>
                </div>
                <div className="rounded-lg border border-border px-3 py-2 text-sm">
                  <div className="text-muted">Historic versions</div>
                  <div className="font-medium text-ink">
                    <ByteText bytes={versions} />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState title="No measurements yet" description="The engine has not captured tenant quota yet." />
        )}
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Reconciliation */}
        <ChartCard
          title="Reconciliation"
          subtitle="Files (with versions) and recycle bins vs what Microsoft counts toward quota"
        >
          {sites.usedBytes > 0 || reconciliation.libraries.total > 0 ? (
            <div className="space-y-4">
              <div className="text-lg font-semibold text-ink">
                {reconciliation.libraries.total > 0 && reconciliation.libraries.done === reconciliation.libraries.total
                  ? 'Inventory complete'
                  : `Crawling: ${formatNumber(reconciliation.libraries.done)} of ${formatNumber(reconciliation.libraries.total)} libraries`}
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted">Files + recycle bins</dt>
                  <dd className="text-xl font-semibold text-ink">{formatBytes(reconciliation.explainedBytes)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Microsoft counts (quota)</dt>
                  <dd className="text-xl font-semibold text-ink">{formatBytes(sites.usedBytes)}</dd>
                </div>
              </dl>
              {reconciliation.percent != null && (
                <p className="text-sm text-muted">
                  Difference: {reconciliation.explainedBytes >= sites.usedBytes ? '+' : '−'}
                  {formatBytes(Math.abs(reconciliation.explainedBytes - sites.usedBytes))} (
                  {(reconciliation.percent * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })} %)
                </p>
              )}
              {reconciliation.sitesChecked > 0 && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded border border-border px-2 py-1">
                    {reconciliation.sitesMatching} de {reconciliation.sitesChecked} sites match (±2%)
                  </span>
                  <span className="rounded border border-border px-2 py-1">{reconciliation.sitesOver} over</span>
                  <span className={`rounded border border-border px-2 py-1 ${reconciliation.sitesUnder > 0 ? 'text-danger' : ''}`}>
                    {reconciliation.sitesUnder} under
                  </span>
                  {reconciliation.libraries.failed > 0 && (
                    <span className="rounded border border-border px-2 py-1 text-danger">
                      {reconciliation.libraries.failed} libraries failed
                    </span>
                  )}
                </div>
              )}
              {reconciliation.sitesOver > 0 && (
                <p className="text-sm leading-relaxed text-muted">
                  When a site is &quot;over&quot;, nothing is missing: files add up to what Microsoft Graph reports, but
                  quota counts less (likely no double billing for duplicate content). On those sites, deleting or
                  archiving X GB may reduce quota by less than X; the lab measures it.
                </p>
              )}
              {reconciliation.sitesUnder > 0 && (
                <p className="text-sm leading-relaxed text-danger">
                  When a site is &quot;under&quot;, inventory is missing (libraries unread or no access): check Sites.
                </p>
              )}
              <Link to="/sites?sort=explained" className="text-sm font-medium text-accent underline">
                View site by site
              </Link>
            </div>
          ) : (
            <EmptyState title="No measurements yet" description="No sites or libraries in inventory yet." />
          )}
        </ChartCard>

        {/* Engine */}
        <ChartCard
          title="Engine"
          subtitle={engine.pauseReason ? `Pause reason: ${engine.pauseReason}` : undefined}
          actions={
            <div className="flex flex-wrap gap-2">
              {engine.state === 'paused' ? (
                <button
                  type="button"
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg"
                  disabled={resume.isPending}
                  onClick={() => resume.mutate()}
                >
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg"
                  disabled={pause.isPending || engine.state === 'no_signal'}
                  onClick={() => {
                    const reason = window.prompt('Pause reason (optional)') ?? undefined;
                    pause.mutate(reason || undefined);
                  }}
                >
                  Pause
                </button>
              )}
            </div>
          }
        >
          <div className="space-y-4">
            <span
              className={`inline-flex rounded-full border px-3 py-1 text-sm font-medium ${ENGINE_TONE[engine.state]}`}
            >
              {ENGINE_LABELS[engine.state]}
            </span>
            <ul className="space-y-2 text-sm">
              {engine.slots.filter((s) => s.target || s.kind).length === 0 ? (
                <li className="text-muted">No active slots.</li>
              ) : (
                engine.slots
                  .filter((s) => s.target || s.kind)
                  .map((slot, i) => (
                    <li key={i} className="rounded-lg border border-border px-3 py-2">
                      <div className="text-ink">
                        {slot.status ||
                          (slot.kind && slot.target
                            ? `${slot.kind} · ${slot.target}`
                            : slot.target || slot.kind)}
                      </div>
                      {slot.since ? (
                        <div className="text-xs text-muted">since {formatRelativeDate(slot.since)}</div>
                      ) : null}
                    </li>
                  ))
              )}
            </ul>
            <div className="h-12">
              {spark.length > 1 ? <Sparkline data={spark} /> : <p className="text-xs text-muted">No activity in the last hour.</p>}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted sm:grid-cols-4">
              <div>Items/h: {formatNumber(engine.lastHour.items)}</div>
              <div>Throttling: {formatNumber(engine.lastHour.throttled)}</div>
              <div>Errores: {formatNumber(engine.lastHour.errors)}</div>
              <div>
                Queue: {engine.queue.ready} / overdue {engine.queue.due} / failed {engine.queue.failed}
              </div>
            </div>
            {failedCount > 0 ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <button
                  type="button"
                  className="rounded-lg bg-accent px-3 py-1.5 text-white hover:opacity-90"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate()}
                >
                  Retry {failedCount} failed tasks
                </button>
                <Link to="/activity?tab=tasks" className="text-accent hover:underline">
                  Ver en Activity
                </Link>
              </div>
            ) : null}
          </div>
        </ChartCard>
      </div>

      {/* Ahorro */}
      <div className="grid gap-4 md:grid-cols-2">
        <KpiTile
          label="Heavy versions"
          value={<ByteText bytes={savings.heavyVersionsBytes} />}
          hint={`${formatNumber(savings.heavyVersionsFiles)} files`}
          footer={
            <Link
              to="/files?minVersionsBytes=20971520&sort=versions"
              className="text-accent hover:underline"
            >
              Ver en Files
            </Link>
          }
        />
        <KpiTile
          label="Unmodified for over 1 year"
          value={<ByteText bytes={savings.olderThan365Bytes} />}
          hint={
            <>
              Over 2 years: <ByteText bytes={savings.olderThan730Bytes} />
            </>
          }
          footer={
            <Link
              to={`/files?modifiedBefore=${encodeURIComponent(
                new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
              )}`}
              className="text-accent hover:underline"
            >
              Ver en Files
            </Link>
          }
        />
      </div>

      {/* Eventos */}
      <ChartCard title="Recent events">
        {data.recentEvents.length === 0 ? (
          <EmptyState title="No measurements yet" description="Engine events will appear here." />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {data.recentEvents.map((ev) => (
              <li key={ev.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="text-xs text-muted">{formatRelativeDate(ev.at)}</span>
                <span className={`font-medium uppercase ${EVENT_TONE[ev.level]}`}>{ev.level}</span>
                <span className="text-ink">{ev.message}</span>
                {ev.siteTitle ? <span className="text-xs text-muted">· {ev.siteTitle}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </ChartCard>
    </div>
  );
}
