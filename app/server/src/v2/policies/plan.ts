/**
 * Turns a policy definition into concrete targets. The same WHERE clause backs the simulation (aggregate +
 * preview, nothing written) and the plan (rows in spo.policy_actions with status 'planned').
 * Only metadata in spo.* is used: nothing here talks to SharePoint.
 */
import { db, type Params } from '../db.js';
import { getSetting } from '../settings.js';
import type { PolicyDefinition } from './definitions.js';

interface Built {
  from: string;
  where: string[];
  params: Params;
  /** SQL expression for the estimated bytes freed per target row. */
  bytes: string;
  targetUrl: string;
  action: string;
  select: { siteId: string; libraryId: string; fileId: string };
  /** Extra preview columns (file facts, versions to delete); NULLs for non-file kinds. */
  detail: string;
  /** Drop targets that would free nothing. */
  positiveOnly: boolean;
}

function scopeWhere(def: PolicyDefinition, alias: { site: string; library?: string; file?: string }, params: Params): string[] {
  const w: string[] = [];
  const s = def.scope ?? {};
  if (s.siteIds?.length) {
    params.siteIds = JSON.stringify(s.siteIds);
    w.push(`${alias.site}.id IN (SELECT CAST(value AS INT) FROM OPENJSON(@siteIds))`);
  }
  if (s.excludeSiteIds?.length) {
    params.excludeSiteIds = JSON.stringify(s.excludeSiteIds);
    w.push(`${alias.site}.id NOT IN (SELECT CAST(value AS INT) FROM OPENJSON(@excludeSiteIds))`);
  }
  if (s.libraryIds?.length && alias.library) {
    params.libraryIds = JSON.stringify(s.libraryIds);
    w.push(`${alias.library}.id IN (SELECT CAST(value AS INT) FROM OPENJSON(@libraryIds))`);
  }
  if (alias.file) {
    if (s.extensions?.length) {
      params.extensions = JSON.stringify(s.extensions.map((e) => e.toLowerCase()));
      w.push(`${alias.file}.extension IN (SELECT value FROM OPENJSON(@extensions))`);
    }
    if (s.excludeExtensions?.length) {
      params.excludeExtensions = JSON.stringify(s.excludeExtensions.map((e) => e.toLowerCase()));
      w.push(`(${alias.file}.extension IS NULL OR ${alias.file}.extension NOT IN (SELECT value FROM OPENJSON(@excludeExtensions)))`);
    }
    if (s.fileIds?.length) {
      params.fileIds = JSON.stringify(s.fileIds);
      w.push(`${alias.file}.id IN (SELECT CAST(value AS BIGINT) FROM OPENJSON(@fileIds))`);
    }
  }
  w.push(`${alias.site}.deleted_at IS NULL`, `${alias.site}.excluded = 0`);
  if (alias.library) w.push(`${alias.library}.deleted_at IS NULL`);
  return w;
}

function build(def: PolicyDefinition): Built {
  const params: Params = {};
  switch (def.kind) {
    case 'delete_versions': {
      params.minVersions = def.minVersionsBytes;
      params.minSize = def.minFileSizeBytes;
      params.keep = def.keepLatest;
      params.older = def.olderThanDays;
      const where = [
        'f.deleted_at IS NULL',
        'f.versions_bytes >= @minVersions',
        'f.size_bytes >= @minSize',
        'l.hidden = 0', // never touch Preservation Hold Library or system libraries
        ...scopeWhere(def, { site: 's', library: 'l', file: 'f' }, params),
      ];
      // Precise when version detail exists (files ≥ heavy threshold). Otherwise estimated from the major version
      // (N.0 → N-1 historic majors of similar size): versions_bytes × (historic - keep) / historic.
      const hasDetail = 'EXISTS (SELECT 1 FROM spo.file_versions v0 WHERE v0.file_id = f.id)';
      const picked = `(SELECT x.size_bytes FROM (
            SELECT v.size_bytes, v.created_at, ROW_NUMBER() OVER (ORDER BY v.version_id DESC) AS rn
            FROM spo.file_versions v WHERE v.file_id = f.id) x
          WHERE x.rn > @keep AND (@older IS NULL OR x.created_at < DATEADD(day, -CAST(@older AS INT), SYSUTCDATETIME())))`;
      const historic = "(TRY_CAST(LEFT(f.version_label, CHARINDEX('.', f.version_label + '.') - 1) AS INT) - 1)";
      const bytes = `CASE WHEN ${hasDetail} THEN ISNULL((SELECT SUM(p.size_bytes) FROM ${picked} p), 0)
          WHEN ${historic} IS NULL THEN f.versions_bytes
          WHEN ${historic} > @keep THEN f.versions_bytes * (${historic} - @keep) / ${historic}
          ELSE 0 END`;
      const versionsToDelete = `CASE WHEN ${hasDetail} THEN (SELECT COUNT(*) FROM ${picked} p)
          WHEN ${historic} > @keep THEN ${historic} - @keep ELSE 0 END`;
      return {
        from: 'spo.files f JOIN spo.libraries l ON l.id = f.library_id JOIN spo.sites s ON s.id = f.site_id',
        where,
        params,
        bytes,
        targetUrl: 'f.server_relative_url',
        action: 'delete_versions',
        select: { siteId: 's.id', libraryId: 'l.id', fileId: 'f.id' },
        detail: `${`f.name AS fileName, f.extension AS extension, l.title AS libraryTitle, f.size_bytes AS sizeBytes, f.versions_bytes AS versionsBytes, f.version_label AS versionLabel, f.modified_at AS modifiedAt, f.last_access_at AS lastAccessAt`}, ${versionsToDelete} AS versionsToDelete`,
        positiveOnly: true,
      };
    }
    case 'archive_files': {
      params.minSize = def.minSizeBytes;
      params.notModified = def.notModifiedDays;
      const where = [
        'f.deleted_at IS NULL',
        'f.archived_id IS NULL',
        'f.size_bytes >= @minSize',
        'f.modified_at < DATEADD(day, -@notModified, SYSUTCDATETIME())',
        // never archive our own links or system/page libraries
        "f.extension NOT IN (N'.url', N'.aspx')",
        'l.hidden = 0',
        'l.base_template = 101',
        ...scopeWhere(def, { site: 's', library: 'l', file: 'f' }, params),
      ];
      if (def.notAccessedDays !== null) {
        params.notAccessed = def.notAccessedDays;
        // No audit record within a fully covered window means nobody opened it (checked by assertAuditCoverage).
        where.push('(f.last_access_at IS NULL OR f.last_access_at < DATEADD(day, -@notAccessed, SYSUTCDATETIME()))');
      }
      return {
        from: 'spo.files f JOIN spo.libraries l ON l.id = f.library_id JOIN spo.sites s ON s.id = f.site_id',
        where,
        params,
        bytes: 'COALESCE(f.total_bytes, f.size_bytes)',
        targetUrl: 'f.server_relative_url',
        action: 'archive_file',
        select: { siteId: 's.id', libraryId: 'l.id', fileId: 'f.id' },
        detail: `${`f.name AS fileName, f.extension AS extension, l.title AS libraryTitle, f.size_bytes AS sizeBytes, f.versions_bytes AS versionsBytes, f.version_label AS versionLabel, f.modified_at AS modifiedAt, f.last_access_at AS lastAccessAt`}, CAST(NULL AS INT) AS versionsToDelete`,
        positiveOnly: true,
      };
    }
    case 'purge_recycle': {
      const stageBytes =
        def.stage === 'first' ? 'r.first_stage_bytes' : def.stage === 'second' ? 'r.second_stage_bytes' : '(r.first_stage_bytes + r.second_stage_bytes)';
      return {
        from: 'spo.recycle_bin r JOIN spo.sites s ON s.id = r.site_id',
        where: [`${stageBytes} > 0`, ...scopeWhere(def, { site: 's' }, params)],
        params,
        bytes: stageBytes, // upper bound: the age filter is applied at execution
        targetUrl: 's.url',
        action: 'purge_recycle',
        select: { siteId: 's.id', libraryId: 'NULL', fileId: 'NULL' },
        detail: `${`CAST(NULL AS NVARCHAR(400)) AS fileName, CAST(NULL AS NVARCHAR(40)) AS extension, CAST(NULL AS NVARCHAR(400)) AS libraryTitle, CAST(NULL AS BIGINT) AS sizeBytes, CAST(NULL AS BIGINT) AS versionsBytes, CAST(NULL AS NVARCHAR(20)) AS versionLabel, CAST(NULL AS DATETIME2(3)) AS modifiedAt, CAST(NULL AS DATETIME2(3)) AS lastAccessAt`}, CAST(NULL AS INT) AS versionsToDelete`,
        positiveOnly: false,
      };
    }
    case 'version_limit': {
      params.limit = def.majorVersionLimit;
      return {
        from: 'spo.libraries l JOIN spo.sites s ON s.id = l.site_id',
        where: [
          'l.base_template = 101',
          'l.hidden = 0',
          '(l.major_version_limit IS NULL OR l.major_version_limit > @limit OR l.versioning_enabled = 0)',
          ...scopeWhere(def, { site: 's', library: 'l' }, params),
        ],
        params,
        bytes: '0',
        targetUrl: 'l.root_url',
        action: 'set_version_limit',
        select: { siteId: 's.id', libraryId: 'l.id', fileId: 'NULL' },
        detail: `CAST(NULL AS NVARCHAR(400)) AS fileName, CAST(NULL AS NVARCHAR(40)) AS extension, l.title AS libraryTitle,
          CAST(NULL AS BIGINT) AS sizeBytes, CAST(NULL AS BIGINT) AS versionsBytes, CAST(l.major_version_limit AS NVARCHAR(20)) AS versionLabel,
          CAST(NULL AS DATETIME2(3)) AS modifiedAt, CAST(NULL AS DATETIME2(3)) AS lastAccessAt, CAST(NULL AS INT) AS versionsToDelete`,
        positiveOnly: false,
      };
    }
  }
}

/** A policy that cannot be planned yet; the message is shown to the user as-is. */
export class PolicyPlanError extends Error {
  readonly code = 'POLICY_NOT_READY';
  readonly statusCode = 400;
}

/** "Not accessed for N days" is only meaningful when the audit log has been read for those N days. */
export async function assertAuditCoverage(def: PolicyDefinition, now = new Date()): Promise<void> {
  if (def.kind !== 'archive_files' || def.notAccessedDays === null) return;
  const status = await getSetting<{ coverageFrom?: string | null }>('audit.status');
  const cutoff = new Date(now.getTime() - def.notAccessedDays * 86_400_000);
  const from = status?.coverageFrom ? new Date(status.coverageFrom) : null;
  if (!from || from.getTime() > cutoff.getTime() + 86_400_000) {
    throw new PolicyPlanError(
      from
        ? `Access audit coverage starts on ${from.toISOString().slice(0, 10)}; does not yet reach ${def.notAccessedDays} days. Use a lower value or wait for ingestion to finish.`
        : 'Access audit is still loading: last-access filtering is not available yet.',
    );
  }
}

/** Base rowset shared by simulate and materialize. Aggregates run over it (T-SQL cannot SUM a subquery). */
function baseQuery(b: Built): string {
  const inner = `SELECT ${b.select.siteId} AS siteId, s.title AS siteTitle, ${b.select.libraryId} AS libraryId,
                 ${b.select.fileId} AS fileId, ${b.targetUrl} AS targetUrl, CAST(${b.bytes} AS BIGINT) AS bytes, ${b.detail}
          FROM ${b.from} WHERE ${b.where.join(' AND ')}`;
  return b.positiveOnly ? `SELECT * FROM (${inner}) p0 WHERE p0.bytes > 0` : inner;
}

export interface SimulationPreviewRow {
  siteId: number;
  siteTitle: string | null;
  libraryId: number | null;
  libraryTitle: string | null;
  fileId: number | null;
  fileName: string | null;
  extension: string | null;
  targetUrl: string;
  /** Estimated bytes freed. */
  bytes: number;
  sizeBytes: number | null;
  versionsBytes: number | null;
  versionLabel: string | null;
  versionsToDelete: number | null;
  modifiedAt: string | null;
  lastAccessAt: string | null;
}

export interface Simulation {
  count: number;
  bytes: number;
  bySite: Array<{ siteId: number; title: string | null; count: number; bytes: number }>;
  preview: SimulationPreviewRow[];
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isoOrNull = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Two passes over the matching set: per-site totals (all sites) and the top previewSize targets. */
export async function simulate(def: PolicyDefinition, previewSize = 50): Promise<Simulation> {
  await assertAuditCoverage(def);
  const b = build(def);
  const d = await db();
  const base = baseQuery(b);
  const bySite = await d.all<{ siteId: number; title: string | null; count: number; bytes: number | null }>(
    `SELECT t.siteId, MAX(t.siteTitle) AS title, COUNT_BIG(*) AS count, SUM(t.bytes) AS bytes
     FROM (${base}) t GROUP BY t.siteId ORDER BY bytes DESC`,
    b.params,
  );
  const preview = await d.all<Record<string, unknown>>(
    `SELECT TOP (${Math.max(1, Math.min(500, previewSize))}) t.* FROM (${base}) t ORDER BY t.bytes DESC`,
    b.params,
  );
  const sites = bySite.map((r) => ({ siteId: Number(r.siteId), title: r.title, count: Number(r.count), bytes: Number(r.bytes ?? 0) }));
  return {
    count: sites.reduce((acc, r) => acc + r.count, 0),
    bytes: sites.reduce((acc, r) => acc + r.bytes, 0),
    bySite: sites,
    preview: preview.map((r) => ({
      siteId: Number(r.siteId),
      siteTitle: (r.siteTitle as string | null) ?? null,
      libraryId: numOrNull(r.libraryId),
      libraryTitle: (r.libraryTitle as string | null) ?? null,
      fileId: numOrNull(r.fileId),
      fileName: (r.fileName as string | null) ?? null,
      extension: (r.extension as string | null) ?? null,
      targetUrl: String(r.targetUrl),
      bytes: Number(r.bytes ?? 0),
      sizeBytes: numOrNull(r.sizeBytes),
      versionsBytes: numOrNull(r.versionsBytes),
      versionLabel: (r.versionLabel as string | null) ?? null,
      versionsToDelete: numOrNull(r.versionsToDelete),
      modifiedAt: isoOrNull(r.modifiedAt),
      lastAccessAt: isoOrNull(r.lastAccessAt),
    })),
  };
}

/** Writes the plan of a run into spo.policy_actions and returns totals. */
export async function materializePlan(runId: number, def: PolicyDefinition): Promise<{ count: number; bytes: number }> {
  await assertAuditCoverage(def);
  const b = build(def);
  const d = await db();
  await d.exec(
    `INSERT INTO spo.policy_actions (run_id, site_id, library_id, file_id, target_url, action, bytes, status)
     SELECT @runId, t.siteId, t.libraryId, t.fileId, t.targetUrl, N'${b.action}', ISNULL(t.bytes, 0), N'planned'
     FROM (${baseQuery(b)}) t`,
    { ...b.params, runId },
  );
  const totals = await d.one<{ c: number; bytes: number | null }>(
    `SELECT COUNT_BIG(*) AS c, SUM(bytes) AS bytes FROM spo.policy_actions WHERE run_id = @runId`,
    { runId },
  );
  const count = Number(totals?.c ?? 0);
  const bytes = Number(totals?.bytes ?? 0);
  await d.exec(`UPDATE spo.policy_runs SET planned_count = @count, planned_bytes = @bytes WHERE id = @runId`, { runId, count, bytes });
  return { count, bytes };
}
