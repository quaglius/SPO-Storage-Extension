import { useEffect, useState } from 'react';
import type { V2ArchiveSettings, V2EngineSettings } from '@spostorage/shared';
import {
  useHealth,
  useUpdateV2Settings,
  useV2Settings,
} from '../api/v2.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { useToast } from '../app/toast.js';

const GiB = 1024 ** 3;
const MB = 1024 * 1024;

const APP_PERMISSIONS = [
  { api: 'SharePoint', permission: 'Sites.FullControl.All', why: 'Inventory, .url link, permissions, delete, and GetUserEffectivePermissions' },
  { api: 'Microsoft Graph', permission: 'Sites.Read.All', why: 'File quickXorHash' },
  { api: 'Microsoft Graph', permission: 'GroupMember.Read.All', why: 'Group members in “Who can open it”' },
  { api: 'Microsoft Graph', permission: 'AuditLogsQuery-SharePoint.Read.All', why: 'Last access (audit)' },
  { api: 'Office 365 Management', permission: 'ActivityFeed.Read', why: 'Reserved for continuous audit' },
];

export function SettingsPage() {
  const { pushToast } = useToast();
  const { data: health } = useHealth();
  const engineQ = useV2Settings<V2EngineSettings>('engine');
  const archiveQ = useV2Settings<V2ArchiveSettings>('archive');
  const pricingQ = useV2Settings<number>('pricing.extraStorageUsdPerGbMonth');
  const update = useUpdateV2Settings();

  const [engine, setEngine] = useState<V2EngineSettings | null>(null);
  const [pricing, setPricing] = useState<number>(0.2);
  const [maxFileGb, setMaxFileGb] = useState<number>(15);

  useEffect(() => {
    if (engineQ.data?.value) setEngine(engineQ.data.value);
  }, [engineQ.data]);
  useEffect(() => {
    if (typeof pricingQ.data?.value === 'number') setPricing(pricingQ.data.value);
  }, [pricingQ.data]);
  useEffect(() => {
    if (archiveQ.data?.value) setMaxFileGb(archiveQ.data.value.maxFileBytes / GiB);
  }, [archiveQ.data]);

  if (engineQ.isLoading || archiveQ.isLoading || pricingQ.isLoading || !engine) {
    return <PageSkeleton />;
  }

  if (engineQ.isError || archiveQ.isError || pricingQ.isError) {
    return (
      <EmptyState
        title="Could not load settings"
        description="Only administrators can view and change these values."
      />
    );
  }

  const archive = archiveQ.data!.value;
  const commit = health?.build?.commit ?? 'local';

  async function saveEngine() {
    try {
      await update.mutateAsync({ key: 'engine', value: engine });
      pushToast('Engine settings saved', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to save', 'error');
    }
  }

  async function savePricing() {
    try {
      await update.mutateAsync({ key: 'pricing.extraStorageUsdPerGbMonth', value: pricing });
      pushToast('Extra storage price saved', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to save', 'error');
    }
  }

  async function saveArchive() {
    try {
      await update.mutateAsync({
        key: 'archive',
        value: { ...archive, maxFileBytes: Math.round(maxFileGb * GiB) },
      });
      pushToast('Archive settings saved', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to save', 'error');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Settings</h1>
        <p className="mt-1 text-sm text-muted">Engine parameters, pricing, and archiving (administrators only).</p>
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-ink">Engine</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            label="Concurrency"
            value={engine.concurrency}
            onChange={(v) => setEngine({ ...engine, concurrency: v })}
          />
          <NumberField
            label="Requests per minute"
            value={engine.requestsPerMinute}
            onChange={(v) => setEngine({ ...engine, requestsPerMinute: v })}
          />
          <NumberField
            label="Heavy versions threshold (MB)"
            value={Math.round(engine.heavyVersionsThresholdBytes / MB)}
            onChange={(v) => setEngine({ ...engine, heavyVersionsThresholdBytes: v * MB })}
          />
          <NumberField
            label="Tenant usage interval (min)"
            value={engine.tenantUsageIntervalMinutes}
            onChange={(v) => setEngine({ ...engine, tenantUsageIntervalMinutes: v })}
          />
          <NumberField
            label="Site structure interval (h)"
            value={engine.siteStructureIntervalHours}
            onChange={(v) => setEngine({ ...engine, siteStructureIntervalHours: v })}
          />
          <NumberField
            label="Library scan interval (h)"
            value={engine.libraryScanIntervalHours}
            onChange={(v) => setEngine({ ...engine, libraryScanIntervalHours: v })}
          />
          <NumberField
            label="Versions rescan (days)"
            value={engine.versionsRescanDays}
            onChange={(v) => setEngine({ ...engine, versionsRescanDays: v })}
          />
          <NumberField
            label="Retry failed after (h)"
            value={engine.retryFailedAfterHours}
            onChange={(v) => setEngine({ ...engine, retryFailedAfterHours: v })}
          />
        </div>
        <button
          type="button"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          disabled={update.isPending}
          onClick={() => void saveEngine()}
        >
          Save engine
        </button>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-ink">Pricing</h2>
        <NumberField
          label="Extra storage (USD / GB·month)"
          value={pricing}
          step={0.01}
          onChange={setPricing}
        />
        <button
          type="button"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          disabled={update.isPending}
          onClick={() => void savePricing()}
        >
          Save pricing
        </button>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-ink">Archiving</h2>
        <NumberField label="Maximum file size (GB)" value={maxFileGb} step={0.5} onChange={setMaxFileGb} />
        <label className="block text-sm">
          <span className="text-muted">Tier (read-only)</span>
          <input
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted"
            value={archive.tier}
            readOnly
          />
        </label>
        <button
          type="button"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          disabled={update.isPending}
          onClick={() => void saveArchive()}
        >
          Save archiving
        </button>
      </section>

      <section className="space-y-3 border-t border-border pt-6">
        <h2 className="text-lg font-medium text-ink">Deployment info</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Deployed commit</dt>
            <dd className="font-mono text-ink">{commit}</dd>
          </div>
          <div>
            <dt className="text-muted">Blob account</dt>
            <dd className="font-mono text-ink">{archive.account}</dd>
          </div>
          <div>
            <dt className="text-muted">Container</dt>
            <dd className="font-mono text-ink">{archive.container}</dd>
          </div>
          <div>
            <dt className="text-muted">This instance role</dt>
            <dd className="text-ink">{health?.role ?? '—'}</dd>
          </div>
        </dl>

        <h3 className="pt-2 text-sm font-medium text-ink">App permissions (SpoStorage Collector Cloud)</h3>
        <ul className="space-y-2 text-sm text-muted">
          {APP_PERMISSIONS.map((p) => (
            <li key={`${p.api}-${p.permission}`}>
              <span className="font-medium text-ink">{p.api}</span> · <code>{p.permission}</code> — {p.why}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          SpoStorage Web uses Easy Auth. Both App Services have Storage Blob Data Contributor on the archive storage
          account.
        </p>
      </section>
    </div>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{props.label}</span>
      <input
        type="number"
        step={props.step ?? 1}
        className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-ink"
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}
