/**
 * L4: version detail only for files whose historic versions weigh at least heavyVersionsThresholdBytes.
 * Batches of files per execution; recurring task 'file-versions' on target 'library:<id>' (shares the target
 * with 'library-scan' so both never run on the same library at once).
 */
import { db, sqlDate } from '../db.js';
import type { TaskHandler } from '../engine/types.js';
import { getEngineSettings } from '../settings.js';
import { onFile } from '../actions/sp-ops.js';
import { isAccessDenied, isNotFound, SpoError } from '../spo/client.js';

const BATCH = 40;

interface VersionRow {
  ID?: number;
  VersionLabel?: string;
  Size?: string | number;
  Created?: string;
  CreatedBy?: { Email?: string; Title?: string };
}

export const fileVersions: TaskHandler = async (ctx) => {
  const settings = await getEngineSettings();
  const d = await db();
  const libraryId = ctx.task.library_id;
  const lib = await d.one<{ web_url: string; title: string; site_title: string | null; deleted_at: Date | null }>(
    `SELECT l.web_url, l.title, s.title AS site_title, l.deleted_at FROM spo.libraries l JOIN spo.sites s ON s.id = l.site_id WHERE l.id = @libraryId`,
    { libraryId },
  );
  if (!lib || lib.deleted_at) return { outcome: 'done' };

  const files = await d.all<{ id: number; server_relative_url: string; unique_id: string | null }>(
    `SELECT TOP (${BATCH}) id, server_relative_url, CAST(unique_id AS NVARCHAR(36)) AS unique_id FROM spo.files
     WHERE library_id = @libraryId AND deleted_at IS NULL AND versions_bytes >= @heavy
       AND (versions_scanned_at IS NULL OR versions_scanned_at < modified_at
            OR versions_scanned_at < DATEADD(day, -@rescanDays, SYSUTCDATETIME()))
     ORDER BY versions_bytes DESC`,
    { libraryId, heavy: settings.heavyVersionsThresholdBytes, rescanDays: settings.versionsRescanDays },
  );
  if (files.length === 0) {
    return { outcome: 'again', afterMs: 6 * 3_600_000 };
  }

  ctx.status(`Reading versions for ${files.length} heavy files in ${lib.title} (${lib.site_title ?? 'site'})`);
  for (const f of files) {
    ctx.signal.throwIfAborted();
    let versions: VersionRow[] = [];
    try {
      const res = await onFile(lib.web_url, f.server_relative_url, f.unique_id, (u) =>
        ctx.spo.get<{ value: VersionRow[] }>(u('/Versions?$select=ID,VersionLabel,Size,Created'), ctx.signal),
      );
      versions = res.value ?? [];
    } catch (err) {
      if (isNotFound(err)) {
        await d.exec(`UPDATE spo.files SET deleted_at = SYSUTCDATETIME() WHERE id = @id`, { id: f.id });
        continue;
      }
      if (isAccessDenied(err) || (err instanceof SpoError && !err.retryable)) {
        // Unreadable versions (access, locked or odd items): remember the attempt and move on.
        await d.exec(`UPDATE spo.files SET versions_scanned_at = SYSUTCDATETIME() WHERE id = @id`, { id: f.id });
        await ctx.event({ level: 'warn', kind: 'versions-unreadable', message: `Could not read versions for ${f.server_relative_url}: ${(err as Error).message}`.slice(0, 1000) });
        continue;
      }
      throw err;
    }
    const rows = versions.map((v) => ({
      versionId: Number(v.ID ?? 0),
      label: String(v.VersionLabel ?? '').slice(0, 20),
      size: Number(v.Size ?? 0) || 0,
      created: sqlDate(v.Created),
      createdBy: (v.CreatedBy?.Email || v.CreatedBy?.Title || null)?.slice(0, 200) ?? null,
    }));
    await d.execJson(
      `DELETE FROM spo.file_versions WHERE file_id = @fileId;
       INSERT INTO spo.file_versions (file_id, version_id, label, size_bytes, created_at, created_by, captured_at)
       SELECT @fileId, versionId, label, size, created, createdBy, SYSUTCDATETIME()
       FROM OPENJSON(@json) WITH (versionId INT, label NVARCHAR(20), size BIGINT, created DATETIME2(3), createdBy NVARCHAR(200));
       UPDATE spo.files SET version_count = @count, versions_scanned_at = SYSUTCDATETIME() WHERE id = @fileId;`,
      rows,
      { fileId: f.id, count: rows.length + 1 },
    );
    ctx.progress(1);
  }
  return { outcome: 'again', afterMs: 0 };
};
