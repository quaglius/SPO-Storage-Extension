import { Link } from 'react-router-dom';
import { useV2DeletePolicy, useV2Policies } from '../api/v2.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { useToast } from '../app/toast.js';
import { formatAbsoluteDate } from '../lib/format.js';

export function PoliciesPage() {
  const { data, isLoading } = useV2Policies();
  const del = useV2DeletePolicy();
  const { pushToast } = useToast();

  if (isLoading && !data) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Policies</h1>
          <p className="mt-1 text-sm text-muted">Define, simulate, and run tenant cleanups.</p>
        </div>
        <Link
          to="/policies/new"
          className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          New
        </Link>
      </div>

      {!data?.items.length ? (
        <EmptyState
          title="No policies yet"
          description="Create the first one to simulate estimated savings."
        />
      ) : (
        <ul className="space-y-3">
          {data.items.map((p) => (
            <li key={p.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Link to={`/policies/${p.id}`} className="text-base font-semibold text-ink hover:underline">
                    {p.name}
                  </Link>
                  <p className="mt-1 text-sm text-muted">{p.kindLabel}</p>
                  <p className="mt-1 text-xs text-muted">
                    Updated {p.updatedAt ? formatAbsoluteDate(p.updatedAt) : '—'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link
                    to={`/policies/${p.id}`}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg"
                  >
                    Edit / simulate
                  </Link>
                  <button
                    type="button"
                    className="rounded-lg border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger/5"
                    onClick={() =>
                      void del.mutateAsync(p.id).then(() => pushToast('Policy deleted', 'success'))
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
