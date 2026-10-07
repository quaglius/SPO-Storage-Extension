import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  V2EventListItem,
  V2EventListResponse,
  V2RetryFailedResponse,
  V2TaskListItem,
  V2TaskListResponse,
} from '@spostorage/shared';
import { db, toIso } from '../db.js';
import { logEvent } from '../engine/events.js';
import { retryFailed } from '../engine/queue.js';
import { num } from './coerce.js';

const eventsQuerySchema = z.object({
  level: z.enum(['info', 'warn', 'error']).optional(),
  siteId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(200).optional().default(50),
});

const tasksQuerySchema = z.object({
  state: z.enum(['failed', 'ready', 'leased', 'done']).optional().default('failed'),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(200).optional().default(50),
});

const pauseBodySchema = z.object({
  reason: z.string().max(400).optional(),
});

export async function registerEventsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/events', async (request, reply): Promise<V2EventListResponse | void> => {
    const parsed = eventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid event parameters' },
      });
    }
    const { level, siteId, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;
    const d = await db();

    const totals = await d.one<{ total: number }>(
      `SELECT COUNT_BIG(*) AS total
       FROM spo.engine_events e
       WHERE (@level IS NULL OR e.level = @level)
         AND (@siteId IS NULL OR e.site_id = @siteId)`,
      { level: level ?? null, siteId: siteId ?? null },
    );

    const rows = await d.all<{
      id: number;
      at: Date;
      level: string;
      kind: string;
      message: string;
      site_id: number | null;
      site_title: string | null;
      library_id: number | null;
    }>(
      `SELECT e.id, e.at, e.level, e.kind, e.message, e.site_id, s.title AS site_title, e.library_id
       FROM spo.engine_events e
       LEFT JOIN spo.sites s ON s.id = e.site_id
       WHERE (@level IS NULL OR e.level = @level)
         AND (@siteId IS NULL OR e.site_id = @siteId)
       ORDER BY e.at DESC, e.id DESC
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      { level: level ?? null, siteId: siteId ?? null, offset, pageSize },
    );

    const items: V2EventListItem[] = rows.map((e) => ({
      id: num(e.id),
      at: toIso(e.at)!,
      level: (e.level === 'warn' || e.level === 'error' ? e.level : 'info') as V2EventListItem['level'],
      kind: e.kind,
      message: e.message,
      siteId: e.site_id == null ? null : num(e.site_id),
      siteTitle: e.site_title,
      libraryId: e.library_id == null ? null : num(e.library_id),
    }));

    return { items, total: num(totals?.total), page, pageSize };
  });
}

export async function registerEngineRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/tasks', async (request, reply): Promise<V2TaskListResponse | void> => {
    const parsed = tasksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid task parameters' },
      });
    }
    const { state, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;
    const d = await db();

    const totals = await d.one<{ total: number }>(
      `SELECT COUNT_BIG(*) AS total FROM spo.tasks WHERE state = @state`,
      { state },
    );

    const rows = await d.all<{
      id: number;
      kind: string;
      target_key: string;
      site_title: string | null;
      library_title: string | null;
      attempts: number;
      last_error: string | null;
      updated_at: Date;
      state: string;
    }>(
      `SELECT t.id, t.kind, t.target_key, s.title AS site_title, l.title AS library_title,
              t.attempts, t.last_error, t.updated_at, t.state
       FROM spo.tasks t
       LEFT JOIN spo.sites s ON s.id = t.site_id
       LEFT JOIN spo.libraries l ON l.id = t.library_id
       WHERE t.state = @state
       ORDER BY t.updated_at DESC, t.id DESC
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      { state, offset, pageSize },
    );

    const items: V2TaskListItem[] = rows.map((t) => ({
      id: num(t.id),
      kind: t.kind,
      targetKey: t.target_key,
      siteTitle: t.site_title,
      libraryTitle: t.library_title,
      attempts: num(t.attempts),
      lastError: t.last_error,
      updatedAt: toIso(t.updated_at)!,
      state: t.state,
    }));

    return { items, total: num(totals?.total), page, pageSize };
  });

  app.post('/api/v2/tasks/retry-failed', async (): Promise<V2RetryFailedResponse> => {
    const retried = await retryFailed();
    await logEvent({
      level: 'info',
      kind: 'tasks.retry_failed',
      message: retried
        ? `Retried ${retried} failed tasks`
        : 'No failed tasks to retry',
      data: { retried },
    });
    return { retried };
  });

  app.post('/api/v2/engine/pause', async (request, reply) => {
    const parsed = pauseBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid pause body' },
      });
    }
    const reason = parsed.data.reason?.trim() || null;
    const d = await db();
    await d.exec(
      `UPDATE spo.engine_state
       SET paused = 1, pause_reason = @reason
       WHERE id = 1`,
      { reason },
    );
    await logEvent({
      level: 'warn',
      kind: 'engine.pause',
      message: reason ? `Engine paused: ${reason}` : 'Engine paused',
      data: { reason },
    });
    return { ok: true, paused: true, reason };
  });

  app.post('/api/v2/engine/resume', async () => {
    const d = await db();
    await d.exec(
      `UPDATE spo.engine_state
       SET paused = 0, pause_reason = NULL
       WHERE id = 1`,
    );
    await logEvent({
      level: 'info',
      kind: 'engine.resume',
      message: 'Engine resumed',
    });
    return { ok: true, paused: false };
  });
}
