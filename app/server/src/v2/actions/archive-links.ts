/**
 * Engine task 'archive-complete-links' (target 'links'): finishes archives whose .url link is still pending.
 * An admin launches it whenever they want (POST /api/v2/archive/links/complete); it makes ONE pass over the pending
 * rows (cursor in the task payload) and ends, so it can be launched again as often as needed:
 *  - state 'uploaded' / 'linked': the original is still in SharePoint → re-verify the blob and that the original is
 *    unchanged, create the link (or, if the site has no space, delete the original first), delete the original;
 *  - state 'original_deleted' with no link_url: only the link is created.
 * It never copies, rewrites or deletes blobs and never changes sha256, blob_path or acl_json of a row.
 */
import { db } from '../db.js';
import { enqueue } from '../engine/queue.js';
import type { TaskHandler } from '../engine/types.js';
import { fileTarget } from '../policies/run.js';
import { ARCHIVE_ROW_COLUMNS, completeArchive, setLinkError, type ArchiveRow } from './archive-link.js';
import { getArchiveSettings } from './blob.js';

const BATCH = 24;
const PARALLEL = 4;

/** Rows waiting for their link. A policy run that is copying the same file right now is left alone. */
export const PENDING_LINK_WHERE = `(a.state IN (N'uploaded', N'linked') OR (a.state = N'original_deleted' AND a.link_url IS NULL))
  AND NOT EXISTS (SELECT 1 FROM spo.policy_actions pa WHERE pa.file_id = a.file_id AND pa.action = N'archive_file' AND pa.status = N'running')`;

interface Pass {
  afterId: number;
  requestedBy: string | null;
  processed: number;
  linksCreated: number;
  originalsDeleted: number;
  stillPending: number;
  skipped: number;
  failed: number;
  freedBytes: number;
  blockedSites: number[];
}

const newPass = (requestedBy: string | null): Pass => ({
  afterId: 0,
  requestedBy,
  processed: 0,
  linksCreated: 0,
  originalsDeleted: 0,
  stillPending: 0,
  skipped: 0,
  failed: 0,
  freedBytes: 0,
  blockedSites: [],
});

/** False when a pass is already queued or running. */
export async function requestCompleteLinks(requestedBy: string): Promise<boolean> {
  return enqueue({ kind: 'archive-complete-links', targetKey: 'links', priority: 20, maxAttempts: 5, payload: newPass(requestedBy) });
}

export const archiveCompleteLinks: TaskHandler<Pass | null> = async (ctx) => {
  const d = await db();
  const pass: Pass = { ...newPass(null), ...(ctx.payload ?? {}) };
  const settings = await getArchiveSettings();
  const rows = await d.all<ArchiveRow & { site_url: string }>(
    `SELECT TOP (${BATCH}) ${ARCHIVE_ROW_COLUMNS}, s.url AS site_url
     FROM spo.archived_files a JOIN spo.sites s ON s.id = a.site_id
     WHERE a.id > @afterId AND ${PENDING_LINK_WHERE}
     ORDER BY a.id`,
    { afterId: pass.afterId },
  );

  if (rows.length === 0) {
    const by = pass.requestedBy ? ` (requested by ${pass.requestedBy})` : '';
    await ctx.event({
      level: pass.failed || pass.stillPending ? 'warn' : 'info',
      kind: 'archive-links-done',
      message:
        `Archive links pass finished${by}: ${pass.linksCreated} links created, ${pass.originalsDeleted} originals deleted, ` +
        `${pass.stillPending} still pending, ${pass.skipped} skipped for review, ${pass.failed} failed.`,
      data: pass,
    });
    return { outcome: 'done' };
  }

  const blocked = new Set(pass.blockedSites);
  const one = async (row: ArchiveRow & { site_url: string }) => {
    ctx.signal.throwIfAborted();
    ctx.status(`Completing archive links: ${row.name}`);
    try {
      const target = row.file_id ? await fileTarget(row.file_id) : null;
      const res = await completeArchive(ctx.spo, row, {
        portalBaseUrl: settings.portalBaseUrl,
        verify: 'basic',
        reverify: true,
        target,
        uniqueId: target?.uniqueId,
        siteUrl: row.site_url,
        siteBlocked: blocked.has(row.site_id),
        signal: ctx.signal,
      });
      if (res.noSpace) blocked.add(row.site_id);
      if (res.linked && row.link_url === null) pass.linksCreated += 1;
      if (res.deletedNow) {
        pass.originalsDeleted += 1;
        pass.freedBytes += res.outcome.bytes;
      }
      if (res.outcome.status === 'failed') pass.failed += 1;
      else if (res.outcome.status === 'skipped') pass.skipped += 1;
      if (!res.linked) pass.stillPending += 1;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      pass.failed += 1;
      pass.stillPending += 1;
      await setLinkError(row.id, (err as Error).message).catch(() => undefined);
    }
    pass.processed += 1;
    ctx.progress(1);
  };
  for (let i = 0; i < rows.length; i += PARALLEL) {
    await Promise.all(rows.slice(i, i + PARALLEL).map(one));
  }

  pass.afterId = Number(rows[rows.length - 1].id);
  pass.blockedSites = [...blocked];
  return { outcome: 'again', afterMs: 0, payload: pass };
};
