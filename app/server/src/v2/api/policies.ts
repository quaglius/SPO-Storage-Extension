import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, toIso } from '../db.js';
import {
  POLICY_KIND_LABELS,
  policyDefinitionSchema,
  type PolicyDefinition,
  type PolicyKind,
} from '../policies/definitions.js';
import { materializePlan, simulate } from '../policies/plan.js';
import { enqueuePolicyRun } from '../policies/run.js';
import { requireAdmin } from './auth.js';
import { num, numOrNull } from './coerce.js';

const policyBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  definition: policyDefinitionSchema,
});

const simulateBodySchema = z.object({
  definition: policyDefinitionSchema,
  previewSize: z.number().int().min(1).max(500).optional(),
});

const createRunBodySchema = z.object({
  scope: z.literal('tenant'),
});

const runsQuerySchema = z.object({
  scope: z.enum(['lab', 'tenant']).optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(200).optional().default(50),
});

const actionsQuerySchema = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(200).optional().default(50),
});

const approveBodySchema = z.object({
  step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  confirmText: z.string().optional(),
});

interface ApprovalEntry {
  step: 1 | 2 | 3;
  by: string;
  at: string;
}

function parseApprovals(raw: string | null): ApprovalEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is ApprovalEntry =>
        typeof a === 'object' &&
        a !== null &&
        (a as ApprovalEntry).step >= 1 &&
        (a as ApprovalEntry).step <= 3 &&
        typeof (a as ApprovalEntry).by === 'string' &&
        typeof (a as ApprovalEntry).at === 'string',
    );
  } catch {
    return [];
  }
}

function parseJsonSafe(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Simulation for the UI: names, titles and per-file facts come straight from plan.simulate(). */
async function enrichSimulation(def: PolicyDefinition, previewSize = 50) {
  return simulate(def, previewSize);
}

function mapPolicyRow(r: {
  id: number;
  name: string;
  kind: string;
  enabled: boolean | number;
  definition_json: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}) {
  const kind = r.kind as PolicyKind;
  return {
    id: num(r.id),
    name: r.name,
    kind,
    kindLabel: POLICY_KIND_LABELS[kind] ?? kind,
    enabled: Boolean(r.enabled),
    definition: parseJsonSafe(r.definition_json),
    createdBy: r.created_by,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function mapRunRow(
  r: {
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
    policy_name?: string | null;
  },
  actionTotals?: Record<string, number>,
) {
  return {
    id: num(r.id),
    policyId: numOrNull(r.policy_id),
    policyName: r.policy_name ?? null,
    scope: r.scope,
    mode: r.mode,
    status: r.status,
    definition: parseJsonSafe(r.definition_json),
    selection: parseJsonSafe(r.selection_json),
    requestedBy: r.requested_by,
    approvals: parseApprovals(r.approvals_json),
    plannedCount: numOrNull(r.planned_count),
    plannedBytes: numOrNull(r.planned_bytes),
    doneCount: numOrNull(r.done_count),
    freedBytes: numOrNull(r.freed_bytes),
    createdAt: toIso(r.created_at),
    startedAt: toIso(r.started_at),
    finishedAt: toIso(r.finished_at),
    error: r.error,
    actionTotals: actionTotals ?? undefined,
  };
}

export async function registerPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/policies', async () => {
    const d = await db();
    const rows = await d.all<{
      id: number;
      name: string;
      kind: string;
      enabled: boolean | number;
      definition_json: string;
      created_by: string | null;
      created_at: Date;
      updated_at: Date;
    }>(`SELECT id, name, kind, enabled, definition_json, created_by, created_at, updated_at
        FROM spo.policies ORDER BY updated_at DESC, id DESC`);
    return { items: rows.map(mapPolicyRow) };
  });

  app.post('/api/v2/policies', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const parsed = policyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid policy' },
      });
    }
    const { name, definition } = parsed.data;
    const d = await db();
    const row = await d.one<{
      id: number;
      name: string;
      kind: string;
      enabled: boolean | number;
      definition_json: string;
      created_by: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO spo.policies (name, kind, enabled, definition_json, created_by)
       OUTPUT INSERTED.id, INSERTED.name, INSERTED.kind, INSERTED.enabled, INSERTED.definition_json,
              INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
       VALUES (@name, @kind, 0, @def, @by)`,
      { name, kind: definition.kind, def: JSON.stringify(definition), by: admin },
    );
    return reply.status(201).send(mapPolicyRow(row!));
  });

  app.put('/api/v2/policies/:id', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const parsed = policyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid policy' },
      });
    }
    const { name, definition } = parsed.data;
    const d = await db();
    const row = await d.one<{
      id: number;
      name: string;
      kind: string;
      enabled: boolean | number;
      definition_json: string;
      created_by: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE spo.policies
       SET name = @name, kind = @kind, definition_json = @def, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.id, INSERTED.name, INSERTED.kind, INSERTED.enabled, INSERTED.definition_json,
              INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
       WHERE id = @id`,
      { id, name, kind: definition.kind, def: JSON.stringify(definition) },
    );
    if (!row) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
    }
    return mapPolicyRow(row);
  });

  app.delete('/api/v2/policies/:id', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const d = await db();
    const n = await d.exec(`DELETE FROM spo.policies WHERE id = @id`, { id });
    if (!n) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
    }
    return reply.status(204).send();
  });

  app.post('/api/v2/policies/simulate', async (request, reply) => {
    const parsed = simulateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid policy definition' },
      });
    }
    return enrichSimulation(parsed.data.definition, parsed.data.previewSize);
  });

  app.post('/api/v2/policies/:id/runs', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const parsed = createRunBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid run scope' },
      });
    }
    const d = await db();
    const policy = await d.one<{ id: number; name: string; definition_json: string }>(
      `SELECT id, name, definition_json FROM spo.policies WHERE id = @id`,
      { id },
    );
    if (!policy) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
    }
    const def = policyDefinitionSchema.parse(JSON.parse(policy.definition_json));
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
      `INSERT INTO spo.policy_runs (policy_id, scope, mode, status, definition_json, requested_by)
       OUTPUT INSERTED.*
       VALUES (@policyId, N'tenant', N'execute', N'planned', @def, @by)`,
      { policyId: id, def: JSON.stringify(def), by: admin },
    );
    const plan = await materializePlan(run!.id, def);
    return reply.status(201).send({
      ...mapRunRow({ ...run!, policy_name: policy.name, planned_count: plan.count, planned_bytes: plan.bytes }),
      plannedCount: plan.count,
      plannedBytes: plan.bytes,
    });
  });

  app.get('/api/v2/runs', async (request, reply) => {
    const parsed = runsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid run parameters' },
      });
    }
    const { scope, status, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;
    const d = await db();
    const totals = await d.one<{ total: number }>(
      `SELECT COUNT_BIG(*) AS total FROM spo.policy_runs
       WHERE (@scope IS NULL OR scope = @scope)
         AND (@status IS NULL OR status = @status)`,
      { scope: scope ?? null, status: status ?? null },
    );
    const rows = await d.all<{
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
      policy_name: string | null;
    }>(
      `SELECT r.*, p.name AS policy_name
       FROM spo.policy_runs r
       LEFT JOIN spo.policies p ON p.id = r.policy_id
       WHERE (@scope IS NULL OR r.scope = @scope)
         AND (@status IS NULL OR r.status = @status)
       ORDER BY r.created_at DESC, r.id DESC
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      { scope: scope ?? null, status: status ?? null, offset, pageSize },
    );
    return {
      items: rows.map((r) => mapRunRow(r)),
      total: num(totals?.total),
      page,
      pageSize,
    };
  });

  app.get('/api/v2/runs/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const d = await db();
    const row = await d.one<{
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
      policy_name: string | null;
    }>(
      `SELECT r.*, p.name AS policy_name
       FROM spo.policy_runs r
       LEFT JOIN spo.policies p ON p.id = r.policy_id
       WHERE r.id = @id`,
      { id },
    );
    if (!row) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    }
    const totals = await d.all<{ status: string; c: number }>(
      `SELECT status, COUNT_BIG(*) AS c FROM spo.policy_actions WHERE run_id = @id GROUP BY status`,
      { id },
    );
    const actionTotals: Record<string, number> = {};
    for (const t of totals) actionTotals[t.status] = num(t.c);
    return mapRunRow(row, actionTotals);
  });

  app.get('/api/v2/runs/:id/actions', async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const parsed = actionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid action parameters' },
      });
    }
    const { status, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;
    const d = await db();
    const totals = await d.one<{ total: number }>(
      `SELECT COUNT_BIG(*) AS total FROM spo.policy_actions
       WHERE run_id = @id AND (@status IS NULL OR status = @status)`,
      { id, status: status ?? null },
    );
    const rows = await d.all<{
      id: number;
      site_id: number | null;
      library_id: number | null;
      file_id: number | null;
      target_url: string;
      action: string;
      bytes: number;
      status: string;
      detail: string | null;
      evidence_json: string | null;
      executed_at: Date | null;
    }>(
      `SELECT id, site_id, library_id, file_id, target_url, action, bytes, status, detail, evidence_json, executed_at
       FROM spo.policy_actions
       WHERE run_id = @id AND (@status IS NULL OR status = @status)
       ORDER BY id
       OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      { id, status: status ?? null, offset, pageSize },
    );
    return {
      items: rows.map((a) => ({
        id: num(a.id),
        siteId: numOrNull(a.site_id),
        libraryId: numOrNull(a.library_id),
        fileId: numOrNull(a.file_id),
        targetUrl: a.target_url,
        action: a.action,
        bytes: num(a.bytes),
        status: a.status,
        detail: a.detail,
        evidence: parseJsonSafe(a.evidence_json),
        executedAt: toIso(a.executed_at),
      })),
      total: num(totals?.total),
      page,
      pageSize,
    };
  });

  app.post('/api/v2/runs/:id/approve', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const parsed = approveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid approval' },
      });
    }
    const { step, confirmText } = parsed.data;
    const d = await db();
    const run = await d.one<{
      id: number;
      status: string;
      planned_count: number | null;
      approvals_json: string | null;
    }>(`SELECT id, status, planned_count, approvals_json FROM spo.policy_runs WHERE id = @id`, { id });
    if (!run) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    }
    if (run.status === 'cancelled' || run.status === 'done' || run.status === 'failed' || run.status === 'running') {
      return reply.status(409).send({
        error: { code: 'INVALID_STATE', message: `The run is in state ${run.status} and does not accept approval.` },
      });
    }

    const approvals = parseApprovals(run.approvals_json);
    const nextStep = (approvals.length + 1) as 1 | 2 | 3;
    if (step !== nextStep) {
      return reply.status(400).send({
        error: {
          code: 'APPROVAL_OUT_OF_ORDER',
          message: `You must complete step ${nextStep} before ${step}.`,
        },
      });
    }

    if (step === 3) {
      const expected = `DELETE ${num(run.planned_count)}`;
      if ((confirmText ?? '').trim() !== expected) {
        return reply.status(400).send({
          error: {
            code: 'CONFIRM_TEXT_MISMATCH',
            message: `You must type exactly "${expected}" to confirm.`,
          },
        });
      }
    }

    approvals.push({ step, by: admin, at: new Date().toISOString() });
    const approvalsJson = JSON.stringify(approvals);

    if (step === 1) {
      await d.exec(
        `UPDATE spo.policy_runs SET status = N'awaiting_approval', approvals_json = @approvals WHERE id = @id`,
        { id, approvals: approvalsJson },
      );
    } else if (step === 2) {
      await d.exec(`UPDATE spo.policy_runs SET approvals_json = @approvals WHERE id = @id`, {
        id,
        approvals: approvalsJson,
      });
    } else {
      await d.exec(
        `UPDATE spo.policy_runs
         SET status = N'running', started_at = SYSUTCDATETIME(), approvals_json = @approvals
         WHERE id = @id`,
        { id, approvals: approvalsJson },
      );
      await enqueuePolicyRun(id);
    }

    const updated = await d.one<{
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
      policy_name: string | null;
    }>(
      `SELECT r.*, p.name AS policy_name
       FROM spo.policy_runs r
       LEFT JOIN spo.policies p ON p.id = r.policy_id
       WHERE r.id = @id`,
      { id },
    );
    return mapRunRow(updated!);
  });

  app.post('/api/v2/runs/:id/cancel', async (request, reply) => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } });
    }
    const d = await db();
    const run = await d.one<{ status: string }>(`SELECT status FROM spo.policy_runs WHERE id = @id`, { id });
    if (!run) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Run not found' } });
    }
    if (run.status === 'done' || run.status === 'cancelled') {
      return reply.status(409).send({
        error: { code: 'INVALID_STATE', message: `The run is already ${run.status}.` },
      });
    }
    await d.exec(
      `UPDATE spo.policy_runs SET status = N'cancelled', finished_at = SYSUTCDATETIME() WHERE id = @id`,
      { id },
    );
    return { ok: true, status: 'cancelled' };
  });
}

export { enrichSimulation, mapRunRow, parseApprovals, parseJsonSafe };
