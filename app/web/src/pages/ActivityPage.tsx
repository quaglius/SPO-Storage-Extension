import { createColumnHelper } from '@tanstack/react-table';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { V2EventListItem, V2PolicyRun, V2TaskListItem } from '@spostorage/shared';
import { useV2Events, useV2RetryFailed, useV2Runs, useV2Tasks } from '../api/v2.js';
import { ByteText } from '../components/ByteText.js';
import { DataTable } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { formatAbsoluteDate, formatRelativeDate } from '../lib/format.js';

const eventHelper = createColumnHelper<V2EventListItem>();
const taskHelper = createColumnHelper<V2TaskListItem>();
const runHelper = createColumnHelper<V2PolicyRun>();

const LEVEL_CLASS = {
  info: 'text-muted',
  warn: 'text-warn',
  error: 'text-danger',
} as const;

type Tab = 'events' | 'tasks' | 'runs';

export function ActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab =
    tabParam === 'tasks' || tabParam === 'tareas' ? 'tasks' : tabParam === 'runs' || tabParam === 'corridas' ? 'runs' : 'events';
  const level = searchParams.get('level') ?? '';
  const page = Number(searchParams.get('page') ?? '1');

  const events = useV2Events({
    level: level || undefined,
    page,
    pageSize: 50,
  });
  const tasks = useV2Tasks({ state: 'failed', page, pageSize: 50 });
  const runs = useV2Runs({ page });
  const retry = useV2RetryFailed();

  const eventColumns = useMemo(
    () => [
      eventHelper.accessor('at', {
        header: 'When',
        cell: (info) => formatRelativeDate(info.getValue()),
      }),
      eventHelper.accessor('level', {
        header: 'Level',
        cell: (info) => (
          <span className={`font-medium uppercase ${LEVEL_CLASS[info.getValue()]}`}>{info.getValue()}</span>
        ),
      }),
      eventHelper.accessor('kind', { header: 'Type' }),
      eventHelper.accessor('message', { header: 'Message' }),
      eventHelper.accessor('siteTitle', {
        header: 'Site',
        cell: (info) => info.getValue() || '—',
      }),
    ],
    [],
  );

  const taskColumns = useMemo(
    () => [
      taskHelper.accessor('kind', { header: 'Type' }),
      taskHelper.accessor('targetKey', { header: 'Target' }),
      taskHelper.accessor('siteTitle', {
        header: 'Site',
        cell: (info) => info.getValue() || '—',
      }),
      taskHelper.accessor('libraryTitle', {
        header: 'Library',
        cell: (info) => info.getValue() || '—',
      }),
      taskHelper.accessor('attempts', { header: 'Attempts' }),
      taskHelper.accessor('lastError', {
        header: 'Error',
        cell: (info) => <span className="text-xs text-danger">{info.getValue() || '—'}</span>,
      }),
      taskHelper.accessor('updatedAt', {
        header: 'Updated',
        cell: (info) => formatRelativeDate(info.getValue()),
      }),
    ],
    [],
  );

  const runColumns = useMemo(
    () => [
      runHelper.accessor('id', {
        header: 'Id',
        cell: (info) => (
          <Link className="text-accent hover:underline" to={`/runs/${info.getValue()}`}>
            #{info.getValue()}
          </Link>
        ),
      }),
      runHelper.accessor('scope', { header: 'Scope' }),
      runHelper.accessor('status', { header: 'Status' }),
      runHelper.accessor('policyName', {
        header: 'Policy',
        cell: (info) => info.getValue() || '—',
      }),
      runHelper.accessor('plannedCount', {
        header: 'Planned',
        cell: (info) => (
          <span>
            {info.getValue() ?? 0} · <ByteText bytes={info.row.original.plannedBytes ?? 0} />
          </span>
        ),
      }),
      runHelper.accessor('createdAt', {
        header: 'Created',
        cell: (info) => (info.getValue() ? formatAbsoluteDate(info.getValue()!) : '—'),
      }),
    ],
    [],
  );

  const setTab = (next: Tab) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'events') p.delete('tab');
      else p.set('tab', next);
      p.set('page', '1');
      return p;
    });
  };

  const loading =
    (tab === 'events' && events.isLoading && !events.data) ||
    (tab === 'tasks' && tasks.isLoading && !tasks.data) ||
    (tab === 'runs' && runs.isLoading && !runs.data);
  if (loading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Activity</h1>
        <p className="mt-1 text-sm text-muted">Engine events, failed tasks, and policy runs.</p>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {(
          [
            ['events', 'Events'],
            ['tasks', 'Failed tasks'],
            ['runs', 'Runs'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === key ? 'bg-accent/10 text-accent' : 'text-muted'}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'events' ? (
        <>
          <div className="flex flex-wrap gap-3">
            <select
              className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
              value={level}
              onChange={(e) =>
                setSearchParams((prev) => {
                  const p = new URLSearchParams(prev);
                  if (e.target.value) p.set('level', e.target.value);
                  else p.delete('level');
                  p.set('page', '1');
                  return p;
                })
              }
            >
              <option value="">All levels</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
          </div>
          {!events.data || events.data.items.length === 0 ? (
            <EmptyState title="No measurements yet" description="Engine events will appear here." />
          ) : (
            <DataTable data={events.data.items} columns={eventColumns} pageSize={50} />
          )}
        </>
      ) : null}

      {tab === 'tasks' ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
              disabled={retry.isPending || !tasks.data?.total}
              onClick={() => retry.mutate()}
            >
              Retry {tasks.data?.total ?? 0} failed tasks
            </button>
          </div>
          {!tasks.data || tasks.data.items.length === 0 ? (
            <EmptyState title="No failed tasks" description="No failures pending retry." />
          ) : (
            <DataTable data={tasks.data.items} columns={taskColumns} pageSize={50} />
          )}
        </>
      ) : null}

      {tab === 'runs' ? (
        !runs.data || runs.data.items.length === 0 ? (
          <EmptyState title="No runs" description="Policy and lab runs will appear here." />
        ) : (
          <DataTable data={runs.data.items} columns={runColumns} pageSize={50} />
        )
      ) : null}
    </div>
  );
}
