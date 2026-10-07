/**
 * Durable task queue on spo.tasks.
 *
 * A task is a small unit of work (one page, one site, one library pass). Recurring work is one row
 * that cycles ready → leased → ready (run_after in the future); one-shot work ends in done/failed.
 * At most one open (ready|leased) task exists per (kind, target_key) — enforced by uq_tasks_open.
 */
import { db, type Db } from '../db.js';

export type TaskState = 'ready' | 'leased' | 'done' | 'failed';

export interface TaskRow {
  id: number;
  kind: string;
  target_key: string;
  site_id: number | null;
  library_id: number | null;
  state: TaskState;
  priority: number;
  run_after: Date;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: Date | null;
  payload_json: string | null;
  last_error: string | null;
}

export interface EnqueueInput {
  kind: string;
  targetKey: string;
  siteId?: number | null;
  libraryId?: number | null;
  priority?: number;
  runAfter?: Date;
  payload?: unknown;
  maxAttempts?: number;
}

const DUPLICATE_KEY = new Set([2601, 2627]);

function isDuplicate(err: unknown): boolean {
  const n = (err as { number?: number; originalError?: { info?: { number?: number } } })?.number ??
    (err as { originalError?: { info?: { number?: number } } })?.originalError?.info?.number;
  return typeof n === 'number' && DUPLICATE_KEY.has(n);
}

/** Idempotent: returns false when an open task for (kind, targetKey) already exists. */
export async function enqueue(input: EnqueueInput, d?: Db): Promise<boolean> {
  const conn = d ?? (await db());
  try {
    const n = await conn.exec(
      `INSERT INTO spo.tasks (kind, target_key, site_id, library_id, state, priority, run_after, max_attempts, payload_json)
       SELECT @kind, @target, @siteId, @libraryId, N'ready', @priority, @runAfter, @maxAttempts, @payload
       WHERE NOT EXISTS (SELECT 1 FROM spo.tasks WHERE kind = @kind AND target_key = @target AND state IN (N'ready', N'leased'))`,
      {
        kind: input.kind,
        target: input.targetKey,
        siteId: input.siteId ?? null,
        libraryId: input.libraryId ?? null,
        priority: input.priority ?? 100,
        runAfter: input.runAfter ?? new Date(),
        maxAttempts: input.maxAttempts ?? 8,
        payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      },
    );
    return n > 0;
  } catch (err) {
    if (isDuplicate(err)) return false;
    throw err;
  }
}

/** Marks tasks whose lease expired after their last allowed attempt as failed. */
export async function failExhaustedLeases(): Promise<number> {
  const conn = await db();
  return conn.exec(
    `UPDATE spo.tasks
       SET state = N'failed', finished_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME(),
           last_error = COALESCE(last_error, N'') + N' | lease expired on last attempt'
     WHERE state = N'leased' AND lease_until < SYSUTCDATETIME() AND attempts >= max_attempts`,
  );
}

/**
 * Claims the next due task (ready and due, or leased with an expired lease).
 * READPAST + UPDLOCK lets several slots/instances claim concurrently without blocking.
 */
export async function claim(owner: string, leaseMs: number, excludeTargets: string[] = []): Promise<TaskRow | null> {
  const conn = await db();
  const params = { owner, leaseMs, exclude: excludeTargets.length ? JSON.stringify(excludeTargets) : null };
  // Two passes so each can seek ix_tasks_claim and stop at the first row (an OR forces a full scan,
  // which U-locks every candidate and makes concurrent claimers READPAST all of them).
  for (const where of [
    // 5 ms of slack: datetime2(3) rounding can put run_after = now slightly in the future.
    `state = N'ready' AND run_after <= DATEADD(millisecond, 5, SYSUTCDATETIME())`,
    `state = N'leased' AND lease_until < SYSUTCDATETIME() AND attempts < max_attempts`,
  ]) {
    const row = await conn.one<TaskRow>(
      `WITH next AS (
         SELECT TOP (1) *
         FROM spo.tasks WITH (UPDLOCK, READPAST, ROWLOCK)
         WHERE ${where}
           AND (@exclude IS NULL OR target_key NOT IN (SELECT value FROM OPENJSON(@exclude)))
         ORDER BY priority, run_after
       )
       UPDATE next
         SET state = N'leased', lease_owner = @owner,
             lease_until = DATEADD(millisecond, @leaseMs, SYSUTCDATETIME()),
             attempts = attempts + 1, updated_at = SYSUTCDATETIME()
       OUTPUT inserted.*`,
      params,
    );
    if (row) return row;
  }
  return null;
}

/** Extends the lease. Returns false when the lease was lost (another owner or state changed). */
export async function renew(id: number, owner: string, leaseMs: number): Promise<boolean> {
  const conn = await db();
  const n = await conn.exec(
    `UPDATE spo.tasks SET lease_until = DATEADD(millisecond, @leaseMs, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
     WHERE id = @id AND lease_owner = @owner AND state = N'leased'`,
    { id, owner, leaseMs },
  );
  return n > 0;
}

export async function complete(id: number, owner: string, d?: Db): Promise<void> {
  const conn = d ?? (await db());
  await conn.exec(
    `UPDATE spo.tasks SET state = N'done', finished_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME(),
            lease_owner = NULL, lease_until = NULL, last_error = NULL
     WHERE id = @id AND lease_owner = @owner`,
    { id, owner },
  );
}

/**
 * Puts the task back to ready (same row): used for pagination (afterMs = 0) and for recurring work.
 * Resets attempts because the previous attempt succeeded.
 */
export async function again(id: number, owner: string, afterMs: number, payload?: unknown, d?: Db): Promise<void> {
  const conn = d ?? (await db());
  await conn.exec(
    `UPDATE spo.tasks
       SET state = N'ready', run_after = DATEADD(millisecond, @afterMs, SYSUTCDATETIME()), attempts = 0,
           lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = SYSUTCDATETIME(),
           payload_json = CASE WHEN @hasPayload = 1 THEN @payload ELSE payload_json END
     WHERE id = @id AND lease_owner = @owner`,
    {
      id,
      owner,
      afterMs,
      hasPayload: payload === undefined ? 0 : 1,
      payload: payload === undefined ? null : JSON.stringify(payload),
    },
  );
}

export function backoffMs(attempts: number, retryAfterMs?: number | null): number {
  const exp = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return Math.max(exp, retryAfterMs ?? 0);
}

/** Records a failed attempt: back to ready with backoff, or failed after max_attempts / non-retryable. */
export async function fail(
  task: Pick<TaskRow, 'id' | 'attempts' | 'max_attempts'>,
  owner: string,
  error: string,
  opts: { retryable: boolean; retryAfterMs?: number | null },
): Promise<'retry' | 'failed'> {
  const conn = await db();
  const final = !opts.retryable || task.attempts >= task.max_attempts;
  await conn.exec(
    `UPDATE spo.tasks
       SET state = CASE WHEN @final = 1 THEN N'failed' ELSE N'ready' END,
           run_after = DATEADD(millisecond, @delay, SYSUTCDATETIME()),
           finished_at = CASE WHEN @final = 1 THEN SYSUTCDATETIME() ELSE NULL END,
           lease_owner = NULL, lease_until = NULL, last_error = @error, updated_at = SYSUTCDATETIME()
     WHERE id = @id AND lease_owner = @owner`,
    {
      id: task.id,
      owner,
      final: final ? 1 : 0,
      delay: backoffMs(task.attempts, opts.retryAfterMs),
      error: error.slice(0, 2000),
    },
  );
  return final ? 'failed' : 'retry';
}

/** Re-arms failed tasks (operator "reintentar" or planner after a cool-down). */
export async function retryFailed(filter: { kind?: string; olderThanMs?: number } = {}): Promise<number> {
  const conn = await db();
  return conn.exec(
    `WITH latest AS (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY kind, target_key ORDER BY id DESC) AS rn
       FROM spo.tasks t
       WHERE t.state = N'failed'
         AND (@kind IS NULL OR t.kind = @kind)
         AND (@older IS NULL OR t.finished_at < DATEADD(second, -CAST(@older AS INT), SYSUTCDATETIME()))
         AND NOT EXISTS (SELECT 1 FROM spo.tasks o WHERE o.kind = t.kind AND o.target_key = t.target_key AND o.state IN (N'ready', N'leased'))
     )
     UPDATE t SET state = N'ready', attempts = 0, run_after = SYSUTCDATETIME(), finished_at = NULL, updated_at = SYSUTCDATETIME()
     FROM spo.tasks t JOIN latest l ON l.id = t.id AND l.rn = 1`,
    { kind: filter.kind ?? null, older: filter.olderThanMs == null ? null : Math.round(filter.olderThanMs / 1000) },
  );
}

export async function purgeFinished(olderThanDays: number): Promise<number> {
  const conn = await db();
  return conn.exec(
    `DELETE FROM spo.tasks WHERE state IN (N'done', N'failed') AND finished_at < DATEADD(day, -@days, SYSUTCDATETIME())`,
    { days: olderThanDays },
  );
}
