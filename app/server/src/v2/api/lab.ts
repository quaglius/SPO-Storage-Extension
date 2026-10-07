import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decideArchiveAccess } from '../actions/access.js';
import { db } from '../db.js';
import { policyDefinitionSchema } from '../policies/definitions.js';
import { materializePlan } from '../policies/plan.js';
import { requireAdmin } from './auth.js';
import { enrichSimulation, mapRunRow } from './policies.js';
import { webSpoClient } from './spo-web.js';

const LAB_MAX_ACTIONS = 20;

const labRunBodySchema = z.object({
  definition: policyDefinitionSchema,
  fileIds: z.array(z.number().int().positive()).optional(),
  siteIds: z.array(z.number().int().positive()).optional(),
});

const accessCheckBodySchema = z.object({
  archivedId: z.number().int().positive(),
  upns: z.array(z.string().trim().min(1)).min(1).max(50),
});

export async function registerLabRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v2/lab/runs', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const parsed = labRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid lab run' },
      });
    }

    const { fileIds, siteIds } = parsed.data;
    const definition = {
      ...parsed.data.definition,
      scope: {
        ...(parsed.data.definition.scope ?? {}),
        ...(fileIds?.length ? { fileIds } : {}),
        ...(siteIds?.length ? { siteIds } : {}),
      },
    };
    const def = policyDefinitionSchema.parse(definition);

    const sim = await enrichSimulation(def);
    if (sim.count > LAB_MAX_ACTIONS) {
      return reply.status(400).send({
        error: {
          code: 'LAB_TOO_BIG',
          message: `The lab allows at most ${LAB_MAX_ACTIONS} actions; this selection produces ${sim.count}. Narrow the scope.`,
        },
      });
    }

    const selection = { fileIds: fileIds ?? [], siteIds: siteIds ?? [] };
    const d = await db();
    const run = await d.one<{
      id: number;
      policy_id: number | null;
      scope: string;
      mode: string;
      status: string;
      definition_json: string;
      selection_json: string | null;
      requested_by: string | null;
      approvals_json: string | null;
      planned_count: number | null;
      planned_bytes: number | null;
      done_count: number | null;
      freed_bytes: number | null;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
      error: string | null;
    }>(
      `INSERT INTO spo.policy_runs (policy_id, scope, mode, status, definition_json, selection_json, requested_by)
       OUTPUT INSERTED.*
       VALUES (NULL, N'lab', N'execute', N'planned', @def, @selection, @by)`,
      { def: JSON.stringify(def), selection: JSON.stringify(selection), by: admin },
    );
    const plan = await materializePlan(run!.id, def);
    if (plan.count > LAB_MAX_ACTIONS) {
      await d.exec(`DELETE FROM spo.policy_actions WHERE run_id = @id`, { id: run!.id });
      await d.exec(`DELETE FROM spo.policy_runs WHERE id = @id`, { id: run!.id });
      return reply.status(400).send({
        error: {
          code: 'LAB_TOO_BIG',
          message: `The lab allows at most ${LAB_MAX_ACTIONS} actions; this selection produces ${plan.count}. Narrow the scope.`,
        },
      });
    }

    return reply.status(201).send({
      ...mapRunRow({
        ...run!,
        policy_name: null,
        planned_count: plan.count,
        planned_bytes: plan.bytes,
      }),
      plannedCount: plan.count,
      plannedBytes: plan.bytes,
    });
  });

  app.post('/api/v2/lab/access-check', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const parsed = accessCheckBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid access check' },
      });
    }
    const { archivedId, upns } = parsed.data;
    const spo = await webSpoClient();
    const results = [];
    for (const upn of upns) {
      const decision = await decideArchiveAccess(spo, archivedId, upn.trim());
      results.push({ upn: upn.trim(), granted: decision.granted, reason: decision.reason });
    }
    return { archivedId, results };
  });
}
