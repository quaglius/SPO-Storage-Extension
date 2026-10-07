import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { archiveSettingsSchema, getArchiveSettings } from '../actions/blob.js';
import { logEvent } from '../engine/events.js';
import { engineSettingsSchema, getEngineSettings, getSetting, putSetting } from '../settings.js';
import { requireAdmin } from './auth.js';

const PRICING_KEY = 'pricing.extraStorageUsdPerGbMonth';

const pricingSchema = z.number().positive().max(100);

/** Writable subset of archive settings (tier is read-only in the UI). */
const archivePutSchema = archiveSettingsSchema.partial().extend({
  tier: archiveSettingsSchema.shape.tier.optional(),
});

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/settings/:key', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;

    const { key } = request.params as { key: string };

    if (key === 'engine') {
      return { key, value: await getEngineSettings() };
    }
    if (key === 'archive') {
      return { key, value: await getArchiveSettings() };
    }
    if (key === PRICING_KEY) {
      const raw = await getSetting<unknown>(PRICING_KEY);
      const parsed = typeof raw === 'number' ? raw : Number(raw);
      return { key, value: Number.isFinite(parsed) ? parsed : 0.2 };
    }

    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Unknown settings key: ${key}` },
    });
  });

  app.put('/api/v2/settings/:key', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;

    const { key } = request.params as { key: string };
    const body = (request.body ?? {}) as { value?: unknown };
    if (body.value === undefined) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Missing value field' },
      });
    }

    if (key === 'engine') {
      const parsed = engineSettingsSchema.safeParse(body.value);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid value' },
        });
      }
      const previous = await getEngineSettings();
      await putSetting('engine', parsed.data);
      await logEvent({
        level: 'info',
        kind: 'settings-changed',
        message: `${admin} updated engine settings.`,
        data: { key: 'engine', by: admin, previous, next: parsed.data },
      });
      return { key, value: parsed.data };
    }

    if (key === 'archive') {
      const current = await getArchiveSettings();
      const parsed = archivePutSchema.safeParse(body.value);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid value' },
        });
      }
      // tier is informational / infra-fixed: keep existing, ignore client changes
      const next = archiveSettingsSchema.parse({
        ...current,
        ...parsed.data,
        tier: current.tier,
      });
      await putSetting('archive', next);
      await logEvent({
        level: 'info',
        kind: 'settings-changed',
        message: `${admin} updated archive settings.`,
        data: { key: 'archive', by: admin, previous: current, next },
      });
      return { key, value: next };
    }

    if (key === PRICING_KEY) {
      const parsed = pricingSchema.safeParse(body.value);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid value' },
        });
      }
      const previous = await getSetting<unknown>(PRICING_KEY);
      await putSetting(PRICING_KEY, parsed.data);
      await logEvent({
        level: 'info',
        kind: 'settings-changed',
        message: `${admin} updated extra storage pricing.`,
        data: { key: PRICING_KEY, by: admin, previous, next: parsed.data },
      });
      return { key, value: parsed.data };
    }

    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Unknown settings key: ${key}` },
    });
  });
}
