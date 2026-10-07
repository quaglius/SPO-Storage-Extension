import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { V2FileListItem, V2FileListResponse } from '@spostorage/shared';
import { db, toIso } from '../db.js';
import { bool, num, numOrNull } from './coerce.js';

const filesQuerySchema = z.object({
  siteId: z.coerce.number().int().positive().optional(),
  libraryId: z.coerce.number().int().positive().optional(),
  minSizeBytes: z.coerce.number().int().nonnegative().optional(),
  minVersionsBytes: z.coerce.number().int().nonnegative().optional(),
  modifiedBefore: z.string().min(1).optional(),
  accessedBefore: z.string().min(1).optional(),
  extension: z.string().optional(),
  search: z.string().optional(),
  sort: z.enum(['size', 'versions', 'modified']).optional().default('size'),
  dir: z.enum(['asc', 'desc']).optional().default('desc'),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(200).optional().default(50),
});

function sortColumn(sort: string): string {
  switch (sort) {
    case 'versions':
      return 'f.versions_bytes';
    case 'modified':
      return 'f.modified_at';
    default:
      return 'f.size_bytes';
  }
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/files', async (request, reply): Promise<V2FileListResponse | void> => {
    const parsed = filesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid file parameters' },
      });
    }
    const q = parsed.data;
    const offset = (q.page - 1) * q.pageSize;
    const orderCol = sortColumn(q.sort);
    const orderDir = q.dir === 'asc' ? 'ASC' : 'DESC';

    const extensions = q.extension
      ? q.extension
          .split(',')
          .map((e) => e.trim().replace(/^\./, '').toLowerCase())
          .filter(Boolean)
      : [];

    const searchPrefix = q.search?.trim() ? `${q.search.trim()}%` : null;
    const modifiedBefore = q.modifiedBefore ? new Date(q.modifiedBefore) : null;
    const accessedBefore = q.accessedBefore ? new Date(q.accessedBefore) : null;
    if (
      (modifiedBefore && Number.isNaN(modifiedBefore.getTime())) ||
      (accessedBefore && Number.isNaN(accessedBefore.getTime()))
    ) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid date in filters' },
      });
    }

    const where = `
      f.deleted_at IS NULL
      AND (@siteId IS NULL OR f.site_id = @siteId)
      AND (@libraryId IS NULL OR f.library_id = @libraryId)
      AND (@minSize IS NULL OR f.size_bytes >= @minSize)
      AND (@minVersions IS NULL OR f.versions_bytes >= @minVersions)
      AND (@modifiedBefore IS NULL OR f.modified_at < @modifiedBefore)
      AND (@accessedBefore IS NULL OR f.last_access_at < @accessedBefore)
      AND (@search IS NULL OR f.name LIKE @search)
      AND (
        @extCount = 0
        OR LOWER(COALESCE(f.extension, N'')) IN (SELECT value FROM OPENJSON(@extJson))
      )`;

    const params = {
      siteId: q.siteId ?? null,
      libraryId: q.libraryId ?? null,
      minSize: q.minSizeBytes ?? null,
      minVersions: q.minVersionsBytes ?? null,
      modifiedBefore,
      accessedBefore,
      search: searchPrefix,
      extCount: extensions.length,
      extJson: JSON.stringify(extensions),
      offset,
      pageSize: q.pageSize,
    };

    const d = await db();
    const totals = await d.one<{ total: number; total_bytes: number }>(
      `SELECT COUNT_BIG(*) AS total, COALESCE(SUM(f.size_bytes), 0) AS total_bytes
       FROM spo.files f
       WHERE ${where}`,
      params,
    );

    const rows = await d.all<{
      id: number;
      site_id: number;
      site_title: string | null;
      library_title: string | null;
      url: string;
      name: string;
      extension: string | null;
      size_bytes: number;
      total_bytes: number | null;
      versions_bytes: number;
      version_label: string | null;
      modified_at: Date | null;
      editor: string | null;
      created_at: Date | null;
      author: string | null;
      last_access_at: Date | null;
      has_unique_perms: boolean | number | null;
    }>(
      `SELECT f.id, f.site_id, s.title AS site_title, l.title AS library_title,
              f.server_relative_url AS url, f.name, f.extension, f.size_bytes, f.total_bytes,
              f.versions_bytes, f.version_label, f.modified_at, f.editor, f.created_at, f.author,
              f.last_access_at, f.has_unique_perms
       FROM spo.files f
       INNER JOIN spo.sites s ON s.id = f.site_id
       INNER JOIN spo.libraries l ON l.id = f.library_id
       WHERE ${where}
       ORDER BY ${orderCol} ${orderDir}, f.id ASC
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      params,
    );

    const items: V2FileListItem[] = rows.map((f) => ({
      id: num(f.id),
      siteId: num(f.site_id),
      siteTitle: f.site_title,
      libraryTitle: f.library_title,
      url: f.url,
      name: f.name,
      extension: f.extension,
      sizeBytes: num(f.size_bytes),
      totalBytes: numOrNull(f.total_bytes),
      versionsBytes: num(f.versions_bytes),
      versionLabel: f.version_label,
      modifiedAt: toIso(f.modified_at),
      editor: f.editor,
      createdAt: toIso(f.created_at),
      author: f.author,
      lastAccessAt: toIso(f.last_access_at),
      hasUniquePerms: f.has_unique_perms == null ? null : bool(f.has_unique_perms),
    }));

    return {
      items,
      total: num(totals?.total),
      totalBytes: num(totals?.total_bytes),
      page: q.page,
      pageSize: q.pageSize,
    };
  });
}
