/**
 * GET /api/v2/notices — actionable warnings that need someone outside the app (Purview, Entra).
 * Cheap: reads spo.libraries (a few thousand rows) and spo.settings.
 */
import type { FastifyInstance } from 'fastify';
import type { V2Notice, V2NoticesResponse } from '@spostorage/shared';
import { db } from '../db.js';
import { appOnlyClientId } from '../env.js';
import { getSetting } from '../settings.js';


export async function registerNoticeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/notices', async (): Promise<V2NoticesResponse> => {
    const d = await db();
    const notices: V2Notice[] = [];

    // Retention: SharePoint creates a Preservation Hold Library the first time a retention policy or hold applies.
    const phl = await d.all<{ site_id: number; title: string | null; url: string; items: number | null }>(
      `SELECT s.id AS site_id, s.title, s.url, SUM(CAST(l.item_count AS BIGINT)) AS items
       FROM spo.libraries l JOIN spo.sites s ON s.id = l.site_id
       WHERE l.deleted_at IS NULL AND s.deleted_at IS NULL
         AND (l.title = N'Preservation Hold Library' OR l.root_url LIKE N'%/PreservationHoldLibrary')
       GROUP BY s.id, s.title, s.url
       ORDER BY items DESC, s.title`,
    );
    if (phl.length > 0) {
      const withItems = phl.filter((r) => Number(r.items ?? 0) > 0).length;
      notices.push({
        id: 'retention',
        level: 'warn',
        title: `Active retention on ${phl.length} sites`,
        body:
          'These sites have a "Preservation Hold Library": at some point a retention policy ' +
          'or legal hold (Microsoft Purview) was applied. While retention is active, SharePoint keeps a copy of what ' +
          'is deleted and that space still counts against quota: deleting historic versions or archiving to Cold may not free anything. ' +
          `Today ${withItems === 0 ? 'none have retained content' : `${withItems} have retained content`}. ` +
          'In Purview → Data lifecycle management → Retention policies, review which policy covers ' +
          'SharePoint, which sites it applies to, and for how long, and decide whether to exclude sites or shorten it. ' +
          'The Lab shows, for each test, whether the Preservation Hold Library grew.',
        links: [
          { label: 'Open Microsoft Purview', href: 'https://purview.microsoft.com/' },
          {
            label: 'How retention works in SharePoint',
            href: 'https://learn.microsoft.com/en-us/purview/retention-policies-sharepoint',
          },
        ],
        sites: phl.map((r) => ({
          siteId: Number(r.site_id),
          title: r.title,
          url: r.url,
          detail: `${Number(r.items ?? 0)} retained items`,
        })),
      });
    }

    // Audit permissions for "last access": the audit ingestion marks audit.status.consented once it can read.
    const audit = await getSetting<{ consented?: boolean }>('audit.status');
    if (!audit?.consented) {
      notices.push({
        id: 'audit-consent',
        level: 'info',
        title: 'Audit permissions not yet granted (last access)',
        body:
          'To know when each file was last opened, the app needs to read Microsoft 365 audit logs. ' +
          'A Global Admin must grant consent to the "SpoStorage Collector Cloud" app ' +
          '(ActivityFeed.Read and AuditLogsQuery-SharePoint.Read.All). Until then, "inactive" policies use the modified date.',
        links: [
          {
            label: 'Grant consent in Entra (Admin consent)',
            href: `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${appOnlyClientId() ?? ''}/isMSAApp~/false`,
          },
        ],
        sites: [],
      });
    }

    return { notices };
  });
}
