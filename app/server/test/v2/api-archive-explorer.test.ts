import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { setWebSpoClientForTests } from '../../src/v2/api/spo-web.js';
import { db } from '../../src/v2/db.js';
import { SpoClient } from '../../src/v2/spo/client.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

const WEB = 'https://t.sharepoint.com/sites/a';
const SITE_PATH = '/sites/a';
const ROOT = `${SITE_PATH}/Shared Documents`;

async function seedArchiveTree() {
  const d = await db();
  await d.exec(`
    SET IDENTITY_INSERT spo.sites ON;
    INSERT INTO spo.sites (id, url, title) VALUES
      (1, N'${WEB}', N'Alpha'),
      (2, N'https://t.sharepoint.com/sites/b', N'Beta');
    SET IDENTITY_INSERT spo.sites OFF;

    SET IDENTITY_INSERT spo.policy_runs ON;
    INSERT INTO spo.policy_runs (id, scope, mode, status, definition_json)
    VALUES (90, N'lab', N'execute', N'done', N'{}');
    SET IDENTITY_INSERT spo.policy_runs OFF;

    INSERT INTO spo.policy_actions (
      run_id, site_id, target_url, action, bytes, status, detail, evidence_json, executed_at)
    VALUES (
      90, 1, N'${ROOT}/folder[1]/old%video.mp4', N'archive_file', 8000, N'done',
      N'hash ok', N'{"blobSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',
      SYSUTCDATETIME());

    SET IDENTITY_INSERT spo.archived_files ON;
    INSERT INTO spo.archived_files (
      id, site_id, original_url, web_url, name, extension, size_bytes, sha256, content_type,
      blob_container, blob_path, blob_tier, link_url, unique_perms, acl_json,
      original_modified_at, original_modified_by, state, run_id, archived_by, archived_at)
    VALUES
      (50, 1, N'${ROOT}/folder[1]/old%video.mp4', N'${WEB}',
        N'old%video.mp4', N'.mp4', 8000, REPLICATE('b', 64), N'video/mp4',
        N'archive', N'a/Shared Documents/folder[1]/old%video.mp4', N'Cold',
        N'${ROOT}/folder[1]/old%video.mp4.url',
        1, N'[{"upn":"jorge@example.com"}]',
        '2024-06-01', N'Ana', N'original_deleted', 90, N'lab', SYSUTCDATETIME()),
      (51, 1, N'${ROOT}/folder[1]/nested/deep.zip', N'${WEB}',
        N'deep.zip', N'.zip', 1200, REPLICATE('c', 64), N'application/zip',
        N'archive', N'a/Shared Documents/folder[1]/nested/deep.zip', N'Cold',
        N'${ROOT}/folder[1]/nested/deep.zip.url',
        0, NULL,
        '2024-07-01', N'Bob', N'linked', NULL, N'lab', SYSUTCDATETIME()),
      (52, 1, N'${ROOT}/root-file.pptx', N'${WEB}',
        N'root-file.pptx', N'.pptx', 500, REPLICATE('d', 64), N'application/pptx',
        N'archive', N'a/Shared Documents/root-file.pptx', N'Cold',
        N'${ROOT}/root-file.pptx.url',
        0, NULL,
        NULL, NULL, N'original_deleted', NULL, N'lab', SYSUTCDATETIME()),
      (53, 2, N'/sites/b/Docs/solo.docx', N'https://t.sharepoint.com/sites/b',
        N'solo.docx', N'.docx', 300, REPLICATE('e', 64), N'application/docx',
        N'archive', N'b/Docs/solo.docx', N'Cold',
        N'/sites/b/Docs/solo.docx.url',
        0, NULL,
        NULL, NULL, N'original_deleted', NULL, N'lab', SYSUTCDATETIME()),
      (54, 1, N'${ROOT}/failed.bin', N'${WEB}',
        N'failed.bin', N'.bin', 99, REPLICATE('f', 64), N'application/octet-stream',
        N'archive', N'a/failed.bin', N'Cold', NULL,
        0, NULL, NULL, NULL, N'failed', NULL, N'lab', SYSUTCDATETIME());
    SET IDENTITY_INSERT spo.archived_files OFF;

    INSERT INTO spo.archive_access_log (archived_id, at, user_upn, granted, reason)
    VALUES (50, SYSUTCDATETIME(), N'jorge@example.com', 1, N'unique ACL');
  `);
}

describe('v2 API /archive tree and item', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
    await seedArchiveTree();
  });

  afterEach(async () => {
    setWebSpoClientForTests(null);
    await closeTestDb();
  });

  it('lists sites and navigates folders with special characters', async () => {
    const app = await buildApp({ logger: false });

    const sitesRes = await app.inject({ method: 'GET', url: '/api/v2/archive/tree' });
    expect(sitesRes.statusCode).toBe(200);
    const sitesBody = sitesRes.json();
    expect(sitesBody.summary).toMatchObject({ fileCount: 4, bytes: 8000 + 1200 + 500 + 300 });
    expect(sitesBody.sites).toHaveLength(2);
    expect(sitesBody.sites[0]).toMatchObject({
      siteId: 1,
      title: 'Alpha',
      fileCount: 3,
      bytes: 9700,
    });

    const root = await app.inject({
      method: 'GET',
      url: '/api/v2/archive/tree?siteId=1',
    });
    expect(root.statusCode).toBe(200);
    const rootBody = root.json();
    expect(rootBody.folders.map((f: { name: string }) => f.name)).toEqual(['Shared Documents']);
    expect(rootBody.files).toEqual([]);

    const lib = await app.inject({
      method: 'GET',
      url: `/api/v2/archive/tree?siteId=1&path=${encodeURIComponent('/Shared Documents')}`,
    });
    expect(lib.statusCode).toBe(200);
    const libBody = lib.json();
    expect(libBody.folders.map((f: { name: string }) => f.name)).toEqual(['folder[1]']);
    expect(libBody.files.map((f: { name: string }) => f.name)).toEqual(['root-file.pptx']);

    const folder = await app.inject({
      method: 'GET',
      url: `/api/v2/archive/tree?siteId=1&path=${encodeURIComponent('/Shared Documents/folder[1]')}`,
    });
    expect(folder.statusCode).toBe(200);
    const folderBody = folder.json();
    expect(folderBody.folders.map((f: { name: string }) => f.name)).toEqual(['nested']);
    expect(folderBody.files.map((f: { name: string }) => f.name)).toEqual(['old%video.mp4']);
    expect(folderBody.files[0]).toMatchObject({
      archivedId: 50,
      blobTier: 'Cold',
      state: 'original_deleted',
      originalModifiedBy: 'Ana',
    });

    await app.close();
  });

  it('returns item detail with Azure/SharePoint links and live access', async () => {
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
    const res = await app.inject({ method: 'GET', url: '/api/v2/archive/item/50' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: 50,
      name: 'old%video.mp4',
      blobTier: 'Cold',
      portalUrl: '/archive/50',
      sha256: 'b'.repeat(64),
    });
    expect(body.blobUrlInPortal).toContain('portal.azure.com');
    expect(body.blobUrlInPortal).toContain(encodeURIComponent('archive/a/Shared Documents/folder[1]/old%video.mp4'));
    expect(body.containerUrlInPortal).toContain('ContainerMenuBlade');
    expect(body.sharePointFolderUrl).toBe(
      'https://t.sharepoint.com' + encodeURI(`${ROOT}/folder[1]`),
    );
    expect(body.sharePointLinkUrl).toBe(
      'https://t.sharepoint.com' + encodeURI(`${ROOT}/folder[1]/old%video.mp4.url`),
    );
    expect(body.access.people[0].email).toBe('jorge@example.com');
    expect(body.accessLog).toHaveLength(1);
    expect(body.accessLog[0].userUpn).toBe('jorge@example.com');
    expect(body.integrity).toMatchObject({
      sha256: 'b'.repeat(64),
      detail: 'hash ok',
    });
    expect(body.integrity.evidence).toEqual({
      blobSha256: 'b'.repeat(64),
    });
    expect(body.acl).toEqual([{ upn: 'jorge@example.com' }]);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v2/archive/tree',
      headers: { 'x-ms-client-principal-name': 'nobody@example.com' },
    });
    expect(forbidden.statusCode).toBe(403);

    await app.close();
  });
});
