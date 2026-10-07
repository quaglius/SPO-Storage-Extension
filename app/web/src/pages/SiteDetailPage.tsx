import { createColumnHelper } from '@tanstack/react-table';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { V2LibraryDetail, V2TopFile } from '@spostorage/shared';
import { useV2Site } from '../api/v2.js';
import { ByteText } from '../components/ByteText.js';
import { ChartCard } from '../components/ChartCard.js';
import { DataTable } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { KpiTile } from '../components/KpiTile.js';
import { PercentBar } from '../components/PercentBar.js';
import { SiteFolderExplorer } from '../components/SiteFolderExplorer.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { formatNumber, formatPercent, formatRelativeDate } from '../lib/format.js';

const libHelper = createColumnHelper<V2LibraryDetail>();
const fileHelper = createColumnHelper<V2TopFile>();

const BASELINE_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'In progress',
  done: 'Done',
  failed: 'Error',
};

export function SiteDetailPage() {
  const { id } = useParams();
  const siteId = Number(id);
  const { data, isLoading, isError, error } = useV2Site(siteId);

  const libColumns = useMemo(
    () => [
      libHelper.accessor('title', { header: 'Library' }),
      libHelper.accessor('baselineState', {
        header: 'Crawl',
        cell: (info) => BASELINE_LABEL[info.getValue()] ?? info.getValue(),
      }),
      libHelper.accessor((r) => r.rollup?.totalBytes ?? r.metricsTotalBytes, {
        id: 'bytes',
        header: 'Bytes',
        cell: (info) =>
          info.getValue() != null ? <ByteText bytes={info.getValue() as number} /> : '—',
      }),
      libHelper.accessor((r) => r.rollup?.versionsBytes ?? null, {
        id: 'versions',
        header: 'Versions',
        cell: (info) =>
          info.getValue() != null ? <ByteText bytes={info.getValue() as number} /> : '—',
      }),
      libHelper.accessor('baselineDoneAt', {
        header: 'Baseline',
        cell: (info) => (info.getValue() ? formatRelativeDate(info.getValue()!) : '—'),
      }),
      libHelper.accessor('lastError', {
        header: 'Error',
        cell: (info) =>
          info.getValue() ? <span className="text-xs text-danger">{info.getValue()}</span> : '—',
      }),
    ],
    [],
  );

  const topColumns = useMemo(
    () => [
      fileHelper.accessor('name', {
        header: 'File',
        cell: (info) => (
          <div>
            <div className="font-medium text-ink">{info.getValue()}</div>
            <div className="text-xs text-muted">{info.row.original.libraryTitle}</div>
          </div>
        ),
      }),
      fileHelper.accessor('sizeBytes', {
        header: 'Size',
        cell: (info) => <ByteText bytes={info.getValue()} />,
      }),
      fileHelper.accessor('versionsBytes', {
        header: 'Versions',
        cell: (info) => <ByteText bytes={info.getValue()} />,
      }),
      fileHelper.accessor('modifiedAt', {
        header: 'Modified',
        cell: (info) => (info.getValue() ? formatRelativeDate(info.getValue()!) : '—'),
      }),
    ],
    [],
  );

  if (isLoading) return <PageSkeleton />;
  if (isError || !data) {
    return (
      <EmptyState
        title="Site not found"
        description={error instanceof Error ? error.message : 'No data for this site.'}
        action={
          <Link to="/sites" className="text-accent hover:underline">
            Back to sites
          </Link>
        }
      />
    );
  }

  const pct = (data.percent ?? 0) * 100;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/sites" className="text-sm text-accent hover:underline">
          ← Sites
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{data.title || data.url}</h1>
        <p className="mt-1 text-sm text-muted">{data.url}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="SPO usage"
          value={data.usedBytes != null ? <ByteText bytes={data.usedBytes} /> : '—'}
        />
        <KpiTile label="Reconciled" value={<ByteText bytes={data.explainedBytes} />} />
        <KpiTile
          label="Coverage"
          value={data.percent != null ? formatPercent(pct, 1) : '—'}
          footer={<PercentBar value={pct} warnAt={90} dangerAt={98} />}
        />
        <KpiTile label="Versiones" value={<ByteText bytes={data.versionsBytes} />} />
      </div>

      <ChartCard title="Folders" subtitle="Browse libraries and folders on this site">
        <SiteFolderExplorer siteId={data.id} />
      </ChartCard>

      {data.recycleBin ? (
        <ChartCard title="Recycle bin" subtitle={`Measured ${formatRelativeDate(data.recycleBin.capturedAt)}`}>
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              Stage 1: <ByteText bytes={data.recycleBin.firstStageBytes} /> (
              {formatNumber(data.recycleBin.firstStageItems)} items)
            </div>
            <div>
              Stage 2: <ByteText bytes={data.recycleBin.secondStageBytes} /> (
              {formatNumber(data.recycleBin.secondStageItems)} items)
            </div>
          </div>
        </ChartCard>
      ) : null}

      <ChartCard title="Libraries">
        {data.libraries.length === 0 ? (
          <EmptyState title="No measurements yet" description="No libraries inventoried yet." />
        ) : (
          <DataTable data={data.libraries} columns={libColumns} pageSize={25} searchPlaceholder="Search library…" />
        )}
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="TOP 20 by historic versions">
          {data.topFilesByVersions.length === 0 ? (
            <EmptyState title="No measurements yet" />
          ) : (
            <DataTable data={data.topFilesByVersions} columns={topColumns} pageSize={20} />
          )}
        </ChartCard>
        <ChartCard title="TOP 20 by size">
          {data.topFilesBySize.length === 0 ? (
            <EmptyState title="No measurements yet" />
          ) : (
            <DataTable data={data.topFilesBySize} columns={topColumns} pageSize={20} />
          )}
        </ChartCard>
      </div>
    </div>
  );
}
