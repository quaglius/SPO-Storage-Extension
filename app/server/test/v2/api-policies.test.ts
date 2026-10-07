import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/v2/db.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

const MB = 1024 * 1024;

async function seedPolicyTargets() {
  const d = await db();
  await d.exec(`
    SET IDENTITY_INSERT spo.sites ON;
    INSERT INTO spo.sites (id, url, title) VALUES (1, N'https://t.sharepoint.com/sites/a', N'Alpha');
    SET IDENTITY_INSERT spo.sites OFF;
    SET IDENTITY_INSERT spo.libraries ON;
    INSERT INTO spo.libraries (id, site_id, web_url, list_guid, title, root_url, base_template, hidden)
    VALUES (10, 1, N'https://t.sharepoint.com/sites/a', NEWID(), N'Documentos', N'/sites/a/Shared Documents', 101, 0);
    SET IDENTITY_INSERT spo.libraries OFF;
    SET IDENTITY_INSERT spo.files ON;
    INSERT INTO spo.files (id, site_id, library_id, unique_id, list_item_id, server_relative_url, name, extension,
      size_bytes, total_bytes, modified_at, seen_at)
    VALUES
      (1, 1, 10, NEWID(), 1, N'/x/viejo.mp4', N'viejo.mp4', N'.mp4', ${500 * MB}, ${900 * MB}, '2020-01-01', SYSUTCDATETIME()),
      (2, 1, 10, NEWID(), 2, N'/x/nuevo.pptx', N'nuevo.pptx', N'.pptx', ${50 * MB}, ${300 * MB}, '2026-09-01', SYSUTCDATETIME());
    SET IDENTITY_INSERT spo.files OFF;
    INSERT INTO spo.file_versions (file_id, version_id, label, size_bytes, created_at, captured_at) VALUES
      (2, 512, N'1.0', ${100 * MB}, '2026-01-01', SYSUTCDATETIME()),
      (2, 1024, N'2.0', ${100 * MB}, '2026-02-01', SYSUTCDATETIME()),
      (2, 1536, N'3.0', ${50 * MB}, '2026-09-20', SYSUTCDATETIME());
  `);
}

const deleteVersionsDef = {
  kind: 'delete_versions' as const,
  scope: {},
  minVersionsBytes: 100 * MB,
  keepLatest: 1,
  olderThanDays: 30,
};

describe('v2 API /policies and /runs', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
    await seedPolicyTargets();
  });

  afterEach(async () => {
    await closeTestDb();
  });

  it('CRUD policies with validation; non-admin cannot write', async () => {
    const app = await buildApp({ logger: false });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v2/policies',
      payload: { name: 'x', definition: { kind: 'nope' } },
    });
    expect(bad.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/policies',
      payload: { name: 'Heavy versions', definition: deleteVersionsDef },
    });
    expect(created.statusCode).toBe(201);
    const policy = created.json();
    expect(policy.name).toBe('Heavy versions');
    expect(policy.kind).toBe('delete_versions');
    expect(policy.kindLabel).toContain('historic');

    const list = await app.inject({ method: 'GET', url: '/api/v2/policies' });
    expect(list.json().items).toHaveLength(1);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v2/policies/${policy.id}`,
      payload: { name: 'Versions (edited)', definition: deleteVersionsDef },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe('Versions (edited)');

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v2/policies',
      headers: { 'x-ms-client-principal-name': 'nobody@example.com' },
      payload: { name: 'No', definition: deleteVersionsDef },
    });
    expect(forbidden.statusCode).toBe(403);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v2/policies/${policy.id}` });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v2/policies' })).json().items).toHaveLength(0);

    await app.close();
  });

  it('simulates a policy with site and file names', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/policies/simulate',
      payload: { definition: deleteVersionsDef },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.preview.some((p: { fileName: string }) => p.fileName === 'viejo.mp4')).toBe(true);
    expect(body.bySite[0].title).toBe('Alpha');
    await app.close();
  });

  it('creates a run with materialized plan and enforces triple approval', async () => {
    const app = await buildApp({ logger: false });
    const policy = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/policies',
        payload: { name: 'P', definition: deleteVersionsDef },
      })
    ).json();

    const runRes = await app.inject({
      method: 'POST',
      url: `/api/v2/policies/${policy.id}/runs`,
      payload: { scope: 'tenant' },
    });
    expect(runRes.statusCode).toBe(201);
    const run = runRes.json();
    expect(run.status).toBe('planned');
    expect(run.plannedCount).toBe(2);
    expect(run.plannedBytes).toBeGreaterThan(0);

    const outOfOrder = await app.inject({
      method: 'POST',
      url: `/api/v2/runs/${run.id}/approve`,
      payload: { step: 2 },
    });
    expect(outOfOrder.statusCode).toBe(400);
    expect(outOfOrder.json().error.code).toBe('APPROVAL_OUT_OF_ORDER');

    const step1 = await app.inject({
      method: 'POST',
      url: `/api/v2/runs/${run.id}/approve`,
      payload: { step: 1 },
    });
    expect(step1.statusCode).toBe(200);
    expect(step1.json().status).toBe('awaiting_approval');
    expect(step1.json().approvals).toHaveLength(1);

    const step2 = await app.inject({
      method: 'POST',
      url: `/api/v2/runs/${run.id}/approve`,
      payload: { step: 2 },
    });
    expect(step2.statusCode).toBe(200);
    expect(step2.json().approvals).toHaveLength(2);

    const badConfirm = await app.inject({
      method: 'POST',
      url: `/api/v2/runs/${run.id}/approve`,
      payload: { step: 3, confirmText: 'DELETE 999' },
    });
    expect(badConfirm.statusCode).toBe(400);
    expect(badConfirm.json().error.code).toBe('CONFIRM_TEXT_MISMATCH');

    const nonAdmin = await app.inject({
      method: 'POST',
      url: `/api/v2/runs/${run.id}/approve`,
      headers: { 'x-ms-client-principal-name': 'nobody@example.com' },
      payload: { step: 3, confirmText: `DELETE ${run.plannedCount}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    const step3 = await app.inject({
      method: 'POST',
      url: `/api/v2/runs/${run.id}/approve`,
      payload: { step: 3, confirmText: `DELETE ${run.plannedCount}` },
    });
    expect(step3.statusCode).toBe(200);
    expect(step3.json().status).toBe('running');
    expect(step3.json().startedAt).toBeTruthy();

    const d = await db();
    const task = await d.one<{ kind: string; target_key: string; state: string }>(
      `SELECT kind, target_key, state FROM spo.tasks WHERE kind = N'policy-run' AND target_key = @key`,
      { key: `run:${run.id}` },
    );
    expect(task).toBeTruthy();
    expect(task!.state).toBe('ready');

    const detail = await app.inject({ method: 'GET', url: `/api/v2/runs/${run.id}` });
    expect(detail.json().actionTotals.planned).toBe(2);

    const actions = await app.inject({ method: 'GET', url: `/api/v2/runs/${run.id}/actions` });
    expect(actions.json().total).toBe(2);

    await app.close();
  });

  it('cancels a run', async () => {
    const app = await buildApp({ logger: false });
    const policy = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/policies',
        payload: { name: 'P', definition: deleteVersionsDef },
      })
    ).json();
    const run = (
      await app.inject({
        method: 'POST',
        url: `/api/v2/policies/${policy.id}/runs`,
        payload: { scope: 'tenant' },
      })
    ).json();

    const cancel = await app.inject({ method: 'POST', url: `/api/v2/runs/${run.id}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('cancelled');

    const get = await app.inject({ method: 'GET', url: `/api/v2/runs/${run.id}` });
    expect(get.json().status).toBe('cancelled');
    await app.close();
  });
});
