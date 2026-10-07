import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decideArchiveAccess } from '../actions/access.js';
import { containerClient, getArchiveSettings } from '../actions/blob.js';
import { db, toIso } from '../db.js';
import { isAdminUser, requireAdmin, requestUser } from './auth.js';
import { bool, num } from './coerce.js';
import { parseJsonSafe } from './policies.js';
import { webSpoClient } from './spo-web.js';

const archivedQuerySchema = z.object({
  search: z.string().optional(),
  siteId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(200).optional().default(50),
});

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function registerArchiveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/archived', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const parsed = archivedQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid archived file parameters' },
      });
    }
    const { search, siteId, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;
    const searchPrefix = search?.trim() ? `${search.trim()}%` : null;
    const d = await db();
    const totals = await d.one<{ total: number }>(
      `SELECT COUNT_BIG(*) AS total
       FROM spo.archived_files a
       WHERE (@siteId IS NULL OR a.site_id = @siteId)
         AND (@search IS NULL OR a.name LIKE @search OR a.original_url LIKE @search)`,
      { siteId: siteId ?? null, search: searchPrefix },
    );
    const rows = await d.all<{
      id: number;
      name: string;
      size_bytes: number;
      state: string;
      archived_at: Date;
      site_id: number;
      site_title: string | null;
      original_url: string;
    }>(
      `SELECT a.id, a.name, a.size_bytes, a.state, a.archived_at, a.site_id, s.title AS site_title, a.original_url
       FROM spo.archived_files a
       LEFT JOIN spo.sites s ON s.id = a.site_id
       WHERE (@siteId IS NULL OR a.site_id = @siteId)
         AND (@search IS NULL OR a.name LIKE @search OR a.original_url LIKE @search)
       ORDER BY a.archived_at DESC, a.id DESC
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      { siteId: siteId ?? null, search: searchPrefix, offset, pageSize },
    );
    return {
      items: rows.map((r) => ({
        id: num(r.id),
        name: r.name,
        sizeBytes: num(r.size_bytes),
        state: r.state,
        archivedAt: toIso(r.archived_at),
        siteId: num(r.site_id),
        siteTitle: r.site_title,
        originalUrl: r.original_url,
      })),
      total: num(totals?.total),
      page,
      pageSize,
    };
  });

  app.get('/api/v2/archived/:id', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const d = await db();
    const row = await d.one<{
      id: number;
      name: string;
      size_bytes: number;
      state: string;
      archived_at: Date;
      site_id: number;
      site_title: string | null;
      original_url: string;
      web_url: string;
      link_url: string | null;
      content_type: string | null;
      blob_path: string;
      sha256: string;
      acl_json: string | null;
      archived_by: string | null;
    }>(
      `SELECT a.*, s.title AS site_title
       FROM spo.archived_files a
       LEFT JOIN spo.sites s ON s.id = a.site_id
       WHERE a.id = @id`,
      { id },
    );
    if (!row) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Archived file not found' } });
    }
    const accessLog = await d.all<{
      id: number;
      at: Date;
      user_upn: string;
      granted: boolean | number;
      reason: string | null;
    }>(
      `SELECT TOP 50 id, at, user_upn, granted, reason
       FROM spo.archive_access_log WHERE archived_id = @id
       ORDER BY at DESC, id DESC`,
      { id },
    );
    return {
      id: num(row.id),
      name: row.name,
      sizeBytes: num(row.size_bytes),
      state: row.state,
      archivedAt: toIso(row.archived_at),
      siteId: num(row.site_id),
      siteTitle: row.site_title,
      originalUrl: row.original_url,
      webUrl: row.web_url,
      linkUrl: row.link_url,
      contentType: row.content_type,
      blobPath: row.blob_path,
      sha256: row.sha256,
      archivedBy: row.archived_by,
      acl: parseJsonSafe(row.acl_json),
      accessLog: accessLog.map((e) => ({
        id: num(e.id),
        at: toIso(e.at),
        userUpn: e.user_upn,
        granted: bool(e.granted),
        reason: e.reason,
      })),
    };
  });

  app.get('/api/v2/portal/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const upn = requestUser(request);
    const spo = await webSpoClient();
    const decision = await decideArchiveAccess(spo, id, upn);
    if (!decision.granted) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to view this file.',
        },
      });
    }
    const d = await db();
    const row = await d.one<{
      name: string;
      size_bytes: number;
      archived_at: Date;
      original_url: string;
      site_title: string | null;
    }>(
      `SELECT a.name, a.size_bytes, a.archived_at, a.original_url, s.title AS site_title
       FROM spo.archived_files a
       LEFT JOIN spo.sites s ON s.id = a.site_id
       WHERE a.id = @id`,
      { id },
    );
    if (!row) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    }
    return {
      name: row.name,
      sizeBytes: num(row.size_bytes),
      archivedAt: toIso(row.archived_at),
      originalUrl: row.original_url,
      siteTitle: row.site_title,
      granted: true,
      reason: decision.reason,
    };
  });

  app.get('/api/v2/portal/:id/download', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const upn = requestUser(request);
    const spo = await webSpoClient();
    const decision = await decideArchiveAccess(spo, id, upn);
    if (!decision.granted) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to view this file.',
        },
      });
    }
    const d = await db();
    const row = await d.one<{
      name: string;
      content_type: string | null;
      blob_path: string;
      size_bytes: number;
    }>(`SELECT name, content_type, blob_path, size_bytes FROM spo.archived_files WHERE id = @id`, { id });
    if (!row) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    }

    // Admins in local/test without blob credentials still get metadata-only denial path above;
    // streaming requires real Azure credentials.
    try {
      const settings = await getArchiveSettings();
      const download = await containerClient(settings).getBlobClient(row.blob_path).download();
      reply.header('Content-Disposition', contentDisposition(row.name));
      reply.header('Content-Type', row.content_type || 'application/octet-stream');
      if (download.contentLength != null) {
        reply.header('Content-Length', String(download.contentLength));
      } else {
        reply.header('Content-Length', String(num(row.size_bytes)));
      }
      return reply.send(download.readableStreamBody);
    } catch (err) {
      request.log.error({ err, archivedId: id }, 'archive download failed');
      return reply.status(502).send({
        error: {
          code: 'BLOB_UNAVAILABLE',
          message: 'Could not download the file from storage.',
        },
      });
    }
  });
}

/** Used by portal exemption checks in other modules — kept for tests. */
export { isAdminUser };
