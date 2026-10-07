/**
 * Policy action executors (docs/PLAN-V2.md §4.5–4.7). All destructive steps are PERMANENT and each
 * executor collects evidence before/after so the Lab can prove what happened:
 *  - delete_versions: DeleteByLabel, then versions list, SMTotalSize and recycle bin are re-read.
 *  - archive_file: stream SharePoint → Blob (QuickXorHash + SHA-256 verified against Graph and the blob), then
 *    archive-link.ts: .url link with the original permissions (deferred when the site has no space), permanent
 *    delete of the original, re-checks.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { db } from '../db.js';
import type { SpoClient } from '../spo/client.js';
import { spPath } from '../spo/client.js';
import { completeArchive, type ArchiveRow } from './archive-link.js';
import { blobPathFor, ensureContainer, type ArchiveSettings } from './blob.js';
import { QuickXorHash } from './quickxor.js';
import {
  aclSnapshot,
  deleteVersionByLabel,
  fileExists,
  findInRecycleBin,
  graphQuickXorHash,
  hasUniquePermissions,
  hostPath,
  isUrlTooLong,
  listVersions,
  preservationHoldItemCount,
  readItemSizes,
  readRoleAssignments,
} from './sp-ops.js';

export type VerifyLevel = 'full' | 'basic';

export interface FileTarget {
  fileId: number | null;
  siteId: number;
  siteUrl: string;
  webUrl: string;
  listGuid: string;
  listItemId: number;
  /** File UniqueId: addresses the file when its path makes the REST URL too long. */
  uniqueId?: string | null;
  url: string; // server-relative
  name: string;
  sizeBytes: number;
  modifiedAt: string | null;
  editor: string | null;
}

export interface ActionOutcome {
  status: 'done' | 'skipped' | 'failed';
  bytes: number;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface VersionRule {
  /** Keep this many most recent historic versions (0 = delete all historic versions). */
  keepLatest?: number;
  /** Only versions created more than N days ago. */
  olderThanDays?: number;
  /** Only these labels (lab). */
  labels?: string[];
}

export function pickVersionsToDelete<T extends { id: number; label: string; created: string | null }>(versions: T[], rule: VersionRule, now = new Date()): T[] {
  const sorted = [...versions].sort((a, b) => a.id - b.id); // oldest first
  const keep = Math.max(0, rule.keepLatest ?? 0);
  let candidates = keep > 0 ? sorted.slice(0, Math.max(0, sorted.length - keep)) : sorted;
  if (rule.olderThanDays !== undefined) {
    const limit = now.getTime() - rule.olderThanDays * 86_400_000;
    candidates = candidates.filter((v) => v.created !== null && new Date(v.created).getTime() < limit);
  }
  if (rule.labels?.length) candidates = candidates.filter((v) => rule.labels!.includes(v.label));
  return candidates;
}

export async function executeDeleteVersions(
  spo: SpoClient,
  target: FileTarget,
  rule: VersionRule,
  verify: VerifyLevel,
  signal?: AbortSignal,
): Promise<ActionOutcome> {
  const started = new Date();
  const before = await listVersions(spo, target.webUrl, target.url, signal, target.uniqueId);
  const toDelete = pickVersionsToDelete(before, rule);
  if (toDelete.length === 0) {
    return { status: 'skipped', bytes: 0, detail: 'No versions match the rule', evidence: { before: before.map((v) => v.label) } };
  }
  const sizesBefore = verify === 'full' ? await readItemSizes(spo, target.webUrl, target.listGuid, target.listItemId, signal) : null;
  const phlBefore = verify === 'full' ? await preservationHoldItemCount(spo, target.siteUrl, signal) : null;

  const deleted: Array<{ label: string; size: number }> = [];
  for (const v of toDelete) {
    signal?.throwIfAborted();
    await deleteVersionByLabel(spo, target.webUrl, target.url, v.label, signal, target.uniqueId);
    deleted.push({ label: v.label, size: v.size });
  }

  const after = await listVersions(spo, target.webUrl, target.url, signal, target.uniqueId);
  const stillThere = deleted.filter((d) => after.some((a) => a.label === d.label)).map((d) => d.label);
  const evidence: Record<string, unknown> = {
    startedAt: started.toISOString(),
    before: before.map((v) => ({ label: v.label, size: v.size })),
    deleted,
    after: after.map((v) => ({ label: v.label, size: v.size })),
    stillThere,
  };
  let freed = deleted.reduce((a, d) => a + d.size, 0);
  const problems: string[] = [];
  if (stillThere.length) problems.push(`versions still present: ${stillThere.join(', ')}`);

  if (verify === 'full') {
    const sizesAfter = await readItemSizes(spo, target.webUrl, target.listGuid, target.listItemId, signal);
    const recycle = await findInRecycleBin(spo, target.siteUrl, target.name, started, signal);
    const phlAfter = await preservationHoldItemCount(spo, target.siteUrl, signal);
    evidence.totalBytesBefore = sizesBefore?.total ?? null;
    evidence.totalBytesAfter = sizesAfter?.total ?? null;
    evidence.recycleBinEntries = recycle;
    evidence.preservationHoldBefore = phlBefore;
    evidence.preservationHoldAfter = phlAfter;
    if (sizesBefore?.total != null && sizesAfter?.total != null) freed = sizesBefore.total - sizesAfter.total;
    if (recycle.length) problems.push(`${recycle.length} recycle bin entries appeared`);
    if (phlBefore !== null && phlAfter !== null && phlAfter > phlBefore) {
      problems.push(`Preservation Hold Library grew (${phlBefore} → ${phlAfter}): retention is keeping deleted content`);
    }
  }
  evidence.problems = problems;
  if (target.fileId) {
    const d = await db();
    await d.exec(
      `DELETE FROM spo.file_versions WHERE file_id = @id AND label IN (SELECT value FROM OPENJSON(@labels));
       UPDATE spo.files SET versions_scanned_at = NULL, total_bytes = CASE WHEN total_bytes IS NULL THEN NULL ELSE total_bytes - @freed END WHERE id = @id`,
      { id: target.fileId, labels: JSON.stringify(deleted.map((x) => x.label)), freed: Math.max(0, freed) },
    );
  }
  return {
    status: problems.length ? 'failed' : 'done',
    bytes: Math.max(0, freed),
    detail: problems.length
      ? `Deleted ${deleted.length} versions with notes: ${problems.join('; ')}`
      : `Permanently deleted ${deleted.length} versions (${deleted.map((x) => x.label).join(', ')})`,
    evidence,
  };
}

/** Sites that just refused a link for lack of space: skip the doomed attempt for a while (siteId → until). */
const noSpaceSites = new Map<number, number>();
const NO_SPACE_MEMORY_MS = 10 * 60_000;

export async function executeArchiveFile(
  spo: SpoClient,
  target: FileTarget,
  settings: ArchiveSettings,
  ctx: { runId: number | null; archivedBy: string; verify: VerifyLevel; signal?: AbortSignal; onBytes?: (bytes: number) => void },
): Promise<ActionOutcome> {
  const { signal, verify } = ctx;
  const d = await db();
  const started = new Date();
  const existing = await d.one<{ id: number; state: string }>(`SELECT id, state FROM spo.archived_files WHERE original_url = @url`, { url: target.url });
  if (existing?.state === 'original_deleted') {
    return { status: 'skipped', bytes: 0, detail: 'Already archived', evidence: { archivedId: existing.id } };
  }
  if (target.sizeBytes > settings.maxFileBytes) {
    return { status: 'skipped', bytes: 0, detail: `Exceeds automatic archive max size (${settings.maxFileBytes} bytes)`, evidence: {} };
  }
  if (!(await fileExists(spo, target.webUrl, target.url, signal, target.uniqueId))) {
    return { status: 'skipped', bytes: 0, detail: 'The file no longer exists in SharePoint', evidence: {} };
  }

  // 1. Facts before touching anything.
  const graph = await graphQuickXorHash(spo, hostPath(target.webUrl), target.listGuid, target.listItemId, signal).catch(() => ({ hash: null, size: null }));
  const sizesBefore = await readItemSizes(spo, target.webUrl, target.listGuid, target.listItemId, signal);
  const unique = await hasUniquePermissions(spo, target.webUrl, target.url, signal, target.uniqueId);
  const assignments = await readRoleAssignments(spo, target.webUrl, target.url, signal, target.uniqueId);
  const phlBefore = verify === 'full' ? await preservationHoldItemCount(spo, target.siteUrl, signal) : null;

  // 2. Stream SharePoint → Blob, hashing on the way.
  const blobPath = blobPathFor(target.siteUrl, target.url);
  const container = await ensureContainer(settings);
  const blob = container.getBlockBlobClient(blobPath);
  const res = await spo
    .download(`${target.webUrl}/_api/web/GetFileByServerRelativePath(decodedurl='${spPath(target.url)}')/$value`, signal)
    .catch((err: unknown) => {
      if (target.uniqueId && isUrlTooLong(err)) return spo.download(`${target.webUrl}/_api/web/GetFileById('${target.uniqueId}')/$value`, signal);
      throw err;
    });
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const qx = new QuickXorHash();
  const sha = createHash('sha256');
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      qx.update(chunk);
      sha.update(chunk);
      bytes += chunk.length;
      ctx.onBytes?.(chunk.length);
      cb(null, chunk);
    },
  });
  const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>).pipe(hasher);
  await blob.uploadStream(source, 8 * 1024 * 1024, 4, {
    abortSignal: signal,
    tier: settings.tier,
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: {
      sourceurl: encodeURIComponent(target.url).slice(0, 2000),
      site: encodeURIComponent(target.siteUrl).slice(0, 500),
      listitem: `${target.listGuid}:${target.listItemId}`,
    },
  });
  const sha256 = sha.digest('hex');
  const quickXor = qx.digestBase64();
  const props = await blob.getProperties({ abortSignal: signal });
  await blob.setMetadata({ ...(props.metadata ?? {}), sha256, quickxor: quickXor }, { abortSignal: signal });

  const integrity = {
    bytesRead: bytes,
    sharePointSize: graph.size ?? sizesBefore?.size ?? null,
    blobSize: props.contentLength ?? null,
    blobTier: props.accessTier ?? null,
    quickXorComputed: quickXor,
    quickXorSharePoint: graph.hash,
    sha256,
  };
  const problems: string[] = [];
  if (integrity.sharePointSize !== null && integrity.sharePointSize !== bytes) problems.push('bytes read do not match SharePoint');
  if (integrity.blobSize !== bytes) problems.push('blob size does not match bytes read');
  if (graph.hash && graph.hash !== quickXor) problems.push('QuickXor hash does not match SharePoint');
  if (problems.length) {
    return {
      status: 'failed',
      bytes: 0,
      detail: `Blob copy not verified: ${problems.join('; ')}. The original was NOT modified.`,
      evidence: { integrity, blobPath },
    };
  }

  // 3. Record, then leave the link with the original permissions.
  const row = await d.one<{ id: number }>(
    `MERGE spo.archived_files AS t USING (SELECT @url AS original_url) AS s ON t.original_url = s.original_url
     WHEN MATCHED THEN UPDATE SET blob_path = @blobPath, sha256 = @sha256, size_bytes = @size, unique_perms = @unique, acl_json = @acl, link_error = NULL,
       state = N'uploaded', archived_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT (file_id, site_id, original_url, web_url, name, extension, size_bytes, sha256, content_type,
       blob_container, blob_path, blob_tier, unique_perms, acl_json, original_modified_at, original_modified_by, state, run_id, archived_by, archived_at)
       VALUES (@fileId, @siteId, @url, @webUrl, @name, @ext, @size, @sha256, @contentType, @container, @blobPath, @tier,
         @unique, @acl, @modifiedAt, @editor, N'uploaded', @runId, @archivedBy, SYSUTCDATETIME())
     OUTPUT inserted.id;`,
    {
      url: target.url,
      fileId: target.fileId,
      siteId: target.siteId,
      webUrl: target.webUrl,
      name: target.name,
      ext: path.extname(target.name).toLowerCase() || null,
      size: bytes,
      sha256,
      contentType,
      container: settings.container,
      blobPath,
      tier: String(props.accessTier ?? settings.tier),
      unique: unique ? 1 : 0,
      acl: JSON.stringify(aclSnapshot(assignments)),
      modifiedAt: target.modifiedAt ? new Date(target.modifiedAt) : null,
      editor: target.editor,
      runId: ctx.runId,
      archivedBy: ctx.archivedBy,
    },
  );
  const archivedId = row!.id;
  const archived = await d.one<ArchiveRow>(
    `SELECT a.id, a.site_id, a.file_id, a.web_url, a.original_url, a.name, a.size_bytes, a.sha256, a.blob_container, a.blob_path,
            a.link_url, a.unique_perms, a.acl_json, a.state, a.archived_at FROM spo.archived_files a WHERE a.id = @id`,
    { id: archivedId },
  );
  const result = await completeArchive(spo, archived!, {
    portalBaseUrl: settings.portalBaseUrl,
    verify,
    reverify: false, // the copy was verified a moment ago in this same call
    siteBlocked: (noSpaceSites.get(target.siteId) ?? 0) > Date.now(),
    assignments,
    target,
    uniqueId: target.uniqueId,
    siteUrl: target.siteUrl,
    startedAt: started,
    freedBytes: sizesBefore?.total ?? bytes,
    phlBefore,
    signal,
  });
  if (result.noSpace && !result.linked) noSpaceSites.set(target.siteId, Date.now() + NO_SPACE_MEMORY_MS);
  else if (result.linked) noSpaceSites.delete(target.siteId);
  return { ...result.outcome, evidence: { ...result.outcome.evidence, integrity, blobPath, permissions: { unique, acl: aclSnapshot(assignments) } } };
}
