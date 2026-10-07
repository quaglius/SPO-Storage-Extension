/**
 * Site structure: every web (root + subwebs), every document library (hidden ones included, they count in
 * storage) and the recycle bin. Recurring task 'site-structure' on target 'site:<id>'.
 */
import { db } from '../db.js';
import type { TaskContext, TaskHandler } from '../engine/types.js';
import { getEngineSettings } from '../settings.js';
import { isAccessDenied, isNotFound } from '../spo/client.js';

interface WebInfo {
  Url: string;
  ServerRelativeUrl: string;
}

interface ListInfo {
  Id: string;
  Title: string;
  BaseTemplate: number;
  Hidden: boolean;
  ItemCount: number;
  EnableVersioning?: boolean;
  MajorVersionLimit?: number;
  RootFolder?: { ServerRelativeUrl: string };
}

interface RecycleItem {
  Size?: string | number;
  ItemState?: number;
  DeletedDate?: string;
}

async function listWebs(ctx: TaskContext, rootUrl: string, maxDepth: number): Promise<string[]> {
  const webs = [rootUrl];
  let frontier = [rootUrl];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const web of frontier) {
      try {
        const res = await ctx.spo.get<{ value: WebInfo[] }>(`${web}/_api/web/webs?$select=Url,ServerRelativeUrl`, ctx.signal);
        for (const w of res.value ?? []) next.push(w.Url.replace(/\/$/, ''));
      } catch (err) {
        if (isAccessDenied(err) || isNotFound(err)) continue; // a subweb we cannot read must not block the site
        throw err;
      }
    }
    webs.push(...next);
    frontier = next;
  }
  return webs;
}

async function readRecycleBin(ctx: TaskContext, siteUrl: string) {
  let first = 0;
  let firstItems = 0;
  let second = 0;
  let secondItems = 0;
  let oldest: string | null = null;
  let url: string | null = `${siteUrl}/_api/site/RecycleBin?$select=Size,ItemState,DeletedDate&$top=5000`;
  let pages = 0;
  while (url && pages < 200) {
    const res: { value: RecycleItem[]; 'odata.nextLink'?: string } = await ctx.spo.get(url, ctx.signal);
    for (const item of res.value ?? []) {
      const size = Number(item.Size ?? 0) || 0;
      if (item.ItemState === 2) {
        second += size;
        secondItems += 1;
      } else {
        first += size;
        firstItems += 1;
      }
      if (item.DeletedDate && (!oldest || item.DeletedDate < oldest)) oldest = item.DeletedDate;
    }
    url = res['odata.nextLink'] ?? null;
    pages += 1;
  }
  return { first, firstItems, second, secondItems, oldest };
}

export const siteStructure: TaskHandler = async (ctx) => {
  const settings = await getEngineSettings();
  const d = await db();
  const siteId = ctx.task.site_id;
  const site = await d.one<{ id: number; url: string; title: string | null; excluded: boolean; deleted_at: Date | null }>(
    `SELECT id, url, title, excluded, deleted_at FROM spo.sites WHERE id = @siteId`,
    { siteId },
  );
  if (!site || site.deleted_at || site.excluded) return { outcome: 'done' };
  ctx.status(`Reading libraries for ${site.title ?? site.url}`);

  let webs: string[];
  try {
    webs = await listWebs(ctx, site.url, settings.maxSubwebDepth);
  } catch (err) {
    if (isAccessDenied(err) || isNotFound(err)) {
      await d.exec(
        `UPDATE spo.sites SET access_state = N'denied', access_error = @error WHERE id = @siteId`,
        { siteId, error: (err as Error).message.slice(0, 1000) },
      );
      await ctx.event({
        level: 'warn',
        kind: 'site-denied',
        message: `No access to site ${site.title ?? site.url}: ${(err as Error).message}`.slice(0, 1000),
      });
      return { outcome: 'again', afterMs: 24 * 3_600_000 };
    }
    throw err;
  }

  const libraries: Array<Record<string, unknown>> = [];
  for (const web of webs) {
    let lists: ListInfo[];
    try {
      const res = await ctx.spo.get<{ value: ListInfo[] }>(
        `${web}/_api/web/lists?$select=Id,Title,BaseTemplate,Hidden,ItemCount,EnableVersioning,MajorVersionLimit,RootFolder/ServerRelativeUrl` +
          `&$expand=RootFolder&$filter=BaseType eq 1`,
        ctx.signal,
      );
      lists = res.value ?? [];
    } catch (err) {
      if (isAccessDenied(err) || isNotFound(err)) continue;
      throw err;
    }
    for (const l of lists) {
      libraries.push({
        webUrl: web,
        listGuid: l.Id,
        title: l.Title,
        rootUrl: l.RootFolder?.ServerRelativeUrl ?? '',
        baseTemplate: l.BaseTemplate,
        hidden: l.Hidden ? 1 : 0,
        itemCount: l.ItemCount,
        versioning: l.EnableVersioning === undefined ? null : l.EnableVersioning ? 1 : 0,
        majorLimit: l.MajorVersionLimit ?? null,
      });
    }
  }

  const now = new Date();
  await d.execJson(
    `MERGE spo.libraries AS t
     USING (
       SELECT * FROM OPENJSON(@json) WITH (
         webUrl NVARCHAR(600), listGuid UNIQUEIDENTIFIER, title NVARCHAR(400), rootUrl NVARCHAR(800),
         baseTemplate INT, hidden BIT, itemCount INT, versioning BIT, majorLimit INT)
     ) AS s ON t.site_id = @siteId AND t.list_guid = s.listGuid
     WHEN MATCHED THEN UPDATE SET
       web_url = s.webUrl, title = s.title, root_url = s.rootUrl, base_template = s.baseTemplate, hidden = s.hidden,
       item_count = s.itemCount, versioning_enabled = s.versioning, major_version_limit = s.majorLimit,
       last_seen_at = @now, deleted_at = NULL
     WHEN NOT MATCHED THEN INSERT
       (site_id, web_url, list_guid, title, root_url, base_template, hidden, item_count, versioning_enabled,
        major_version_limit, first_seen_at, last_seen_at)
       VALUES (@siteId, s.webUrl, s.listGuid, s.title, s.rootUrl, s.baseTemplate, s.hidden, s.itemCount, s.versioning,
        s.majorLimit, @now, @now);`,
    libraries,
    { siteId, now },
  );
  await d.exec(
    `UPDATE spo.libraries SET deleted_at = @now WHERE site_id = @siteId AND deleted_at IS NULL AND last_seen_at < @now`,
    { siteId, now },
  );

  try {
    ctx.status(`Reading recycle bin for ${site.title ?? site.url}`);
    const rb = await readRecycleBin(ctx, site.url);
    await d.exec(
      `MERGE spo.recycle_bin AS t USING (SELECT @siteId AS site_id) AS s ON t.site_id = s.site_id
       WHEN MATCHED THEN UPDATE SET first_stage_bytes = @first, first_stage_items = @firstItems,
         second_stage_bytes = @second, second_stage_items = @secondItems, oldest_deleted_at = @oldest, captured_at = @now
       WHEN NOT MATCHED THEN INSERT (site_id, first_stage_bytes, first_stage_items, second_stage_bytes, second_stage_items, oldest_deleted_at, captured_at)
         VALUES (@siteId, @first, @firstItems, @second, @secondItems, @oldest, @now);`,
      { siteId, now, ...rb, oldest: rb.oldest ? new Date(rb.oldest) : null },
    );
  } catch (err) {
    if (!isAccessDenied(err)) throw err;
  }

  await d.exec(`UPDATE spo.sites SET access_state = N'ok', access_error = NULL WHERE id = @siteId`, { siteId });
  ctx.progress(libraries.length);
  return { outcome: 'again', afterMs: settings.siteStructureIntervalHours * 3_600_000 };
};
