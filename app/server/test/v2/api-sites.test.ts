import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/v2/db.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

async function seedTwoSites() {
  const d = await db();
  const a = await d.one<{ id: number }>(
    `INSERT INTO spo.sites (url, title, storage_used_bytes, spo_file_count, access_state)
     OUTPUT INSERTED.id
     VALUES (N'https://contoso.sharepoint.com/sites/alpha', N'Alpha', 900000000, 10, N'ok')`,
  );
  const b = await d.one<{ id: number }>(
    `INSERT INTO spo.sites (url, title, storage_used_bytes, spo_file_count, access_state)
     OUTPUT INSERTED.id
     VALUES (N'https://contoso.sharepoint.com/sites/beta', N'Beta', 100000000, 5, N'ok')`,
  );
  const libA = await d.one<{ id: number }>(
    `INSERT INTO spo.libraries (site_id, web_url, list_guid, title, root_url, base_template, hidden, baseline_state)
     OUTPUT INSERTED.id
     VALUES (@siteId, N'https://x', NEWID(), N'Documentos', N'/Docs', 101, 0, N'done')`,
    { siteId: a!.id },
  );
  await d.exec(
    `INSERT INTO spo.library_rollups (
       library_id, site_id, file_count, current_bytes, total_bytes, versions_bytes,
       heavy_versions_files, heavy_versions_bytes,
       age_30_bytes, age_120_bytes, age_365_bytes, age_730_bytes, age_old_bytes, computed_at)
     VALUES (@libId, @siteId, 10, 500000000, 700000000, 200000000, 1, 100000000, 0,0,0,0,0, SYSUTCDATETIME())`,
    { libId: libA!.id, siteId: a!.id },
  );
  await d.exec(
    `INSERT INTO spo.recycle_bin (site_id, first_stage_bytes, first_stage_items, second_stage_bytes, second_stage_items, captured_at)
     VALUES (@siteId, 10000000, 1, 0, 0, SYSUTCDATETIME())`,
    { siteId: a!.id },
  );
  return { siteA: a!.id, siteB: b!.id, libA: libA!.id };
}

describe('v2 API /sites', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
  });

  afterEach(async () => {
    await closeTestDb();
  });

  it('lists sites with sort and search', async () => {
    await seedTwoSites();
    const app = await buildApp({ logger: false });

    const byUsed = await app.inject({
      method: 'GET',
      url: '/api/v2/sites?sort=used&dir=desc&pageSize=10',
    });
    expect(byUsed.statusCode).toBe(200);
    const usedBody = byUsed.json();
    expect(usedBody.total).toBe(2);
    expect(usedBody.items[0].title).toBe('Alpha');
    expect(usedBody.items[0].explainedBytes).toBe(710_000_000);
    expect(usedBody.items[0].percent).toBeCloseTo(710_000_000 / 900_000_000, 6);
    expect(usedBody.items[0].versionsBytes).toBe(200_000_000);
    expect(usedBody.items[0].libraries).toEqual({ total: 1, done: 1, failed: 0 });

    const search = await app.inject({ method: 'GET', url: '/api/v2/sites?search=beta' });
    expect(search.json().items).toHaveLength(1);
    expect(search.json().items[0].title).toBe('Beta');

    const byName = await app.inject({ method: 'GET', url: '/api/v2/sites?sort=name&dir=asc' });
    expect(byName.json().items.map((i: { title: string }) => i.title)).toEqual(['Alpha', 'Beta']);

    await app.close();
  });

  it('returns site detail with libraries and top files', async () => {
    const { siteA, libA } = await seedTwoSites();
    const d = await db();
    await d.exec(
      `INSERT INTO spo.files (site_id, library_id, unique_id, server_relative_url, name, extension,
         size_bytes, total_bytes, modified_at, seen_at)
       VALUES
         (@siteId, @libId, NEWID(), N'/a.docx', N'a.docx', N'docx', 1000, 5000, SYSUTCDATETIME(), SYSUTCDATETIME()),
         (@siteId, @libId, NEWID(), N'/b.pdf', N'b.pdf', N'pdf', 9000, 9000, SYSUTCDATETIME(), SYSUTCDATETIME())`,
      { siteId: siteA, libId: libA },
    );

    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: `/api/v2/sites/${siteA}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe('Alpha');
    expect(body.recycleBin.firstStageBytes).toBe(10_000_000);
    expect(body.libraries).toHaveLength(1);
    expect(body.libraries[0].baselineState).toBe('done');
    expect(body.topFilesBySize[0].name).toBe('b.pdf');
    expect(body.topFilesByVersions[0].name).toBe('a.docx');
    await app.close();
  });
});
