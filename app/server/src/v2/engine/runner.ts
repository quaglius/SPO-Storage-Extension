/**
 * The v2 engine loop (docs/PLAN-V2.md §4.3).
 *
 * N slots claim tasks from spo.tasks and run their handlers. A task error never stops the loop:
 * it is recorded on the task (retry with backoff or failed) and the slot moves on.
 * A watchdog exits the process when due work exists but nothing progresses, so App Service restarts
 * it and the durable queue resumes exactly where it was.
 */
import os from 'node:os';
import { getBuildInfo } from '../../config.js';
import { db } from '../db.js';
import { SpoClient, SpoError } from '../spo/client.js';
import { logEvent } from './events.js';
import { again, claim, complete, fail, failExhaustedLeases, renew, type TaskRow } from './queue.js';
import type { HandlerRegistry, TaskContext, TaskResult } from './types.js';

export interface EngineOptions {
  handlers: HandlerRegistry;
  spo: SpoClient;
  /** Enqueues recurring/new work idempotently; called every plannerIntervalMs. */
  planner?: () => Promise<void>;
  concurrency?: number;
  leaseMs?: number;
  taskTimeoutMs?: number;
  /** Per-kind overrides, e.g. policy runs that copy multi-GB files. */
  taskTimeoutsByKind?: Record<string, number>;
  pollMs?: number;
  plannerIntervalMs?: number;
  heartbeatMs?: number;
  stallMs?: number;
  /** Called by the watchdog; defaults to process.exit(1). */
  onStall?: () => void;
}

interface SlotState {
  taskId: number | null;
  kind: string | null;
  target: string | null;
  since: string | null;
  status: string | null;
}

export interface EngineHandle {
  stop(): Promise<void>;
  /** For tests: resolves when every slot is idle and nothing is due. */
  readonly slots: SlotState[];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function startEngine(opts: EngineOptions): EngineHandle {
  const concurrency = opts.concurrency ?? 4;
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  const taskTimeoutMs = opts.taskTimeoutMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  const plannerIntervalMs = opts.plannerIntervalMs ?? 60_000;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const stallMs = opts.stallMs ?? 20 * 60_000;
  const owner = `${os.hostname()}:${process.pid}`;
  const stopping = new AbortController();
  const slots: SlotState[] = Array.from({ length: concurrency }, () => ({
    taskId: null,
    kind: null,
    target: null,
    since: null,
    status: null,
  }));

  let paused = false;
  let lastProgressAt = Date.now();
  let minuteItems = 0;
  let minuteErrors = 0;
  let lastStats = { ...opts.spo.stats };

  const markProgress = (items: number) => {
    lastProgressAt = Date.now();
    minuteItems += items;
  };

  async function runTask(slot: SlotState, task: TaskRow): Promise<void> {
    const handler = opts.handlers[task.kind];
    slot.taskId = task.id;
    slot.kind = task.kind;
    slot.target = task.target_key;
    slot.since = new Date().toISOString();
    slot.status = null;
    if (!handler) {
      await fail(task, owner, `Unknown task type: ${task.kind}`, { retryable: false });
      return;
    }

    const controller = new AbortController();
    const limitMs = opts.taskTimeoutsByKind?.[task.kind] ?? taskTimeoutMs;
    const timeout = setTimeout(
      () => controller.abort(new Error(`Task exceeded ${Math.round(limitMs / 60_000)} min`)),
      limitMs,
    );
    const onStop = () => controller.abort(new Error('Engine stopped'));
    stopping.signal.addEventListener('abort', onStop, { once: true });
    const renewTimer = setInterval(() => {
      void renew(task.id, owner, leaseMs)
        .then((ok) => {
          if (!ok) controller.abort(new Error('Task lease was lost'));
        })
        .catch(() => undefined);
    }, Math.max(1_000, Math.floor(leaseMs / 3)));

    let payload: unknown = null;
    try {
      payload = task.payload_json ? JSON.parse(task.payload_json) : null;
    } catch {
      payload = null;
    }

    const ctx: TaskContext<unknown> = {
      task,
      payload,
      signal: controller.signal,
      spo: opts.spo,
      progress: markProgress,
      status: (text) => {
        slot.status = text.slice(0, 200);
      },
      event: (e) =>
        logEvent({
          ...e,
          siteId: e.siteId ?? task.site_id,
          libraryId: e.libraryId ?? task.library_id,
        }),
    };

    try {
      const result: TaskResult = await (handler as (c: TaskContext<unknown>) => Promise<TaskResult>)(ctx);
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('aborted');
      if (result.outcome === 'done') {
        await complete(task.id, owner);
      } else {
        await again(task.id, owner, result.afterMs, result.payload);
      }
      lastProgressAt = Date.now();
    } catch (err) {
      minuteErrors += 1;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof SpoError ? err.retryable : true;
      const retryAfterMs = err instanceof SpoError ? err.retryAfterMs : null;
      if (stopping.signal.aborted) {
        // Leave the lease to expire; the next process picks the task up without burning an attempt.
        return;
      }
      const outcome = await fail(task, owner, message, { retryable, retryAfterMs }).catch(() => 'retry' as const);
      if (outcome === 'failed') {
        await logEvent({
          level: 'error',
          kind: 'task-failed',
          siteId: task.site_id,
          libraryId: task.library_id,
          message: `Task ${task.kind} (${task.target_key}) failed permanently: ${message}`.slice(0, 1000),
        });
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(renewTimer);
      stopping.signal.removeEventListener('abort', onStop);
      slot.taskId = null;
      slot.kind = null;
      slot.target = null;
      slot.since = null;
      slot.status = null;
    }
  }

  async function slotLoop(slot: SlotState): Promise<void> {
    while (!stopping.signal.aborted) {
      try {
        if (paused) {
          await sleep(pollMs, stopping.signal);
          continue;
        }
        const busy = slots.map((s) => s.target).filter((t): t is string => Boolean(t));
        const task = await claim(owner, leaseMs, busy);
        if (!task) {
          await sleep(pollMs, stopping.signal);
          continue;
        }
        await runTask(slot, task);
      } catch (err) {
        // DB hiccup while claiming: wait and keep going.
        console.error(`[engine] slot error: ${(err as Error).message}`);
        await sleep(Math.min(60_000, pollMs * 4), stopping.signal);
      }
    }
  }

  async function heartbeat(): Promise<void> {
    const d = await db();
    const state = await d.one<{ paused: boolean }>(`SELECT paused FROM spo.engine_state WHERE id = 1`);
    paused = Boolean(state?.paused);
    const stats = opts.spo.stats;
    const requests = stats.requests - lastStats.requests;
    const throttled = stats.throttled - lastStats.throttled;
    const errors = stats.errors - lastStats.errors + minuteErrors;
    lastStats = { ...stats };
    const items = minuteItems;
    minuteItems = 0;
    minuteErrors = 0;
    await d.exec(
      `UPDATE spo.engine_state
         SET instance = @owner, build_commit = @commit, heartbeat_at = SYSUTCDATETIME(),
             last_progress_at = @lastProgress, current_json = @current
       WHERE id = 1;
       MERGE spo.engine_throughput AS t
       USING (SELECT DATEADD(minute, DATEDIFF(minute, 0, SYSUTCDATETIME()), 0) AS minute) AS s
         ON t.minute = s.minute
       WHEN MATCHED THEN UPDATE SET items = t.items + @items, requests = t.requests + @requests,
            throttled = t.throttled + @throttled, errors = t.errors + @errors
       WHEN NOT MATCHED THEN INSERT (minute, items, requests, throttled, errors)
            VALUES (s.minute, @items, @requests, @throttled, @errors);`,
      {
        owner,
        commit: getBuildInfo().commit,
        lastProgress: new Date(lastProgressAt),
        current: JSON.stringify(slots),
        items,
        requests,
        throttled,
        errors,
      },
    );
  }

  async function watchdog(): Promise<void> {
    if (paused || Date.now() - lastProgressAt < stallMs) return;
    const d = await db();
    const due = await d.one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM spo.tasks WHERE state = N'ready' AND run_after <= SYSUTCDATETIME()`,
    );
    const busy = slots.some((s) => s.taskId !== null);
    if ((due?.c ?? 0) === 0 && !busy) {
      lastProgressAt = Date.now(); // idle, not stalled
      return;
    }
    await logEvent({
      level: 'error',
      kind: 'engine-stalled',
      message: `No engine progress for ${Math.round((Date.now() - lastProgressAt) / 60_000)} min; restarting.`,
      data: { slots },
    });
    (opts.onStall ?? (() => process.exit(1)))();
  }

  const started = (async () => {
    try {
      const d = await db();
      await d.exec(
        `UPDATE spo.engine_state SET started_at = SYSUTCDATETIME(), instance = @owner, build_commit = @commit WHERE id = 1`,
        { owner, commit: getBuildInfo().commit },
      );
      await logEvent({ level: 'info', kind: 'engine-started', message: `Engine started (${concurrency} parallel tasks).` });
    } catch (err) {
      console.error(`[engine] start bookkeeping failed: ${(err as Error).message}`);
    }
  })();

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<void>, name: string) => {
    let running = false;
    timers.push(
      setInterval(() => {
        if (running || stopping.signal.aborted) return;
        running = true;
        fn()
          .catch((err) => console.error(`[engine] ${name}: ${(err as Error).message}`))
          .finally(() => {
            running = false;
          });
      }, ms),
    );
  };

  every(heartbeatMs, heartbeat, 'heartbeat');
  every(60_000, watchdog, 'watchdog');
  every(60_000, async () => {
    await failExhaustedLeases();
  }, 'leases');
  if (opts.planner) {
    const planner = opts.planner;
    every(plannerIntervalMs, planner, 'planner');
    void started.then(() => planner().catch((err) => console.error(`[engine] planner: ${(err as Error).message}`)));
  }

  const loops = started.then(() => Promise.all(slots.map((slot) => slotLoop(slot))));

  return {
    slots,
    async stop() {
      stopping.abort();
      for (const t of timers) clearInterval(t);
      await loops;
    },
  };
}
