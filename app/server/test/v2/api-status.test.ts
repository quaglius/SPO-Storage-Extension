import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/v2/db.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

describe('v2 API /status', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
  });

  afterEach(async () => {
    await closeTestDb();
  });

  it('returns empty-shaped status when there is no data', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/v2/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant).toBeNull();
    expect(body.sites).toEqual({ total: 0, excluded: 0, denied: 0, usedBytes: 0 });
    expect(body.reconciliation.percent).toBeNull();
    expect(body.reconciliation.explainedBytes).toBe(0);
    expect(body.savings.heavyVersionsBytes).toBe(0);
    expect(body.engine.state).toBe('no_signal');
    expect(body.engine.queue).toEqual({ ready: 0, due: 0, leased: 0, failed: 0 });
    expect(body.recentEvents).toEqual([]);
    await app.close();
  });

  it('computes excess, percent and engine state from seeded rows', async () => {
    const d = await db();

    await d.exec(
      `INSERT INTO spo.tenant_snapshots (captured_at, quota_bytes, used_bytes, sites_count, spo_file_count, source)
       VALUES (SYSUTCDATETIME(), @quota, @used, 2, 100, N'admin-api')`,
      { quota: 1_000_000_000, used: 1_500_000_000 },
    );
    await d.exec(
      `INSERT INTO spo.settings ([key], value_json)
       VALUES (N'pricing.extraStorageUsdPerGbMonth', N'0.20'),
              (N'tenant.lastUsage', N'{"versionsBytes":400000000}')`,
    );

    const site = await d.one<{ id: number }>(
      `INSERT INTO spo.sites (url, title, storage_used_bytes, spo_file_count, access_state, excluded)
       OUTPUT INSERTED.id
       VALUES (N'https://contoso.sharepoint.com/sites/a', N'Sitio A', 1000000000, 80, N'ok', 0)`,
    );
    await d.exec(
      `INSERT INTO spo.sites (url, title, storage_used_bytes, spo_file_count, access_state, excluded)
       VALUES (N'https://contoso.sharepoint.com/sites/b', N'Sitio B', 500000000, 20, N'denied', 1)`,
    );

    const lib = await d.one<{ id: number }>(
      `INSERT INTO spo.libraries (site_id, web_url, list_guid, title, root_url, base_template, hidden, baseline_state)
       OUTPUT INSERTED.id
       VALUES (@siteId, N'https://x', NEWID(), N'Docs', N'/Docs', 101, 0, N'done')`,
      { siteId: site!.id },
    );
    await d.exec(
      `INSERT INTO spo.libraries (site_id, web_url, list_guid, title, root_url, base_template, hidden, baseline_state)
       VALUES (@siteId, N'https://x', NEWID(), N'Pending', N'/P', 101, 0, N'pending')`,
      { siteId: site!.id },
    );

    await d.exec(
      `INSERT INTO spo.library_rollups (
         library_id, site_id, file_count, current_bytes, total_bytes, versions_bytes,
         heavy_versions_files, heavy_versions_bytes,
         age_30_bytes, age_120_bytes, age_365_bytes, age_730_bytes, age_old_bytes, computed_at)
       VALUES (
         @libId, @siteId, 50, 600000000, 800000000, 200000000,
         3, 150000000,
         0, 0, 0, 100000000, 50000000, SYSUTCDATETIME())`,
      { libId: lib!.id, siteId: site!.id },
    );
    await d.exec(
      `INSERT INTO spo.recycle_bin (site_id, first_stage_bytes, first_stage_items, second_stage_bytes, second_stage_items, captured_at)
       VALUES (@siteId, 50000000, 2, 0, 0, SYSUTCDATETIME())`,
      { siteId: site!.id },
    );

    await d.exec(
      `UPDATE spo.engine_state
       SET heartbeat_at = DATEADD(minute, -10, SYSUTCDATETIME()), paused = 0, current_json = N'[]'`,
    );

    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/v2/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.tenant.usedBytes).toBe(1_500_000_000);
    expect(body.tenant.quotaBytes).toBe(1_000_000_000);
    expect(body.tenant.excessBytes).toBe(500_000_000);
    expect(body.tenant.versionsBytes).toBe(400_000_000);
    expect(body.tenant.estimatedMonthlyCostUsd).toBeCloseTo((500_000_000 / 1024 ** 3) * 0.2, 6);

    expect(body.sites.total).toBe(2);
    expect(body.sites.excluded).toBe(1);
    expect(body.sites.denied).toBe(1);
    expect(body.sites.usedBytes).toBe(1_500_000_000);

    expect(body.reconciliation.explainedBytes).toBe(850_000_000);
    expect(body.reconciliation.percent).toBeCloseTo(850_000_000 / 1_500_000_000, 6);
    expect(body.reconciliation.libraries).toMatchObject({
      total: 2,
      done: 1,
      pending: 1,
      running: 0,
      failed: 0,
    });
    expect(body.reconciliation.filesKnown).toBe(50);
    expect(body.reconciliation.filesDeclared).toBe(100);

    expect(body.savings.heavyVersionsBytes).toBe(150_000_000);
    expect(body.savings.heavyVersionsFiles).toBe(3);
    expect(body.savings.olderThan365Bytes).toBe(150_000_000);
    expect(body.savings.olderThan730Bytes).toBe(50_000_000);

    expect(body.engine.state).toBe('no_signal');
    await app.close();
  });

  it('reports working when heartbeat is fresh and a slot has a task', async () => {
    const d = await db();
    await d.exec(
      `UPDATE spo.engine_state
       SET heartbeat_at = SYSUTCDATETIME(), paused = 0,
           current_json = N'[{"taskId":1,"kind":"library-crawl","target":"library:1","since":"2026-01-01T00:00:00.000Z","status":"page 1"}]'`,
    );
    const app = await buildApp({ logger: false });
    const body = (await app.inject({ method: 'GET', url: '/api/v2/status' })).json();
    expect(body.engine.state).toBe('working');
    expect(body.engine.slots[0].status).toBe('page 1');
    await app.close();
  });
});
