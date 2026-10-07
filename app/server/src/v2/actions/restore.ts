/**
 * Restore an archived file from Blob Cold back to its original SharePoint location
 * (docs/ARCHIVE-LINK-SECURITY.md). Mirror image of executeArchiveFile, with the same rules:
 *  - never overwrite: the original path must be free;
 *  - upload in chunks, hashing on the way, and require SHA-256 = the one recorded when archiving;
 *  - give the file the permissions the .url link has *now* (so changes made meanwhile are kept);
 *  - only then delete the .url link (permanently);
 *  - resumable: restore_state 'uploaded' skips the upload on retry.
 * The blob is kept (soft delete + versioning protect it); archived_files.state becomes 'restored'.
 *
 * Engine task 'archive-restore' on target 'archived:<id>'.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { db } from '../db.js';
import { enqueue } from '../engine/queue.js';
import type { TaskHandler } from '../engine/types.js';
import type { SpoClient } from '../spo/client.js';
import { spPath } from '../spo/client.js';
import { containerClient, getArchiveSettings } from './blob.js';
import {
  applyRoleAssignments,
  assignableRoles,
  byAlias,
  byPath,
  deleteFilePermanently,
  fileExists,
  hasUniquePermissions,
  isUrlTooLong,
  readRoleAssignments,
  type FileUrl,
  type RoleAssignment,
} from './sp-ops.js';

const CHUNK = 10 * 1024 * 1024;

interface ArchivedRow {
  id: number;
  site_id: number;
  web_url: string;
  original_url: string;
  name: string;
  size_bytes: number;
  sha256: string;
  blob_container: string;
  blob_path: string;
  link_url: string | null;
  unique_perms: boolean;
  state: string;
  restore_state: string | null;
  restore_requested_by: string | null;
}

export class RestoreError extends Error {}

export async function requestRestore(archivedId: number, requestedBy: string): Promise<void> {
  const d = await db();
  const n = await d.exec(
    `UPDATE spo.archived_files
       SET restore_state = CASE WHEN restore_state = N'uploaded' THEN N'uploaded' ELSE N'requested' END,
           restore_requested_by = @by, restore_requested_at = SYSUTCDATETIME(), restore_error = NULL
     WHERE id = @id AND state = N'original_deleted'
       AND (restore_state IS NULL OR restore_state = N'failed' OR (restore_state = N'uploaded' AND restore_error IS NOT NULL))`,
    { id: archivedId, by: requestedBy.slice(0, 200) },
  );
  if (n === 0) throw new RestoreError('Only an archived file that is not already being restored can be restored.');
  await enqueue({ kind: 'archive-restore', targetKey: `archived:${archivedId}`, priority: 25, maxAttempts: 10 });
}

/**
 * Uploads a byte stream to a NEW SharePoint file (fails if it exists) in chunks:
 * StartUpload → ContinueUpload… → FinishUpload, or a single PUT of $value when it fits in one chunk.
 */
export async function uploadStreamToSharePoint(
  spo: SpoClient,
  webUrl: string,
  serverRelativeUrl: string,
  source: AsyncIterable<Buffer | Uint8Array>,
  opts: { signal?: AbortSignal; onBytes?: (n: number) => void; chunkSize?: number } = {},
): Promise<{ bytes: number; sha256: string }> {
  const chunkSize = opts.chunkSize ?? CHUNK;
  const { signal } = opts;
  const folder = path.posix.dirname(serverRelativeUrl);
  const name = path.posix.basename(serverRelativeUrl);
  // Create the (empty) file; overwrite=false guarantees we never replace something that appeared meanwhile.
  // A path that makes the URL too long is refused with maxUrlLength: the path then moves to the query string.
  let u: FileUrl = byPath(webUrl, serverRelativeUrl);
  const post = (url: string, body: Uint8Array, headers: Record<string, string>) => spo.request(url, { method: 'POST', body, headers, signal });
  const empty = new Uint8Array(0);
  const octet = { 'Content-Type': 'application/octet-stream' };
  try {
    await post(`${webUrl}/_api/web/GetFolderByServerRelativePath(decodedurl='${spPath(folder)}')/Files/AddUsingPath(decodedurl='${spPath(name)}',overwrite=false)`, empty, octet);
  } catch (err) {
    if (!isUrlTooLong(err)) throw err;
    u = byAlias(webUrl, serverRelativeUrl);
    await post(
      `${webUrl}/_api/web/GetFolderByServerRelativePath(decodedurl=@f)/Files/AddUsingPath(decodedurl=@n,overwrite=false)?@f='${spPath(folder)}'&@n='${spPath(name)}'`,
      empty,
      octet,
    );
  }

  const sha = createHash('sha256');
  const uploadId = randomUUID();
  let offset = 0;
  let started = false;
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  const send = async (chunk: Buffer, last: boolean) => {
    let suffix: string;
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (!started && last) {
      suffix = '/$value'; // whole file in one chunk: overwrite the empty file
      headers['X-HTTP-Method'] = 'PUT';
    } else if (!started) {
      suffix = `/StartUpload(uploadId=guid'${uploadId}')`;
    } else if (last) {
      suffix = `/FinishUpload(uploadId=guid'${uploadId}',fileOffset=${offset})`;
    } else {
      suffix = `/ContinueUpload(uploadId=guid'${uploadId}',fileOffset=${offset})`;
    }
    try {
      await post(u(suffix), new Uint8Array(chunk), headers);
    } catch (err) {
      // The suffix can push a path that was just short enough over the limit: nothing was processed, so retry it.
      if (!isUrlTooLong(err)) throw err;
      u = byAlias(webUrl, serverRelativeUrl);
      await post(u(suffix), new Uint8Array(chunk), headers);
    }
    started = true;
    offset += chunk.length;
    opts.onBytes?.(chunk.length);
  };

  for await (const part of source) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part);
    sha.update(buf);
    pending.push(buf);
    pendingBytes += buf.length;
    // Keep one full chunk in hand: only the last chunk may be sent with FinishUpload.
    while (pendingBytes > chunkSize) {
      const all = Buffer.concat(pending);
      await send(all.subarray(0, chunkSize), false);
      const rest = all.subarray(chunkSize);
      pending = [rest];
      pendingBytes = rest.length;
    }
  }
  await send(Buffer.concat(pending), true);
  return { bytes: offset, sha256: sha.digest('hex') };
}

async function uploadFromBlob(
  spo: SpoClient,
  row: ArchivedRow,
  signal: AbortSignal,
  onBytes: (n: number) => void,
): Promise<{ bytes: number; sha256: string }> {
  const settings = await getArchiveSettings();
  const blob = containerClient({ ...settings, container: row.blob_container }).getBlobClient(row.blob_path);
  const download = await blob.download(0, undefined, { abortSignal: signal });
  const stream = download.readableStreamBody;
  if (!stream) throw new Error('Blob returned no content');
  return uploadStreamToSharePoint(spo, row.web_url, row.original_url, stream as AsyncIterable<Buffer>, { signal, onBytes });
}

export const archiveRestore: TaskHandler = async (ctx) => {
  const archivedId = Number(ctx.task.target_key.split(':')[1]);
  const d = await db();
  const row = await d.one<ArchivedRow>(
    `SELECT id, site_id, web_url, original_url, name, size_bytes, sha256, blob_container, blob_path, link_url, unique_perms,
            state, restore_state, restore_requested_by
     FROM spo.archived_files WHERE id = @id`,
    { id: archivedId },
  );
  if (!row || !row.restore_state || row.restore_state === 'done') return { outcome: 'done' };

  /** keepUploaded: the file is already back in SharePoint; a retry must not upload it again. */
  const fail = async (message: string, keepUploaded = false) => {
    await d.exec(
      `UPDATE spo.archived_files SET restore_state = CASE WHEN @keep = 1 THEN N'uploaded' ELSE N'failed' END, restore_error = @m WHERE id = @id`,
      { id: archivedId, m: message.slice(0, 2000), keep: keepUploaded ? 1 : 0 },
    );
    await ctx.event({ level: 'warn', kind: 'archive-restore-failed', siteId: row.site_id, message: `Did not restore ${row.original_url}: ${message}`.slice(0, 1000) });
    return { outcome: 'done' as const };
  };

  // Permissions to give back: the ones the link carries today.
  let linkUnique = false;
  let assignments: RoleAssignment[] = [];
  const linkExists = row.link_url ? await fileExists(ctx.spo, row.web_url, row.link_url, ctx.signal) : false;
  if (linkExists && row.link_url) {
    linkUnique = await hasUniquePermissions(ctx.spo, row.web_url, row.link_url, ctx.signal);
    if (linkUnique) assignments = await readRoleAssignments(ctx.spo, row.web_url, row.link_url, ctx.signal);
  } else if (row.unique_perms) {
    return fail('The SharePoint link no longer exists and the file had unique permissions: they cannot be reconstructed safely.');
  }

  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString() };
  if (row.restore_state !== 'uploaded') {
    if (await fileExists(ctx.spo, row.web_url, row.original_url, ctx.signal)) {
      return fail('A file already exists at the original path; it will not be overwritten.');
    }
    ctx.status(`Restoring ${row.name} to SharePoint`);
    let up: { bytes: number; sha256: string };
    try {
      up = await uploadFromBlob(ctx.spo, row, ctx.signal, () => ctx.progress(0));
    } catch (err) {
      // Remove our partial upload so the retry starts clean (the path was verified free before).
      await deleteFilePermanently(ctx.spo, row.web_url, row.original_url).catch(() => undefined);
      throw err;
    }
    evidence.bytes = up.bytes;
    evidence.sha256 = up.sha256;
    if (up.bytes !== Number(row.size_bytes) || up.sha256 !== row.sha256) {
      await deleteFilePermanently(ctx.spo, row.web_url, row.original_url, ctx.signal).catch(() => undefined);
      return fail(`Uploaded copy does not match archived copy (bytes ${up.bytes}/${row.size_bytes}, sha256 mismatch: ${up.sha256 !== row.sha256}).`);
    }
    await d.exec(`UPDATE spo.archived_files SET restore_state = N'uploaded' WHERE id = @id`, { id: archivedId });
  }

  if (linkUnique) {
    await applyRoleAssignments(ctx.spo, row.web_url, row.original_url, assignments, ctx.signal);
    const got = assignableRoles(await readRoleAssignments(ctx.spo, row.web_url, row.original_url, ctx.signal)).map((x) => `${x.principalId}:${x.roleId}`);
    const want = assignableRoles(assignments).map((x) => `${x.principalId}:${x.roleId}`);
    if (got.length !== want.length || !want.every((k) => got.includes(k))) {
      return fail('Restored file permissions do not match the link; the link was left in place.', true);
    }
  }

  if (linkExists && row.link_url) await deleteFilePermanently(ctx.spo, row.web_url, row.link_url, ctx.signal);
  await d.exec(
    `UPDATE spo.archived_files SET state = N'restored', restore_state = N'done', restored_at = SYSUTCDATETIME(), restore_error = NULL WHERE id = @id;
     UPDATE spo.files SET archived_id = NULL WHERE archived_id = @id;`,
    { id: archivedId },
  );
  await ctx.event({
    level: 'info',
    kind: 'archive-restored',
    siteId: row.site_id,
    message: `Restored to SharePoint: ${row.original_url} (requested by ${row.restore_requested_by ?? 'admin'}).`.slice(0, 1000),
    data: { archivedId, ...evidence, permissions: linkUnique ? 'unique, copied from link' : 'inherited from folder' },
  });
  return { outcome: 'done' };
};
