import { useMemo, useState } from 'react';
import type { V2ArchiveItemDetail } from '@spostorage/shared';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Link, useParams } from 'react-router-dom';
import { formatBytes } from '@spostorage/shared';
import type { V2ArchiveTreeFile, V2ArchiveTreeFolder, V2ArchiveTreeSite } from '@spostorage/shared';
import {
  useV2ArchiveItem,
  useV2ArchiveLinks,
  useV2CompleteArchiveLinks,
  useV2RestoreArchived,
  useV2ArchiveTree,
  useV2ArchivedDetail,
  useV2LabAccessCheck,
} from '../api/v2.js';
import { ApiClientError } from '../api/client.js';
import { useToast } from '../app/toast.js';
import { ByteText } from '../components/ByteText.js';
import { EmptyState } from '../components/EmptyState.js';
import { ExplorerAccessBlock } from '../components/SiteFolderExplorer.js';
import { PageSkeleton, TableSkeleton } from '../components/Skeleton.js';
import { PercentBar } from '../components/PercentBar.js';
import { formatAbsoluteDate, formatNumber, formatRelativeDate } from '../lib/format.js';

const COLD_USD_PER_GB_MONTH = 0.0045;

function coldCostUsd(bytes: number): string {
  const usd = (bytes / 1024 ** 3) * COLD_USD_PER_GB_MONTH;
  return usd.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function linkFileName(linkUrl: string | null): string | null {
  if (!linkUrl) return null;
  const parts = linkUrl.split('/');
  return parts[parts.length - 1] || null;
}

const RESTORE_LABELS: Record<string, string> = {
  requested: 'Restore requested: the engine is processing it…',
  uploaded: 'File uploaded to SharePoint; applying permissions and removing the link…',
  done: 'Restored to SharePoint.',
  failed: 'Restore failed.',
};

function RestoreSection({
  archivedId,
  restore,
  originalUrl,
}: {
  archivedId: number;
  restore: V2ArchiveItemDetail['restore'];
  originalUrl: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useV2RestoreArchived();
  const { pushToast } = useToast();
  const state = restore?.state ?? null;
  const busy = state === 'requested' || (state === 'uploaded' && !restore?.error);
  const canRequest = !busy && state !== 'done';
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <h4 className="font-medium">Restore to SharePoint</h4>
      {state ? (
        <p className={state === 'failed' || restore?.error ? 'text-danger' : 'text-muted'}>
          {RESTORE_LABELS[state] ?? state}
          {restore?.error ? ` ${restore.error}` : ''}
          {restore?.restoredAt ? ` (${new Date(restore.restoredAt).toLocaleString(undefined)})` : ''}
        </p>
      ) : (
        <p className="text-muted">
          Re-uploads the file to its original location with the permissions the link has today, verifies it matches the
          archived copy, then removes the link. The blob copy is kept.
        </p>
      )}
      {canRequest ? (
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-1.5 hover:bg-bg"
          onClick={() => setConfirming(true)}
        >
          {state === 'failed' || restore?.error ? 'Retry restore' : 'Restore to SharePoint'}
        </button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="Restore this file to SharePoint?"
        description={`It will be recreated at ${originalUrl}. If a file already exists at that path, it is not overwritten and restore fails. It will use quota again.`}
        confirmLabel="Restore"
        loading={mutation.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          mutation.mutate(archivedId, {
            onSuccess: () => {
              setConfirming(false);
              pushToast('Restore requested', 'success');
            },
            onError: (err) => {
              setConfirming(false);
              pushToast(err instanceof Error ? err.message : 'Could not request restore', 'error');
            },
          })
        }
      />
    </div>
  );
}

function ArchiveItemPanel({ archivedId, onClose }: { archivedId: number; onClose: () => void }) {
  const item = useV2ArchiveItem(archivedId);
  const [upns, setUpns] = useState('');
  const [results, setResults] = useState<Array<{ upn: string; granted: boolean; reason: string }> | null>(
    null,
  );
  const accessCheck = useV2LabAccessCheck();
  const { pushToast } = useToast();
  const data = item.data;

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-card shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-semibold text-ink">Archived detail</h2>
        <button type="button" className="text-sm text-muted hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {item.isLoading ? <TableSkeleton rows={8} /> : null}
        {item.isError ? (
          <p className="text-sm text-danger">
            {item.error instanceof Error ? item.error.message : 'Could not load detail'}
          </p>
        ) : null}
        {data ? (
          <>
            <div>
              <h3 className="text-lg font-medium text-ink">{data.name}</h3>
              <p className="text-sm text-muted">{data.siteTitle}</p>
              <span className="mt-1 inline-block rounded-full border border-accent/40 bg-accent/5 px-2 py-0.5 text-xs text-accent">
                {data.blobTier} · {data.state}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-muted">Size</dt>
                <dd>
                  <ByteText bytes={data.sizeBytes} />
                </dd>
              </div>
              <div>
                <dt className="text-muted">Tier</dt>
                <dd>{data.blobTier}</dd>
              </div>
              <div>
                <dt className="text-muted">Archived</dt>
                <dd>
                  {data.archivedAt ? formatRelativeDate(data.archivedAt) : '—'}
                  {data.archivedBy ? ` · ${data.archivedBy}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Original modified</dt>
                <dd>
                  {data.originalModifiedAt ? formatRelativeDate(data.originalModifiedAt) : '—'}
                  {data.originalModifiedBy ? ` · ${data.originalModifiedBy}` : ''}
                </dd>
              </div>
            </dl>

            <div>
              <h4 className="mb-1 text-sm font-medium">SHA-256</h4>
              <p className="break-all font-mono text-xs text-muted">{data.sha256}</p>
            </div>

            {data.blobUrlInPortal || data.containerUrlInPortal ? (
              <div className="flex flex-wrap gap-2">
                {data.blobUrlInPortal ? (
                  <a
                    className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg"
                    href={data.blobUrlInPortal}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Azure
                  </a>
                ) : null}
                {data.containerUrlInPortal ? (
                  <a
                    className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg"
                    href={data.containerUrlInPortal}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View container
                  </a>
                ) : null}
              </div>
            ) : null}

            <RestoreSection archivedId={data.id} restore={data.restore} originalUrl={data.originalUrl} />

            <div className="space-y-1 text-sm">
              {data.sharePointFolderUrl ? (
                <p>
                  <a
                    className="text-accent hover:underline"
                    href={data.sharePointFolderUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View in SharePoint
                  </a>
                  {linkFileName(data.linkUrl) ? (
                    <span className="text-muted"> · {linkFileName(data.linkUrl)}</span>
                  ) : null}
                </p>
              ) : null}
              <p>
                <Link className="text-accent hover:underline" to={data.portalUrl}>
                  Download portal
                </Link>
              </p>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">Who can open it</h4>
              <ExplorerAccessBlock access={data.access} />
            </div>

            <div className="space-y-2 border-t border-border pt-3">
              <h4 className="text-sm font-medium">Test whether someone can open it</h4>
              <textarea
                className="h-24 w-full rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-sm"
                placeholder="emails, one per line"
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
                    .mutateAsync({ archivedId: data.id, upns: list })
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
                </ul>
              ) : null}
            </div>

            <div className="border-t border-border pt-3">
              <h4 className="mb-2 text-sm font-medium">Portal access log</h4>
              <ul className="space-y-1 text-sm">
                {data.accessLog.length === 0 ? (
                  <li className="text-muted">No access log entries yet.</li>
                ) : (
                  data.accessLog.map((e) => (
                    <li key={e.id}>
                      {e.granted ? '✅' : '⛔'} {e.userUpn}
                      {e.reason ? ` — ${e.reason}` : ''}{' '}
                      <span className="text-muted">
                        {e.at ? formatAbsoluteDate(e.at) : ''}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function PendingLinksCard() {
  const status = useV2ArchiveLinks();
  const mutation = useV2CompleteArchiveLinks();
  const { pushToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const s = status.data;
  if (!s || (s.originalsPending === 0 && s.linksPending === 0 && !s.running)) return null;
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <h2 className="font-medium">Archive links pending</h2>
      <p className="text-muted">
        {formatNumber(s.originalsPending)} archived files still have their original in SharePoint (
        {formatBytes(s.originalsPendingBytes)}) and {formatNumber(s.linksPending)} have no link yet. A site over its
        quota cannot take the .url link: the pass deletes the verified original first to free the space, then creates
        the link. Nothing is copied again and the archived copies are never modified.
      </p>
      {s.errors.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-muted">
          {s.errors.map((e) => (
            <li key={e.message}>
              {formatNumber(e.count)} × {e.message}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        className="rounded-lg border border-border px-3 py-1.5 hover:bg-bg disabled:opacity-60"
        disabled={s.running || mutation.isPending}
        onClick={() => setConfirming(true)}
      >
        {s.running ? 'Running…' : 'Complete archive links'}
      </button>
      <ConfirmDialog
        open={confirming}
        title="Complete the pending archive links?"
        description="For every pending file the archived copy is verified and the original must be unchanged. Then the link is created, or, if the site has no space, the original is permanently deleted first and the link is created right after. Files that fail a check are skipped and left untouched."
        confirmLabel="Complete links"
        loading={mutation.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          mutation.mutate(undefined, {
            onSuccess: (r) => {
              setConfirming(false);
              pushToast(r.started ? 'Archive links pass started' : 'A pass is already running', r.started ? 'success' : 'error');
            },
            onError: (err) => {
              setConfirming(false);
              pushToast(err instanceof Error ? err.message : 'Could not start the pass', 'error');
            },
          })
        }
      />
    </div>
  );
}

export function ArchivedPage() {
  const [siteId, setSiteId] = useState<number | null>(null);
  const [siteTitle, setSiteTitle] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const tree = useV2ArchiveTree({ siteId, path });

  const summary = tree.data?.summary ?? { fileCount: 0, bytes: 0 };
  const gbLabel = formatBytes(summary.bytes);

  const crumbs = useMemo(() => {
    const list: Array<{ label: string; onClick: () => void }> = [
      {
        label: 'Sites',
        onClick: () => {
          setSiteId(null);
          setSiteTitle(null);
          setPath('');
        },
      },
    ];
    if (siteId) {
      list.push({
        label: siteTitle || tree.data?.siteTitle || `Site #${siteId}`,
        onClick: () => setPath(''),
      });
      const parts = path.split('/').filter(Boolean);
      let acc = '';
      for (const part of parts) {
        acc += `/${part}`;
        const crumbPath = acc;
        list.push({
          label: part,
          onClick: () => setPath(crumbPath),
        });
      }
    }
    return list;
  }, [siteId, siteTitle, path, tree.data?.siteTitle]);

  const maxBytes = Math.max(
    1,
    ...(tree.data?.sites ?? []).map((s) => s.bytes),
    ...(tree.data?.folders ?? []).map((f) => f.bytes),
  );

  const enterSite = (s: V2ArchiveTreeSite) => {
    setSiteId(s.siteId);
    setSiteTitle(s.title);
    setPath('');
  };

  const enterFolder = (f: V2ArchiveTreeFolder) => setPath(f.path);

  const openFile = (f: V2ArchiveTreeFile) => setSelectedId(f.archivedId);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Archived</h1>
        <p className="mt-1 text-sm text-muted">
          {formatNumber(summary.fileCount)} files · {gbLabel} en Blob Cold · approx. cost{' '}
          {coldCostUsd(summary.bytes)}/mo
        </p>
      </div>

      <PendingLinksCard />

      <nav className="flex flex-wrap items-center gap-1 text-sm">
        {crumbs.map((c, i) => (
          <span key={`${c.label}-${i}`} className="flex items-center gap-1">
            {i > 0 ? <span className="text-muted">›</span> : null}
            <button type="button" className="text-accent hover:underline" onClick={c.onClick}>
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      {tree.isLoading ? (
        <TableSkeleton rows={6} />
      ) : tree.isError ? (
        <EmptyState
          title="Could not load tree"
          description={tree.error instanceof Error ? tree.error.message : 'Error'}
        />
      ) : !siteId ? (
        (tree.data?.sites.length ?? 0) === 0 ? (
          <EmptyState title="No archived files" description="When you archive files they will appear here." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="py-2">Site</th>
                <th className="py-2">Files</th>
                <th className="py-2">Size</th>
                <th className="w-40 py-2" />
                <th className="py-2">Last</th>
              </tr>
            </thead>
            <tbody>
              {tree.data!.sites.map((s) => (
                <tr
                  key={s.siteId}
                  className="cursor-pointer border-b border-border/60 hover:bg-bg"
                  onClick={() => enterSite(s)}
                >
                  <td className="py-2 font-medium">{s.title || s.url}</td>
                  <td className="py-2">{formatNumber(s.fileCount)}</td>
                  <td className="py-2">
                    <ByteText bytes={s.bytes} />
                  </td>
                  <td className="py-2">
                    <PercentBar value={s.bytes} max={maxBytes} />
                  </td>
                  <td className="py-2">
                    {s.lastArchivedAt ? formatRelativeDate(s.lastArchivedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <div className="space-y-6">
          {(tree.data?.folders.length ?? 0) > 0 ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="py-2">Folder</th>
                  <th className="py-2">Files</th>
                  <th className="py-2">Size</th>
                  <th className="w-40 py-2" />
                </tr>
              </thead>
              <tbody>
                {tree.data!.folders.map((f) => (
                  <tr
                    key={f.path}
                    className="cursor-pointer border-b border-border/60 hover:bg-bg"
                    onClick={() => enterFolder(f)}
                  >
                    <td className="py-2 font-medium">{f.name}</td>
                    <td className="py-2">{formatNumber(f.fileCount)}</td>
                    <td className="py-2">
                      <ByteText bytes={f.bytes} />
                    </td>
                    <td className="py-2">
                      <PercentBar value={f.bytes} max={maxBytes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {(tree.data?.files.length ?? 0) > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-medium text-ink">Files en esta carpeta</h3>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th className="py-2">Name</th>
                    <th className="py-2">Size</th>
                    <th className="py-2">Tier</th>
                    <th className="py-2">Archived</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tree.data!.files.map((f) => (
                    <tr
                      key={f.archivedId}
                      className="cursor-pointer border-b border-border/60 hover:bg-bg"
                      onClick={() => openFile(f)}
                    >
                      <td className="py-2 font-medium">{f.name}</td>
                      <td className="py-2">
                        <ByteText bytes={f.sizeBytes} />
                      </td>
                      <td className="py-2">{f.blobTier}</td>
                      <td className="py-2">
                        {f.archivedAt ? formatRelativeDate(f.archivedAt) : '—'}
                        {f.archivedBy ? (
                          <span className="text-muted"> · {f.archivedBy}</span>
                        ) : null}
                      </td>
                      <td className="py-2">{f.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (tree.data?.folders.length ?? 0) === 0 ? (
            <EmptyState title="Empty folder" description="No archived files in this path." />
          ) : null}
        </div>
      )}

      {selectedId != null ? (
        <ArchiveItemPanel archivedId={selectedId} onClose={() => setSelectedId(null)} />
      ) : null}
    </div>
  );
}

export function ArchivedDetailPage() {
  const id = Number(useParams().id);
  const { data, isLoading } = useV2ArchivedDetail(id);
  if (isLoading || !data) return <PageSkeleton />;

  const acl = Array.isArray(data.acl) ? (data.acl as unknown[]) : null;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/archived" className="text-sm text-accent hover:underline">
          ← Archived
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{data.name}</h1>
        <p className="mt-1 text-sm text-muted">
          {data.siteTitle} · <ByteText bytes={data.sizeBytes} /> · {data.state}
        </p>
      </div>

      <div className="space-y-1 rounded-xl border border-border bg-card p-4 text-sm">
        <div>
          <span className="text-muted">URL original: </span>
          {data.originalUrl}
        </div>
        <div>
          <span className="text-muted">Archived: </span>
          {data.archivedAt ? formatAbsoluteDate(data.archivedAt) : '—'}
        </div>
        <div>
          <Link className="text-accent hover:underline" to={`/archive/${data.id}`}>
            Open portal de descarga
          </Link>
        </div>
      </div>

      <section>
        <h2 className="text-lg font-semibold">Permissions copied</h2>
        {acl && acl.length ? (
          <ul className="mt-2 space-y-1 text-sm">
            {acl.map((entry, i) => (
              <li key={i} className="font-mono text-xs">
                {typeof entry === 'string' ? entry : JSON.stringify(entry)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No ACL recorded.</p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold">Access log</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {data.accessLog.length === 0 ? (
            <li className="text-muted">No access log entries yet.</li>
          ) : (
            data.accessLog.map((e) => (
              <li key={e.id}>
                {e.granted ? '✅' : '⛔'} {e.userUpn} — {e.reason}{' '}
                <span className="text-muted">{e.at ? formatAbsoluteDate(e.at) : ''}</span>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}
