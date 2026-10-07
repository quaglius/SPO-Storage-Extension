import { createColumnHelper } from '@tanstack/react-table';
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { V2SiteListItem } from '@spostorage/shared';
import { useV2Sites } from '../api/v2.js';
import { ByteText } from '../components/ByteText.js';
import { DataTable } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { PercentBar } from '../components/PercentBar.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { formatPercent, formatRelativeDate } from '../lib/format.js';

const columnHelper = createColumnHelper<V2SiteListItem>();

export function SitesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Number(searchParams.get('page') ?? '1');
  const sort = searchParams.get('sort') ?? 'used';
  const dir = (searchParams.get('dir') ?? 'desc') as 'asc' | 'desc';
  const search = searchParams.get('search') ?? '';

  const { data, isLoading, isError, error } = useV2Sites({
    search: search || undefined,
    sort,
    dir,
    page,
    pageSize: 50,
  });

  const columns = useMemo(
    () => [
      columnHelper.accessor('title', {
        header: 'Site',
        cell: (info) => (
          <Link to={`/sites/${info.row.original.id}`} className="font-medium text-accent hover:underline">
            {info.getValue() || info.row.original.url}
          </Link>
        ),
      }),
      columnHelper.accessor('usedBytes', {
        header: 'Usage',
        cell: (info) =>
          info.getValue() != null ? <ByteText bytes={info.getValue()!} /> : <span className="text-muted">—</span>,
      }),
      columnHelper.accessor('percent', {
        header: 'Reconciled',
        cell: (info) => {
          const pct = (info.getValue() ?? 0) * 100;
          return (
            <div className="min-w-[8rem]">
              <PercentBar value={pct} warnAt={90} dangerAt={98} />
              <div className="mt-1 text-xs text-muted">
                {info.getValue() != null ? formatPercent(pct, 1) : '—'} ·{' '}
                <ByteText bytes={info.row.original.explainedBytes} />
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('versionsBytes', {
        header: 'Versions',
        cell: (info) => <ByteText bytes={info.getValue()} />,
      }),
      columnHelper.accessor('olderThan365Bytes', {
        header: '> 1 year',
        cell: (info) => <ByteText bytes={info.getValue()} />,
      }),
      columnHelper.display({
        id: 'libraries',
        header: 'Libraries',
        cell: (info) => {
          const libs = info.row.original.libraries;
          return (
            <span>
              {libs.done}/{libs.total}
              {libs.failed > 0 ? <span className="ml-1 text-danger">({libs.failed} error)</span> : null}
            </span>
          );
        },
      }),
      columnHelper.accessor('accessState', {
        header: 'Access',
        cell: (info) => {
          const state = info.getValue();
          if (state === 'ok') return <span className="text-ok">ok</span>;
          if (state === 'denied') return <span className="text-danger">denied</span>;
          return <span className="text-muted">{state}</span>;
        },
      }),
      columnHelper.accessor('lastActivityAt', {
        header: 'Activity',
        cell: (info) =>
          info.getValue() ? (
            <span className="text-xs text-muted">{formatRelativeDate(info.getValue()!)}</span>
          ) : (
            '—'
          ),
      }),
    ],
    [],
  );

  if (isLoading && !data) return <PageSkeleton />;
  if (isError) {
    return (
      <EmptyState
        title="Could not load sites"
        description={error instanceof Error ? error.message : 'Unknown error'}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Sites</h1>
        <p className="mt-1 text-sm text-muted">
          {data ? `${data.total} sites` : null} · usage, reconciliation, and crawl progress
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
          placeholder="Search sites…"
          defaultValue={search}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const value = (e.target as HTMLInputElement).value;
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                if (value) next.set('search', value);
                else next.delete('search');
                next.set('page', '1');
                return next;
              });
            }
          }}
        />
        <select
          className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
          value={sort}
          onChange={(e) => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set('sort', e.target.value);
              next.set('page', '1');
              return next;
            });
          }}
        >
          <option value="used">Sort: usage</option>
          <option value="explained">Sort: reconciled</option>
          <option value="versions">Sort: versions</option>
          <option value="name">Sort: name</option>
        </select>
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-1.5 text-sm"
          onClick={() => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set('dir', dir === 'desc' ? 'asc' : 'desc');
              return next;
            });
          }}
        >
          {dir === 'desc' ? 'Descending' : 'Ascending'}
        </button>
      </div>

      {!data || data.items.length === 0 ? (
        <EmptyState
          title="No measurements yet"
          description="When the engine inventories sites, they will appear here."
        />
      ) : (
        <DataTable
          data={data.items}
          columns={columns}
          pageSize={50}
          emptyTitle="No measurements yet"
          onRowClick={(row) => navigate(`/sites/${row.id}`)}
          searchPlaceholder="Filter on this page…"
        />
      )}

      {data && data.total > data.pageSize ? (
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 disabled:opacity-40"
            disabled={page <= 1}
            onClick={() =>
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('page', String(page - 1));
                return next;
              })
            }
          >
            Previous
          </button>
          <span className="text-muted">
            Page {page} · {data.total} sites
          </span>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 disabled:opacity-40"
            disabled={page * data.pageSize >= data.total}
            onClick={() =>
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('page', String(page + 1));
                return next;
              })
            }
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
