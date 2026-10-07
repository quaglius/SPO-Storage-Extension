/**
 * Second half of archiving a file: leave the .url link (with the original permissions) and permanently delete
 * the original. Shared by the policy run (right after the blob copy) and by the 'archive-complete-links' task.
 *
 * A site that is over quota (HTTP 507) or read-only cannot take the .url file, and deleting the original is what
 * frees the space. So when the link cannot be written, the original is deleted anyway (the blob copy is verified
 * and the ACL is stored) and the link is left pending: archived_files.state = 'original_deleted' with
 * link_url NULL. Running the task again creates it. The blob is never touched here.
 *
 * Fail-closed order: everything that can be checked without side effects (blob, original unchanged, ACL
 * resolvable) is checked BEFORE the original is deleted; after the delete nothing throws.
 */
import path from 'node:path';
import { db } from '../db.js';
import type { SpoClient } from '../spo/client.js';
import { containerClient, getArchiveSettings } from './blob.js';
import type { ActionOutcome, FileTarget, VerifyLevel } from './execute.js';
import {
  aclKeys,
  aclSnapshot,
  applyRoleAssignments,
  assignmentsFromStoredAcl,
  deleteFilePermanently,
  fileExists,
  findInRecycleBin,
  graphQuickXorHash,
  hasUniquePermissions,
  hostPath,
  isNoSpaceError,
  parseStoredAcl,
  preservationHoldItemCount,
  readFileInfo,
  readRoleAssignments,
  readRoleDefinitions,
  uploadSmallFile,
  type RoleAssignment,
} from './sp-ops.js';

/** Columns of spo.archived_files needed to finish an archive. */
export interface ArchiveRow {
  id: number;
  site_id: number;
  file_id: number | null;
  web_url: string;
  original_url: string;
  name: string;
  size_bytes: number;
  sha256: string;
  blob_container: string;
  blob_path: string;
  link_url: string | null;
  unique_perms: boolean | number;
  acl_json: string | null;
  state: string;
  archived_at: Date;
}

export const ARCHIVE_ROW_COLUMNS =
  'a.id, a.site_id, a.file_id, a.web_url, a.original_url, a.name, a.size_bytes, a.sha256, a.blob_container, a.blob_path, a.link_url, a.unique_perms, a.acl_json, a.state, a.archived_at';

export interface CompleteOptions {
  portalBaseUrl: string;
  verify: VerifyLevel;
  /** Re-check blob, original and ACL before touching anything (the task; the policy run has just done it). */
  reverify: boolean;
  /** Assignments already read from the original (policy run). Otherwise rebuilt from the stored ACL. */
  assignments?: RoleAssignment[] | null;
  /** Inventory identity of the file, for the Graph hash check. */
  target?: FileTarget | null;
  /** File UniqueId of the original, for paths too long for a REST URL. */
  uniqueId?: string | null;
  /** Site collection URL for the recycle bin / Preservation Hold checks (defaults to the library's web). */
  siteUrl?: string;
  /** The site already refused a link in this pass: skip the attempt before deleting. */
  siteBlocked?: boolean;
  /** Reads the archived blob's properties (Azure by default; replaced in tests). */
  readBlob?: (row: ArchiveRow) => Promise<{ contentLength?: number; metadata?: Record<string, string> }>;
  startedAt?: Date;
  /** Total bytes (versions included) the delete frees, when known. */
  freedBytes?: number | null;
  phlBefore?: number | null;
  signal?: AbortSignal;
}

export interface CompleteResult {
  outcome: ActionOutcome;
  linked: boolean;
  originalDeleted: boolean;
  /** This call deleted the original (as opposed to finding it already gone). */
  deletedNow: boolean;
  /** The site refused data (quota / read-only) at some point. */
  noSpace: boolean;
}

export class LinkVerificationError extends Error {}

export function linkContent(portalBaseUrl: string, archivedId: number): string {
  return `[InternetShortcut]\r\nURL=${portalBaseUrl.replace(/\/$/, '')}/archive/${archivedId}\r\n`;
}

async function resolveAssignments(spo: SpoClient, row: ArchiveRow, signal?: AbortSignal): Promise<RoleAssignment[]> {
  const acl = parseStoredAcl(row.acl_json);
  if (!acl) throw new Error('The stored permissions of the original are missing or unreadable.');
  const { assignments, missingRoles } = assignmentsFromStoredAcl(acl, await readRoleDefinitions(spo, row.web_url, signal));
  if (missingRoles.length) throw new Error(`Permission levels no longer exist in the site: ${missingRoles.join(', ')}.`);
  return assignments;
}

/**
 * Creates the .url link and gives it the original's permissions. A link that cannot be verified is deleted, so a
 * link with the wrong permissions never stays in SharePoint.
 */
export async function createArchiveLink(
  spo: SpoClient,
  row: ArchiveRow,
  portalBaseUrl: string,
  assignments: RoleAssignment[] | null,
  signal?: AbortSignal,
): Promise<string> {
  const unique = Boolean(row.unique_perms);
  const folder = path.posix.dirname(row.original_url);
  const linkUrl = await uploadSmallFile(spo, row.web_url, folder, `${row.name}.url`, linkContent(portalBaseUrl, row.id), signal);
  try {
    if (unique) {
      if (!assignments) throw new Error('Permissions to apply are missing.');
      await applyRoleAssignments(spo, row.web_url, linkUrl, assignments, signal);
    }
    const linkUnique = await hasUniquePermissions(spo, row.web_url, linkUrl, signal);
    if (linkUnique !== unique) throw new LinkVerificationError('Link permission inheritance does not match the original file.');
    if (unique) {
      const want = aclKeys(parseStoredAcl(row.acl_json) ?? []);
      const got = aclKeys(aclSnapshot(await readRoleAssignments(spo, row.web_url, linkUrl, signal)));
      if (want.length !== got.length || want.some((k, i) => k !== got[i])) {
        throw new LinkVerificationError('Link permissions do not match the original file.');
      }
    }
    return linkUrl;
  } catch (err) {
    await deleteFilePermanently(spo, row.web_url, linkUrl).catch(() => undefined);
    throw err;
  }
}

const defaultReadBlob = (signal?: AbortSignal) => async (row: ArchiveRow) => {
  const settings = await getArchiveSettings();
  return containerClient({ ...settings, container: row.blob_container }).getBlobClient(row.blob_path).getProperties({ abortSignal: signal });
};

/** Why the original must NOT be deleted, or null when blob and original check out. */
async function reverifyBeforeDelete(spo: SpoClient, row: ArchiveRow, opts: CompleteOptions): Promise<string | null> {
  let props: { contentLength?: number; metadata?: Record<string, string> };
  try {
    props = await (opts.readBlob ?? defaultReadBlob(opts.signal))(row);
  } catch (err) {
    return `The archived copy cannot be read from storage: ${(err as Error).message}`;
  }
  if (props.contentLength !== Number(row.size_bytes)) return 'The archived copy has a different size than recorded.';
  if (props.metadata?.sha256 !== row.sha256) return 'The archived copy does not carry the recorded SHA-256.';

  if (!(await fileExists(spo, row.web_url, row.original_url, opts.signal, opts.uniqueId))) return 'The original no longer exists in SharePoint.';
  const info = await readFileInfo(spo, row.web_url, row.original_url, opts.signal, opts.uniqueId);
  if (info.length !== Number(row.size_bytes)) return 'The original changed after it was archived (size differs).';
  if (info.modified && Date.parse(info.modified) > new Date(row.archived_at).getTime()) {
    return 'The original was modified after it was archived.';
  }
  const t = opts.target;
  if (t) {
    const graph = await graphQuickXorHash(spo, hostPath(t.webUrl), t.listGuid, t.listItemId, opts.signal).catch(() => ({ hash: null, size: null }));
    const archived = props.metadata?.quickxor;
    if (graph.hash && archived && graph.hash !== archived) return 'The original changed after it was archived (hash differs).';
  }
  return null;
}

export async function setLinkError(id: number, message: string): Promise<void> {
  const d = await db();
  await d.exec(`UPDATE spo.archived_files SET link_error = @m, link_attempted_at = SYSUTCDATETIME() WHERE id = @id`, { id, m: message.slice(0, 2000) });
}

async function setLinked(id: number, linkUrl: string, state: string): Promise<void> {
  const d = await db();
  await d.exec(
    `UPDATE spo.archived_files SET link_url = @linkUrl, state = @state, link_error = NULL, link_attempted_at = SYSUTCDATETIME() WHERE id = @id`,
    { id, linkUrl, state },
  );
}

const failed = (detail: string, evidence: Record<string, unknown>): ActionOutcome => ({ status: 'failed', bytes: 0, detail, evidence });

export async function completeArchive(spo: SpoClient, row: ArchiveRow, opts: CompleteOptions): Promise<CompleteResult> {
  const d = await db();
  const { signal } = opts;
  const started = opts.startedAt ?? new Date();
  const evidence: Record<string, unknown> = { archivedId: row.id, startedAt: started.toISOString() };
  const done = (outcome: ActionOutcome, r: Partial<Omit<CompleteResult, 'outcome'>> = {}): CompleteResult => ({
    outcome,
    linked: r.linked ?? false,
    originalDeleted: r.originalDeleted ?? false,
    deletedNow: r.deletedNow ?? false,
    noSpace: r.noSpace ?? false,
  });
  let linkUrl = row.link_url;
  let noSpace = false;

  // 1. Only the link is missing (the original is already gone).
  if (row.state === 'original_deleted') {
    if (linkUrl) return done({ status: 'skipped', bytes: 0, detail: 'Already archived with its link', evidence }, { linked: true, originalDeleted: true });
    try {
      linkUrl = await createArchiveLink(spo, row, opts.portalBaseUrl, Boolean(row.unique_perms) ? await resolveAssignments(spo, row, signal) : null, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      const message = (err as Error).message;
      await setLinkError(row.id, message);
      return done(failed(`Link still pending: ${message}`, { ...evidence, linkError: message }), { originalDeleted: true, noSpace: isNoSpaceError(err) });
    }
    await setLinked(row.id, linkUrl, 'original_deleted');
    return done({ status: 'done', bytes: 0, detail: `Link created at ${linkUrl}`, evidence: { ...evidence, linkUrl } }, { linked: true, originalDeleted: true });
  }

  // 2. The original still exists: check everything that has no side effects before touching it.
  if (opts.reverify) {
    const problem = await reverifyBeforeDelete(spo, row, opts);
    if (problem) {
      await setLinkError(row.id, problem);
      return done({ status: 'skipped', bytes: 0, detail: `${problem} The original was NOT deleted.`, evidence: { ...evidence, problem } });
    }
  }
  let assignments = opts.assignments ?? null;
  if (Boolean(row.unique_perms) && !linkUrl && !assignments) {
    try {
      assignments = await resolveAssignments(spo, row, signal);
    } catch (err) {
      const message = (err as Error).message;
      await setLinkError(row.id, message);
      return done(failed(`${message} The original was NOT deleted.`, { ...evidence, problem: message }));
    }
  }

  // 3. Link first when the site takes it; otherwise it waits until the original is gone.
  if (!linkUrl && !opts.siteBlocked) {
    try {
      linkUrl = await createArchiveLink(spo, row, opts.portalBaseUrl, assignments, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (isNoSpaceError(err)) {
        noSpace = true;
      } else if (err instanceof LinkVerificationError) {
        await setLinkError(row.id, err.message);
        return done(failed(`${err.message} The original was NOT deleted.`, { ...evidence, problem: err.message }));
      } else {
        throw err;
      }
    }
  } else if (!linkUrl) {
    noSpace = true;
  }
  if (linkUrl) await setLinked(row.id, linkUrl, 'linked');

  // 4. Permanent delete of the original, then re-check.
  await deleteFilePermanently(spo, row.web_url, row.original_url, signal, opts.uniqueId);
  const stillExists = await fileExists(spo, row.web_url, row.original_url, signal, opts.uniqueId);
  const problems: string[] = [];
  evidence.linkUrl = linkUrl;
  evidence.originalStillExists = stillExists;
  if (stillExists) problems.push('the original still exists');
  if (opts.verify === 'full') {
    const recycle = await findInRecycleBin(spo, opts.siteUrl ?? row.web_url, row.name, started, signal);
    const phlAfter = await preservationHoldItemCount(spo, opts.siteUrl ?? row.web_url, signal);
    evidence.recycleBinEntries = recycle;
    evidence.preservationHoldBefore = opts.phlBefore ?? null;
    evidence.preservationHoldAfter = phlAfter;
    if (recycle.length) problems.push(`the original appeared in the recycle bin (${recycle.length} entries)`);
    if (opts.phlBefore != null && phlAfter !== null && phlAfter > opts.phlBefore) {
      problems.push(`Preservation Hold Library grew (${opts.phlBefore} → ${phlAfter}): retention is keeping the file`);
    }
  }
  if (stillExists) {
    // Delete refused: with a link the row is 'failed' as always; without one it simply waits for the next pass.
    await d.exec(`UPDATE spo.archived_files SET state = CASE WHEN link_url IS NULL THEN N'uploaded' ELSE N'failed' END WHERE id = @id`, { id: row.id });
    evidence.problems = problems;
    return done(failed(`Archived with notes: ${problems.join('; ')}`, evidence), { linked: Boolean(linkUrl), noSpace });
  }
  await d.exec(
    `UPDATE spo.archived_files SET state = N'original_deleted' WHERE id = @id;
     UPDATE spo.files SET deleted_at = SYSUTCDATETIME(), archived_id = @id WHERE id = @fileId`,
    { id: row.id, fileId: row.file_id },
  );

  // 5. Original gone: the link can finally be written. Nothing after this point throws.
  if (!linkUrl) {
    try {
      linkUrl = await createArchiveLink(spo, row, opts.portalBaseUrl, assignments, signal);
      await setLinked(row.id, linkUrl, 'original_deleted');
      evidence.linkUrl = linkUrl;
    } catch (err) {
      const message = (err as Error).message;
      noSpace = noSpace || isNoSpaceError(err);
      evidence.linkError = message;
      await setLinkError(row.id, message).catch(() => undefined);
    }
  }
  evidence.problems = problems;
  const freed = opts.freedBytes ?? Number(row.size_bytes);
  const linkNote = linkUrl ? `link at ${linkUrl}` : `link pending (${String(evidence.linkError ?? 'not created')})`;
  return done(
    {
      status: problems.length ? 'failed' : 'done',
      bytes: freed,
      detail: problems.length
        ? `Archived with notes: ${problems.join('; ')}`
        : `Archived (${Number(row.size_bytes)} verified bytes) and original deleted; ${linkNote}`,
      evidence,
    },
    { linked: Boolean(linkUrl), originalDeleted: true, deletedNow: true, noSpace },
  );
}
