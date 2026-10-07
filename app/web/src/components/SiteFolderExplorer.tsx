import { useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  V2ExplorerAccess,
  V2ExplorerFileRow,
  V2ExplorerFolder,
  V2ExplorerLibrary,
} from '@spostorage/shared';
import {
  useV2ExplorerArchived,
  useV2ExplorerFile,
  useV2ExplorerFolder,
  useV2LabAccessCheck,
} from '../api/v2.js';
import { ApiClientError } from '../api/client.js';
import { useToast } from '../app/toast.js';
import { ByteText } from './ByteText.js';
import { EmptyState } from './EmptyState.js';
import { PercentBar } from './PercentBar.js';
import { TableSkeleton } from './Skeleton.js';
import { formatNumber, formatRelativeDate } from '../lib/format.js';

function roleLabel(roles: string[]): string {
  const joined = roles.join(', ');
  if (/control total|full control/i.test(joined)) return 'Full control';
  if (/editar|edit|contribu/i.test(joined)) return 'Edit';
  if (/leer|read/i.test(joined)) return 'Read';
  return roles[0] || '—';
}

export function ExplorerAccessBlock({ access }: { access: V2ExplorerAccess }) {
  if ('error' in access) {
    return <p className="text-sm text-danger">{access.error}</p>;
  }
  return (
    <div className="space-y-3">
      {access.everyone ? (
        <p className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-warn">
          Anyone in the organization
        </p>
      ) : null}
      <ul className="space-y-2 text-sm">
        {access.people.map((p) => (
          <li key={p.email ?? p.name} className="border-b border-border/50 pb-2">
            <div className="font-medium text-ink">{p.name}</div>
            <div className="text-muted">{p.email || 'no email'}</div>
            <div className="text-xs text-muted">
              {roleLabel(p.roles)} · via {p.via.join(', ')}
            </div>
          </li>
        ))}
      </ul>
      {access.principals.some((p) => p.membersNote) ? (
        <div className="space-y-1 text-xs text-muted">
          {access.principals
            .filter((p) => p.membersNote)
            .map((p) => (
              <p key={p.name}>
                <strong>{p.name}:</strong> {p.membersNote}
              </p>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function FileDetailPanel({
  fileId,
  archivedId,
  onClose,
}: {
  fileId: number | null;
  archivedId: number | null;
  onClose: () => void;
}) {
  const file = useV2ExplorerFile(fileId);
  const archived = useV2ExplorerArchived(archivedId);
  const [upns, setUpns] = useState('');
  const [results, setResults] = useState<Array<{ upn: string; granted: boolean; reason: string }> | null>(
    null,
  );
  const accessCheck = useV2LabAccessCheck();
  const { pushToast } = useToast();

  const loading = (fileId && file.isLoading) || (archivedId && archived.isLoading);
  const detail = fileId ? file.data : null;
  const arch = archivedId ? archived.data : null;

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-card shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-semibold text-ink">Detail</h2>
        <button type="button" className="text-sm text-muted hover:text-ink" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {loading ? <TableSkeleton rows={6} /> : null}
        {detail ? (
          <>
            <div>
              <h3 className="text-lg font-medium text-ink">{detail.name}</h3>
              <p className="text-sm text-muted">
                {detail.siteTitle} › {detail.libraryTitle}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-muted">Size</dt>
                <dd>
                  <ByteText bytes={detail.sizeBytes} />
                </dd>
              </div>
              <div>
                <dt className="text-muted">Versions</dt>
                <dd>
                  <ByteText bytes={detail.versionsBytes} />
                </dd>
              </div>
              <div>
                <dt className="text-muted">Modified</dt>
                <dd>{detail.modifiedAt ? formatRelativeDate(detail.modifiedAt) : '—'}</dd>
              </div>
              <div>
                <dt className="text-muted">Last access</dt>
                <dd>
                  {detail.lastAccess
                    ? `${formatRelativeDate(detail.lastAccess.at)}${detail.lastAccess.user ? ` · ${detail.lastAccess.user}` : ''}`
                    : detail.lastAccessAt
                      ? formatRelativeDate(detail.lastAccessAt)
                      : 'no record'}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Author</dt>
                <dd>{detail.author || '—'}</dd>
              </div>
              <div>
                <dt className="text-muted">Editor</dt>
                <dd>{detail.editor || '—'}</dd>
              </div>
            </dl>
            {detail.versions.length > 0 ? (
              <div>
                <h4 className="mb-2 text-sm font-medium">Versions</h4>
                <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                  {detail.versions.map((v) => (
                    <li key={v.label} className="flex justify-between gap-2">
                      <span>
                        {v.label}
                        {v.createdAt ? (
                          <span className="text-muted"> · {formatRelativeDate(v.createdAt)}</span>
                        ) : null}
                      </span>
                      <ByteText bytes={v.sizeBytes} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <h4 className="mb-2 text-sm font-medium">Who can open it</h4>
              <ExplorerAccessBlock access={detail.access} />
            </div>
          </>
        ) : null}
        {arch ? (
          <>
            <div>
              <h3 className="text-lg font-medium text-ink">{arch.name}</h3>
              <span className="mt-1 inline-block rounded-full border border-accent/40 bg-accent/5 px-2 py-0.5 text-xs text-accent">
                Archived ({arch.blobTier})
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-muted">Size</dt>
                <dd>
                  <ByteText bytes={arch.sizeBytes} />
                </dd>
              </div>
              <div>
                <dt className="text-muted">Archived</dt>
                <dd>{arch.archivedAt ? formatRelativeDate(arch.archivedAt) : '—'}</dd>
              </div>
            </dl>
            <p className="text-sm">
              <Link className="text-accent hover:underline" to={`/archive/${arch.id}`}>
                Open portal de descarga
              </Link>
            </p>
            {arch.linkUrl ? (
              <p className="break-all text-xs text-muted">SharePoint link: {arch.linkUrl}</p>
            ) : null}
            <div>
              <h4 className="mb-2 text-sm font-medium">Who can open it</h4>
              <ExplorerAccessBlock access={arch.access} />
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
                    .mutateAsync({ archivedId: arch.id, upns: list })
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
          </>
        ) : null}
      </div>
    </aside>
  );
}

export function SiteFolderExplorer({ siteId }: { siteId: number }) {
  const [libraryId, setLibraryId] = useState<number | null>(null);
  const [libraryTitle, setLibraryTitle] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [detail, setDetail] = useState<{ fileId: number | null; archivedId: number | null } | null>(
    null,
  );

  const folder = useV2ExplorerFolder({ siteId, libraryId, path });

  const crumbs: Array<{ label: string; onClick: () => void }> = [];
  crumbs.push({
    label: 'Libraries',
    onClick: () => {
      setLibraryId(null);
      setLibraryTitle(null);
      setPath('');
    },
  });
  if (libraryId) {
    crumbs.push({
      label: libraryTitle || folder.data?.libraryTitle || 'Library',
      onClick: () => setPath(''),
    });
    const parts = path.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc += `/${parts[i]}`;
      const crumbPath = acc;
      crumbs.push({
        label: parts[i],
        onClick: () => setPath(crumbPath),
      });
    }
  }

  const maxBytes = Math.max(
    1,
    ...(folder.data?.libraries ?? []).map((l) => l.totalBytes),
    ...(folder.data?.folders ?? []).map((f) => f.totalBytes),
  );

  const enterLibrary = (lib: V2ExplorerLibrary) => {
    setLibraryId(lib.id);
    setLibraryTitle(lib.title);
    setPath('');
  };

  const enterFolder = (f: V2ExplorerFolder) => setPath(f.path);

  const openFile = (f: V2ExplorerFileRow) => {
    if (f.archived && f.archivedId) setDetail({ fileId: null, archivedId: f.archivedId });
    else if (f.id) setDetail({ fileId: f.id, archivedId: null });
  };

  return (
    <div className="space-y-4">
      {crumbs.length > 0 ? (
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
      ) : null}

      {folder.isLoading ? (
        <TableSkeleton rows={6} />
      ) : folder.isError ? (
        <EmptyState
          title="Could not load folder"
          description={folder.error instanceof Error ? folder.error.message : 'Error'}
        />
      ) : (
        <div className="space-y-6">
          {!libraryId && (folder.data?.libraries.length ?? 0) > 0 ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="py-2">Library</th>
                  <th className="py-2">Files</th>
                  <th className="py-2">Size total</th>
                  <th className="w-40 py-2" />
                </tr>
              </thead>
              <tbody>
                {folder.data!.libraries.map((lib) => (
                  <tr
                    key={lib.id}
                    className="cursor-pointer border-b border-border/60 hover:bg-bg"
                    onClick={() => enterLibrary(lib)}
                  >
                    <td className="py-2 font-medium">{lib.title}</td>
                    <td className="py-2">{formatNumber(lib.fileCount)}</td>
                    <td className="py-2">
                      <ByteText bytes={lib.totalBytes} />
                      <span className="text-muted">
                        {' '}
                        (versions <ByteText bytes={lib.versionsBytes} />)
                      </span>
                    </td>
                    <td className="py-2">
                      <PercentBar value={lib.totalBytes} max={maxBytes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {!libraryId && (folder.data?.libraries.length ?? 0) === 0 ? (
            <EmptyState
              title="No libraries"
              description="This site has no libraries with inventoried files yet."
            />
          ) : null}

          {libraryId ? (
            <>
              {(folder.data?.folders.length ?? 0) > 0 ? (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th className="py-2">Folder</th>
                      <th className="py-2">Files</th>
                      <th className="py-2">Size total</th>
                      <th className="w-40 py-2" />
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {folder.data!.folders.map((f) => (
                      <tr
                        key={f.path}
                        className="cursor-pointer border-b border-border/60 hover:bg-bg"
                        onClick={() => enterFolder(f)}
                      >
                        <td className="py-2 font-medium">{f.name}</td>
                        <td className="py-2">{formatNumber(f.fileCount)}</td>
                        <td className="py-2">
                          <ByteText bytes={f.totalBytes} />
                        </td>
                        <td className="py-2">
                          <PercentBar value={f.totalBytes} max={maxBytes} />
                        </td>
                        <td className="py-2">
                          {f.archivedCount > 0 ? (
                            <span className="rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-xs text-accent">
                              {f.archivedCount} archived
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}

              {(folder.data?.files.length ?? 0) > 0 ? (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-ink">Files in this folder</h3>
                  {folder.data!.hasMore ? (
                    <p className="mb-2 text-xs text-muted">Showing top 300 by size</p>
                  ) : null}
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted">
                        <th className="py-2">Name</th>
                        <th className="py-2">Size</th>
                        <th className="py-2">Versions</th>
                        <th className="py-2">Total</th>
                        <th className="py-2">Modified</th>
                        <th className="py-2">Last access</th>
                      </tr>
                    </thead>
                    <tbody>
                      {folder.data!.files.map((f) => (
                        <tr
                          key={f.archivedId ? `a-${f.archivedId}` : `f-${f.id}`}
                          className="cursor-pointer border-b border-border/60 hover:bg-bg"
                          onClick={() => openFile(f)}
                        >
                          <td className="py-2">
                            <span className="font-medium">{f.name}</span>
                            {f.archived ? (
                              <span className="ml-2 rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-xs text-accent">
                                Archived ({f.blobTier || 'Cold'})
                              </span>
                            ) : null}
                          </td>
                          <td className="py-2">
                            <ByteText bytes={f.sizeBytes} />
                          </td>
                          <td className="py-2">
                            <ByteText bytes={f.versionsBytes} />
                          </td>
                          <td className="py-2">
                            <ByteText bytes={f.totalBytes} />
                          </td>
                          <td className="py-2">
                            {f.modifiedAt ? formatRelativeDate(f.modifiedAt) : '—'}
                          </td>
                          <td className="py-2">
                            {f.lastAccessAt ? formatRelativeDate(f.lastAccessAt) : 'no record'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : libraryId && (folder.data?.folders.length ?? 0) === 0 ? (
                <EmptyState title="Empty folder" description="No files or subfolders here." />
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {detail ? (
        <FileDetailPanel
          fileId={detail.fileId}
          archivedId={detail.archivedId}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </div>
  );
}
