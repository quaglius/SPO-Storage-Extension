import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/v2/db.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

describe('v2 API /files, /events, engine controls', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
  });

  afterEach(async () => {
    await closeTestDb();
  });

  async function seedFiles() {
    const d = await db();
    const site = await d.one<{ id: number }>(
      `INSERT INTO spo.sites (url, title, storage_used_bytes, access_state)
       OUTPUT INSERTED.id
       VALUES (N'https://contoso.sharepoint.com/sites/f', N'Files', 100, N'ok')`,
    );
    const lib = await d.one<{ id: number }>(
      `INSERT INTO spo.libraries (site_id, web_url, list_guid, title, root_url, base_template, hidden)
       OUTPUT INSERTED.id
       VALUES (@siteId, N'https://x', NEWID(), N'Lib', N'/L', 101, 0)`,
      { siteId: site!.id },
    );
    await d.exec(
      `INSERT INTO spo.files (site_id, library_id, unique_id, server_relative_url, name, extension,
         size_bytes, total_bytes, modified_at, seen_at)
       VALUES
         (@siteId, @libId, NEWID(), N'/big.pptx', N'big.pptx', N'pptx', 100000, 300000, '2020-01-01', SYSUTCDATETIME()),
         (@siteId, @libId, NEWID(), N'/small.txt', N'small.txt', N'txt', 10, 10, '2024-06-01', SYSUTCDATETIME()),
         (@siteId, @libId, NEWID(), N'/gone.doc', N'gone.doc', N'doc', 50, 50, '2023-01-01', SYSUTCDATETIME())`,
      { siteId: site!.id, libId: lib!.id },
    );
    await d.exec(`UPDATE spo.files SET deleted_at = SYSUTCDATETIME() WHERE name = N'gone.doc'`);
    return { siteId: site!.id, libId: lib!.id };
  }

  it('filters files and returns matching totals', async () => {
    const { siteId } = await seedFiles();
    const app = await buildApp({ logger: false });

    const all = await app.inject({ method: 'GET', url: `/api/v2/files?siteId=${siteId}` });
    expect(all.statusCode).toBe(200);
    const allBody = all.json();
    expect(allBody.total).toBe(2);
    expect(allBody.totalBytes).toBe(100_010);
    expect(allBody.items.map((i: { name: string }) => i.name).sort()).toEqual(['big.pptx', 'small.txt']);

    const heavy = await app.inject({
      method: 'GET',
      url: `/api/v2/files?minVersionsBytes=1000&sort=versions`,
    });
    expect(heavy.json().total).toBe(1);
    expect(heavy.json().items[0].name).toBe('big.pptx');
    expect(heavy.json().items[0].versionsBytes).toBe(200_000);

    const byExt = await app.inject({ method: 'GET', url: '/api/v2/files?extension=txt,pdf' });
    expect(byExt.json().total).toBe(1);
    expect(byExt.json().items[0].extension).toBe('txt');

    const search = await app.inject({ method: 'GET', url: '/api/v2/files?search=big' });
    expect(search.json().total).toBe(1);

    const old = await app.inject({
      method: 'GET',
      url: '/api/v2/files?modifiedBefore=2021-01-01T00:00:00.000Z',
    });
    expect(old.json().total).toBe(1);
    expect(old.json().items[0].name).toBe('big.pptx');

    await app.close();
  });

  it('pauses and resumes the engine and retries failed tasks', async () => {
    const d = await db();
    await d.exec(
      `INSERT INTO spo.tasks (kind, target_key, state, priority, run_after, attempts, max_attempts, last_error, finished_at)
       VALUES (N'library-crawl', N'library:9', N'failed', 100, SYSUTCDATETIME(), 3, 8, N'boom', SYSUTCDATETIME())`,
    );

    const app = await buildApp({ logger: false });

    const pause = await app.inject({
      method: 'POST',
      url: '/api/v2/engine/pause',
      payload: { reason: 'mantenimiento' },
    });
    expect(pause.statusCode).toBe(200);
    const engine = await d.one<{ paused: boolean | number; pause_reason: string }>(
      `SELECT paused, pause_reason FROM spo.engine_state WHERE id = 1`,
    );
    expect(Number(engine!.paused)).toBe(1);
    expect(engine!.pause_reason).toBe('mantenimiento');

    const statusPaused = (await app.inject({ method: 'GET', url: '/api/v2/status' })).json();
    expect(statusPaused.engine.state).toBe('no_signal');

    await d.exec(`UPDATE spo.engine_state SET heartbeat_at = SYSUTCDATETIME()`);
    const statusPausedFresh = (await app.inject({ method: 'GET', url: '/api/v2/status' })).json();
    expect(statusPausedFresh.engine.state).toBe('paused');
    expect(statusPausedFresh.engine.pauseReason).toBe('mantenimiento');

    const resume = await app.inject({ method: 'POST', url: '/api/v2/engine/resume' });
    expect(resume.statusCode).toBe(200);
    const after = await d.one<{ paused: boolean | number; pause_reason: string | null }>(
      `SELECT paused, pause_reason FROM spo.engine_state WHERE id = 1`,
    );
    expect(Number(after!.paused)).toBe(0);
    expect(after!.pause_reason).toBeNull();

    const tasks = await app.inject({ method: 'GET', url: '/api/v2/tasks?state=failed' });
    expect(tasks.json().total).toBe(1);

    const retry = await app.inject({ method: 'POST', url: '/api/v2/tasks/retry-failed' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().retried).toBe(1);

    const tasksAfter = await app.inject({ method: 'GET', url: '/api/v2/tasks?state=failed' });
    expect(tasksAfter.json().total).toBe(0);

    const events = await app.inject({ method: 'GET', url: '/api/v2/events?pageSize=10' });
    expect(events.statusCode).toBe(200);
    expect(events.json().total).toBeGreaterThanOrEqual(3);
    const kinds = events.json().items.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('engine.pause');
    expect(kinds).toContain('engine.resume');
    expect(kinds).toContain('tasks.retry_failed');

    await app.close();
  });
});
