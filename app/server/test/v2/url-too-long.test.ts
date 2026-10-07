import { describe, expect, it } from 'vitest';
import { executeDeleteVersions, type FileTarget } from '../../src/v2/actions/execute.js';
import { uploadStreamToSharePoint } from '../../src/v2/actions/restore.js';
import {
  applyRoleAssignments,
  deleteVersionByLabel,
  fileExists,
  isUrlTooLong,
  listVersions,
  uploadSmallFile,
  userCanOpen,
} from '../../src/v2/actions/sp-ops.js';
import { SpoClient, SpoError } from '../../src/v2/spo/client.js';

const WEB = 'https://t.sharepoint.com/sites/a';
const UID = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const LONG = `/sites/a/Shared Documents/${'Carpeta con ñandú y acentos '.repeat(10)}/archivo.psd`;
const SHORT = '/sites/a/Shared Documents/corto.psd';
const TOO_LONG = { error: { message: { value: 'The length of the URL for this request exceeds the configured maxUrlLength value.' } } };

/** SharePoint that refuses long path-addressed URLs the way the real one does (HTTP 401 maxUrlLength). */
function fakeSharePoint() {
  const calls: string[] = [];
  const versions = [
    { ID: 512, VersionLabel: '1.0', Size: '100', Created: '2024-01-01T00:00:00Z' },
    { ID: 1024, VersionLabel: '2.0', Size: '100', Created: '2024-02-01T00:00:00Z' },
    { ID: 1536, VersionLabel: '3.0', Size: '100', Created: '2026-09-20T00:00:00Z' },
  ];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    const method = (init?.headers as Record<string, string> | undefined)?.['X-HTTP-Method'] ?? init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(/^.*\/_api\/web\//, '')}`);
    // The limit is on the URL path; the query string (parameter aliases) is not counted.
    if (/ByServerRelativePath/.test(url.split('?')[0]) && url.split('?')[0].length > 300) return new Response(JSON.stringify(TOO_LONG), { status: 401 });
    if (url.includes('/Versions/DeleteByLabel')) {
      const label = /versionlabel='([^']+)'/.exec(url)![1];
      const i = versions.findIndex((v) => v.VersionLabel === label);
      if (i >= 0) versions.splice(i, 1);
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/Versions')) return new Response(JSON.stringify({ value: versions }), { status: 200 });
    if (url.includes('$select=Exists')) return new Response(JSON.stringify({ Exists: true }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { calls, spo: new SpoClient({ tenant: 't', tokenProvider: async () => 't', fetchImpl, maxRetries: 0 }) };
}

describe('files whose path makes the REST URL too long', () => {
  it('recognizes only the maxUrlLength 401', () => {
    expect(isUrlTooLong(new SpoError('HTTP 401 The length of the URL for this request exceeds the configured maxUrlLength value.', 401, false))).toBe(true);
    expect(isUrlTooLong(new SpoError('HTTP 401 Unauthorized', 401, false))).toBe(false);
    expect(isUrlTooLong(new SpoError('HTTP 400 maxUrlLength', 400, false))).toBe(false);
    expect(isUrlTooLong(new Error('maxUrlLength'))).toBe(false);
  });

  it('short paths never touch GetFileById', async () => {
    const { calls, spo } = fakeSharePoint();
    expect((await listVersions(spo, WEB, SHORT, undefined, UID)).map((v) => v.label)).toEqual(['1.0', '2.0', '3.0']);
    expect(await fileExists(spo, WEB, SHORT, undefined, UID)).toBe(true);
    expect(calls.every((c) => !c.includes('GetFileById'))).toBe(true);
  });

  it('long paths are retried by UniqueId and give the same results', async () => {
    const { calls, spo } = fakeSharePoint();
    expect((await listVersions(spo, WEB, LONG, undefined, UID)).map((v) => v.label)).toEqual(['1.0', '2.0', '3.0']);
    expect(calls.at(-1)).toContain(`GetFileById('${UID}')/Versions`);
    await deleteVersionByLabel(spo, WEB, LONG, '1.0', undefined, UID);
    expect(calls.at(-1)).toContain(`GetFileById('${UID}')/Versions/DeleteByLabel(versionlabel='1.0')`);
    expect(await fileExists(spo, WEB, LONG, undefined, UID)).toBe(true);
  });

  it('without a UniqueId the path moves to the query string and the call works', async () => {
    const { calls, spo } = fakeSharePoint();
    expect((await listVersions(spo, WEB, LONG)).map((v) => v.label)).toEqual(['1.0', '2.0', '3.0']);
    expect(calls.at(-1)).toContain('GetFileByServerRelativePath(decodedurl=@p)/Versions?$select=ID,VersionLabel,Size,Created&@p=');
    expect(calls.at(-1)).toContain(LONG);
    expect(await fileExists(spo, WEB, LONG, undefined, null)).toBe(true);
  });

  it('a 401 that is not about the URL length is still an error', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: { value: 'Access denied' } } }), { status: 401 })) as typeof fetch;
    const spo = new SpoClient({ tenant: 't', tokenProvider: async () => 't', fetchImpl, maxRetries: 0 });
    await expect(listVersions(spo, WEB, LONG, undefined, UID)).rejects.toMatchObject({ status: 401 });
  });

  it('the .url link is created in a folder whose path is too long', async () => {
    const { calls, spo } = fakeSharePoint();
    const folder = `/sites/a/Shared Documents/${'Carpeta con ñandú y acentos '.repeat(10)}`;
    const name = `${'archivo '.repeat(8)}.psd.url`;
    const link = await uploadSmallFile(spo, WEB, folder, name, 'link content', undefined);
    expect(link).toBe(`${folder}/${name}`);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("GetFolderByServerRelativePath(decodedurl='");
    expect(calls[1]).toContain('GetFolderByServerRelativePath(decodedurl=@f)/Files/AddUsingPath(decodedurl=@n,overwrite=true)?@f=');
    expect(calls[1]).toContain(`@n='${name}'`);
  });

  it('a short folder still uses a single call', async () => {
    const { calls, spo } = fakeSharePoint();
    await uploadSmallFile(spo, WEB, '/sites/a/Shared Documents', 'x.url', 'c', undefined);
    expect(calls).toHaveLength(1);
  });

  it('permissions are applied to a link with a long path', async () => {
    const { calls, spo } = fakeSharePoint();
    const link = `${LONG}.url`;
    await applyRoleAssignments(spo, WEB, link, [{ principalId: 7, loginName: 'a', title: 'A', principalType: 1, roles: [{ id: 1073741826, name: 'Read', roleTypeKind: 2 }] }]);
    const after = calls.filter((c) => c.includes('ListItemAllFields'));
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(after.every((c) => c.includes('decodedurl=@p'))).toBe(true);
    expect(after.some((c) => c.includes('breakroleinheritance'))).toBe(true);
    expect(after.some((c) => c.includes('addroleassignment(principalid=7,roledefid=1073741826)'))).toBe(true);
  });

  it('the access check works for a link with a long path and keeps its own @u parameter', async () => {
    const { calls, spo } = fakeSharePoint();
    await userCanOpen(spo, WEB, `${LONG}.url`, 'ana@example.com');
    const last = calls.at(-1)!;
    expect(last).toContain('GetUserEffectivePermissions(@u)?@u=');
    expect(last).toContain('&@p=');
  });

  it('delete_versions works end to end on a long path', async () => {
    const { calls, spo } = fakeSharePoint();
    const target: FileTarget = {
      fileId: null,
      siteId: 1,
      siteUrl: WEB,
      webUrl: WEB,
      listGuid: '00000000-0000-0000-0000-000000000000',
      listItemId: 1,
      uniqueId: UID,
      url: LONG,
      name: 'archivo.psd',
      sizeBytes: 100,
      modifiedAt: null,
      editor: null,
    };
    const out = await executeDeleteVersions(spo, target, { keepLatest: 1 }, 'basic');
    expect(out.status).toBe('done');
    expect(out.detail).toMatch(/Permanently deleted 2 versions \(1\.0, 2\.0\)/);
    expect(calls.filter((c) => c.includes('DeleteByLabel') && c.includes('GetFileById'))).toHaveLength(2);
  });

  it('restore uploads a file whose path is too long, in chunks, through the query string', async () => {
    const { calls, spo } = fakeSharePoint();
    async function* data() {
      yield Buffer.alloc(25, 1);
    }
    const out = await uploadStreamToSharePoint(spo, WEB, LONG, data(), { chunkSize: 10 });
    expect(out.bytes).toBe(25);
    expect(calls[0]).toContain("Files/AddUsingPath(decodedurl='");
    expect(calls[1]).toContain('Files/AddUsingPath(decodedurl=@n,overwrite=false)?@f=');
    const rest = calls.slice(2).map((c) => c.replace(/guid'[^']+'/, 'guid'));
    expect(rest.map((c) => /(StartUpload|ContinueUpload|FinishUpload)/.exec(c)?.[1])).toEqual(['StartUpload', 'ContinueUpload', 'FinishUpload']);
    expect(rest.every((c) => c.includes('decodedurl=@p'))).toBe(true);
  });
});
