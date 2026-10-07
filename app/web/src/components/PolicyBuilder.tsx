import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatBytes } from '@spostorage/shared';
import type { V2PolicyKind, V2SimulationPreview, V2SimulationResponse } from '@spostorage/shared';
import { apiPost, ApiClientError } from '../api/client.js';
import { useV2Audit, useV2Sites } from '../api/v2.js';
import { ByteText } from './ByteText.js';
import { Skeleton, TableSkeleton } from './Skeleton.js';
import { formatAbsoluteDate, formatNumber, formatRelativeDate } from '../lib/format.js';

const MB = 1024 * 1024;

const KIND_CARDS: Array<{ kind: V2PolicyKind; title: string; blurb: string }> = [
  {
    kind: 'delete_versions',
    title: 'Delete old versions',
    blurb: 'Deletes historic versions of large files. The current version is not touched.',
  },
  {
    kind: 'archive_files',
    title: 'Archive to Blob Cold',
    blurb: 'Moves inactive files to Azure and leaves a link in place.',
  },
  {
    kind: 'purge_recycle',
    title: 'Empty recycle bins',
    blurb: 'Permanently deletes recycle bin items older than N days.',
  },
  {
    kind: 'version_limit',
    title: 'Limit versions (preventive)',
    blurb: 'Sets how many versions each library keeps from now on.',
  },
];

export function defaultDefinition(kind: V2PolicyKind): Record<string, unknown> {
  switch (kind) {
    case 'delete_versions':
      return {
        kind,
        scope: {},
        minVersionsBytes: 1,
        minFileSizeBytes: 100 * MB,
        keepLatest: 5,
        olderThanDays: null,
      };
    case 'archive_files':
      return {
        kind,
        scope: {},
        minSizeBytes: 50 * MB,
        notModifiedDays: 365,
        notAccessedDays: null,
      };
    case 'purge_recycle':
      return { kind, scope: {}, olderThanDays: 30, stage: 'both' };
    case 'version_limit':
      return { kind, scope: {}, majorVersionLimit: 50 };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function mbFromBytes(bytes: number): number {
  return Math.round((bytes / MB) * 100) / 100;
}

function bytesFromMb(mb: number): number {
  return Math.round(mb * MB);
}

function normalizeExt(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  return t.startsWith('.') ? t : `.${t}`;
}

function selectionId(row: V2SimulationPreview, kind: V2PolicyKind): number | null {
  if (kind === 'purge_recycle') return row.siteId;
  if (kind === 'version_limit') return row.libraryId;
  return row.fileId;
}

function countNoun(kind: V2PolicyKind): string {
  if (kind === 'purge_recycle') return 'recycle bins';
  if (kind === 'version_limit') return 'libraries';
  return 'files';
}

function siteLibrary(row: V2SimulationPreview): string {
  const site = row.siteTitle || `site ${row.siteId}`;
  if (row.libraryTitle) return `${site} › ${row.libraryTitle}`;
  return site;
}

export interface PolicyBuilderProps {
  mode: 'lab' | 'policy';
  definition: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Lab: create run with selected targets. Policy: save / create plan. */
  onCreateLabRun?: (payload: {
    definition: Record<string, unknown>;
    fileIds?: number[];
    siteIds?: number[];
  }) => void;
  labRunPending?: boolean;
  onSavePolicy?: () => void;
  onCreatePlan?: () => void;
  savePending?: boolean;
  planPending?: boolean;
}

export function PolicyBuilder({
  mode,
  definition,
  onChange,
  onCreateLabRun,
  labRunPending,
  onSavePolicy,
  onCreatePlan,
  savePending,
  planPending,
}: PolicyBuilderProps) {
  const kind = (definition.kind as V2PolicyKind) ?? 'delete_versions';
  const scope = (definition.scope as { siteIds?: number[]; extensions?: string[]; libraryIds?: number[] }) ?? {};
  const selectedSites = scope.siteIds ?? [];
  const extensions = scope.extensions ?? [];

  const [scopeMode, setScopeMode] = useState<'tenant' | 'sites'>(
    selectedSites.length > 0 ? 'sites' : 'tenant',
  );
  const [siteSearch, setSiteSearch] = useState('');
  const [extInput, setExtInput] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [accessEnabled, setAccessEnabled] = useState(definition.notAccessedDays != null);
  const [bySiteOpen, setBySiteOpen] = useState(true);
  const [selected, setSelected] = useState<number[]>([]);
  const [debouncedDef, setDebouncedDef] = useState(definition);

  const sites = useV2Sites({ search: siteSearch || undefined, pageSize: 20, sort: 'name', dir: 'asc' });
  const audit = useV2Audit();

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedDef(definition), 700);
    return () => window.clearTimeout(t);
  }, [definition]);

  useEffect(() => {
    setSelected([]);
  }, [kind]);

  useEffect(() => {
    if (kind === 'delete_versions' && Number(definition.minVersionsBytes) !== 1) {
      onChange({ ...definition, minVersionsBytes: 1 });
    }
    if (kind === 'purge_recycle' && definition.stage !== 'both') {
      onChange({ ...definition, stage: 'both' });
    }
  }, [kind, definition.minVersionsBytes, definition.stage]); // eslint-disable-line react-hooks/exhaustive-deps

  const simulate = useQuery({
    queryKey: ['v2', 'simulate', debouncedDef] as const,
    queryFn: () =>
      apiPost<V2SimulationResponse>('/v2/policies/simulate', {
        definition: debouncedDef,
        previewSize: 200,
      }),
    staleTime: 30_000,
    retry: false,
  });

  const patch = (partial: Record<string, unknown>) => onChange({ ...definition, ...partial, kind });
  const patchScope = (partial: Record<string, unknown>) =>
    onChange({ ...definition, kind, scope: { ...scope, ...partial } });

  const setKind = (next: V2PolicyKind) => {
    onChange(defaultDefinition(next));
    setScopeMode('tenant');
    setAccessEnabled(false);
    setAdvancedOpen(false);
  };

  const coverageDays = (() => {
    const from = audit.data?.coverageFrom ? new Date(audit.data.coverageFrom) : null;
    const to = audit.data?.coverageTo ? new Date(audit.data.coverageTo) : new Date();
    if (!from || Number.isNaN(from.getTime())) return null;
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
  })();

  const accessBlocked =
    accessEnabled &&
    (coverageDays == null ||
      (typeof definition.notAccessedDays === 'number' &&
        definition.notAccessedDays > (coverageDays ?? 0)));

  const sim = simulate.data;
  const simError =
    simulate.error instanceof ApiClientError
      ? simulate.error.message
      : simulate.isError
        ? 'Could not simulate'
        : null;

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 20) return prev;
      return [...prev, id];
    });
  };

  const createLab = () => {
    if (!onCreateLabRun || selected.length === 0) return;
    if (kind === 'purge_recycle') {
      onCreateLabRun({ definition, siteIds: selected });
    } else if (kind === 'version_limit') {
      onCreateLabRun({
        definition: {
          ...definition,
          scope: { ...scope, libraryIds: selected },
        },
      });
    } else {
      onCreateLabRun({ definition, fileIds: selected });
    }
  };

  const preview = sim?.preview ?? [];

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">1. What do you want to do?</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {KIND_CARDS.map((c) => {
            const active = kind === c.kind;
            return (
              <button
                key={c.kind}
                type="button"
                onClick={() => setKind(c.kind)}
                className={`rounded-xl border p-4 text-left transition ${
                  active
                    ? 'border-accent bg-accent/5 ring-1 ring-accent'
                    : 'border-border bg-card hover:border-accent/40'
                }`}
              >
                <div className="font-medium text-ink">{c.title}</div>
                <p className="mt-1 text-sm text-muted">{c.blurb}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">2. Where?</h2>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={scopeMode === 'tenant'}
              onChange={() => {
                setScopeMode('tenant');
                patchScope({ siteIds: undefined });
              }}
            />
            Entire tenant
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={scopeMode === 'sites'}
              onChange={() => setScopeMode('sites')}
            />
            These sites
          </label>
        </div>
        {scopeMode === 'sites' ? (
          <div className="space-y-2">
            {selectedSites.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {selectedSites.map((id) => {
                  const title =
                    (sites.data?.items ?? []).find((s) => s.id === id)?.title ||
                    `Site #${id}`;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="rounded-full border border-border bg-bg px-2.5 py-0.5 text-xs hover:border-danger"
                      onClick={() => {
                        const next = selectedSites.filter((x) => x !== id);
                        patchScope({ siteIds: next.length ? next : undefined });
                        if (!next.length) setScopeMode('tenant');
                      }}
                    >
                      {title} ×
                    </button>
                  );
                })}
              </div>
            ) : null}
            <input
              type="search"
              className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-sm"
              placeholder="Search sites…"
              value={siteSearch}
              onChange={(e) => setSiteSearch(e.target.value)}
            />
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2 text-sm">
              {(sites.data?.items ?? []).map((s) => {
                const checked = selectedSites.includes(s.id);
                return (
                  <label key={s.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? selectedSites.filter((id) => id !== s.id)
                          : [...selectedSites, s.id];
                        patchScope({ siteIds: next.length ? next : undefined });
                      }}
                    />
                    <span>{s.title || s.url}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {kind === 'delete_versions' || kind === 'archive_files' ? (
          <div className="space-y-2">
            <div className="text-sm text-muted">Extensions</div>
            <p className="text-xs text-muted">Leave empty to include all types</p>
            {extensions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {extensions.map((ext) => (
                  <button
                    key={ext}
                    type="button"
                    className="rounded-full border border-border bg-bg px-2.5 py-0.5 text-xs"
                    onClick={() =>
                      patchScope({
                        extensions: extensions.filter((e) => e !== ext),
                      })
                    }
                  >
                    {ext} ×
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex gap-2">
              <input
                className="w-40 rounded-lg border border-border bg-bg px-2 py-1.5 text-sm"
                placeholder=".mp4"
                value={extInput}
                onChange={(e) => setExtInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const ext = normalizeExt(extInput);
                    if (ext && !extensions.includes(ext)) {
                      patchScope({ extensions: [...extensions, ext] });
                    }
                    setExtInput('');
                  }
                }}
              />
              <button
                type="button"
                className="rounded-lg border border-border px-2 py-1 text-sm hover:bg-bg"
                onClick={() => {
                  const ext = normalizeExt(extInput);
                  if (ext && !extensions.includes(ext)) {
                    patchScope({ extensions: [...extensions, ext] });
                  }
                  setExtInput('');
                }}
              >
                Add
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-ink">3. Which files?</h2>

        {kind === 'delete_versions' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-muted">Files larger than (MB)</span>
              <input
                type="number"
                min={0}
                className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
                value={mbFromBytes(Number(definition.minFileSizeBytes ?? 0))}
                onChange={(e) => patch({ minFileSizeBytes: bytesFromMb(Number(e.target.value) || 0) })}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Keep latest versions</span>
              <input
                type="number"
                min={0}
                className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
                value={Number(definition.keepLatest ?? 5)}
                onChange={(e) => patch({ keepLatest: Number(e.target.value) || 0 })}
              />
            </label>
            <div className="sm:col-span-2">
              <button
                type="button"
                className="text-sm text-accent hover:underline"
                onClick={() => setAdvancedOpen((o) => !o)}
              >
                {advancedOpen ? '▾' : '▸'} Advanced options
              </button>
              {advancedOpen ? (
                <label className="mt-2 block text-sm">
                  <span className="text-muted">Only versions older than (days; empty = any age)</span>
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full max-w-xs rounded-lg border border-border bg-bg px-2 py-1.5"
                    value={definition.olderThanDays == null ? '' : Number(definition.olderThanDays)}
                    onChange={(e) =>
                      patch({
                        olderThanDays: e.target.value === '' ? null : Number(e.target.value) || 0,
                      })
                    }
                  />
                </label>
              ) : null}
            </div>
          </div>
        ) : null}

        {kind === 'archive_files' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-muted">Files larger than (MB)</span>
              <input
                type="number"
                min={0}
                className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
                value={mbFromBytes(Number(definition.minSizeBytes ?? 0))}
                onChange={(e) => patch({ minSizeBytes: bytesFromMb(Number(e.target.value) || 0) })}
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Unmodified for (days)</span>
              <input
                type="number"
                min={0}
                className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
                value={Number(definition.notModifiedDays ?? 365)}
                onChange={(e) => patch({ notModifiedDays: Number(e.target.value) || 0 })}
              />
            </label>
            <div className="sm:col-span-2 space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={accessEnabled}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setAccessEnabled(on);
                    patch({ notAccessedDays: on ? 365 : null });
                  }}
                />
                Not opened for N days
              </label>
              {coverageDays != null ? (
                <p className="text-xs text-muted">
                  Audit covers {formatNumber(coverageDays)} days
                  {audit.data?.coverageFrom
                    ? ` (since ${formatAbsoluteDate(audit.data.coverageFrom)})`
                    : ''}
                  .
                </p>
              ) : (
                <p className="text-xs text-muted">No access audit coverage yet.</p>
              )}
              {accessEnabled ? (
                <input
                  type="number"
                  min={0}
                  disabled={coverageDays == null}
                  className="w-full max-w-xs rounded-lg border border-border bg-bg px-2 py-1.5 text-sm disabled:opacity-50"
                  value={Number(definition.notAccessedDays ?? 365)}
                  onChange={(e) => patch({ notAccessedDays: Number(e.target.value) || 0 })}
                  title={
                    coverageDays == null
                      ? 'Without audit coverage you cannot filter by last access'
                      : undefined
                  }
                />
              ) : null}
              {accessBlocked ? (
                <p className="text-xs text-danger">
                  The filter exceeds available audit coverage; lower it or wait for loading to finish.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {kind === 'purge_recycle' ? (
          <div className="space-y-2">
            <label className="block text-sm">
              <span className="text-muted">Items deleted more than (days) ago</span>
              <input
                type="number"
                min={0}
                className="mt-1 w-full max-w-xs rounded-lg border border-border bg-bg px-2 py-1.5"
                value={Number(definition.olderThanDays ?? 30)}
                onChange={(e) => patch({ olderThanDays: Number(e.target.value) || 0, stage: 'both' })}
              />
            </label>
            <p className="max-w-xl text-xs text-muted">
              SharePoint has two recycle bins: the site bin and the second-stage bin (where first-stage empties go). Both
              use quota; both are emptied.
            </p>
          </div>
        ) : null}

        {kind === 'version_limit' ? (
          <div className="space-y-2">
            <label className="block text-sm">
              <span className="text-muted">Keep at most (versions)</span>
              <input
                type="number"
                min={1}
                className="mt-1 w-full max-w-xs rounded-lg border border-border bg-bg px-2 py-1.5"
                value={Number(definition.majorVersionLimit ?? 50)}
                onChange={(e) => patch({ majorVersionLimit: Number(e.target.value) || 1 })}
              />
            </label>
            <p className="max-w-xl text-xs text-muted">
              Does not delete today; SharePoint applies the limit the next time each file is edited.
            </p>
          </div>
        ) : null}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-ink">4. Result</h2>

        {simulate.isFetching ? (
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-10 w-72" />
            <TableSkeleton rows={4} />
            <p className="text-sm text-muted">
              Calculating… tenant-wide can take up to 30 seconds
            </p>
          </div>
        ) : null}

        {simError && !simulate.isFetching ? (
          <div className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
            {simError}
          </div>
        ) : null}

        {sim && !simulate.isFetching ? (
          <div className="space-y-4">
            <p className="text-2xl font-semibold text-ink">
              {formatNumber(sim.count)} {countNoun(kind)}
              {kind !== 'version_limit' ? (
                <>
                  {' '}
                  · {formatBytes(sim.bytes)} would be freed
                </>
              ) : null}
            </p>

            {sim.bySite.length > 0 ? (
              <div>
                <button
                  type="button"
                  className="mb-2 text-sm font-medium text-ink hover:underline"
                  onClick={() => setBySiteOpen((o) => !o)}
                >
                  {bySiteOpen ? '▾' : '▸'} By site
                </button>
                {bySiteOpen ? (
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted">
                        <th className="py-1">Site</th>
                        <th className="py-1">Count</th>
                        <th className="py-1">Bytes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sim.bySite.map((s) => (
                        <tr key={s.siteId} className="border-b border-border/60">
                          <td className="py-1">{s.title || `#${s.siteId}`}</td>
                          <td className="py-1">{formatNumber(s.count)}</td>
                          <td className="py-1">
                            <ByteText bytes={s.bytes} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            ) : null}

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-ink">Candidates</h3>
                {mode === 'lab' ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted">{selected.length}/20 selected</span>
                    <button
                      type="button"
                      className="rounded border border-border px-2 py-0.5 text-xs hover:bg-bg"
                      onClick={() => {
                        const ids = preview
                          .map((r) => selectionId(r, kind))
                          .filter((id): id is number => id != null)
                          .slice(0, 5);
                        setSelected(ids);
                      }}
                    >
                      Select first 5
                    </button>
                  </div>
                ) : null}
              </div>
              {sim.count > preview.length ? (
                <p className="mb-2 text-xs text-muted">
                  Showing top {preview.length} by impact of {formatNumber(sim.count)}
                </p>
              ) : null}
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-card text-muted">
                    <tr>
                      {mode === 'lab' ? <th className="px-2 py-2" /> : null}
                      {kind === 'purge_recycle' ? (
                        <>
                          <th className="px-3 py-2">Site</th>
                          <th className="px-3 py-2">Bytes</th>
                        </>
                      ) : kind === 'version_limit' ? (
                        <>
                          <th className="px-3 py-2">Library</th>
                          <th className="px-3 py-2">Current limit</th>
                        </>
                      ) : kind === 'archive_files' ? (
                        <>
                          <th className="px-3 py-2">File</th>
                          <th className="px-3 py-2">Location</th>
                          <th className="px-3 py-2">Size</th>
                          <th className="px-3 py-2">Modified</th>
                          <th className="px-3 py-2">Last access</th>
                        </>
                      ) : (
                        <>
                          <th className="px-3 py-2">File</th>
                          <th className="px-3 py-2">Location</th>
                          <th className="px-3 py-2">Current size</th>
                          <th className="px-3 py-2">Version</th>
                          <th className="px-3 py-2">To delete</th>
                          <th className="px-3 py-2">Freed</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => {
                      const id = selectionId(row, kind);
                      const checked = id != null && selected.includes(id);
                      return (
                        <tr key={`${row.targetUrl}-${i}`} className="border-t border-border">
                          {mode === 'lab' ? (
                            <td className="px-2 py-2">
                              <input
                                type="checkbox"
                                disabled={id == null || (!checked && selected.length >= 20)}
                                checked={checked}
                                onChange={() => id != null && toggleSelected(id)}
                              />
                            </td>
                          ) : null}
                          {kind === 'purge_recycle' ? (
                            <>
                              <td className="px-3 py-2">{row.siteTitle || `#${row.siteId}`}</td>
                              <td className="px-3 py-2">
                                <ByteText bytes={row.bytes} />
                              </td>
                            </>
                          ) : kind === 'version_limit' ? (
                            <>
                              <td className="px-3 py-2">{siteLibrary(row)}</td>
                              <td className="px-3 py-2">{row.versionLabel ?? '—'}</td>
                            </>
                          ) : kind === 'archive_files' ? (
                            <>
                              <td className="max-w-[12rem] truncate px-3 py-2">
                                {row.fileName || row.targetUrl}
                              </td>
                              <td className="px-3 py-2 text-muted">{siteLibrary(row)}</td>
                              <td className="px-3 py-2">
                                <ByteText bytes={row.sizeBytes ?? row.bytes} />
                              </td>
                              <td className="px-3 py-2">
                                {row.modifiedAt ? formatRelativeDate(row.modifiedAt) : '—'}
                              </td>
                              <td className="px-3 py-2">
                                {row.lastAccessAt ? formatRelativeDate(row.lastAccessAt) : 'no record'}
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="max-w-[12rem] truncate px-3 py-2">
                                {row.fileName || row.targetUrl}
                              </td>
                              <td className="px-3 py-2 text-muted">{siteLibrary(row)}</td>
                              <td className="px-3 py-2">
                                <ByteText bytes={row.sizeBytes ?? 0} />
                              </td>
                              <td className="px-3 py-2">{row.versionLabel ?? '—'}</td>
                              <td className="px-3 py-2">{row.versionsToDelete ?? '—'}</td>
                              <td className="px-3 py-2">
                                <ByteText bytes={row.bytes} />
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}

        {mode === 'lab' ? (
          <button
            type="button"
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={selected.length === 0 || labRunPending}
            onClick={createLab}
          >
            Create test with {selected.length} selected
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-bg"
              disabled={savePending}
              onClick={onSavePolicy}
            >
              Save policy
            </button>
            <button
              type="button"
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              disabled={planPending}
              onClick={onCreatePlan}
            >
              Create execution plan
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
