import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { setWebSpoClientForTests } from '../../src/v2/api/spo-web.js';
import { db } from '../../src/v2/db.js';
import { SpoClient } from '../../src/v2/spo/client.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

const MB = 1024 * 1024;

async function seedManyArchiveCandidates(count: number) {
  const d = await db();
  await d.exec(`
    SET IDENTITY_INSERT spo.sites ON;
    INSERT INTO spo.sites (id, url, title) VALUES (1, N'https://t.sharepoint.com/sites/a', N'Alpha');
    SET IDENTITY_INSERT spo.sites OFF;
    SET IDENTITY_INSERT spo.libraries ON;
    INSERT INTO spo.libraries (id, site_id, web_url, list_guid, title, root_url, base_template, hidden)
    VALUES (10, 1, N'https://t.sharepoint.com/sites/a', NEWID(), N'Documentos', N'/sites/a/Shared Documents', 101, 0);
    SET IDENTITY_INSERT spo.libraries OFF;
  `);
  for (let i = 1; i <= count; i++) {
    await d.exec(
      `SET IDENTITY_INSERT spo.files ON;
       INSERT INTO spo.files (id, site_id, library_id, unique_id, list_item_id, server_relative_url, name, extension,
         size_bytes, total_bytes, modified_at, seen_at)
       VALUES (@id, 1, 10, NEWID(), @id, CONCAT(N'/x/f', @id, N'.mp4'), CONCAT(N'f', @id, N'.mp4'), N'.mp4',
         @size, @size, '2020-01-01', SYSUTCDATETIME());
       SET IDENTITY_INSERT spo.files OFF;`,
      { id: i, size: 50 * MB },
    );
  }
}

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
      42, 1, N'/sites/a/Shared Documents/video.mp4', N'https://t.sharepoint.com/sites/a',
      N'video.mp4', N'.mp4', 1000, REPLICATE('a', 64), N'video/mp4',
      N'archive', N'a/uid/video.mp4', N'Cold', N'/sites/a/Shared Documents/video.mp4.url',
      1, N'[{"upn":"jorge@example.com"}]', N'original_deleted', N'lab', SYSUTCDATETIME());
    SET IDENTITY_INSERT spo.archived_files OFF;
  `);
}

describe('v2 API /lab', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
  });

  afterEach(async () => {
    setWebSpoClientForTests(null);
    await closeTestDb();
  });

  it('rejects lab runs with more than 20 actions', async () => {
    await seedManyArchiveCandidates(25);
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/lab/runs',
      payload: {
        definition: {
          kind: 'archive_files',
          scope: {},
          minSizeBytes: 10 * MB,
          notModifiedDays: 365,
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('LAB_TOO_BIG');
    await app.close();
  });

  it('creates a small lab run', async () => {
    await seedManyArchiveCandidates(3);
    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/lab/runs',
      payload: {
        definition: {
          kind: 'archive_files',
          scope: {},
          minSizeBytes: 10 * MB,
          notModifiedDays: 365,
        },
        fileIds: [1, 2],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.scope).toBe('lab');
    expect(body.plannedCount).toBe(2);
    expect(body.selection.fileIds).toEqual([1, 2]);
    await app.close();
  });

  it('access-check grants and denies with a fake SpoClient', async () => {
    await seedArchived();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      // Jorge can open; anyone else gets effective permissions without Open bits.
      const granted = url.includes(encodeURIComponent('i:0#.f|membership|jorge@example.com'));
      return new Response(
        JSON.stringify({
          Low: granted ? 0x21 : 0,
          High: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    setWebSpoClientForTests(async () => new SpoClient({ tenant: 'test', tokenProvider: async () => 't', fetchImpl }));

    const app = await buildApp({ logger: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/lab/access-check',
      payload: {
        archivedId: 42,
        upns: ['jorge@example.com', 'otra@example.com'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(2);
    const jorge = body.results.find((r: { upn: string }) => r.upn === 'jorge@example.com');
    const other = body.results.find((r: { upn: string }) => r.upn === 'otra@example.com');
    expect(jorge.granted).toBe(true);
    expect(other.granted).toBe(false);
    await app.close();
  });
});
