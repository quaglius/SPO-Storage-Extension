import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  V2EngineSlot,
  V2EngineState,
  V2StatusEvent,
  V2StatusResponse,
  V2ThroughputMinute,
} from '@spostorage/shared';
import { db, toIso } from '../db.js';
import { bool, num, numOrNull } from './coerce.js';

const DEFAULT_PRICE_PER_GB = 0.2;
const HEARTBEAT_STALE_MS = 2 * 60_000;
const GiB = 1024 ** 3;

function parseSlots(raw: string | null | undefined): V2EngineSlot[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{
      kind?: string | null;
      target?: string | null;
      since?: string | null;
      status?: string | null;
      taskId?: number | null;
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((s) => ({
      kind: s.kind ?? null,
      target: s.target ?? null,
      since: s.since ?? null,
      status: s.status ?? null,
    }));
  } catch {
    return [];
  }
}

function deriveEngineState(opts: {
  heartbeatAt: Date | string | null | undefined;
  paused: boolean;
  rawSlots: Array<{ taskId?: number | null }>;
}): V2EngineState {
  const hb = opts.heartbeatAt ? new Date(opts.heartbeatAt).getTime() : null;
  if (hb == null || Number.isNaN(hb) || Date.now() - hb > HEARTBEAT_STALE_MS) {
    return 'no_signal';
  }
  if (opts.paused) return 'paused';
  if (opts.rawSlots.some((s) => s.taskId != null && s.taskId !== 0)) return 'working';
  return 'idle';
}

export async function registerStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/status', async (_request, _reply: FastifyReply): Promise<V2StatusResponse> => {
    const d = await db();

    // Keep ≤ 8 simple queries (polled every 10s).
    const [
      snapshot,
      settingsRows,
      sitesAgg,
      rollupRecycle,
      libStates,
      engineQueue,
      throughputRows,
      eventRows,
    ] = await Promise.all([
      d.one<{
        captured_at: Date;
        source: string;
        quota_bytes: number | null;
        used_bytes: number | null;
      }>(
        `SELECT TOP (1) captured_at, source, quota_bytes, used_bytes
         FROM spo.tenant_snapshots
         ORDER BY captured_at DESC`,
      ),
      d.all<{ key: string; value_json: string }>(
        `SELECT [key], value_json FROM spo.settings
         WHERE [key] IN (N'pricing.extraStorageUsdPerGbMonth', N'tenant.lastUsage')`,
      ),
      d.one<{
        total: number;
        excluded: number;
        denied: number;
        used_bytes: number;
        files_declared: number;
      }>(
        `SELECT
           COUNT_BIG(*) AS total,
           SUM(CASE WHEN excluded = 1 THEN 1 ELSE 0 END) AS excluded,
           SUM(CASE WHEN access_state = N'denied' THEN 1 ELSE 0 END) AS denied,
           COALESCE(SUM(storage_used_bytes), 0) AS used_bytes,
           COALESCE(SUM(spo_file_count), 0) AS files_declared
         FROM spo.sites
         WHERE deleted_at IS NULL`,
      ),
      d.one<{
        total_bytes: number;
        file_count: number;
        heavy_versions_bytes: number;
        heavy_versions_files: number;
        age_730_bytes: number;
        age_old_bytes: number;
        recycle_bytes: number;
      }>(
        `SELECT
           COALESCE((SELECT SUM(total_bytes) FROM spo.library_rollups), 0) AS total_bytes,
           COALESCE((SELECT SUM(file_count) FROM spo.library_rollups), 0) AS file_count,
           COALESCE((SELECT SUM(heavy_versions_bytes) FROM spo.library_rollups), 0) AS heavy_versions_bytes,
           COALESCE((SELECT SUM(heavy_versions_files) FROM spo.library_rollups), 0) AS heavy_versions_files,
           COALESCE((SELECT SUM(age_730_bytes) FROM spo.library_rollups), 0) AS age_730_bytes,
           COALESCE((SELECT SUM(age_old_bytes) FROM spo.library_rollups), 0) AS age_old_bytes,
           COALESCE((SELECT SUM(first_stage_bytes + second_stage_bytes) FROM spo.recycle_bin), 0) AS recycle_bytes`,
      ),
      d.one<{
        total: number;
        done: number;
        running: number;
        pending: number;
        failed: number;
      }>(
        `SELECT
           COUNT_BIG(*) AS total,
           SUM(CASE WHEN baseline_state = N'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN baseline_state = N'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN baseline_state = N'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN baseline_state = N'failed' THEN 1 ELSE 0 END) AS failed
         FROM spo.libraries
         WHERE deleted_at IS NULL`,
      ),
      d.one<{
        heartbeat_at: Date | null;
        last_progress_at: Date | null;
        started_at: Date | null;
        build_commit: string | null;
        paused: boolean | number;
        pause_reason: string | null;
        current_json: string | null;
        ready: number;
        due: number;
        leased: number;
        failed: number;
      }>(
        `SELECT e.heartbeat_at, e.last_progress_at, e.started_at, e.build_commit, e.paused, e.pause_reason, e.current_json,
           (SELECT COUNT_BIG(*) FROM spo.tasks WHERE state = N'ready') AS ready,
           (SELECT COUNT_BIG(*) FROM spo.tasks WHERE state = N'ready' AND run_after <= SYSUTCDATETIME()) AS due,
           (SELECT COUNT_BIG(*) FROM spo.tasks WHERE state = N'leased') AS leased,
           (SELECT COUNT_BIG(*) FROM spo.tasks WHERE state = N'failed') AS failed
         FROM spo.engine_state e WHERE e.id = 1`,
      ),
      d.all<{ minute: Date; items: number; requests: number; throttled: number; errors: number }>(
        `SELECT minute, items, requests, throttled, errors
         FROM spo.engine_throughput
         WHERE minute >= DATEADD(hour, -1, SYSUTCDATETIME())
         ORDER BY minute ASC`,
      ),
      d.all<{
        id: number;
        at: Date;
        level: string;
        kind: string;
        message: string;
        site_id: number | null;
        site_title: string | null;
      }>(
        `SELECT TOP (15) e.id, e.at, e.level, e.kind, e.message, e.site_id, s.title AS site_title
         FROM spo.engine_events e
         LEFT JOIN spo.sites s ON s.id = e.site_id
         ORDER BY e.at DESC, e.id DESC`,
      ),
    ]);

    const perSite = await d.one<{ checked: number; matching: number; over_: number; under_: number }>(
      `SELECT COUNT(*) AS checked,
              SUM(CASE WHEN x.ratio BETWEEN 0.98 AND 1.02 THEN 1 ELSE 0 END) AS matching,
              SUM(CASE WHEN x.ratio > 1.02 THEN 1 ELSE 0 END) AS over_,
              SUM(CASE WHEN x.ratio < 0.98 THEN 1 ELSE 0 END) AS under_
       FROM (
         SELECT (CAST(ISNULL(r.total, 0) AS FLOAT) + ISNULL(rb.first_stage_bytes + rb.second_stage_bytes, 0)) / s.storage_used_bytes AS ratio
         FROM spo.sites s
         LEFT JOIN (SELECT site_id, SUM(total_bytes) AS total FROM spo.library_rollups GROUP BY site_id) r ON r.site_id = s.id
         LEFT JOIN spo.recycle_bin rb ON rb.site_id = s.id
         WHERE s.deleted_at IS NULL AND s.excluded = 0 AND s.storage_used_bytes >= 1073741824
       ) x`,
    );

    const settings = new Map(settingsRows.map((r) => [r.key, r.value_json]));
    let pricePerGb = DEFAULT_PRICE_PER_GB;
    const priceRaw = settings.get('pricing.extraStorageUsdPerGbMonth');
    if (priceRaw) {
      try {
        const parsed = JSON.parse(priceRaw) as unknown;
        const n = typeof parsed === 'number' ? parsed : Number(parsed);
        if (Number.isFinite(n) && n >= 0) pricePerGb = n;
      } catch {
        const n = Number(priceRaw);
        if (Number.isFinite(n) && n >= 0) pricePerGb = n;
      }
    }

    let versionsBytes: number | null = null;
    const lastUsageRaw = settings.get('tenant.lastUsage');
    if (lastUsageRaw) {
      try {
        const parsed = JSON.parse(lastUsageRaw) as { versionsBytes?: unknown };
        versionsBytes = numOrNull(parsed.versionsBytes);
      } catch {
        versionsBytes = null;
      }
    }

    const usedBytes = numOrNull(snapshot?.used_bytes);
    const quotaBytes = numOrNull(snapshot?.quota_bytes);
    let tenant: V2StatusResponse['tenant'] = null;
    if (snapshot) {
      const excessBytes =
        usedBytes != null && quotaBytes != null ? Math.max(0, usedBytes - quotaBytes) : null;
      tenant = {
        capturedAt: toIso(snapshot.captured_at)!,
        source: snapshot.source,
        quotaBytes,
        usedBytes,
        versionsBytes,
        excessBytes,
        estimatedMonthlyCostUsd: excessBytes != null ? (excessBytes / GiB) * pricePerGb : null,
      };
    }

    const sitesUsed = num(sitesAgg?.used_bytes);
    const rollupTotal = num(rollupRecycle?.total_bytes);
    const recycleBytes = num(rollupRecycle?.recycle_bytes);
    const explainedBytes = rollupTotal + recycleBytes;
    const percent = sitesUsed > 0 ? explainedBytes / sitesUsed : null;

    const rawSlotsJson = engineQueue?.current_json ?? null;
    let rawSlots: Array<{ taskId?: number | null }> = [];
    try {
      const p = rawSlotsJson ? JSON.parse(rawSlotsJson) : [];
      if (Array.isArray(p)) rawSlots = p;
    } catch {
      rawSlots = [];
    }
    const slots = parseSlots(rawSlotsJson);
    const engineState = deriveEngineState({
      heartbeatAt: engineQueue?.heartbeat_at,
      paused: bool(engineQueue?.paused),
      rawSlots,
    });

    const perMinute: V2ThroughputMinute[] = throughputRows.map((r) => ({
      minute: toIso(r.minute)!,
      items: num(r.items),
      throttled: num(r.throttled),
      errors: num(r.errors),
    }));
    const lastHour = {
      items: perMinute.reduce((a, r) => a + r.items, 0),
      requests: throughputRows.reduce((a, r) => a + num(r.requests), 0),
      throttled: perMinute.reduce((a, r) => a + r.throttled, 0),
      errors: perMinute.reduce((a, r) => a + r.errors, 0),
      perMinute,
    };

    const recentEvents: V2StatusEvent[] = eventRows.map((e) => ({
      id: num(e.id),
      at: toIso(e.at)!,
      level: (e.level === 'warn' || e.level === 'error' ? e.level : 'info') as V2StatusEvent['level'],
      kind: e.kind,
      message: e.message,
      siteId: e.site_id == null ? null : num(e.site_id),
      siteTitle: e.site_title,
    }));

    return {
      tenant,
      sites: {
        total: num(sitesAgg?.total),
        excluded: num(sitesAgg?.excluded),
        denied: num(sitesAgg?.denied),
        usedBytes: sitesUsed,
      },
      reconciliation: {
        explainedBytes,
        percent,
        libraries: {
          total: num(libStates?.total),
          done: num(libStates?.done),
          running: num(libStates?.running),
          pending: num(libStates?.pending),
          failed: num(libStates?.failed),
        },
        filesKnown: num(rollupRecycle?.file_count),
        filesDeclared: num(sitesAgg?.files_declared),
        sitesChecked: num(perSite?.checked),
        sitesMatching: num(perSite?.matching),
        sitesOver: num(perSite?.over_),
        sitesUnder: num(perSite?.under_),
      },
      savings: {
        heavyVersionsBytes: num(rollupRecycle?.heavy_versions_bytes),
        heavyVersionsFiles: num(rollupRecycle?.heavy_versions_files),
        olderThan365Bytes: num(rollupRecycle?.age_730_bytes) + num(rollupRecycle?.age_old_bytes),
        olderThan730Bytes: num(rollupRecycle?.age_old_bytes),
      },
      engine: {
        state: engineState,
        heartbeatAt: toIso(engineQueue?.heartbeat_at),
        lastProgressAt: toIso(engineQueue?.last_progress_at),
        startedAt: toIso(engineQueue?.started_at),
        commit: engineQueue?.build_commit ?? null,
        pauseReason: engineQueue?.pause_reason ?? null,
        slots,
        lastHour,
        queue: {
          ready: num(engineQueue?.ready),
          due: num(engineQueue?.due),
          leased: num(engineQueue?.leased),
          failed: num(engineQueue?.failed),
        },
      },
      recentEvents,
    };
  });
}
