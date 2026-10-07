/**
 * L0 + L1: tenant quota/usage and every site's usage (docs/DECISIONS.md 2026-09-24, phase-0 probes).
 * Recurring task 'tenant-usage' on target 'tenant'.
 */
import { db, sqlDate } from '../db.js';
import type { TaskHandler } from '../engine/types.js';
import { getEngineSettings, putSetting } from '../settings.js';

const MB = 1024 * 1024;
const AGGREGATED_LIST = 'DO_NOT_DELETE_SPLIST_TENANTADMIN_AGGREGATED_SITECOLLECTIONS';

interface StorageQuotaRow {
  GeoUsedStorageMB?: string;
  GeoUsedVersionSizeStorageMB?: string;
  TenantStorageMB?: string;
}

interface AggregatedSiteRow {
  SiteUrl?: string;
  Title?: string;
  StorageUsed?: string | number;
  StorageQuota?: string | number;
  NumOfFiles?: string | number;
  LastActivityOn?: string;
  TemplateName?: string;
  SiteId?: string;
  State?: string | number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isPersonal(url: string): boolean {
  return /-my\.sharepoint\.com/i.test(url) || /\/personal\//i.test(url);
}

export const tenantUsage: TaskHandler = async (ctx) => {
  const settings = await getEngineSettings();
  const { spo } = ctx;
  ctx.status('Reading tenant quota and usage');

  const quotas = await spo.get<{ value: StorageQuotaRow[] }>(
    `${spo.adminUrl}/_api/StorageQuotas()?api-version=1.3.2`,
    ctx.signal,
  );
  const q = quotas?.value?.[0] ?? {};
  const usedBytes = num(q.GeoUsedStorageMB) !== null ? num(q.GeoUsedStorageMB)! * MB : null;
  const versionsBytes = num(q.GeoUsedVersionSizeStorageMB) !== null ? num(q.GeoUsedVersionSizeStorageMB)! * MB : null;
  const quotaBytes = num(q.TenantStorageMB) !== null ? num(q.TenantStorageMB)! * MB : null;

  ctx.status('Reading usage for each site');
  const rows: AggregatedSiteRow[] = [];
  let url: string | null =
    `${spo.adminUrl}/_api/web/lists/GetByTitle('${AGGREGATED_LIST}')/items?$top=5000` +
    `&$select=SiteUrl,Title,StorageUsed,StorageQuota,NumOfFiles,LastActivityOn,TemplateName,SiteId,State`;
  while (url) {
    const page: { value: AggregatedSiteRow[]; 'odata.nextLink'?: string } = await spo.get(url, ctx.signal);
    rows.push(...(page.value ?? []));
    url = page['odata.nextLink'] ?? null;
  }
  const sites = rows
    .filter((r) => r.SiteUrl && !isPersonal(r.SiteUrl))
    .map((r) => ({
      url: r.SiteUrl!.replace(/\/$/, ''),
      title: r.Title ?? null,
      template: r.TemplateName ?? null,
      isGroup: /^GROUP#/i.test(r.TemplateName ?? '') ? 1 : 0,
      state: r.State === undefined || r.State === null ? null : String(r.State),
      used: num(r.StorageUsed),
      quota: num(r.StorageQuota), // the aggregated list reports bytes (StorageUsed too)
      files: num(r.NumOfFiles),
      lastActivity: sqlDate(r.LastActivityOn),
      siteGuid: r.SiteId && /^[0-9a-f-]{36}$/i.test(r.SiteId.replace(/[{}]/g, '')) ? r.SiteId.replace(/[{}]/g, '') : null,
    }));

  const d = await db();
  const now = new Date();
  await d.execJson(
    `MERGE spo.sites AS t
     USING (
       SELECT * FROM OPENJSON(@json) WITH (
         url NVARCHAR(400), title NVARCHAR(400), template NVARCHAR(80), isGroup BIT, state NVARCHAR(40),
         used BIGINT, quota BIGINT, files BIGINT, lastActivity DATETIME2(3), siteGuid UNIQUEIDENTIFIER)
     ) AS s ON t.url = s.url
     WHEN MATCHED THEN UPDATE SET
       title = s.title, template = s.template, is_group = s.isGroup, state = s.state,
       storage_used_bytes = s.used, storage_quota_bytes = s.quota, spo_file_count = s.files,
       last_activity_at = s.lastActivity, site_guid = COALESCE(s.siteGuid, t.site_guid),
       usage_captured_at = @now, last_seen_at = @now, deleted_at = NULL
     WHEN NOT MATCHED THEN INSERT
       (url, title, template, is_group, state, storage_used_bytes, storage_quota_bytes, spo_file_count,
        last_activity_at, site_guid, usage_captured_at, first_seen_at, last_seen_at)
       VALUES (s.url, s.title, s.template, s.isGroup, s.state, s.used, s.quota, s.files,
        s.lastActivity, s.siteGuid, @now, @now, @now);`,
    sites,
    { now },
  );
  // Sites that vanished from the admin list (deleted or moved to the recycle bin of sites).
  // Guard against a truncated listing wiping the inventory.
  const active = await d.one<{ c: number }>(`SELECT COUNT(*) AS c FROM spo.sites WHERE deleted_at IS NULL`);
  if (sites.length >= (active?.c ?? 0) * 0.8) {
    await d.exec(`UPDATE spo.sites SET deleted_at = @now WHERE deleted_at IS NULL AND last_seen_at < @now`, { now });
  } else {
    await ctx.event({
      level: 'warn',
      kind: 'sites-list-short',
      message: `Admin site list returned ${sites.length} sites (previously ${active?.c}); no sites marked removed.`,
    });
  }

  const sumUsed = sites.reduce((a, s) => a + (s.used ?? 0), 0);
  const sumFiles = sites.reduce((a, s) => a + (s.files ?? 0), 0);
  await d.exec(
    `INSERT INTO spo.tenant_snapshots (captured_at, quota_bytes, used_bytes, sites_count, spo_file_count, source)
     VALUES (@now, @quota, @used, @count, @files, N'SharePoint Admin (StorageQuotas + sites)')`,
    { now, quota: quotaBytes, used: usedBytes ?? sumUsed, count: sites.length, files: sumFiles },
  );
  await putSetting('tenant.lastUsage', {
    capturedAt: now.toISOString(),
    usedBytes: usedBytes ?? sumUsed,
    versionsBytes,
    quotaBytes,
    sitesUsedBytes: sumUsed,
  });

  ctx.progress(sites.length);
  return { outcome: 'again', afterMs: settings.tenantUsageIntervalMinutes * 60_000 };
};
