import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { setWebSpoClientForTests } from '../../src/v2/api/spo-web.js';
import { db } from '../../src/v2/db.js';
import { SpoClient } from '../../src/v2/spo/client.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

const WEB = 'https://t.sharepoint.com/sites/a';
const ROOT = '/sites/a/Shared Documents';

async function seedExplorerTree() {
  const d = await db();
  await d.exec(`
    SET IDENTITY_INSERT spo.sites ON;
    INSERT INTO spo.sites (id, url, title) VALUES (1, N'${WEB}', N'Alpha');
    SET IDENTITY_INSERT spo.sites OFF;
    SET IDENTITY_INSERT spo.libraries ON;
    INSERT INTO spo.libraries (id, site_id, web_url, list_guid, title, root_url, base_template, hidden)
    VALUES (10, 1, N'${WEB}', NEWID(), N'Documentos', N'${ROOT}', 101, 0);
    SET IDENTITY_INSERT spo.libraries OFF;
    INSERT INTO spo.library_rollups (
      library_id, site_id, file_count, current_bytes, total_bytes, versions_bytes,
      heavy_versions_files, heavy_versions_bytes,
      age_30_bytes, age_120_bytes, age_365_bytes, age_730_bytes, age_old_bytes, computed_at)
    VALUES (10, 1, 4, 4000, 7000, 3000, 0, 0, 0, 0, 0, 0, 0, SYSUTCDATETIME());
    SET IDENTITY_INSERT spo.files ON;
    INSERT INTO spo.files (id, site_id, library_id, unique_id, list_item_id, server_relative_url, name, extension,
      size_bytes, total_bytes, modified_at, author, editor, seen_at)
    VALUES
      (1, 1, 10, NEWID(), 1, N'${ROOT}/folder[1]/file%20.txt', N'file%20.txt', N'.txt',
        100, 100, '2024-01-01', N'Ana', N'Ana', SYSUTCDATETIME()),
      (2, 1, 10, NEWID(), 2, N'${ROOT}/folder[1]/nested/deep.docx', N'deep.docx', N'.docx',
        200, 500, '2024-02-01', N'Bob', N'Bob', SYSUTCDATETIME()),
      (3, 1, 10, NEWID(), 3, N'${ROOT}/root-file.pptx', N'root-file.pptx', N'.pptx',
        300, 900, '2024-03-01', N'Ana', N'Carol', SYSUTCDATETIME()),
      (4, 1, 10, NEWID(), 4, N'${ROOT}/folder[1]/sibling.psd', N'sibling.psd', N'.psd',
        400, 400, '2024-04-01', N'Dan', N'Dan', SYSUTCDATETIME());
    SET IDENTITY_INSERT spo.files OFF;
    INSERT INTO spo.file_versions (file_id, version_id, label, size_bytes, created_at, created_by, captured_at)
    VALUES (3, 512, N'1.0', 600, '2024-01-01', N'Ana', SYSUTCDATETIME());
    SET IDENTITY_INSERT spo.archived_files ON;
    INSERT INTO spo.archived_files (
      id, site_id, original_url, web_url, name, extension, size_bytes, sha256, content_type,
      blob_container, blob_path, blob_tier, link_url, unique_perms, acl_json, state, archived_by, archived_at)
    VALUES (
      50, 1, N'${ROOT}/folder[1]/old%video.mp4', N'${WEB}',
      N'old%video.mp4', N'.mp4', 8000, REPLICATE('b', 64), N'video/mp4',
      N'archive', N'a/uid/old.mp4', N'Cold', N'${ROOT}/folder[1]/old%video.mp4.url',
      1, N'[{"upn":"jorge@example.com"}]', N'original_deleted', N'lab', SYSUTCDATETIME());
    SET IDENTITY_INSERT spo.archived_files OFF;
  `);
}

describe('v2 API /explorer', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
    await seedExplorerTree();
  });

  afterEach(async () => {
    setWebSpoClientForTests(null);
    await closeTestDb();
  });

  it('lists libraries for a site and folders/files with special characters', async () => {
    const app = await buildApp({ logger: false });

    const libs = await app.inject({
      method: 'GET',
      url: '/api/v2/explorer/folder?siteId=1',
    });
    expect(libs.statusCode).toBe(200);
    const libBody = libs.json();
    expect(libBody.libraries).toHaveLength(1);
    expect(libBody.libraries[0]).toMatchObject({
      id: 10,
      title: 'Documentos',
      fileCount: 4,
      totalBytes: 7000,
      versionsBytes: 3000,
    });

    const root = await app.inject({
      method: 'GET',
      url: '/api/v2/explorer/folder?siteId=1&libraryId=10&path=',
    });
    expect(root.statusCode).toBe(200);
    const rootBody = root.json();
    expect(rootBody.folders.map((f: { name: string }) => f.name)).toEqual(['folder[1]']);
    expect(rootBody.folders[0]).toMatchObject({
      path: '/folder[1]',
      archivedCount: 1,
    });
    expect(rootBody.files.map((f: { name: string }) => f.name)).toEqual(['root-file.pptx']);
    expect(rootBody.hasMore).toBe(false);

    const folder = await app.inject({
      method: 'GET',
      url: `/api/v2/explorer/folder?siteId=1&libraryId=10&path=${encodeURIComponent('/folder[1]')}`,
    });
    expect(folder.statusCode).toBe(200);
    const folderBody = folder.json();
    expect(folderBody.folders.map((f: { name: string }) => f.name)).toEqual(['nested']);
    const names = folderBody.files.map((f: { name: string; archived: boolean }) => `${f.name}:${f.archived}`);
    expect(names).toContain('old%video.mp4:true');
    expect(names).toContain('sibling.psd:false');
    expect(names).toContain('file%20.txt:false');
    const archived = folderBody.files.find((f: { archived: boolean }) => f.archived);
    expect(archived).toMatchObject({
      archivedId: 50,
      blobTier: 'Cold',
      totalBytes: 8000,
    });

    await app.close();
  });

  it('returns file detail with access from a fake SpoClient', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/RoleAssignments')) {
        return json({
          value: [
            {
              PrincipalId: 7,
              Member: {
                LoginName: 'i:0#.f|membership|jorge@example.com',
                Title: 'Jorge',
                PrincipalType: 1,
              },
              RoleDefinitionBindings: [{ Id: 1, Name: 'Editar', RoleTypeKind: 6 }],
            },
          ],
        });
      }
      return json({ error: { message: `unexpected ${url}` } }, 404);
    };
    setWebSpoClientForTests(async () => new SpoClient({ tenant: 't', tokenProvider: async () => 't', fetchImpl }));

    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/v2/explorer/file/3' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('root-file.pptx');
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].label).toBe('1.0');
    expect(body.access.everyone).toBe(false);
    expect(body.access.people[0]).toMatchObject({
      email: 'jorge@example.com',
      roles: ['Editar'],
      via: ['directo'],
    });

    const archived = await app.inject({ method: 'GET', url: '/api/v2/explorer/archived/50' });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      id: 50,
      blobTier: 'Cold',
      linkUrl: `${ROOT}/folder[1]/old%video.mp4.url`,
    });
    expect(archived.json().access.people[0].email).toBe('jorge@example.com');

    await app.close();
  });
});
