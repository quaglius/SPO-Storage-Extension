import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  V2LibraryDetail,
  V2SiteDetailResponse,
  V2SiteListItem,
  V2SiteListResponse,
  V2TopFile,
} from '@spostorage/shared';
import { db, toIso } from '../db.js';
import { bool, num, numOrNull } from './coerce.js';

const listQuerySchema = z.object({
  search: z.string().optional().default(''),
  sort: z.enum(['used', 'explained', 'versions', 'name']).optional().default('used'),
  dir: z.enum(['asc', 'desc']).optional().default('desc'),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(200).optional().default(50),
});

function sortColumn(sort: string): string {
  switch (sort) {
    case 'explained':
      return 'explained_bytes';
    case 'versions':
      return 'versions_bytes';
    case 'name':
      return 'title';
    default:
      return 'used_bytes';
  }
}

export async function registerSiteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/sites', async (request, reply): Promise<V2SiteListResponse | void> => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid site parameters' },
      });
    }
    const { search, sort, dir, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;
    const orderCol = sortColumn(sort);
    const orderDir = dir === 'asc' ? 'ASC' : 'DESC';
    const searchPattern = search.trim() ? `%${search.trim()}%` : null;

    const d = await db();

    const countRow = await d.one<{ total: number }>(
      `SELECT COUNT_BIG(*) AS total
       FROM spo.sites s
       WHERE s.deleted_at IS NULL
         AND (@search IS NULL OR s.title LIKE @search OR s.url LIKE @search)`,
      { search: searchPattern },
    );

    const rows = await d.all<{
      id: number;
      url: string;
      title: string | null;
      template: string | null;
      used_bytes: number | null;
      file_count_declared: number | null;
      last_activity_at: Date | null;
      access_state: string;
      excluded: boolean | number;
      explained_bytes: number;
      versions_bytes: number;
      heavy_versions_bytes: number;
      older_than_365_bytes: number;
      lib_total: number;
      lib_done: number;
      lib_failed: number;
    }>(
      `SELECT * FROM (
         SELECT
           s.id, s.url, s.title, s.template,
           s.storage_used_bytes AS used_bytes,
           s.spo_file_count AS file_count_declared,
           s.last_activity_at, s.access_state, s.excluded,
           COALESCE(r.rollup_bytes, 0) + COALESCE(rb.first_stage_bytes, 0) + COALESCE(rb.second_stage_bytes, 0) AS explained_bytes,
           COALESCE(r.versions_bytes, 0) AS versions_bytes,
           COALESCE(r.heavy_versions_bytes, 0) AS heavy_versions_bytes,
           COALESCE(r.age_730_bytes, 0) + COALESCE(r.age_old_bytes, 0) AS older_than_365_bytes,
           COALESCE(l.lib_total, 0) AS lib_total,
           COALESCE(l.lib_done, 0) AS lib_done,
           COALESCE(l.lib_failed, 0) AS lib_failed
         FROM spo.sites s
         LEFT JOIN (
           SELECT site_id,
             SUM(total_bytes) AS rollup_bytes,
             SUM(versions_bytes) AS versions_bytes,
             SUM(heavy_versions_bytes) AS heavy_versions_bytes,
             SUM(age_730_bytes) AS age_730_bytes,
             SUM(age_old_bytes) AS age_old_bytes
           FROM spo.library_rollups
           GROUP BY site_id
         ) r ON r.site_id = s.id
         LEFT JOIN spo.recycle_bin rb ON rb.site_id = s.id
         LEFT JOIN (
           SELECT site_id,
             COUNT_BIG(*) AS lib_total,
             SUM(CASE WHEN baseline_state = N'done' THEN 1 ELSE 0 END) AS lib_done,
             SUM(CASE WHEN baseline_state = N'failed' THEN 1 ELSE 0 END) AS lib_failed
           FROM spo.libraries
           WHERE deleted_at IS NULL
           GROUP BY site_id
         ) l ON l.site_id = s.id
         WHERE s.deleted_at IS NULL
           AND (@search IS NULL OR s.title LIKE @search OR s.url LIKE @search)
       ) x
       ORDER BY ${orderCol} ${orderDir}, id ASC
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      { search: searchPattern, offset, pageSize },
    );

    const items: V2SiteListItem[] = rows.map((row) => {
      const used = numOrNull(row.used_bytes);
      const explained = num(row.explained_bytes);
      return {
        id: num(row.id),
        url: row.url,
        title: row.title,
        template: row.template,
        usedBytes: used,
        fileCountDeclared: numOrNull(row.file_count_declared),
        lastActivityAt: toIso(row.last_activity_at),
        accessState: row.access_state,
        excluded: bool(row.excluded),
        explainedBytes: explained,
        percent: used != null && used > 0 ? explained / used : null,
        versionsBytes: num(row.versions_bytes),
        heavyVersionsBytes: num(row.heavy_versions_bytes),
        olderThan365Bytes: num(row.older_than_365_bytes),
        libraries: {
          total: num(row.lib_total),
          done: num(row.lib_done),
          failed: num(row.lib_failed),
        },
      };
    });

    return { items, total: num(countRow?.total), page, pageSize };
  });

  app.get<{ Params: { id: string } }>('/api/v2/sites/:id', async (request, reply) => {
    const siteId = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(siteId)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid site id' },
      });
    }

    const d = await db();
    const site = await d.one<{
      id: number;
      url: string;
      title: string | null;
      template: string | null;
      used_bytes: number | null;
      file_count_declared: number | null;
      last_activity_at: Date | null;
      access_state: string;
      access_error: string | null;
      excluded: boolean | number;
    }>(
      `SELECT id, url, title, template, storage_used_bytes AS used_bytes, spo_file_count AS file_count_declared,
              last_activity_at, access_state, access_error, excluded
       FROM spo.sites WHERE id = @id AND deleted_at IS NULL`,
      { id: siteId },
    );
    if (!site) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Site not found' },
      });
    }

    const [recycle, libraries, topByVersions, topBySize, rollupSums] = await Promise.all([
      d.one<{
        first_stage_bytes: number;
        first_stage_items: number;
        second_stage_bytes: number;
        second_stage_items: number;
        oldest_deleted_at: Date | null;
        captured_at: Date;
      }>(
        `SELECT first_stage_bytes, first_stage_items, second_stage_bytes, second_stage_items,
                oldest_deleted_at, captured_at
         FROM spo.recycle_bin WHERE site_id = @id`,
        { id: siteId },
      ),
      d.all<{
        id: number;
        title: string;
        hidden: boolean | number;
        metrics_total_bytes: number | null;
        metrics_stream_bytes: number | null;
        metrics_file_count: number | null;
        metrics_captured_at: Date | null;
        baseline_state: string;
        baseline_done_at: Date | null;
        delta_at: Date | null;
        last_error: string | null;
        file_count: number | null;
        current_bytes: number | null;
        total_bytes: number | null;
        versions_bytes: number | null;
        heavy_versions_bytes: number | null;
        age_730_bytes: number | null;
        age_old_bytes: number | null;
      }>(
        `SELECT l.id, l.title, l.hidden, l.metrics_total_bytes, l.metrics_stream_bytes, l.metrics_file_count,
                l.metrics_captured_at, l.baseline_state, l.baseline_done_at, l.delta_at, l.last_error,
                r.file_count, r.current_bytes, r.total_bytes, r.versions_bytes, r.heavy_versions_bytes,
                r.age_730_bytes, r.age_old_bytes
         FROM spo.libraries l
         LEFT JOIN spo.library_rollups r ON r.library_id = l.id
         WHERE l.site_id = @id AND l.deleted_at IS NULL
         ORDER BY l.title ASC`,
        { id: siteId },
      ),
      d.all<{
        id: number;
        name: string;
        url: string;
        size_bytes: number;
        versions_bytes: number;
        total_bytes: number | null;
        modified_at: Date | null;
        library_title: string | null;
      }>(
        `SELECT TOP (20) f.id, f.name, f.server_relative_url AS url, f.size_bytes, f.versions_bytes,
                f.total_bytes, f.modified_at, l.title AS library_title
         FROM spo.files f
         INNER JOIN spo.libraries l ON l.id = f.library_id
         WHERE f.site_id = @id AND f.deleted_at IS NULL
         ORDER BY f.versions_bytes DESC, f.id ASC`,
        { id: siteId },
      ),
      d.all<{
        id: number;
        name: string;
        url: string;
        size_bytes: number;
        versions_bytes: number;
        total_bytes: number | null;
        modified_at: Date | null;
        library_title: string | null;
      }>(
        `SELECT TOP (20) f.id, f.name, f.server_relative_url AS url, f.size_bytes, f.versions_bytes,
                f.total_bytes, f.modified_at, l.title AS library_title
         FROM spo.files f
         INNER JOIN spo.libraries l ON l.id = f.library_id
         WHERE f.site_id = @id AND f.deleted_at IS NULL
         ORDER BY f.size_bytes DESC, f.id ASC`,
        { id: siteId },
      ),
      d.one<{ rollup_bytes: number; versions_bytes: number }>(
        `SELECT COALESCE(SUM(total_bytes), 0) AS rollup_bytes, COALESCE(SUM(versions_bytes), 0) AS versions_bytes
         FROM spo.library_rollups WHERE site_id = @id`,
        { id: siteId },
      ),
    ]);

    const recycleBytes = recycle
      ? num(recycle.first_stage_bytes) + num(recycle.second_stage_bytes)
      : 0;
    const explainedBytes = num(rollupSums?.rollup_bytes) + recycleBytes;
    const used = numOrNull(site.used_bytes);

    const mapTop = (rows: typeof topByVersions): V2TopFile[] =>
      rows.map((f) => ({
        id: num(f.id),
        name: f.name,
        url: f.url,
        sizeBytes: num(f.size_bytes),
        versionsBytes: num(f.versions_bytes),
        totalBytes: numOrNull(f.total_bytes),
        modifiedAt: toIso(f.modified_at),
        libraryTitle: f.library_title,
      }));

    const libraryDetails: V2LibraryDetail[] = libraries.map((l) => ({
      id: num(l.id),
      title: l.title,
      hidden: bool(l.hidden),
      metricsTotalBytes: numOrNull(l.metrics_total_bytes),
      metricsStreamBytes: numOrNull(l.metrics_stream_bytes),
      metricsFileCount: numOrNull(l.metrics_file_count),
      metricsCapturedAt: toIso(l.metrics_captured_at),
      baselineState: l.baseline_state,
      baselineDoneAt: toIso(l.baseline_done_at),
      deltaAt: toIso(l.delta_at),
      lastError: l.last_error,
      rollup:
        l.file_count == null
          ? null
          : {
              fileCount: num(l.file_count),
              currentBytes: num(l.current_bytes),
              totalBytes: num(l.total_bytes),
              versionsBytes: num(l.versions_bytes),
              heavyVersionsBytes: num(l.heavy_versions_bytes),
              olderThan365Bytes: num(l.age_730_bytes) + num(l.age_old_bytes),
            },
    }));

    const body: V2SiteDetailResponse = {
      id: num(site.id),
      url: site.url,
      title: site.title,
      template: site.template,
      usedBytes: used,
      fileCountDeclared: numOrNull(site.file_count_declared),
      lastActivityAt: toIso(site.last_activity_at),
      accessState: site.access_state,
      accessError: site.access_error,
      excluded: bool(site.excluded),
      explainedBytes,
      percent: used != null && used > 0 ? explainedBytes / used : null,
      versionsBytes: num(rollupSums?.versions_bytes),
      recycleBin: recycle
        ? {
            firstStageBytes: num(recycle.first_stage_bytes),
            firstStageItems: num(recycle.first_stage_items),
            secondStageBytes: num(recycle.second_stage_bytes),
            secondStageItems: num(recycle.second_stage_items),
            oldestDeletedAt: toIso(recycle.oldest_deleted_at),
            capturedAt: toIso(recycle.captured_at)!,
          }
        : null,
      libraries: libraryDetails,
      topFilesByVersions: mapTop(topByVersions),
      topFilesBySize: mapTop(topBySize),
    };
    return body;
  });
}
