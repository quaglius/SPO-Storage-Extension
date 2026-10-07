import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/v2/db.js';
import { again, claim, complete, enqueue, fail, renew, retryFailed } from '../../src/v2/engine/queue.js';
import { resetSpo } from './helpers.js';

describe('v2 task queue', () => {
  beforeEach(async () => {
    await resetSpo();
  });

  it('enqueues idempotently per (kind, target)', async () => {
    expect(await enqueue({ kind: 'library-crawl', targetKey: 'library:1' })).toBe(true);
    expect(await enqueue({ kind: 'library-crawl', targetKey: 'library:1' })).toBe(false);
    expect(await enqueue({ kind: 'library-crawl', targetKey: 'library:2' })).toBe(true);
    const d = await db();
    const rows = await d.all<{ c: number }>(`SELECT COUNT(*) AS c FROM spo.tasks`);
    expect(rows[0].c).toBe(2);
  });

  it('claims by priority', async () => {
    await enqueue({ kind: 'k', targetKey: 'low', priority: 200 });
    await enqueue({ kind: 'k', targetKey: 'high', priority: 10 });
    expect((await claim('a', 60_000))?.target_key).toBe('high');
    expect((await claim('b', 60_000))?.target_key).toBe('low');
    expect(await claim('c', 60_000)).toBeNull();
  });

  it('never hands the same task to two concurrent claimers', async () => {
    for (let i = 0; i < 10; i++) await enqueue({ kind: 'k', targetKey: `t${i}` });
    const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(`o${i}`, 60_000)));
    const ids = claims.filter(Boolean).map((t) => t!.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('re-claims a task whose lease expired and rejects the stale owner', async () => {
    await enqueue({ kind: 'k', targetKey: 't' });
    const first = await claim('a', 1);
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    const second = await claim('b', 60_000);
    expect(second?.id).toBe(first!.id);
    expect(await renew(first!.id, 'a', 60_000)).toBe(false);
    expect(await renew(first!.id, 'b', 60_000)).toBe(true);
  });

  it('again() recycles the same row with a new payload; complete() closes it', async () => {
    await enqueue({ kind: 'k', targetKey: 't', payload: { page: 1 } });
    const t1 = await claim('a', 60_000);
    await again(t1!.id, 'a', 0, { page: 2 });
    const t2 = await claim('a', 60_000);
    expect(t2!.id).toBe(t1!.id);
    expect(JSON.parse(t2!.payload_json!)).toEqual({ page: 2 });
    expect(t2!.attempts).toBe(1);
    await complete(t2!.id, 'a');
    expect(await claim('a', 60_000)).toBeNull();
    expect(await enqueue({ kind: 'k', targetKey: 't' })).toBe(true);
  });

  it('fail() backs off, then fails for good after max attempts; retryFailed re-arms', async () => {
    await enqueue({ kind: 'k', targetKey: 't', maxAttempts: 2 });
    const t1 = await claim('a', 60_000);
    expect(await fail(t1!, 'a', 'boom', { retryable: true })).toBe('retry');
    expect(await claim('a', 60_000)).toBeNull(); // backoff: not due yet
    const d = await db();
    await d.exec(`UPDATE spo.tasks SET run_after = DATEADD(second, -1, SYSUTCDATETIME())`); // datetime2(3) rounding can land in the future
    const t2 = await claim('a', 60_000);
    expect(t2!.attempts).toBe(2);
    expect(await fail(t2!, 'a', 'boom again', { retryable: true })).toBe('failed');
    expect(await retryFailed()).toBe(1);
    const t3 = await claim('a', 60_000);
    expect(t3!.attempts).toBe(1);
  });

  it('skips excluded targets', async () => {
    await enqueue({ kind: 'k', targetKey: 'busy', priority: 1 });
    await enqueue({ kind: 'k', targetKey: 'free', priority: 2 });
    const t = await claim('a', 60_000, ['busy']);
    expect(t!.target_key).toBe('free');
  });
});
