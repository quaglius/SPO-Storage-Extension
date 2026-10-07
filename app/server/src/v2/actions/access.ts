/**
 * Who may download an archived file (docs/PLAN-V2.md §4.7): a platform admin (allowlist of Global Admins), or
 * anyone SharePoint says can open the .url link left in place — the link carries the original file's
 * permissions, so later permission changes on the folder or the link are honoured. No parent-folder fallback.
 */
import { getAdminAllowlist } from '../../config.js';
import { db } from '../db.js';
import type { SpoClient } from '../spo/client.js';
import { userCanOpen } from './sp-ops.js';

export interface AccessDecision {
  granted: boolean;
  reason: string;
}

export async function decideArchiveAccess(spo: SpoClient, archivedId: number, upn: string): Promise<AccessDecision> {
  const d = await db();
  const row = await d.one<{ web_url: string; link_url: string | null; state: string }>(
    `SELECT web_url, link_url, state FROM spo.archived_files WHERE id = @archivedId`,
    { archivedId },
  );
  let decision: AccessDecision;
  if (!row) {
    decision = { granted: false, reason: 'Does not exist' };
  } else if (getAdminAllowlist().some((a) => a.toLowerCase() === upn.toLowerCase())) {
    decision = { granted: true, reason: 'Platform administrator' };
  } else if (row.state === 'restored') {
    decision = { granted: false, reason: 'The file was restored to SharePoint: open it from its original folder' };
  } else if (!row.link_url) {
    decision = { granted: false, reason: 'The file has no link in SharePoint' };
  } else {
    const ok = await userCanOpen(spo, row.web_url, row.link_url, upn);
    decision = ok
      ? { granted: true, reason: 'Has SharePoint permission on the link' }
      : { granted: false, reason: 'No SharePoint permission' };
  }
  if (row) {
    await d.exec(
      `INSERT INTO spo.archive_access_log (archived_id, at, user_upn, granted, reason) VALUES (@archivedId, SYSUTCDATETIME(), @upn, @granted, @reason)`,
      { archivedId, upn: upn.slice(0, 200), granted: decision.granted ? 1 : 0, reason: decision.reason },
    );
  }
  return decision;
}
