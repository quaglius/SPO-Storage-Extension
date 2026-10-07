/**
 * L3: full, resumable pass over one library with RenderListDataAsStream (5.000 rows per page, SMTotalSize
 * includes historic versions). One page per task execution; the same task row cycles until the pass ends,
 * then waits libraryScanIntervalHours. A pass also detects deletions (files not seen since it started).
 * Recurring task 'library-scan' on target 'library:<id>'.
 */
import { randomUUID } from 'node:crypto';
import { db, sqlDate } from '../db.js';
import type { TaskContext, TaskHandler } from '../engine/types.js';
import { getEngineSettings } from '../settings.js';
import { isAccessDenied, isNotFound, SpoError } from '../spo/client.js';
import { computeLibraryRollup } from './rollup.js';

export interface LibraryScanPayload {
  runId?: string;
  startedAt?: string;
  next?: string | null;
  pages?: number;
  files?: number;
  rowLimit?: number;
}

interface LibraryRow {
  id: number;
  site_id: number;
  web_url: string;
  list_guid: string;
  title: string;
  item_count: number | null;
  crawl_mode: string;
  baseline_state: string;
  baseline_done_at: Date | null;
  deleted_at: Date | null;
  site_title: string | null;
  site_deleted: Date | null;
  site_excluded: boolean;
}

type Person = { title?: string; email?: string } | undefined;

interface RenderRow {
  ID?: string;
  FSObjType?: string;
  UniqueId?: string;
  FileRef?: string;
  FileLeafRef?: string;
  File_x0020_Type?: string;
  File_x0020_Size?: string;
  SMTotalSize?: string;
  'Modified.'?: string;
  'Created.'?: string;
  Editor?: Person[];
  Author?: Person[];
  _UIVersionString?: string;
  ScopeId?: string;
}

const FIELDS = [
  'ID',
  'FSObjType',
  'UniqueId',
  'FileRef',
  'FileLeafRef',
  'File_x0020_Type',
  'File_x0020_Size',
  'SMTotalSize',
  'Modified',
  'Created',
  'Editor',
  'Author',
  '_UIVersionString',
  'ScopeId',
];

export function buildViewXml(rowLimit: number): string {
  return (
    '<View Scope="RecursiveAll"><Query></Query><ViewFields>' +
    FIELDS.map((f) => `<FieldRef Name="${f}"/>`).join('') +
    `</ViewFields><RowLimit Paged="TRUE">${rowLimit}</RowLimit></View>`
  );
}

function guid(value: string | undefined): string | null {
  if (!value) return null;
  const g = value.replace(/[{}]/g, '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g) ? g.toLowerCase() : null;
}

function person(list: Person[] | undefined): string | null {
  const p = list?.[0];
  return (p?.email || p?.title || null)?.slice(0, 200) ?? null;
}

function extensionOf(name: string, type: string | undefined): string | null {
  if (type) return `.${type.toLowerCase()}`.slice(0, 40);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase().slice(0, 40) : null;
}

export function mapRenderRows(rows: RenderRow[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (String(r.FSObjType) !== '0') continue;
    const uniqueId = guid(r.UniqueId);
    if (!uniqueId || !r.FileRef) continue;
    const name = r.FileLeafRef ?? r.FileRef.split('/').pop() ?? '';
    const size = Number(r.File_x0020_Size ?? 0) || 0;
    const total = r.SMTotalSize === undefined || r.SMTotalSize === '' ? null : Number(r.SMTotalSize);
    out.push({
      uniqueId,
      itemId: r.ID ? Number(r.ID) : null,
      url: r.FileRef.slice(0, 800),
      name: name.slice(0, 400),
      ext: extensionOf(name, r.File_x0020_Type),
      size,
      total: total !== null && Number.isFinite(total) ? total : null,
      label: r._UIVersionString?.slice(0, 20) ?? null,
      created: sqlDate(r['Created.']),
      modified: sqlDate(r['Modified.']),
      author: person(r.Author),
      editor: person(r.Editor),
      scope: guid(r.ScopeId),
    });
  }
  return out;
}

export async function upsertFiles(libraryId: number, siteId: number, files: Array<Record<string, unknown>>, seenAt: Date): Promise<void> {
  if (files.length === 0) return;
  const d = await db();
  await d.execJson(
    `MERGE spo.files AS t
     USING (
       SELECT * FROM OPENJSON(@json) WITH (
         uniqueId UNIQUEIDENTIFIER, itemId INT, url NVARCHAR(800), name NVARCHAR(400), ext NVARCHAR(40),
         size BIGINT, total BIGINT, label NVARCHAR(20), created DATETIME2(3), modified DATETIME2(3),
         author NVARCHAR(200), editor NVARCHAR(200), scope UNIQUEIDENTIFIER)
     ) AS s ON t.library_id = @libraryId AND t.unique_id = s.uniqueId
     WHEN MATCHED THEN UPDATE SET
       list_item_id = s.itemId, server_relative_url = s.url, name = s.name, extension = s.ext,
       size_bytes = s.size, total_bytes = s.total, version_label = s.label, created_at = s.created,
       modified_at = s.modified, author = s.author, editor = s.editor, scope_id = s.scope,
       seen_at = @seenAt, deleted_at = NULL
     WHEN NOT MATCHED THEN INSERT
       (site_id, library_id, unique_id, list_item_id, server_relative_url, name, extension, size_bytes, total_bytes,
        version_label, created_at, modified_at, author, editor, scope_id, seen_at)
       VALUES (@siteId, @libraryId, s.uniqueId, s.itemId, s.url, s.name, s.ext, s.size, s.total,
        s.label, s.created, s.modified, s.author, s.editor, s.scope, @seenAt);`,
    files,
    { libraryId, siteId, seenAt },
  );
}

async function markLibrary(id: number, fields: Record<string, unknown>): Promise<void> {
  const d = await db();
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`);
  await d.exec(`UPDATE spo.libraries SET ${sets.join(', ')} WHERE id = @id`, { id, ...fields });
}

async function finishPass(ctx: TaskContext, lib: LibraryRow, payload: LibraryScanPayload, intervalMs: number) {
  const d = await db();
  const startedAt = payload.startedAt ? new Date(payload.startedAt) : new Date();
  const removed = await d.exec(
    `UPDATE spo.files SET deleted_at = SYSUTCDATETIME()
     WHERE library_id = @id AND deleted_at IS NULL AND seen_at < @startedAt`,
    { id: lib.id, startedAt },
  );
  await markLibrary(lib.id, {
    baseline_state: 'done',
    baseline_done_at: new Date(),
    baseline_cursor: null,
    item_count_files: payload.files ?? 0,
    last_error: null,
  });
  await computeLibraryRollup(lib.id);
  if (removed > 0) {
    await ctx.event({
      level: 'info',
      kind: 'files-removed',
      message: `${removed} files no longer exist in ${lib.title} (${lib.site_title ?? 'site'}).`,
    });
  }
  return { outcome: 'again' as const, afterMs: intervalMs, payload: {} };
}

export const libraryScan: TaskHandler<LibraryScanPayload | null> = async (ctx) => {
  const settings = await getEngineSettings();
  const intervalMs = settings.libraryScanIntervalHours * 3_600_000;
  const d = await db();
  const lib = await d.one<LibraryRow>(
    `SELECT l.id, l.site_id, l.web_url, l.list_guid, l.title, l.item_count, l.crawl_mode, l.baseline_state,
            l.baseline_done_at, l.deleted_at, s.title AS site_title, s.deleted_at AS site_deleted, s.excluded AS site_excluded
     FROM spo.libraries l JOIN spo.sites s ON s.id = l.site_id WHERE l.id = @id`,
    { id: ctx.task.library_id },
  );
  if (!lib || lib.deleted_at || lib.site_deleted || lib.site_excluded || lib.crawl_mode === 'skip') {
    return { outcome: 'done' };
  }

  let payload: LibraryScanPayload = ctx.payload ?? {};
  if (!payload.runId) {
    // Not in a pass: start one if due.
    const doneAt = lib.baseline_done_at ? new Date(lib.baseline_done_at).getTime() : 0;
    const dueIn = doneAt + intervalMs - Date.now();
    if (lib.baseline_state === 'done' && dueIn > 60_000) {
      return { outcome: 'again', afterMs: dueIn, payload: {} };
    }
    payload = { runId: randomUUID(), startedAt: new Date().toISOString(), next: null, pages: 0, files: 0, rowLimit: 5000 };
    await markLibrary(lib.id, { baseline_state: 'running', baseline_started_at: new Date(payload.startedAt!), baseline_run_id: payload.runId });
  }

  if ((lib.item_count ?? 0) === 0) {
    return finishPass(ctx, lib, payload, intervalMs);
  }

  const rowLimit = payload.rowLimit ?? 5000;
  ctx.status(`Crawling ${lib.title} on ${lib.site_title ?? 'site'} — page ${(payload.pages ?? 0) + 1}`);
  const endpoint = `${lib.web_url}/_api/web/lists(guid'${lib.list_guid}')/RenderListDataAsStream${payload.next ?? ''}`;
  let page: { Row?: RenderRow[]; NextHref?: string };
  try {
    page = await ctx.spo.post(endpoint, { parameters: { RenderOptions: 2, ViewXml: buildViewXml(rowLimit) } }, ctx.signal);
  } catch (err) {
    if (isAccessDenied(err) || isNotFound(err)) {
      await markLibrary(lib.id, { baseline_state: 'failed', last_error: (err as Error).message.slice(0, 2000) });
      await ctx.event({ level: 'warn', kind: 'library-unreadable', message: `Cannot read ${lib.title} (${lib.site_title}): ${(err as Error).message}`.slice(0, 1000) });
      return { outcome: 'again', afterMs: intervalMs, payload: {} };
    }
    // Big pages sometimes time out: halve the page size and keep going from the same cursor.
    const transient = err instanceof SpoError ? err.retryable || err.status === 0 : !ctx.signal.aborted;
    if (transient && rowLimit > 500) {
      await ctx.event({ level: 'warn', kind: 'page-shrunk', message: `Large page failed in ${lib.title}; retrying with ${Math.floor(rowLimit / 2)} rows.` });
      return { outcome: 'again', afterMs: 5_000, payload: { ...payload, rowLimit: Math.floor(rowLimit / 2) } };
    }
    throw err;
  }

  const files = mapRenderRows(page.Row ?? []);
  await upsertFiles(lib.id, lib.site_id, files, new Date());
  ctx.progress(files.length);
  const next: LibraryScanPayload = {
    ...payload,
    next: page.NextHref ?? null,
    pages: (payload.pages ?? 0) + 1,
    files: (payload.files ?? 0) + files.length,
  };
  if (!page.NextHref) {
    return finishPass(ctx, lib, next, intervalMs);
  }
  await markLibrary(lib.id, { baseline_cursor: page.NextHref.slice(0, 4000) });
  if ((next.pages ?? 0) % 10 === 0) await computeLibraryRollup(lib.id);
  return { outcome: 'again', afterMs: 0, payload: next };
};
