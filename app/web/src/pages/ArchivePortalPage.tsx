import { useParams } from 'react-router-dom';
import { useV2PortalFile } from '../api/v2.js';
import { ByteText } from '../components/ByteText.js';
import { PageSkeleton } from '../components/Skeleton.js';
import { formatAbsoluteDate } from '../lib/format.js';
import { ApiClientError } from '../api/client.js';

/** Minimal portal page for end users — no sidebar layout. */
export function ArchivePortalPage() {
  const id = Number(useParams().id);
  const { data, isLoading, isError, error } = useV2PortalFile(id);

  if (isLoading) return <PageSkeleton />;

  if (isError || !data) {
    const forbidden = error instanceof ApiClientError && error.code === 'FORBIDDEN';
    const message = forbidden
      ? 'You do not have permission to view this file. If you think this is a mistake, ask whoever shared it for access.'
      : error instanceof ApiClientError
        ? error.message
        : 'You do not have permission to view this file. If you think this is a mistake, ask whoever shared it for access.';
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-xl font-semibold text-ink">File unavailable</h1>
        <p className="mt-3 text-sm text-muted">{message}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <div className="mb-8 text-center">
        <div className="text-sm font-medium text-muted">SpoStorage</div>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{data.name}</h1>
        <p className="mt-2 text-sm text-muted">
          <ByteText bytes={data.sizeBytes} />
          {data.siteTitle ? ` · was in ${data.siteTitle}` : ''}
        </p>
        {data.archivedAt ? (
          <p className="mt-1 text-xs text-muted">Archived {formatAbsoluteDate(data.archivedAt)}</p>
        ) : null}
      </div>
      <div className="flex justify-center">
        <a
          href={`/api/v2/portal/${id}/download`}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
        >
          Download
        </a>
      </div>
      <p className="mt-6 text-center text-xs text-muted">{data.originalUrl}</p>
    </div>
  );
}
