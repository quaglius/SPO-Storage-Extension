import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/v2/db.js';
import type { TaskRow } from '../../src/v2/engine/queue.js';
import type { TaskContext, TaskResult } from '../../src/v2/engine/types.js';
import { aggregateRecords, auditIngest, auditPath } from '../../src/v2/crawl/audit.js';
import { policyDefinitionSchema } from '../../src/v2/policies/definitions.js';
import { simulate } from '../../src/v2/policies/plan.js';
import { getSetting, putSetting } from '../../src/v2/settings.js';
import { SpoClient } from '../../src/v2/spo/client.js';
import { resetSpo } from './helpers.js';

const Q = 'https://graph.microsoft.com/beta/security/auditLog/queries';
const MB = 1024 * 1024;

const records = [
  {
    createdDateTime: '2026-09-24T10:00:00Z',
    operation: 'FileAccessed',
    objectId: 'https://t.sharepoint.com/sites/a/Shared%20Documents/Big.pptx',
    userPrincipalName: 'jorge@example.com',
  },
  {
    createdDateTime: '2026-09-24T12:00:00Z',
    operation: 'FileDownloaded',
    objectId: 'https://t.sharepoint.com/sites/a/Shared Documents/big.pptx',
    userPrincipalName: 'eduardo@example.com',
  },
  {
    createdDateTime: '2026-09-24T13:00:00Z',
    operation: 'FileAccessed',
    objectId: 'https://t.sharepoint.com/sites/a/Shared Documents/big.pptx',
    userPrincipalName: 'app@sharepoint',
  },
];

const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (method === 'POST' && url === Q) return json({ id: 'q1' });
  if (method === 'DELETE') return new Response('', { status: 204 });
  if (url === `${Q}/q1`) return json({ status: 'succeeded' });
  if (url.startsWith(`${Q}/q1/records`)) return json({ value: records });
  return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${url}` } }), { status: 404 });
}) as typeof fetch;

const spo = new SpoClient({ tenant: 't', tokenProvider: async () => 't', fetchImpl: fakeFetch });

async function run(payload: unknown): Promise<TaskResult> {
  const task = { id: 1, kind: 'audit-ingest', target_key: 'audit', site_id: null, library_id: null } as TaskRow;
  const ctx = {
    task,
    payload,
    signal: new AbortController().signal,
    spo,
    progress: () => undefined,
    status: () => undefined,
    event: async () => undefined,
  };
  return (auditIngest as unknown as (c: TaskContext<never>) => Promise<TaskResult>)(ctx as never);
}

describe('audit ingestion', () => {
  beforeEach(async () => {
    await resetSpo();
    const d = await db();
    await d.exec(`
      SET IDENTITY_INSERT spo.sites ON;
      INSERT INTO spo.sites (id, url, title) VALUES (1, N'https://t.sharepoint.com/sites/a', N'A');
      SET IDENTITY_INSERT spo.sites OFF;
      SET IDENTITY_INSERT spo.libraries ON;
      INSERT INTO spo.libraries (id, site_id, web_url, list_guid, title, root_url, base_template, hidden)
      VALUES (10, 1, N'https://t.sharepoint.com/sites/a', NEWID(), N'Documentos', N'/sites/a/Shared Documents', 101, 0);
      SET IDENTITY_INSERT spo.libraries OFF;
      INSERT INTO spo.files (site_id, library_id, unique_id, list_item_id, server_relative_url, name, extension, size_bytes, total_bytes, modified_at, seen_at)
      VALUES (1, 10, NEWID(), 1, N'/sites/a/Shared Documents/big.pptx', N'big.pptx', N'.pptx', ${50 * MB}, ${50 * MB}, '2020-01-01', SYSUTCDATETIME()),
             (1, 10, NEWID(), 2, N'/sites/a/Shared Documents/nadie.mp4', N'nadie.mp4', N'.mp4', ${80 * MB}, ${80 * MB}, '2020-01-01', SYSUTCDATETIME());`);
  });

  it('keeps the latest human access per decoded URL', () => {
    expect(auditPath('https://t.sharepoint.com/sites/a/Shared%20Documents/x%C3%B1.docx')).toBe('/sites/a/Shared Documents/xñ.docx');
    const agg = aggregateRecords(records);
    expect([...agg.keys()]).toEqual(['/sites/a/shared documents/big.pptx']);
    expect(agg.get('/sites/a/shared documents/big.pptx')).toMatchObject({ at: '2026-09-24T12:00:00Z', user: 'eduardo@example.com', events: 2 });
  });

  it('creates the query, reads it, applies last access to files and records coverage', async () => {
    await putSetting('audit.backfillDays', 1);
    const first = await run(null);
    expect(first).toMatchObject({ outcome: 'again', afterMs: 60_000 });
    const second = await run(first.outcome === 'again' ? first.payload : null);

    const d = await db();
    const files = await d.all<{ name: string; last_access_at: Date | null; last_access_source: string | null }>(
      `SELECT name, last_access_at, last_access_source FROM spo.files ORDER BY name`,
    );
    expect(files[0]).toMatchObject({ name: 'big.pptx', last_access_source: 'audit' });
    expect(new Date(files[0].last_access_at!).toISOString()).toBe('2026-09-24T12:00:00.000Z');
    expect(files[1].last_access_at).toBeNull();

    const status = await getSetting<{ consented: boolean; coverageFrom: string | null }>('audit.status');
    expect(status?.consented).toBe(true);
    expect(status?.coverageFrom).not.toBeNull();
    expect(second.outcome).toBe('again');
  });

  it('refuses "sin acceso" policies beyond the audited period, and counts unseen files as not accessed within it', async () => {
    const def = policyDefinitionSchema.parse({ kind: 'archive_files', scope: {}, minSizeBytes: MB, notModifiedDays: 365, notAccessedDays: 90 });
    await expect(simulate(def)).rejects.toThrow(/Access audit/);

    await putSetting('audit.status', { consented: true, coverageFrom: new Date(Date.now() - 200 * 86_400_000).toISOString() });
    const d = await db();
    await d.exec(`UPDATE spo.files SET last_access_at = DATEADD(day, -3, SYSUTCDATETIME()) WHERE name = N'big.pptx'`);
    const sim = await simulate(def);
    expect(sim.count).toBe(1); // nadie.mp4: no access recorded in 200 days; big.pptx was opened 3 days ago
  });
});
