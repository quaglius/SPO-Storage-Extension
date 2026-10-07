import type { FastifyInstance } from 'fastify';
import { PENDING_LINK_WHERE, requestCompleteLinks } from '../actions/archive-links.js';
import { requestRestore, RestoreError } from '../actions/restore.js';
import { logEvent } from '../engine/events.js';
import { z } from 'zod';
import type {
  V2ArchiveItemDetail,
  V2ArchiveLinksStatus,
  V2ArchiveTreeResponse,
  V2ExplorerAccess,
} from '@spostorage/shared';
import { describeAccess } from '../actions/access-list.js';
import {
  azurePortalBlobUrl,
  azurePortalContainerUrl,
  getArchiveSettings,
} from '../actions/blob.js';
import { db, toIso } from '../db.js';
import { requireAdmin } from './auth.js';
import { bool, num } from './coerce.js';
import { parseJsonSafe } from './policies.js';
import { webSpoClient } from './spo-web.js';

const ACTIVE_STATES = `N'linked', N'original_deleted'`;

const treeQuerySchema = z.object({
  siteId: z.coerce.number().int().positive().optional(),
  path: z.string().optional().default(''),
});

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function folderPath(parentPath: string, name: string): string {
  const base = normalizePath(parentPath);
  return base ? `${base}/${name}` : `/${name}`;
}

function siteServerPath(siteUrl: string): string {
  try {
    return new URL(siteUrl).pathname.replace(/\/$/, '') || '/';
  } catch {
    return siteUrl.replace(/\/$/, '');
  }
}

function sharePointUrls(
  webUrl: string,
  linkUrl: string | null,
): { sharePointFolderUrl: string | null; sharePointLinkUrl: string | null } {
  if (!linkUrl) return { sharePointFolderUrl: null, sharePointLinkUrl: null };
  let origin: string;
  try {
    origin = new URL(webUrl).origin;
  } catch {
    origin = webUrl.replace(/\/$/, '');
  }
  const folder = linkUrl.replace(/\/[^/]*$/, '') || '/';
  return {
    sharePointFolderUrl: origin + encodeURI(folder),
    sharePointLinkUrl: origin + encodeURI(linkUrl),
  };
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

export async function registerArchiveExplorerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/archive/tree', async (request, reply): Promise<V2ArchiveTreeResponse | void> => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const parsed = treeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid tree parameters' },
      });
    }
    const { siteId } = parsed.data;
    const rawPath = parsed.data.path.trim();
    if (rawPath && rawPath !== '/' && !rawPath.startsWith('/')) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Path must be empty or start with /' },
      });
    }
    const path = normalizePath(rawPath);
    const d = await db();

    const summaryRow = await d.one<{ file_count: number; bytes: number }>(
      `SELECT COUNT_BIG(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM spo.archived_files
       WHERE state IN (${ACTIVE_STATES})`,
    );
    const summary = {
      fileCount: num(summaryRow?.file_count),
      bytes: num(summaryRow?.bytes),
    };

    if (!siteId) {
      const sites = await d.all<{
        site_id: number;
        title: string | null;
        url: string;
        file_count: number;
        bytes: number;
        last_archived_at: Date | null;
      }>(
        `SELECT a.site_id, s.title, s.url,
                COUNT_BIG(*) AS file_count,
                COALESCE(SUM(a.size_bytes), 0) AS bytes,
                MAX(a.archived_at) AS last_archived_at
         FROM spo.archived_files a
         INNER JOIN spo.sites s ON s.id = a.site_id
         WHERE a.state IN (${ACTIVE_STATES})
         GROUP BY a.site_id, s.title, s.url
         ORDER BY bytes DESC, s.title ASC`,
      );
      return {
        summary,
        sites: sites.map((s) => ({
          siteId: num(s.site_id),
          title: s.title,
          url: s.url,
          fileCount: num(s.file_count),
          bytes: num(s.bytes),
          lastArchivedAt: toIso(s.last_archived_at),
        })),
        siteId: null,
        siteTitle: null,
        siteUrl: null,
        path: '',
        folders: [],
        files: [],
      };
    }

    const site = await d.one<{ id: number; title: string | null; url: string }>(
      `SELECT id, title, url FROM spo.sites WHERE id = @siteId AND deleted_at IS NULL`,
      { siteId },
    );
    if (!site) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Site not found' } });
    }

    const sitePath = siteServerPath(site.url);
    const prefix = path ? `${sitePath}${path}` : sitePath;

    const folderRows = await d.all<{
      name: string;
      file_count: number;
      bytes: number;
    }>(
      `WITH under AS (
         SELECT
           CASE
             WHEN CHARINDEX(N'/', a.original_url, LEN(@prefix) + 2) = 0 THEN NULL
             ELSE SUBSTRING(
               a.original_url,
               LEN(@prefix) + 2,
               CHARINDEX(N'/', a.original_url, LEN(@prefix) + 2) - (LEN(@prefix) + 2)
             )
           END AS folder_name,
           a.size_bytes
         FROM spo.archived_files a
         WHERE a.site_id = @siteId
           AND a.state IN (${ACTIVE_STATES})
           AND LEFT(a.original_url, LEN(@prefix) + 1) = @prefix + N'/'
       )
       SELECT folder_name AS name,
              COUNT_BIG(*) AS file_count,
              COALESCE(SUM(size_bytes), 0) AS bytes
       FROM under
       WHERE folder_name IS NOT NULL AND folder_name <> N''
       GROUP BY folder_name
       ORDER BY bytes DESC, folder_name ASC`,
      { prefix, siteId },
    );

    const files = await d.all<{
      id: number;
      name: string;
      extension: string | null;
      size_bytes: number;
      archived_at: Date;
      archived_by: string | null;
      original_modified_at: Date | null;
      original_modified_by: string | null;
      blob_tier: string;
      state: string;
    }>(
      `SELECT a.id, a.name, a.extension, a.size_bytes, a.archived_at, a.archived_by,
              a.original_modified_at, a.original_modified_by, a.blob_tier, a.state
       FROM spo.archived_files a
       WHERE a.site_id = @siteId
         AND a.state IN (${ACTIVE_STATES})
         AND LEFT(a.original_url, LEN(@prefix) + 1) = @prefix + N'/'
         AND CHARINDEX(N'/', a.original_url, LEN(@prefix) + 2) = 0
       ORDER BY a.size_bytes DESC, a.name ASC`,
      { prefix, siteId },
    );

    return {
      summary,
      sites: [],
      siteId: num(site.id),
      siteTitle: site.title,
      siteUrl: site.url,
      path,
      folders: folderRows.map((f) => ({
        name: f.name,
        path: folderPath(path, f.name),
        fileCount: num(f.file_count),
        bytes: num(f.bytes),
      })),
      files: files.map((f) => ({
        archivedId: num(f.id),
        name: f.name,
        extension: f.extension,
        sizeBytes: num(f.size_bytes),
        archivedAt: toIso(f.archived_at),
        archivedBy: f.archived_by,
        originalModifiedAt: toIso(f.original_modified_at),
        originalModifiedBy: f.original_modified_by,
        blobTier: f.blob_tier,
        state: f.state,
      })),
    };
  });

  app.get(
    '/api/v2/archive/item/:archivedId',
    async (request, reply): Promise<V2ArchiveItemDetail | void> => {
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
        size_bytes: number;
        sha256: string;
        content_type: string | null;
        blob_path: string;
        blob_tier: string;
        state: string;
        original_url: string;
        link_url: string | null;
        web_url: string;
        site_id: number;
        site_title: string | null;
        archived_at: Date;
        archived_by: string | null;
        original_modified_at: Date | null;
        original_modified_by: string | null;
        acl_json: string | null;
        run_id: number | null;
        restore_state: string | null;
        restore_requested_by: string | null;
        restore_requested_at: Date | null;
        restored_at: Date | null;
        restore_error: string | null;
      }>(
        `SELECT a.id, a.name, a.extension, a.size_bytes, a.sha256, a.content_type,
                a.blob_path, a.blob_tier, a.state, a.original_url, a.link_url, a.web_url,
                a.site_id, s.title AS site_title, a.archived_at, a.archived_by,
                a.original_modified_at, a.original_modified_by, a.acl_json, a.run_id,
                a.restore_state, a.restore_requested_by, a.restore_requested_at, a.restored_at, a.restore_error
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

      let integrity: V2ArchiveItemDetail['integrity'] = {
        sha256: row.sha256,
        detail: null,
        evidence: null,
      };
      if (row.run_id != null) {
        const action = await d.one<{ detail: string | null; evidence_json: string | null }>(
          `SELECT detail, evidence_json
           FROM spo.policy_actions
           WHERE run_id = @runId AND target_url = @url AND action = N'archive_file'`,
          { runId: row.run_id, url: row.original_url },
        );
        if (action) {
          integrity = {
            sha256: row.sha256,
            detail: action.detail,
            evidence: parseJsonSafe(action.evidence_json),
          };
        }
      }

      const settings = await getArchiveSettings();
      const { sharePointFolderUrl, sharePointLinkUrl } = sharePointUrls(row.web_url, row.link_url);
      const access = await resolveAccess(row.web_url, row.link_url);

      return {
        id: num(row.id),
        name: row.name,
        extension: row.extension,
        sizeBytes: num(row.size_bytes),
        sha256: row.sha256,
        contentType: row.content_type,
        blobPath: row.blob_path,
        blobTier: row.blob_tier,
        state: row.state,
        originalUrl: row.original_url,
        linkUrl: row.link_url,
        webUrl: row.web_url,
        siteId: num(row.site_id),
        siteTitle: row.site_title,
        archivedAt: toIso(row.archived_at),
        archivedBy: row.archived_by,
        originalModifiedAt: toIso(row.original_modified_at),
        originalModifiedBy: row.original_modified_by,
        blobUrlInPortal: azurePortalBlobUrl(settings, row.blob_path),
        containerUrlInPortal: azurePortalContainerUrl(settings),
        sharePointFolderUrl,
        sharePointLinkUrl,
        portalUrl: `/archive/${num(row.id)}`,
        acl: parseJsonSafe(row.acl_json),
        access,
        accessLog: accessLog.map((l) => ({
          id: num(l.id),
          at: toIso(l.at),
          userUpn: l.user_upn,
          granted: bool(l.granted),
          reason: l.reason,
        })),
        integrity,
        restore: {
          state: row.restore_state,
          requestedBy: row.restore_requested_by,
          requestedAt: toIso(row.restore_requested_at),
          restoredAt: toIso(row.restored_at),
          error: row.restore_error,
        },
      };
    },
  );

  // Restore to SharePoint (engine task 'archive-restore', see v2/actions/restore.ts).
  app.post('/api/v2/archive/item/:archivedId/restore', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const archivedId = Number((request.params as { archivedId: string }).archivedId);
    if (!Number.isFinite(archivedId) || archivedId <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    try {
      await requestRestore(archivedId, admin);
    } catch (err) {
      if (err instanceof RestoreError) {
        return reply.status(409).send({ error: { code: 'RESTORE_NOT_ALLOWED', message: err.message } });
      }
      throw err;
    }
    await logEvent({ level: 'info', kind: 'archive-restore-requested', message: `${admin} requested restore of archived file #${archivedId}.` });
    return reply.status(202).send({ archivedId, restoreState: 'requested' });
  });

  // Archives whose .url link is still pending (see v2/actions/archive-links.ts).
  app.get('/api/v2/archive/links', async (request, reply): Promise<V2ArchiveLinksStatus | void> => {
    if (!requireAdmin(request, reply)) return;
    const d = await db();
    const totals = await d.one<{ originals: number | null; originals_bytes: number | null; links: number | null }>(
      `SELECT SUM(CASE WHEN a.state IN (N'uploaded', N'linked') THEN 1 ELSE 0 END) AS originals,
              SUM(CASE WHEN a.state IN (N'uploaded', N'linked') THEN CAST(a.size_bytes AS BIGINT) ELSE 0 END) AS originals_bytes,
              SUM(CASE WHEN a.state = N'original_deleted' THEN 1 ELSE 0 END) AS links
       FROM spo.archived_files a WHERE ${PENDING_LINK_WHERE}`,
    );
    const errors = await d.all<{ message: string; n: number }>(
      `SELECT TOP 5 LEFT(a.link_error, 300) AS message, COUNT(*) AS n
       FROM spo.archived_files a WHERE ${PENDING_LINK_WHERE} AND a.link_error IS NOT NULL
       GROUP BY LEFT(a.link_error, 300) ORDER BY COUNT(*) DESC`,
    );
    const open = await d.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM spo.tasks WHERE kind = N'archive-complete-links' AND state IN (N'ready', N'leased')`,
    );
    return {
      originalsPending: num(totals?.originals),
      originalsPendingBytes: num(totals?.originals_bytes),
      linksPending: num(totals?.links),
      running: num(open?.n) > 0,
      errors: errors.map((e) => ({ message: e.message, count: num(e.n) })),
    };
  });

  // One pass over the pending archives; launch it again whenever needed.
  app.post('/api/v2/archive/links/complete', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const started = await requestCompleteLinks(admin);
    if (started) {
      await logEvent({ level: 'info', kind: 'archive-links-requested', message: `${admin} launched the archive links pass.` });
    }
    return reply.status(202).send({ started });
  });
}
