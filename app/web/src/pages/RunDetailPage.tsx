import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { V2PolicyAction } from '@spostorage/shared';
import {
  useV2ApproveRun,
  useV2CancelRun,
  useV2LabAccessCheck,
  useV2Run,
  useV2RunActions,
} from '../api/v2.js';
import { ByteText } from '../components/ByteText.js';
import { PercentBar } from '../components/PercentBar.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { useToast } from '../app/toast.js';
import { formatAbsoluteDate, formatNumber } from '../lib/format.js';
import { ApiClientError } from '../api/client.js';

function EvidencePanel({ evidence }: { evidence: unknown }) {
  if (!evidence || typeof evidence !== 'object') {
    return <p className="text-sm text-muted">No evidence recorded.</p>;
  }
  const e = evidence as Record<string, unknown>;
  const rows: Array<[string, string]> = [];
  if (e.versionsBefore != null) rows.push(['Versions before', JSON.stringify(e.versionsBefore)]);
  if (e.versionsAfter != null) rows.push(['Versions after', JSON.stringify(e.versionsAfter)]);
  if (e.totalBefore != null) rows.push(['Total size before', String(e.totalBefore)]);
  if (e.totalAfter != null) rows.push(['Total size after', String(e.totalAfter)]);
  if (e.recycleBin != null) rows.push(['Recycle bin', JSON.stringify(e.recycleBin)]);
  if (e.preservationHold != null) rows.push(['Preservation Hold', JSON.stringify(e.preservationHold)]);
  if (e.hash != null || e.sha256 != null) rows.push(['Hash', String(e.hash ?? e.sha256)]);
  if (e.acl != null || e.permissions != null) rows.push(['Permissions copied', JSON.stringify(e.acl ?? e.permissions)]);
  if (e.linkUrl != null) rows.push(['Link left', String(e.linkUrl)]);
  if (e.archivedId != null) rows.push(['Archive id', String(e.archivedId)]);
  if (rows.length === 0) {
    return (
      <pre className="max-h-80 overflow-auto rounded-lg bg-bg p-3 text-xs">{JSON.stringify(evidence, null, 2)}</pre>
    );
  }
  return (
    <dl className="space-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="text-muted">{k}</dt>
          <dd className="break-all font-mono text-xs">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function AccessCheckPanel({ archivedId }: { archivedId: number }) {
  const [upns, setUpns] = useState('');
  const [results, setResults] = useState<Array<{ upn: string; granted: boolean; reason: string }> | null>(
    null,
  );
  const accessCheck = useV2LabAccessCheck();
  const { pushToast } = useToast();

  return (
    <div className="mt-4 space-y-2 border-t border-border pt-3">
      <h4 className="text-sm font-medium text-ink">Test access</h4>
      <p className="text-xs text-muted">Emails (one per line)</p>
      <textarea
        className="h-24 w-full rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-sm"
        value={upns}
        onChange={(e) => setUpns(e.target.value)}
      />
      <button
        type="button"
        className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg"
        disabled={accessCheck.isPending}
        onClick={() => {
          const list = upns
            .split('\n')
            .map((u) => u.trim())
            .filter(Boolean);
          if (!list.length) {
            pushToast('Enter at least one email', 'error');
            return;
          }
          void accessCheck
            .mutateAsync({ archivedId, upns: list })
            .then((r) => setResults(r.results))
            .catch((err: unknown) =>
              pushToast(err instanceof ApiClientError ? err.message : 'Error', 'error'),
            );
        }}
      >
        Check
      </button>
      {results ? (
        <ul className="space-y-1 text-sm">
          {results.map((r) => (
            <li key={r.upn}>
              {r.granted ? '✅' : '⛔'} {r.upn} — {r.reason}
            </li>
          ))}
          <li className="pt-1">
            <Link className="text-accent hover:underline" to={`/archive/${archivedId}`}>
              Open portal
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function archivedIdFromEvidence(evidence: unknown): number | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const id = (evidence as { archivedId?: unknown }).archivedId;
  const n = typeof id === 'number' ? id : Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const STATUS_LABELS: Record<string, string> = {
  planned: 'Pending',
  awaiting_approval: 'Awaiting approval',
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

const ACTION_LABELS: Record<string, string> = {
  archive_file: 'Archive',
  delete_versions: 'Delete versions',
  purge_recycle: 'Empty recycle bin',
  set_version_limit: 'Limit versions',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function RunDetailPage() {
  const id = Number(useParams().id);
  const { data: run, isLoading } = useV2Run(id);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const { data: actions } = useV2RunActions(id, { status: statusFilter || undefined, page });
  const [selected, setSelected] = useState<V2PolicyAction | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const approve = useV2ApproveRun();
  const cancel = useV2CancelRun();
  const { pushToast } = useToast();

  const nextStep = ((run?.approvals?.length ?? 0) + 1) as 1 | 2 | 3;
  const canApprove =
    run &&
    (run.status === 'planned' || run.status === 'awaiting_approval') &&
    nextStep <= 3;

  const progressPct = useMemo(() => {
    const planned = run?.plannedCount ?? 0;
    const done = run?.doneCount ?? 0;
    if (!planned) return 0;
    return Math.min(100, Math.round((done / planned) * 100));
  }, [run]);

  if (isLoading || !run) return <PageSkeleton />;

  const doApprove = async (step: 1 | 2 | 3) => {
    try {
      await approve.mutateAsync({
        id,
        step,
        confirmText: step === 3 ? confirmText : undefined,
      });
      pushToast(step === 3 ? 'Execution started' : `Step ${step} confirmed`, 'success');
      setConfirmText('');
    } catch (err) {
      pushToast(err instanceof ApiClientError ? err.message : 'Failed to approve', 'error');
    }
  };

  const selectedArchivedId =
    selected?.action === 'archive_file' && selected.status === 'done'
      ? archivedIdFromEvidence(selected.evidence)
      : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/activity?tab=runs" className="text-sm text-accent hover:underline">
            ← Runs
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-ink">
            Run #{run.id}
            {run.scope === 'lab' ? ' (lab)' : ''}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {run.policyName || 'No saved policy'} · status <strong>{statusLabel(run.status)}</strong>
            {run.startedAt ? ` · started ${formatAbsoluteDate(run.startedAt)}` : ''}
          </p>
        </div>
        {run.status !== 'done' && run.status !== 'cancelled' ? (
          <button
            type="button"
            className="rounded-lg border border-warn/50 px-3 py-2 text-sm text-warn hover:bg-warn/5"
            disabled={cancel.isPending}
            onClick={() =>
              void cancel.mutateAsync(id).then(() => pushToast('Run cancelled', 'info'))
            }
          >
            Cancel
          </button>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <div className="text-muted">Planned</div>
          <div className="mt-1 text-lg font-semibold">
            {formatNumber(run.plannedCount ?? 0)} · <ByteText bytes={run.plannedBytes ?? 0} />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <div className="text-muted">Done</div>
          <div className="mt-1 text-lg font-semibold">
            {formatNumber(run.doneCount ?? 0)} · <ByteText bytes={run.freedBytes ?? 0} /> freed
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <div className="mb-2 text-muted">Progress</div>
          <PercentBar value={progressPct} />
        </div>
      </div>

      {canApprove ? (
        <div className="space-y-3 rounded-xl border border-danger/30 bg-danger/5 p-4">
          <h2 className="font-semibold text-ink">Triple confirmation</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li className={run.approvals.some((a) => a.step === 1) ? 'text-ok' : ''}>
              I reviewed the simulation
              {nextStep === 1 ? (
                <button
                  type="button"
                  className="ml-2 rounded border border-border px-2 py-0.5 text-xs hover:bg-bg"
                  onClick={() => void doApprove(1)}
                >
                  Confirm
                </button>
              ) : null}
            </li>
            <li className={run.approvals.some((a) => a.step === 2) ? 'text-ok' : ''}>
              I understand this is irreversible
              {nextStep === 2 ? (
                <button
                  type="button"
                  className="ml-2 rounded border border-border px-2 py-0.5 text-xs hover:bg-bg"
                  onClick={() => void doApprove(2)}
                >
                  Confirm
                </button>
              ) : null}
            </li>
            <li>
              Type exactly <code className="font-mono">DELETE {run.plannedCount ?? 0}</code>
              {nextStep === 3 ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="rounded-lg border border-border bg-bg px-2 py-1 font-mono text-sm"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                  <button
                    type="button"
                    className="rounded-lg bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-50"
                    disabled={confirmText !== `DELETE ${run.plannedCount ?? 0}` || approve.isPending}
                    onClick={() => void doApprove(3)}
                  >
                    Run
                  </button>
                </div>
              ) : null}
            </li>
          </ol>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Actions</h2>
            <select
              className="rounded-lg border border-border bg-card px-2 py-1 text-sm"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All</option>
              <option value="planned">planned</option>
              <option value="done">done</option>
              <option value="failed">failed</option>
              <option value="skipped">skipped</option>
            </select>
          </div>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-card text-muted">
                <tr>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Target</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Bytes</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(actions?.items ?? []).map((a) => {
                  const archivedId =
                    a.action === 'archive_file' && a.status === 'done'
                      ? archivedIdFromEvidence(a.evidence)
                      : null;
                  return (
                    <tr
                      key={a.id}
                      className={`cursor-pointer border-t border-border hover:bg-bg ${selected?.id === a.id ? 'bg-accent/5' : ''}`}
                      onClick={() => {
                        setSelected(a);
                        setAccessOpen(false);
                      }}
                    >
                      <td className="px-3 py-2">{ACTION_LABELS[a.action] ?? a.action}</td>
                      <td className="max-w-xs truncate px-3 py-2">{a.targetUrl}</td>
                      <td className="px-3 py-2">
                        {statusLabel(a.status)}
                        {a.status === 'running' && a.detail ? (
                          <div className="text-xs text-muted">{a.detail}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <ByteText bytes={a.bytes} />
                      </td>
                      <td className="px-3 py-2">
                        {archivedId ? (
                          <button
                            type="button"
                            className="text-xs text-accent hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(a);
                              setAccessOpen(true);
                            }}
                          >
                            Test access
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="font-semibold text-ink">Evidence</h3>
          {selected ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted">{selected.detail || 'No detail'}</p>
              <EvidencePanel evidence={selected.evidence} />
              {selectedArchivedId && accessOpen ? (
                <AccessCheckPanel archivedId={selectedArchivedId} />
              ) : selectedArchivedId ? (
                <button
                  type="button"
                  className="mt-3 text-sm text-accent hover:underline"
                  onClick={() => setAccessOpen(true)}
                >
                  Test access
                </button>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Select an action to view evidence.</p>
          )}
        </div>
      </div>
    </div>
  );
}
