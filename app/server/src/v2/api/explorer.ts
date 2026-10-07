import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  V2ExplorerAccess,
  V2ExplorerArchivedDetail,
  V2ExplorerFileDetail,
  V2ExplorerFolderResponse,
} from '@spostorage/shared';
import { describeAccess } from '../actions/access-list.js';
import { db, toIso } from '../db.js';
import { requireAdmin } from './auth.js';
import { bool, num, numOrNull } from './coerce.js';
import { parseJsonSafe } from './policies.js';
import { webSpoClient } from './spo-web.js';

const folderQuerySchema = z.object({
  siteId: z.coerce.number().int().positive(),
  libraryId: z.coerce.number().int().positive().optional(),
  path: z.string().optional().default(''),
});

const FILE_LIMIT = 300;

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function joinPrefix(rootUrl: string, path: string): string {
  const root = rootUrl.replace(/\/$/, '');
  const rel = normalizePath(path);
  return rel ? `${root}${rel}` : root;
}

function folderPath(parentPath: string, name: string): string {
  const base = normalizePath(parentPath);
  return base ? `${base}/${name}` : `/${name}`;
}

async function resolveAccess(
  webUrl: string,
  serverRelativeUrl: string | null,
): Promise<V2ExplorerAccess> {
  if (!serverRelativeUrl) {
    return { error: 'No relative URL to query permissions.' };
  }
  try {
    const spo = await webSpoClient();
    const access = await describeAccess(spo, webUrl, serverRelativeUrl);
    return {
      people: access.people,
      principals: access.principals,
      everyone: access.everyone,
      unique: access.unique,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not read permissions.';
    return { error: message };
  }
}

export async function registerExplorerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/explorer/folder', async (request, reply): Promise<V2ExplorerFolderResponse | void> => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const parsed = folderQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid folder parameters' },
      });
    }
    const { siteId, libraryId } = parsed.data;
    const rawPath = parsed.data.path.trim();
    if (rawPath && rawPath !== '/' && !rawPath.startsWith('/')) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Path must be empty or start with /' },
      });
    }
    const path = normalizePath(rawPath);

    const d = await db();
    const site = await d.one<{ id: number; title: string | null }>(
      `SELECT id, title FROM spo.sites WHERE id = @siteId AND deleted_at IS NULL`,
      { siteId },
    );
    if (!site) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Site not found' } });
    }

    if (!libraryId) {
      const libraries = await d.all<{
        id: number;
        title: string;
        root_url: string;
        file_count: number;
        current_bytes: number;
        total_bytes: number;
        versions_bytes: number;
      }>(
        `SELECT l.id, l.title, l.root_url,
                r.file_count, r.current_bytes, r.total_bytes, r.versions_bytes
         FROM spo.libraries l
         INNER JOIN spo.library_rollups r ON r.library_id = l.id
         WHERE l.site_id = @siteId
           AND l.deleted_at IS NULL
           AND r.file_count > 0
         ORDER BY r.total_bytes DESC, l.title ASC`,
        { siteId },
      );
      return {
        siteId: num(site.id),
        siteTitle: site.title,
        libraryId: null,
        libraryTitle: null,
        rootUrl: null,
        path: '',
        libraries: libraries.map((l) => ({
          id: num(l.id),
          title: l.title,
          rootUrl: l.root_url,
          fileCount: num(l.file_count),
          currentBytes: num(l.current_bytes),
          totalBytes: num(l.total_bytes),
          versionsBytes: num(l.versions_bytes),
        })),
        folders: [],
        files: [],
        hasMore: false,
      };
    }

    const library = await d.one<{
      id: number;
      title: string;
      root_url: string;
      site_id: number;
    }>(
      `SELECT id, title, root_url, site_id FROM spo.libraries
       WHERE id = @libraryId AND site_id = @siteId AND deleted_at IS NULL`,
      { libraryId, siteId },
    );
    if (!library) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Library not found' } });
    }

    const prefix = joinPrefix(library.root_url, path);

    // Subfolders: next segment after prefix+/ for live files and archived originals.
    const folderRows = await d.all<{
      name: string;
      file_count: number;
      total_bytes: number;
      archived_count: number;
    }>(
      `WITH under AS (
         SELECT
           CASE
             WHEN CHARINDEX(N'/', f.server_relative_url, LEN(@prefix) + 2) = 0 THEN NULL
             ELSE SUBSTRING(
               f.server_relative_url,
               LEN(@prefix) + 2,
               CHARINDEX(N'/', f.server_relative_url, LEN(@prefix) + 2) - (LEN(@prefix) + 2)
             )
           END AS folder_name,
           COALESCE(f.total_bytes, f.size_bytes) AS total_bytes,
           0 AS is_archived
         FROM spo.files f
         WHERE f.library_id = @libraryId
           AND f.deleted_at IS NULL
           AND LEFT(f.server_relative_url, LEN(@prefix) + 1) = @prefix + N'/'
         UNION ALL
         SELECT
           CASE
             WHEN CHARINDEX(N'/', a.original_url, LEN(@prefix) + 2) = 0 THEN NULL
             ELSE SUBSTRING(
               a.original_url,
               LEN(@prefix) + 2,
               CHARINDEX(N'/', a.original_url, LEN(@prefix) + 2) - (LEN(@prefix) + 2)
             )
           END AS folder_name,
           a.size_bytes AS total_bytes,
           1 AS is_archived
         FROM spo.archived_files a
         WHERE a.site_id = @siteId
           AND a.state = N'original_deleted'
           AND LEFT(a.original_url, LEN(@prefix) + 1) = @prefix + N'/'
       )
       SELECT folder_name AS name,
              COUNT_BIG(*) AS file_count,
              COALESCE(SUM(total_bytes), 0) AS total_bytes,
              SUM(is_archived) AS archived_count
       FROM under
       WHERE folder_name IS NOT NULL AND folder_name <> N''
       GROUP BY folder_name
       ORDER BY total_bytes DESC, folder_name ASC`,
      { prefix, libraryId, siteId },
    );

    const liveFiles = await d.all<{
      id: number;
      name: string;
      server_relative_url: string;
      size_bytes: number;
      versions_bytes: number;
      total_bytes: number;
      modified_at: Date | null;
      last_access_at: Date | null;
    }>(
      `SELECT f.id, f.name, f.server_relative_url, f.size_bytes, f.versions_bytes,
              COALESCE(f.total_bytes, f.size_bytes) AS total_bytes,
              f.modified_at, f.last_access_at
       FROM spo.files f
       WHERE f.library_id = @libraryId
         AND f.deleted_at IS NULL
         AND LEFT(f.server_relative_url, LEN(@prefix) + 1) = @prefix + N'/'
         AND CHARINDEX(N'/', f.server_relative_url, LEN(@prefix) + 2) = 0
       ORDER BY COALESCE(f.total_bytes, f.size_bytes) DESC, f.id ASC`,
      { prefix, libraryId },
    );

    const archivedFiles = await d.all<{
      id: number;
      name: string;
      original_url: string;
      size_bytes: number;
      archived_at: Date;
      blob_tier: string;
    }>(
      `SELECT a.id, a.name, a.original_url, a.size_bytes, a.archived_at, a.blob_tier
       FROM spo.archived_files a
       WHERE a.site_id = @siteId
         AND a.state = N'original_deleted'
         AND LEFT(a.original_url, LEN(@prefix) + 1) = @prefix + N'/'
         AND CHARINDEX(N'/', a.original_url, LEN(@prefix) + 2) = 0
       ORDER BY a.size_bytes DESC, a.id ASC`,
      { prefix, siteId },
    );

    const merged = [
      ...liveFiles.map((f) => ({
        id: num(f.id),
        name: f.name,
        serverRelativeUrl: f.server_relative_url,
        sizeBytes: num(f.size_bytes),
        versionsBytes: num(f.versions_bytes),
        totalBytes: num(f.total_bytes),
        modifiedAt: toIso(f.modified_at),
        lastAccessAt: toIso(f.last_access_at),
        archived: false,
        archivedId: null as number | null,
        archivedAt: null as string | null,
        blobTier: null as string | null,
      })),
      ...archivedFiles.map((a) => ({
        id: null as number | null,
        name: a.name,
        serverRelativeUrl: a.original_url,
        sizeBytes: num(a.size_bytes),
        versionsBytes: 0,
        totalBytes: num(a.size_bytes),
        modifiedAt: null as string | null,
        lastAccessAt: null as string | null,
        archived: true,
        archivedId: num(a.id),
        archivedAt: toIso(a.archived_at),
        blobTier: a.blob_tier,
      })),
    ]
      .sort((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name))
      .slice(0, FILE_LIMIT + 1);

    const hasMore = merged.length > FILE_LIMIT;
    const files = hasMore ? merged.slice(0, FILE_LIMIT) : merged;

    return {
      siteId: num(site.id),
      siteTitle: site.title,
      libraryId: num(library.id),
      libraryTitle: library.title,
      rootUrl: library.root_url,
      path,
      libraries: [],
      folders: folderRows.map((f) => ({
        name: f.name,
        path: folderPath(path, f.name),
        fileCount: num(f.file_count),
        totalBytes: num(f.total_bytes),
        archivedCount: num(f.archived_count),
      })),
      files,
      hasMore,
    };
  });

  app.get('/api/v2/explorer/file/:fileId', async (request, reply): Promise<V2ExplorerFileDetail | void> => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const fileId = Number((request.params as { fileId: string }).fileId);
    if (!Number.isFinite(fileId) || fileId <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }

    const d = await db();
    const row = await d.one<{
      id: number;
      name: string;
      extension: string | null;
      server_relative_url: string;
      web_url: string;
      site_id: number;
      site_title: string | null;
      library_id: number;
      library_title: string | null;
      size_bytes: number;
      versions_bytes: number;
      total_bytes: number | null;
      version_label: string | null;
      version_count: number | null;
      created_at: Date | null;
      modified_at: Date | null;
      author: string | null;
      editor: string | null;
      last_access_at: Date | null;
    }>(
      `SELECT f.id, f.name, f.extension, f.server_relative_url, l.web_url,
              f.site_id, s.title AS site_title, f.library_id, l.title AS library_title,
              f.size_bytes, f.versions_bytes, f.total_bytes, f.version_label, f.version_count,
              f.created_at, f.modified_at, f.author, f.editor, f.last_access_at
       FROM spo.files f
       JOIN spo.libraries l ON l.id = f.library_id
       JOIN spo.sites s ON s.id = f.site_id
       WHERE f.id = @fileId AND f.deleted_at IS NULL`,
      { fileId },
    );
    if (!row) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    }

    const versions = await d.all<{
      label: string;
      size_bytes: number;
      created_at: Date | null;
      created_by: string | null;
    }>(
      `SELECT label, size_bytes, created_at, created_by
       FROM spo.file_versions
       WHERE file_id = @fileId
       ORDER BY version_id DESC`,
      { fileId },
    );

    const accessRow = await d.one<{
      last_access_at: Date;
      last_user: string | null;
      last_operation: string | null;
    }>(
      `SELECT fa.last_access_at, fa.last_user, fa.last_operation
       FROM spo.file_access fa
       INNER JOIN spo.files f ON f.url_hash = fa.url_hash
       WHERE f.id = @fileId`,
      { fileId },
    );

    const access = await resolveAccess(row.web_url, row.server_relative_url);

    return {
      id: num(row.id),
      name: row.name,
      extension: row.extension,
      serverRelativeUrl: row.server_relative_url,
      webUrl: row.web_url,
      siteId: num(row.site_id),
      siteTitle: row.site_title,
      libraryId: num(row.library_id),
      libraryTitle: row.library_title,
      sizeBytes: num(row.size_bytes),
      versionsBytes: num(row.versions_bytes),
      totalBytes: num(row.total_bytes ?? row.size_bytes),
      versionLabel: row.version_label,
      versionCount: numOrNull(row.version_count),
      createdAt: toIso(row.created_at),
      modifiedAt: toIso(row.modified_at),
      author: row.author,
      editor: row.editor,
      lastAccessAt: toIso(row.last_access_at),
      versions: versions.map((v) => ({
        label: v.label,
        sizeBytes: num(v.size_bytes),
        createdAt: toIso(v.created_at),
        createdBy: v.created_by,
      })),
      lastAccess: accessRow
        ? {
            at: toIso(accessRow.last_access_at)!,
            user: accessRow.last_user,
            operation: accessRow.last_operation,
          }
        : null,
      access,
    };
  });

  app.get(
    '/api/v2/explorer/archived/:archivedId',
    async (request, reply): Promise<V2ExplorerArchivedDetail | void> => {
      const admin = requireAdmin(request, reply);
      if (!admin) return;
      const archivedId = Number((request.params as { archivedId: string }).archivedId);
      if (!Number.isFinite(archivedId) || archivedId <= 0) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
      }

      const d = await db();
      const row = await d.one<{
        id: number;
        name: string;
        extension: string | null;
        original_url: string;
        link_url: string | null;
        web_url: string;
        site_id: number;
        site_title: string | null;
        size_bytes: number;
        blob_tier: string;
        state: string;
        archived_at: Date;
        archived_by: string | null;
        acl_json: string | null;
      }>(
        `SELECT a.id, a.name, a.extension, a.original_url, a.link_url, a.web_url,
                a.site_id, s.title AS site_title, a.size_bytes, a.blob_tier, a.state,
                a.archived_at, a.archived_by, a.acl_json
         FROM spo.archived_files a
         LEFT JOIN spo.sites s ON s.id = a.site_id
         WHERE a.id = @archivedId`,
        { archivedId },
      );
      if (!row) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Archived file not found' },
        });
      }

      const accessLog = await d.all<{
        id: number;
        at: Date;
        user_upn: string;
        granted: boolean | number;
        reason: string | null;
      }>(
        `SELECT TOP (20) id, at, user_upn, granted, reason
         FROM spo.archive_access_log
         WHERE archived_id = @archivedId
         ORDER BY at DESC, id DESC`,
        { archivedId },
      );

      const access = await resolveAccess(row.web_url, row.link_url);

      return {
        id: num(row.id),
        name: row.name,
        extension: row.extension,
        originalUrl: row.original_url,
        linkUrl: row.link_url,
        webUrl: row.web_url,
        siteId: num(row.site_id),
        siteTitle: row.site_title,
        sizeBytes: num(row.size_bytes),
        blobTier: row.blob_tier,
        state: row.state,
        archivedAt: toIso(row.archived_at),
        archivedBy: row.archived_by,
        acl: parseJsonSafe(row.acl_json),
        accessLog: accessLog.map((l) => ({
          id: num(l.id),
          at: toIso(l.at),
          userUpn: l.user_upn,
          granted: bool(l.granted),
          reason: l.reason,
        })),
        access,
      };
    },
  );
}
