/**
 * Planner: makes sure every piece of recurring work has exactly one open task. Set-based and idempotent;
 * runs every minute. Also re-arms tasks that failed for good a while ago (the engine never gives up).
 */
import { db } from '../db.js';
import { purgeEvents } from '../engine/events.js';
import { enqueue, purgeFinished, retryFailed } from '../engine/queue.js';
import type { TaskHandler } from '../engine/types.js';
import { getEngineSettings } from '../settings.js';

export const PRIORITY = {
  tenantUsage: 10,
  siteStructure: 20,
  libraryScan: 50,
  auditIngest: 70,
  fileVersions: 80,
  maintenance: 90,
} as const;

function isDuplicate(err: unknown): boolean {
  const n = (err as { number?: number }).number;
  return n === 2601 || n === 2627;
}

async function insertMissing(sql: string, params: Record<string, unknown>): Promise<void> {
  const d = await db();
  try {
    await d.exec(sql, params);
  } catch (err) {
    if (!isDuplicate(err)) throw err; // a concurrent planner won the race; next tick fills the rest
  }
}

export async function planRecurringWork(): Promise<void> {
  const settings = await getEngineSettings();
  await enqueue({ kind: 'tenant-usage', targetKey: 'tenant', priority: PRIORITY.tenantUsage });
  await enqueue({ kind: 'audit-ingest', targetKey: 'audit', priority: PRIORITY.auditIngest, maxAttempts: 20 });
  await enqueue({ kind: 'maintenance', targetKey: 'global', priority: PRIORITY.maintenance, runAfter: new Date(Date.now() + 3_600_000) });

  await insertMissing(
    `INSERT INTO spo.tasks (kind, target_key, site_id, state, priority, run_after)
     SELECT N'site-structure', CONCAT(N'site:', s.id), s.id, N'ready', @priority, SYSUTCDATETIME()
     FROM spo.sites s
     WHERE s.deleted_at IS NULL AND s.excluded = 0
       AND NOT EXISTS (SELECT 1 FROM spo.tasks t WHERE t.kind = N'site-structure' AND t.target_key = CONCAT(N'site:', s.id) AND (t.state IN (N'ready', N'leased') OR t.state = N'failed'))`,
    { priority: PRIORITY.siteStructure },
  );

  // Bigger sites first on the very first pass: stagger run_after by site size rank.
  await insertMissing(
    `INSERT INTO spo.tasks (kind, target_key, site_id, library_id, state, priority, run_after)
     SELECT N'library-scan', CONCAT(N'library:', l.id), l.site_id, l.id, N'ready', @priority,
            DATEADD(second, ROW_NUMBER() OVER (ORDER BY s.storage_used_bytes DESC, l.item_count DESC) % 600, SYSUTCDATETIME())
     FROM spo.libraries l JOIN spo.sites s ON s.id = l.site_id
     WHERE l.deleted_at IS NULL AND l.crawl_mode <> N'skip' AND s.deleted_at IS NULL AND s.excluded = 0
       AND NOT EXISTS (SELECT 1 FROM spo.tasks t WHERE t.kind = N'library-scan' AND t.target_key = CONCAT(N'library:', l.id) AND (t.state IN (N'ready', N'leased') OR t.state = N'failed'))`,
    { priority: PRIORITY.libraryScan },
  );

  await insertMissing(
    `INSERT INTO spo.tasks (kind, target_key, site_id, library_id, state, priority, run_after)
     SELECT N'file-versions', CONCAT(N'library:', r.library_id), r.site_id, r.library_id, N'ready', @priority, SYSUTCDATETIME()
     FROM spo.library_rollups r JOIN spo.libraries l ON l.id = r.library_id
     WHERE r.heavy_versions_files > 0 AND l.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM spo.tasks t WHERE t.kind = N'file-versions' AND t.target_key = CONCAT(N'library:', r.library_id) AND (t.state IN (N'ready', N'leased') OR t.state = N'failed'))`,
    { priority: PRIORITY.fileVersions },
  );

  await retryFailed({ olderThanMs: settings.retryFailedAfterHours * 3_600_000 });
}

export const maintenance: TaskHandler = async (ctx) => {
  ctx.status('Maintenance: pruning old events and tasks');
  const d = await db();
  await purgeEvents(30);
  await purgeFinished(7);
  await d.exec(`DELETE FROM spo.engine_throughput WHERE minute < DATEADD(day, -7, SYSUTCDATETIME())`);
  await d.exec(`DELETE FROM spo.tenant_snapshots WHERE captured_at < DATEADD(day, -400, SYSUTCDATETIME())`);
  return { outcome: 'again', afterMs: 24 * 3_600_000 };
};
