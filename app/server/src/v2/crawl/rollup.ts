import { db } from '../db.js';
import { getEngineSettings } from '../settings.js';

/**
 * Recomputes spo.library_rollups for one library from spo.files (index ix_files_library).
 * Age buckets use total_bytes (current + versions): archiving a file frees all of it.
 */
export async function computeLibraryRollup(libraryId: number): Promise<void> {
  const { heavyVersionsThresholdBytes } = await getEngineSettings();
  const d = await db();
  await d.exec(
    `DECLARE @now DATETIME2(3) = SYSUTCDATETIME();
     MERGE spo.library_rollups AS t
     USING (
       SELECT l.id AS library_id, l.site_id,
         COUNT_BIG(f.id) AS file_count,
         ISNULL(SUM(f.size_bytes), 0) AS current_bytes,
         ISNULL(SUM(COALESCE(f.total_bytes, f.size_bytes)), 0) AS total_bytes,
         ISNULL(SUM(f.versions_bytes), 0) AS versions_bytes,
         ISNULL(SUM(CASE WHEN f.versions_bytes >= @heavy THEN 1 ELSE 0 END), 0) AS heavy_versions_files,
         ISNULL(SUM(CASE WHEN f.versions_bytes >= @heavy THEN f.versions_bytes ELSE 0 END), 0) AS heavy_versions_bytes,
         ISNULL(SUM(CASE WHEN f.modified_at >= DATEADD(day, -30, @now) THEN COALESCE(f.total_bytes, f.size_bytes) ELSE 0 END), 0) AS age_30_bytes,
         ISNULL(SUM(CASE WHEN f.modified_at < DATEADD(day, -30, @now) AND f.modified_at >= DATEADD(day, -120, @now) THEN COALESCE(f.total_bytes, f.size_bytes) ELSE 0 END), 0) AS age_120_bytes,
         ISNULL(SUM(CASE WHEN f.modified_at < DATEADD(day, -120, @now) AND f.modified_at >= DATEADD(day, -365, @now) THEN COALESCE(f.total_bytes, f.size_bytes) ELSE 0 END), 0) AS age_365_bytes,
         ISNULL(SUM(CASE WHEN f.modified_at < DATEADD(day, -365, @now) AND f.modified_at >= DATEADD(day, -730, @now) THEN COALESCE(f.total_bytes, f.size_bytes) ELSE 0 END), 0) AS age_730_bytes,
         ISNULL(SUM(CASE WHEN f.modified_at < DATEADD(day, -730, @now) OR f.modified_at IS NULL THEN COALESCE(f.total_bytes, f.size_bytes) ELSE 0 END), 0) AS age_old_bytes
       FROM spo.libraries l
       LEFT JOIN spo.files f ON f.library_id = l.id AND f.deleted_at IS NULL
       WHERE l.id = @libraryId
       GROUP BY l.id, l.site_id
     ) AS s ON t.library_id = s.library_id
     WHEN MATCHED THEN UPDATE SET site_id = s.site_id, file_count = s.file_count, current_bytes = s.current_bytes,
       total_bytes = s.total_bytes, versions_bytes = s.versions_bytes, heavy_versions_files = s.heavy_versions_files,
       heavy_versions_bytes = s.heavy_versions_bytes, age_30_bytes = s.age_30_bytes, age_120_bytes = s.age_120_bytes,
       age_365_bytes = s.age_365_bytes, age_730_bytes = s.age_730_bytes, age_old_bytes = s.age_old_bytes, computed_at = @now
     WHEN NOT MATCHED THEN INSERT (library_id, site_id, file_count, current_bytes, total_bytes, versions_bytes,
       heavy_versions_files, heavy_versions_bytes, age_30_bytes, age_120_bytes, age_365_bytes, age_730_bytes, age_old_bytes, computed_at)
       VALUES (s.library_id, s.site_id, s.file_count, s.current_bytes, s.total_bytes, s.versions_bytes,
       s.heavy_versions_files, s.heavy_versions_bytes, s.age_30_bytes, s.age_120_bytes, s.age_365_bytes, s.age_730_bytes, s.age_old_bytes, @now);`,
    { libraryId, heavy: heavyVersionsThresholdBytes },
  );
}
