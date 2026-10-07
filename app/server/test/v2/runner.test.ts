import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/v2/db.js';
import { enqueue } from '../../src/v2/engine/queue.js';
import { startEngine, type EngineHandle } from '../../src/v2/engine/runner.js';
import type { HandlerRegistry } from '../../src/v2/engine/types.js';
import { SpoClient, SpoError } from '../../src/v2/spo/client.js';
import { resetSpo } from './helpers.js';

const spo = new SpoClient({ tenant: 'test', tokenProvider: async () => 'x', fetchImpl: (async () => new Response('{}')) as typeof fetch });

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

async function taskState(target: string): Promise<{ state: string; attempts: number; last_error: string | null } | undefined> {
  const d = await db();
  return d.one(`SELECT TOP 1 state, attempts, last_error FROM spo.tasks WHERE target_key = @target ORDER BY id DESC`, { target });
}

describe('v2 engine runner', () => {
  let engine: EngineHandle | null = null;

  beforeEach(async () => {
    await resetSpo();
  });

  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('pages through a task with again() and keeps running after another task fails for good', async () => {
    const pages: number[] = [];
    const handlers: HandlerRegistry = {
      pager: (async (ctx: { payload: { page?: number } | null; progress: (n: number) => void }) => {
        const page = ctx.payload?.page ?? 1;
        pages.push(page);
        ctx.progress(10);
        return page < 3 ? { outcome: 'again', afterMs: 0, payload: { page: page + 1 } } : { outcome: 'done' };
      }) as never,
      broken: (async () => {
        throw new SpoError('HTTP 400 bad request', 400, false);
      }) as never,
    };
    await enqueue({ kind: 'broken', targetKey: 'b', priority: 1 });
    await enqueue({ kind: 'pager', targetKey: 'p', priority: 2 });
    engine = startEngine({ handlers, spo, concurrency: 2, pollMs: 50, heartbeatMs: 200 });

    await waitFor(async () => (await taskState('p'))?.state === 'done');
    expect(pages).toEqual([1, 2, 3]);
    const broken = await taskState('b');
    expect(broken?.state).toBe('failed');
    expect(broken?.last_error).toContain('bad request');

    const d = await db();
    const events = await d.all<{ kind: string }>(`SELECT kind FROM spo.engine_events`);
    expect(events.map((e) => e.kind)).toContain('task-failed');
  });

  it('retries transient errors with backoff instead of failing', async () => {
    let calls = 0;
    const handlers: HandlerRegistry = {
      flaky: (async () => {
        calls += 1;
        throw new SpoError('HTTP 503', 503, true, 10);
      }) as never,
    };
    await enqueue({ kind: 'flaky', targetKey: 'f' });
    engine = startEngine({ handlers, spo, concurrency: 1, pollMs: 50, heartbeatMs: 200 });
    await waitFor(async () => calls >= 1);
    await waitFor(async () => (await taskState('f'))?.state === 'ready');
    const t = await taskState('f');
    expect(t?.attempts).toBe(1);
  });

  it('stops claiming while paused', async () => {
    const d = await db();
    await d.exec(`UPDATE spo.engine_state SET paused = 1`);
    let calls = 0;
    const handlers: HandlerRegistry = { k: (async () => { calls += 1; return { outcome: 'done' }; }) as never };
    engine = startEngine({ handlers, spo, concurrency: 1, pollMs: 50, heartbeatMs: 100 });
    await new Promise((r) => setTimeout(r, 400));
    await enqueue({ kind: 'k', targetKey: 'x' });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
    await d.exec(`UPDATE spo.engine_state SET paused = 0`);
    await waitFor(async () => calls === 1);
  });
});
