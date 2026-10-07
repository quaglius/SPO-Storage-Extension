import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { setWebSpoClientForTests } from '../../src/v2/api/spo-web.js';
import { db } from '../../src/v2/db.js';
import { SpoClient } from '../../src/v2/spo/client.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

async function seedArchived() {
  const d = await db();
  await d.exec(`
    SET IDENTITY_INSERT spo.sites ON;
    INSERT INTO spo.sites (id, url, title) VALUES (1, N'https://t.sharepoint.com/sites/a', N'Alpha');
    SET IDENTITY_INSERT spo.sites OFF;
    SET IDENTITY_INSERT spo.archived_files ON;
    INSERT INTO spo.archived_files (
      id, site_id, original_url, web_url, name, extension, size_bytes, sha256, content_type,
      blob_container, blob_path, blob_tier, link_url, unique_perms, acl_json, state, archived_by, archived_at)
    VALUES (
      7, 1, N'/sites/a/Shared Documents/secreto.docx', N'https://t.sharepoint.com/sites/a',
      N'secreto.docx', N'.docx', 2048, REPLICATE('b', 64), N'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      N'archive', N'a/uid/secreto.docx', N'Cold', N'/sites/a/Shared Documents/secreto.docx.url',
      1, N'[{"principal":"jorge@example.com","role":"Read"}]', N'original_deleted', N'lab', SYSUTCDATETIME());
    SET IDENTITY_INSERT spo.archived_files OFF;
  `);
}

function denyClient() {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ Low: 0, High: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  return new SpoClient({ tenant: 'test', tokenProvider: async () => 't', fetchImpl });
}

describe('v2 API /archived and /portal', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
    await seedArchived();
  });

  afterEach(async () => {
    setWebSpoClientForTests(null);
    await closeTestDb();
  });

  it('lists archived files and returns detail with acl and access log for admins', async () => {
    const app = await buildApp({ logger: false });
    const list = await app.inject({ method: 'GET', url: '/api/v2/archived' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].name).toBe('secreto.docx');

    const detail = await app.inject({ method: 'GET', url: '/api/v2/archived/7' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().acl).toEqual([{ principal: 'jorge@example.com', role: 'Read' }]);
    expect(Array.isArray(detail.json().accessLog)).toBe(true);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v2/archived',
      headers: { 'x-ms-client-principal-name': 'nobody@example.com' },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it('portal returns 403 without file data and denies download when not authorized', async () => {
    setWebSpoClientForTests(async () => denyClient());
    const app = await buildApp({ logger: false });

    const portal = await app.inject({
      method: 'GET',
      url: '/api/v2/portal/7',
      headers: { 'x-ms-client-principal-name': 'intruso@example.com' },
    });
    expect(portal.statusCode).toBe(403);
    expect(portal.json().error.code).toBe('FORBIDDEN');
    expect(portal.json().error.message).toContain('permission');
    expect(portal.json().name).toBeUndefined();
    expect(portal.json().sizeBytes).toBeUndefined();

    const download = await app.inject({
      method: 'GET',
      url: '/api/v2/portal/7/download',
      headers: { 'x-ms-client-principal-name': 'intruso@example.com' },
    });
    expect(download.statusCode).toBe(403);
    expect(download.json().error.code).toBe('FORBIDDEN');

    await app.close();
  });

  it('portal grants access for platform admins', async () => {
    setWebSpoClientForTests(async () => denyClient());
    const app = await buildApp({ logger: false });
    const portal = await app.inject({
      method: 'GET',
      url: '/api/v2/portal/7',
      headers: { 'x-ms-client-principal-name': 'admin@example.com' },
    });
    expect(portal.statusCode).toBe(200);
    expect(portal.json().name).toBe('secreto.docx');
    expect(portal.json().granted).toBe(true);
    expect(portal.json().siteTitle).toBe('Alpha');
    await app.close();
  });
});
