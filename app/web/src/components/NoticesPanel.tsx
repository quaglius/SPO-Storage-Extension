import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { V2Notice } from '@spostorage/shared';
import { useV2Notices } from '../api/v2.js';

const LEVEL_STYLES: Record<V2Notice['level'], string> = {
  info: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100',
  warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
  error: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100',
};

function Notice({ notice }: { notice: V2Notice }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-xl border p-4 ${LEVEL_STYLES[notice.level]}`}>
      <div className="font-medium">{notice.title}</div>
      <p className="mt-1 text-sm leading-relaxed">{notice.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {notice.links.map((l) => (
          <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="font-medium underline">
            {l.label} ↗
          </a>
        ))}
        {notice.sites.length > 0 && (
          <button type="button" className="underline" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide sites' : `View all ${notice.sites.length} sites`}
          </button>
        )}
      </div>
      {open && notice.sites.length > 0 && (
        <ul className="mt-3 max-h-72 space-y-1 overflow-auto text-sm">
          {notice.sites.map((s) => (
            <li key={s.siteId} className="flex justify-between gap-3">
              <Link to={`/sites/${s.siteId}`} className="truncate underline">
                {s.title ?? s.url}
              </Link>
              <span className="shrink-0 opacity-80">{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Warnings that need someone to act outside the app (Purview, Entra). */
export function NoticesPanel() {
  const { data } = useV2Notices();
  if (!data || data.notices.length === 0) return null;
  return (
    <section aria-label="Notices" className="space-y-3">
      {data.notices.map((n) => (
        <Notice key={n.id} notice={n} />
      ))}
    </section>
  );
}
