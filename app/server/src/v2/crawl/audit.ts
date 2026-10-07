/**
 * L5 "last access": reads SharePoint file operations from the Microsoft 365 audit log through Graph
 * (security/auditLog/queries) and keeps, per file URL, the most recent human access.
 *
 * Recurring task 'audit-ingest' on target 'audit'. Backfill goes day by day from today back
 * auditBackfillDays (Microsoft keeps ~180 days); afterwards it re-reads the last day every few hours.
 * Up to MAX_IN_FLIGHT queries run in parallel on Microsoft's side; records are read in pages and the
 * cursor lives in the task payload, so restarts resume where they were.
 */
import { db } from '../db.js';
import type { TaskContext, TaskHandler } from '../engine/types.js';
import { getSetting, putSetting } from '../settings.js';
import { SpoError } from '../spo/client.js';

const GRAPH = 'https://graph.microsoft.com/beta/security/auditLog/queries';
const DAY = 86_400_000;
const MAX_IN_FLIGHT = 4;
const PAGES_PER_RUN = 25;
const BACKFILL_DAYS = 180;
const INCREMENTAL_EVERY_MS = 6 * 3_600_000;

/** Operations that mean a person opened, downloaded or changed the file. */
export const ACCESS_OPERATIONS = [
  'FileAccessed',
  'FileAccessedExtended',
  'FilePreviewed',
  'FileDownloaded',
  'FileSyncDownloadedFull',
  'FileModified',
  'FileModifiedExtended',
  'FileCopied',
];

export interface AuditWindow {
  start: string;
  end: string;
  kind: 'backfill' | 'incremental';
  queryId?: string;
  next?: string | null;
  records?: number;
  done?: boolean;
  failures?: number;
  /** When reading of this window started: access rows touched since then are applied to spo.files. */
  readSince?: string;
}

export interface AuditPayload {
  backfillCursor?: string; // end of the next backfill window
  backfillDone?: boolean;
  incrementalFrom?: string;
  windows?: AuditWindow[];
}

export interface AuditStatus {
  consented?: boolean;
  coverageFrom?: string | null; // every day from here to coverageTo has been read
  coverageTo?: string | null;
  records?: number;
  lastRunAt?: string;
  truncatedWindows?: number;
}

interface AuditRecord {
  createdDateTime?: string;
  operation?: string;
  objectId?: string;
  userPrincipalName?: string;
  userId?: string;
  auditData?: { ObjectId?: string; UserId?: string; CreationTime?: string };
}

function isServiceAccount(user: string): boolean {
  const u = user.toLowerCase();
  return !u || u === 'app@sharepoint' || u.includes('sharepoint\\system') || u.startsWith('app@') || !u.includes('@');
}

/** Server-relative, decoded path of an audit ObjectId (absolute URL). Null when it is not a file URL. */
export function auditPath(objectId: string | undefined): string | null {
  if (!objectId || !/^https:\/\//i.test(objectId)) return null;
  try {
    const u = new URL(objectId);
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep raw
    }
    return p.length > 800 ? null : p;
  } catch {
    return null;
  }
}

/** Collapses a page of records to the latest human access per URL. */
export function aggregateRecords(records: AuditRecord[]): Map<string, { at: string; user: string; op: string; events: number }> {
  const out = new Map<string, { at: string; user: string; op: string; events: number }>();
  for (const r of records) {
    const user = r.userPrincipalName || r.userId || r.auditData?.UserId || '';
    if (isServiceAccount(user)) continue;
    const path = auditPath(r.objectId || r.auditData?.ObjectId);
    const at = r.createdDateTime || r.auditData?.CreationTime;
    if (!path || !at) continue;
    const key = path.toLowerCase();
    const prev = out.get(key);
    if (!prev) out.set(key, { at, user, op: r.operation ?? '', events: 1 });
    else {
      prev.events += 1;
      if (at > prev.at) Object.assign(prev, { at, user, op: r.operation ?? prev.op });
    }
  }
  return out;
}

async function upsertAccess(rows: Map<string, { at: string; user: string; op: string; events: number }>, path: Map<string, string>): Promise<void> {
  if (rows.size === 0) return;
  const d = await db();
  const payload = [...rows.entries()].map(([key, v]) => ({
    url: path.get(key) ?? key,
    at: new Date(v.at).toISOString().replace('Z', ''),
    user: v.user.slice(0, 200),
    op: v.op.slice(0, 60),
    events: v.events,
  }));
  await d.execJson(
    `MERGE spo.file_access AS t
     USING (
       SELECT CAST(HASHBYTES('SHA2_256', LOWER(url)) AS BINARY(32)) AS url_hash, url, at, [user], op, events
       FROM OPENJSON(@json) WITH (url NVARCHAR(800), at DATETIME2(3), [user] NVARCHAR(200), op NVARCHAR(60), events INT)
     ) AS s ON t.url_hash = s.url_hash
     WHEN MATCHED THEN UPDATE SET
       events = t.events + s.events, updated_at = SYSUTCDATETIME(),
       last_access_at = CASE WHEN s.at > t.last_access_at THEN s.at ELSE t.last_access_at END,
       last_user = CASE WHEN s.at > t.last_access_at THEN s.[user] ELSE t.last_user END,
       last_operation = CASE WHEN s.at > t.last_access_at THEN s.op ELSE t.last_operation END
     WHEN NOT MATCHED THEN INSERT (url_hash, url, last_access_at, last_user, last_operation, events, updated_at)
       VALUES (s.url_hash, s.url, s.at, s.[user], s.op, s.events, SYSUTCDATETIME());`,
    payload,
  );
}

/** Copies newer access dates onto spo.files (join on the URL hash). */
export async function applyAccessToFiles(since: Date): Promise<number> {
  const d = await db();
  return d.exec(
    `UPDATE f SET last_access_at = a.last_access_at, last_access_source = N'audit'
     FROM spo.files f JOIN spo.file_access a ON a.url_hash = f.url_hash
     WHERE a.updated_at >= @since AND (f.last_access_at IS NULL OR f.last_access_at < a.last_access_at)`,
    { since },
  );
}

async function createQuery(ctx: TaskContext, w: AuditWindow): Promise<string> {
  const res = await ctx.spo.request<{ id: string }>(GRAPH, {
    method: 'POST',
    api: 'graph',
    signal: ctx.signal,
    body: {
      '@odata.type': '#microsoft.graph.security.auditLogQuery',
      displayName: `SpoStorage ${w.kind} ${w.start.slice(0, 10)}`,
      filterStartDateTime: w.start,
      filterEndDateTime: w.end,
      recordTypeFilters: ['sharePointFileOperation'],
      operationFilters: ACCESS_OPERATIONS,
    },
  });
  return res.id;
}

function nextWindows(payload: AuditPayload, now: Date, backfillDays: number): AuditWindow[] {
  const windows = payload.windows ?? [];
  const out: AuditWindow[] = [];
  const oldest = now.getTime() - backfillDays * DAY;
  while (windows.length + out.length < MAX_IN_FLIGHT && !payload.backfillDone) {
    const end = payload.backfillCursor ? new Date(payload.backfillCursor) : new Date(now.getTime() - 3_600_000);
    if (end.getTime() <= oldest) {
      payload.backfillDone = true;
      payload.incrementalFrom ??= new Date(now.getTime() - 3_600_000).toISOString();
      break;
    }
    const start = new Date(Math.max(oldest, end.getTime() - DAY));
    out.push({ start: start.toISOString(), end: end.toISOString(), kind: 'backfill' });
    payload.backfillCursor = start.toISOString();
    payload.incrementalFrom ??= end.toISOString();
  }
  if (payload.backfillDone || payload.incrementalFrom) {
    const from = new Date(payload.incrementalFrom ?? now.getTime());
    const hasIncremental = [...windows, ...out].some((w) => w.kind === 'incremental');
    if (!hasIncremental && now.getTime() - from.getTime() >= INCREMENTAL_EVERY_MS && windows.length + out.length < MAX_IN_FLIGHT) {
      // One day of overlap: late-arriving audit records are common; the max() merge makes it idempotent.
      const end = new Date(now.getTime() - 3_600_000);
      out.push({ start: new Date(from.getTime() - DAY).toISOString(), end: end.toISOString(), kind: 'incremental' });
      payload.incrementalFrom = end.toISOString();
    }
  }
  return out;
}

export const auditIngest: TaskHandler<AuditPayload | null> = async (ctx) => {
  const payload: AuditPayload = { windows: [], ...(ctx.payload ?? {}) };
  const status: AuditStatus = (await getSetting<AuditStatus>('audit.status')) ?? {};
  const now = new Date();
  const backfillDays = (await getSetting<number>('audit.backfillDays')) ?? BACKFILL_DAYS;

  payload.windows = [...(payload.windows ?? []), ...nextWindows(payload, now, backfillDays)];
  let moreToRead = false;
  let waiting = false;

  for (const w of payload.windows) {
    ctx.signal.throwIfAborted();
    if (w.done) continue;
    try {
      if (!w.queryId) {
        w.queryId = await createQuery(ctx, w);
        status.consented = true;
        waiting = true;
        continue;
      }
      if (w.next === undefined) {
        const q = await ctx.spo.request<{ status?: string }>(`${GRAPH}/${w.queryId}`, { api: 'graph', signal: ctx.signal });
        if (q.status === 'failed' || q.status === 'cancelled') {
          w.failures = (w.failures ?? 0) + 1;
          w.queryId = undefined;
          if (w.failures >= 5) {
            w.done = true;
            await ctx.event({ level: 'warn', kind: 'audit-window-failed', message: `Audit query for ${w.start.slice(0, 10)} failed 5 times; skipping.` });
          }
          continue;
        }
        if (q.status !== 'succeeded') {
          waiting = true;
          continue;
        }
        w.next = `${GRAPH}/${w.queryId}/records?$top=1000`;
      }
      // Read pages of a finished query.
      ctx.status(`Audit: reading access for ${w.start.slice(0, 10)} (${w.records ?? 0} records)`);
      w.readSince ??= new Date().toISOString();
      for (let i = 0; i < PAGES_PER_RUN && w.next; i++) {
        const page: { value?: AuditRecord[]; '@odata.nextLink'?: string } = await ctx.spo.request(w.next, { api: 'graph', signal: ctx.signal });
        const records = page.value ?? [];
        const agg = aggregateRecords(records);
        const paths = new Map<string, string>();
        for (const r of records) {
          const p = auditPath(r.objectId || r.auditData?.ObjectId);
          if (p) paths.set(p.toLowerCase(), p);
        }
        await upsertAccess(agg, paths);
        w.records = (w.records ?? 0) + records.length;
        status.records = (status.records ?? 0) + records.length;
        ctx.progress(records.length);
        w.next = page['@odata.nextLink'] ?? null;
      }
      if (w.next) {
        moreToRead = true;
        break; // keep executions short; the same window continues next time
      }
      w.done = true;
      const applied = await applyAccessToFiles(new Date(w.readSince!));
      ctx.progress(applied);
      // Graph keeps finished queries around; delete ours so they do not pile up.
      await ctx.spo.request(`${GRAPH}/${w.queryId}`, { method: 'DELETE', api: 'graph', signal: ctx.signal }).catch(() => undefined);
    } catch (err) {
      if (err instanceof SpoError && (err.status === 401 || err.status === 403)) {
        status.consented = false;
        await putSetting('audit.status', status);
        await ctx.event({ level: 'error', kind: 'audit-forbidden', message: `No permission to read audit log: ${err.message}`.slice(0, 1000) });
        return { outcome: 'again', afterMs: 6 * 3_600_000, payload };
      }
      throw err;
    }
  }

  // Coverage = contiguous finished backfill days from the newest one down.
  const backfill = payload.windows.filter((w) => w.kind === 'backfill');
  let coverageFrom = status.coverageFrom ?? null;
  for (const w of backfill) {
    if (!w.done) break;
    if (!coverageFrom || w.start < coverageFrom) coverageFrom = w.start;
    status.coverageTo ??= w.end;
  }
  status.coverageFrom = coverageFrom;
  for (const w of payload.windows) {
    if (w.done && (!status.coverageTo || w.end > status.coverageTo)) status.coverageTo = w.end;
  }
  // Drop finished windows at the head of the list (the order keeps coverage contiguous).
  while (payload.windows.length && payload.windows[0].done) payload.windows.shift();
  status.lastRunAt = now.toISOString();
  await putSetting('audit.status', status);

  const pending = payload.windows.length > 0;
  return {
    outcome: 'again',
    afterMs: moreToRead ? 0 : waiting || pending ? 60_000 : payload.backfillDone ? INCREMENTAL_EVERY_MS : 0,
    payload,
  };
};
