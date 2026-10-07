import { createColumnHelper } from '@tanstack/react-table';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { V2FileListItem } from '@spostorage/shared';
import { formatBytes } from '@spostorage/shared';
import { useV2Files } from '../api/v2.js';
import { ByteText } from '../components/ByteText.js';
import { DataTable } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { formatNumber, formatRelativeDate } from '../lib/format.js';

const columnHelper = createColumnHelper<V2FileListItem>();

function setParam(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}

export function FilesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Number(searchParams.get('page') ?? '1');
  const sort = searchParams.get('sort') ?? 'size';
  const siteId = searchParams.get('siteId') ?? '';
  const minSizeBytes = searchParams.get('minSizeBytes') ?? '';
  const minVersionsBytes = searchParams.get('minVersionsBytes') ?? '';
  const modifiedBefore = searchParams.get('modifiedBefore') ?? '';
  const extension = searchParams.get('extension') ?? '';
  const search = searchParams.get('search') ?? '';

  const query = {
    siteId: siteId ? Number(siteId) : undefined,
    minSizeBytes: minSizeBytes ? Number(minSizeBytes) : undefined,
    minVersionsBytes: minVersionsBytes ? Number(minVersionsBytes) : undefined,
    modifiedBefore: modifiedBefore || undefined,
    extension: extension || undefined,
    search: search || undefined,
    sort,
    page,
    pageSize: 50,
  };

  const { data, isLoading, isError, error } = useV2Files(query);

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'File',
        cell: (info) => (
          <div>
            <div className="font-medium text-ink">{info.getValue()}</div>
            <div className="text-xs text-muted">
              {info.row.original.siteId ? (
                <Link className="text-accent hover:underline" to={`/sites/${info.row.original.siteId}`}>
                  {info.row.original.siteTitle || `Site #${info.row.original.siteId}`}
                </Link>
              ) : (
                info.row.original.siteTitle || '—'
              )}{' '}
              · {info.row.original.libraryTitle}
            </div>
          </div>
        ),
      }),
      columnHelper.accessor('extension', {
        header: 'Ext',
        cell: (info) => info.getValue() || '—',
      }),
      columnHelper.accessor('sizeBytes', {
        header: 'Size',
        cell: (info) => <ByteText bytes={info.getValue()} />,
      }),
      columnHelper.accessor('versionsBytes', {
        header: 'Versions',
        cell: (info) => <ByteText bytes={info.getValue()} />,
      }),
      columnHelper.accessor('modifiedAt', {
        header: 'Modified',
        cell: (info) => (info.getValue() ? formatRelativeDate(info.getValue()!) : '—'),
      }),
      columnHelper.accessor('editor', {
        header: 'Editor',
        cell: (info) => info.getValue() || '—',
      }),
    ],
    [],
  );

  const update = (patch: Record<string, string>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) setParam(next, k, v);
      if (!('page' in patch)) next.set('page', '1');
      return next;
    });
  };

  if (isLoading && !data) return <PageSkeleton />;
  if (isError) {
    return (
      <EmptyState
        title="Could not load files"
        description={error instanceof Error ? error.message : 'Unknown error'}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Files</h1>
        <p className="mt-1 text-sm text-muted">
          {data
            ? `${formatNumber(data.total)} files · ${formatBytes(data.totalBytes)}`
            : 'Search with filters; folders are on each site detail page.'}
        </p>
      </div>

      <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm">
          <span className="text-muted">Site (id)</span>
          <input
            className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
            value={siteId}
            onChange={(e) => update({ siteId: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Minimum size (bytes)</span>
          <input
            className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
            value={minSizeBytes}
            onChange={(e) => update({ minSizeBytes: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Minimum versions (bytes)</span>
          <input
            className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
            value={minVersionsBytes}
            onChange={(e) => update({ minVersionsBytes: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Unmodified since (ISO)</span>
          <input
            className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
            value={modifiedBefore}
            onChange={(e) => update({ modifiedBefore: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Extensions (csv)</span>
          <input
            className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
            value={extension}
            onChange={(e) => update({ extension: e.target.value })}
            placeholder="docx,pdf"
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Name (prefix)</span>
          <input
            className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
            value={search}
            onChange={(e) => update({ search: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Sort</span>
          <select
            className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-1.5"
            value={sort}
            onChange={(e) => update({ sort: e.target.value })}
          >
            <option value="size">Size</option>
            <option value="versions">Versiones</option>
            <option value="modified">Modificado</option>
          </select>
        </label>
      </div>

      {!data || data.items.length === 0 ? (
        <EmptyState
          title="No measurements yet"
          description="No files match the filter (or the crawl has not reached L3 yet)."
        />
      ) : (
        <DataTable data={data.items} columns={columns} pageSize={50} searchPlaceholder="Filter on this page…" />
      )}

      {data && data.total > data.pageSize ? (
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => update({ page: String(page - 1) })}
          >
            Previous
          </button>
          <span className="text-muted">Page {page}</span>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 disabled:opacity-40"
            disabled={page * data.pageSize >= data.total}
            onClick={() => update({ page: String(page + 1) })}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
