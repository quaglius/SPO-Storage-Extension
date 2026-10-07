import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeArchive, linkContent, type ArchiveRow } from '../../src/v2/actions/archive-link.js';
import { archiveCompleteLinks, requestCompleteLinks } from '../../src/v2/actions/archive-links.js';
import {
  aclKeys,
  assignmentsFromStoredAcl,
  isNoSpaceError,
  parseStoredAcl,
} from '../../src/v2/actions/sp-ops.js';
import { SpoClient, SpoError } from '../../src/v2/spo/client.js';
import { db } from '../../src/v2/db.js';
import { resetSpo } from './helpers.js';

vi.mock('../../src/v2/actions/blob.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/v2/actions/blob.js')>();
  return {
    ...real,
    getArchiveSettings: async () => ({ portalBaseUrl: 'https://spostorage.example.com' }),
    containerClient: () => ({
      getBlobClient: () => ({ getProperties: async () => ({ contentLength: 2048, metadata: { sha256: 'b'.repeat(64) } }) }),
    }),
  };
});

const WEB = 'https://t.sharepoint.com/sites/a';
const ORIG = '/sites/a/Shared Documents/a.docx';
const LINK = `${ORIG}.url`;
const ACL = [
  { principalId: 7, loginName: 'i:0#.f|membership|ana@example.com', title: 'Ana', principalType: 1, roles: ['Read'] },
  { principalId: 9, loginName: 'c:0t.c|tenant|grp', title: 'Team', principalType: 4, roles: ['Contribute'] },
];

/** In-memory SharePoint: one original, its .url link, a quota that stays full until the original is deleted. */
function fakeSharePoint(opts: { quotaFull?: boolean; quotaStaysFull?: boolean; unique?: boolean; modified?: string; length?: number; roles?: string[] } = {}) {
  const st = {
    quotaFull: opts.quotaFull ?? false,
    originalExists: true,
    linkExists: false,
    linkUnique: false,
    linkAssignments: [] as Array<{ PrincipalId: number; Member: object; RoleDefinitionBindings: object[] }>,
    log: [] as string[],
  };
  const defs = (opts.roles ?? ['Read', 'Contribute']).map((n, i) => ({ Id: 1073741826 + i, Name: n }));
  const members: Record<number, object> = {
    7: { LoginName: ACL[0].loginName, Title: 'Ana', PrincipalType: 1 },
    9: { LoginName: ACL[1].loginName, Title: 'Team', PrincipalType: 4 },
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    const method = (init?.headers as Record<string, string> | undefined)?.['X-HTTP-Method'] ?? init?.method ?? 'GET';
    const short = url.replace(/^.*\/_api\/web\//, '');
    st.log.push(`${method} ${short}`);
    if (url.includes('/roledefinitions')) return json({ value: defs });
    if (url.includes("AddUsingPath(decodedurl='a.docx.url'")) {
      if (st.quotaFull) return json({ error: { message: { value: 'Site has exceeded its maximum file storage limit' } } }, 507);
      st.linkExists = true;
      return json({});
    }
    const isLink = url.includes(`decodedurl='${LINK}'`);
    const isOrig = url.includes(`decodedurl='${ORIG}'`);
    if (method === 'DELETE') {
      if (isLink) st.linkExists = false;
      if (isOrig) {
        st.originalExists = false;
        if (!opts.quotaStaysFull) st.quotaFull = false;
      }
      return json({});
    }
    if (url.includes('$select=Exists')) return json({ Exists: isLink ? st.linkExists : st.originalExists });
    if (url.includes('$select=Length,TimeLastModified')) return json({ Length: String(opts.length ?? 2048), TimeLastModified: opts.modified ?? '2026-01-01T00:00:00Z' });
    if (url.includes('breakroleinheritance')) {
      st.linkUnique = true;
      return json({});
    }
    if (url.includes('$select=HasUniqueRoleAssignments')) return json({ HasUniqueRoleAssignments: isLink ? st.linkUnique : Boolean(opts.unique) });
    const add = /addroleassignment\(principalid=(\d+),roledefid=(\d+)\)/.exec(url);
    if (add) {
      const role = defs.find((d) => d.Id === Number(add[2]))!;
      st.linkAssignments.push({
        PrincipalId: Number(add[1]),
        Member: members[Number(add[1])],
        RoleDefinitionBindings: [{ Id: role.Id, Name: role.Name, RoleTypeKind: 0 }],
      });
      return json({});
    }
    if (url.includes('/RoleAssignments')) return json({ value: st.linkAssignments });
    return json({});
  }) as typeof fetch;
  return { st, spo: new SpoClient({ tenant: 't', tokenProvider: async () => 't', fetchImpl, maxRetries: 0 }) };
}

const blobOk = async () => ({ contentLength: 2048, metadata: { sha256: 'b'.repeat(64) } });

async function seed(over: { id?: number; state?: string; link?: string | null; unique?: boolean; acl?: string | null; original?: string } = {}): Promise<ArchiveRow> {
  const d = await db();
  const id = over.id ?? 1;
  const original = over.original ?? ORIG;
  await d.exec(
    `IF NOT EXISTS (SELECT 1 FROM spo.sites WHERE id = 1) BEGIN
       SET IDENTITY_INSERT spo.sites ON; INSERT INTO spo.sites (id, url, title) VALUES (1, N'${WEB}', N'A'); SET IDENTITY_INSERT spo.sites OFF; END
     SET IDENTITY_INSERT spo.archived_files ON;
     INSERT INTO spo.archived_files (id, site_id, original_url, web_url, name, extension, size_bytes, sha256, content_type, blob_container, blob_path,
       blob_tier, link_url, unique_perms, acl_json, state, archived_by, archived_at)
     VALUES (@id, 1, @original, N'${WEB}', @name, N'.docx', 2048, REPLICATE('b', 64), N'application/octet-stream', N'archive', CONCAT(N'a/', @name),
       N'Cold', @link, @unique, @acl, @state, N'test', DATEADD(HOUR, -1, SYSUTCDATETIME()));
     SET IDENTITY_INSERT spo.archived_files OFF;`,
    {
      id,
      original,
      name: original.split('/').pop()!,
      link: over.link ?? null,
      unique: over.unique ? 1 : 0,
      acl: over.acl === undefined ? JSON.stringify(ACL) : over.acl,
      state: over.state ?? 'uploaded',
    },
  );
  return (await d.one<ArchiveRow>(`SELECT a.* FROM spo.archived_files a WHERE a.id = @id`, { id }))!;
}

const row = async (id = 1) => (await (await db()).one<{ state: string; link_url: string | null; link_error: string | null }>(`SELECT state, link_url, link_error FROM spo.archived_files WHERE id = @id`, { id }))!;
const base = { portalBaseUrl: 'https://spostorage.example.com', verify: 'basic' as const, readBlob: blobOk };

describe('archive link helpers', () => {
  it('recognizes a site that cannot take data', () => {
    expect(isNoSpaceError(new SpoError('HTTP 507 Site has exceeded its maximum file storage limit', 507, false))).toBe(true);
    expect(isNoSpaceError(new SpoError('HTTP 403 The site is read only', 403, false))).toBe(true);
    expect(isNoSpaceError(new SpoError('HTTP 403 Access denied', 403, false))).toBe(false);
    expect(isNoSpaceError(new SpoError('HTTP 404 Not found', 404, false))).toBe(false);
    expect(isNoSpaceError(new Error('507'))).toBe(false);
  });

  it('parses the stored ACL strictly and rebuilds assignments from role names', () => {
    expect(parseStoredAcl(null)).toBeNull();
    expect(parseStoredAcl('nope')).toBeNull();
    expect(parseStoredAcl('[{"principal":"x","role":"Read"}]')).toBeNull();
    const acl = parseStoredAcl(JSON.stringify(ACL))!;
    const { assignments, missingRoles } = assignmentsFromStoredAcl(acl, new Map([['read', 11], ['contribute', 12]]));
    expect(missingRoles).toEqual([]);
    expect(assignments.map((a) => [a.principalId, a.roles[0].id])).toEqual([[7, 11], [9, 12]]);
    expect(assignmentsFromStoredAcl(acl, new Map([['read', 11]])).missingRoles).toEqual(['Contribute']);
    expect(aclKeys(acl)).toEqual([`7|i:0#.f|membership|ana@example.com|read`, `9|c:0t.c|tenant|grp|contribute`].sort());
  });

  it('writes a .url shortcut to the portal', () => {
    expect(linkContent('https://x.example.com/', 5)).toBe('[InternetShortcut]\r\nURL=https://x.example.com/archive/5\r\n');
  });
});

describe('completeArchive', () => {
  beforeEach(async () => {
    await resetSpo();
  });

  it('with space: link first, then deletes the original', async () => {
    const { st, spo } = fakeSharePoint();
    const r = await completeArchive(spo, await seed(), { ...base, reverify: true });
    expect(r.outcome.status).toBe('done');
    expect(r.linked && r.deletedNow).toBe(true);
    expect(st.originalExists).toBe(false);
    expect(st.linkExists).toBe(true);
    const link = st.log.findIndex((l) => l.includes('AddUsingPath'));
    const del = st.log.findIndex((l) => l.startsWith('DELETE'));
    expect(link).toBeGreaterThanOrEqual(0);
    expect(link).toBeLessThan(del);
    expect(await row()).toMatchObject({ state: 'original_deleted', link_url: LINK, link_error: null });
  });

  it('over quota: deletes the verified original, then creates the link in the freed space', async () => {
    const { st, spo } = fakeSharePoint({ quotaFull: true });
    const r = await completeArchive(spo, await seed(), { ...base, reverify: true });
    expect(r.outcome.status).toBe('done');
    expect(r.noSpace).toBe(true);
    expect(r.linked).toBe(true);
    expect(st.originalExists).toBe(false);
    expect(st.linkExists).toBe(true);
    expect(await row()).toMatchObject({ state: 'original_deleted', link_url: LINK });
  });

  it('quota still full after the delete: the link stays pending, nothing throws, and a later pass creates it', async () => {
    const { st, spo } = fakeSharePoint({ quotaFull: true, quotaStaysFull: true });
    const r = await completeArchive(spo, await seed(), { ...base, reverify: true });
    expect(r.outcome.status).toBe('done');
    expect(r.outcome.bytes).toBe(2048);
    expect(r.linked).toBe(false);
    expect(st.originalExists).toBe(false);
    const pending = await row();
    expect(pending.state).toBe('original_deleted');
    expect(pending.link_url).toBeNull();
    expect(pending.link_error).toMatch(/maximum file storage/);

    st.quotaFull = false; // an admin freed space
    const again = await completeArchive(spo, (await (await db()).one<ArchiveRow>(`SELECT a.* FROM spo.archived_files a WHERE a.id = 1`))!, { ...base, reverify: true });
    expect(again.outcome.status).toBe('done');
    expect(again.deletedNow).toBe(false);
    expect(await row()).toMatchObject({ state: 'original_deleted', link_url: LINK, link_error: null });
    const unchanged = await completeArchive(spo, (await (await db()).one<ArchiveRow>(`SELECT a.* FROM spo.archived_files a WHERE a.id = 1`))!, { ...base, reverify: true });
    expect(unchanged.outcome.status).toBe('skipped');
  });

  it('an original modified after it was archived is never deleted', async () => {
    const { st, spo } = fakeSharePoint({ quotaFull: true, modified: new Date().toISOString() });
    const r = await completeArchive(spo, await seed(), { ...base, reverify: true });
    expect(r.outcome.status).toBe('skipped');
    expect(st.originalExists).toBe(true);
    expect(st.log.some((l) => l.startsWith('DELETE'))).toBe(false);
    expect(await row()).toMatchObject({ state: 'uploaded', link_url: null });
    expect((await row()).link_error).toMatch(/modified after/);
  });

  it('an archived copy that does not match the record blocks the delete', async () => {
    const { st, spo } = fakeSharePoint({ quotaFull: true });
    const r = await completeArchive(spo, await seed(), { ...base, reverify: true, readBlob: async () => ({ contentLength: 2048, metadata: { sha256: 'c'.repeat(64) } }) });
    expect(r.outcome.status).toBe('skipped');
    expect(st.originalExists).toBe(true);
    const failedRead = await completeArchive(spo, await seed({ id: 2, original: '/sites/a/Shared Documents/b.docx' }), {
      ...base,
      reverify: true,
      readBlob: async () => {
        throw new Error('BlobNotFound');
      },
    });
    expect(failedRead.outcome.detail).toMatch(/cannot be read/);
  });

  it('unique permissions: rebuilds them from the stored ACL and verifies the link before deleting', async () => {
    const { st, spo } = fakeSharePoint({ unique: true });
    const r = await completeArchive(spo, await seed({ unique: true }), { ...base, reverify: true });
    expect(r.outcome.status).toBe('done');
    expect(st.linkUnique).toBe(true);
    expect(st.linkAssignments.map((a) => a.PrincipalId).sort()).toEqual([7, 9]);
    expect(st.originalExists).toBe(false);
  });

  it('unique permissions with a role that no longer exists: nothing is deleted', async () => {
    const { st, spo } = fakeSharePoint({ unique: true, quotaFull: true, roles: ['Read'] });
    const r = await completeArchive(spo, await seed({ unique: true }), { ...base, reverify: true });
    expect(r.outcome.status).toBe('failed');
    expect(r.outcome.detail).toMatch(/Contribute/);
    expect(st.originalExists).toBe(true);
    expect((await row()).link_error).toMatch(/Contribute/);
  });

  it('unique permissions with an unreadable stored ACL: nothing is deleted', async () => {
    const { st, spo } = fakeSharePoint({ unique: true });
    const r = await completeArchive(spo, await seed({ unique: true, acl: null }), { ...base, reverify: true });
    expect(r.outcome.status).toBe('failed');
    expect(st.originalExists).toBe(true);
  });
});

describe('archive-complete-links task', () => {
  beforeEach(async () => {
    await resetSpo();
  });

  const ctxFor = (spo: SpoClient, payload: unknown, events: Array<{ kind: string; message: string }> = []) =>
    ({
      task: { id: 1 } as never,
      payload,
      signal: new AbortController().signal,
      spo,
      progress: () => undefined,
      status: () => undefined,
      event: async (e: { kind: string; message: string }) => void events.push(e),
    }) as never;

  it('makes one pass over the pending rows, leaves finished ones alone and ends; a second pass is a no-op', async () => {
    await seed({ id: 1, state: 'original_deleted', link: null, original: ORIG }); // link only
    await seed({ id: 2, state: 'original_deleted', link: '/sites/a/x.url', original: '/sites/a/Shared Documents/done.docx' }); // finished
    await seed({ id: 3, state: 'restored', link: null, original: '/sites/a/Shared Documents/restored.docx' }); // not pending
    const { st, spo } = fakeSharePoint();
    const events: Array<{ kind: string; message: string }> = [];

    let result = await archiveCompleteLinks(ctxFor(spo, { afterId: 0, requestedBy: 'admin@example.com', processed: 0, linksCreated: 0, originalsDeleted: 0, stillPending: 0, skipped: 0, failed: 0, freedBytes: 0, blockedSites: [] }, events));
    expect(result.outcome).toBe('again');
    const payload = (result as { payload: { linksCreated: number; processed: number; afterId: number } }).payload;
    expect(payload).toMatchObject({ processed: 1, linksCreated: 1, afterId: 1 });
    expect(st.linkExists).toBe(true);

    result = await archiveCompleteLinks(ctxFor(spo, payload, events));
    expect(result).toEqual({ outcome: 'done' });
    expect(events.at(-1)?.kind).toBe('archive-links-done');
    expect(events.at(-1)?.message).toMatch(/1 links created/);
    expect((await row(2)).link_url).toBe('/sites/a/x.url');
    expect((await row(3)).state).toBe('restored');

    // Launched again with nothing pending: finishes at once.
    const second = await archiveCompleteLinks(ctxFor(spo, null, events));
    expect(second).toEqual({ outcome: 'done' });
  });

  it('can be requested again once the previous pass is over, but not twice at the same time', async () => {
    expect(await requestCompleteLinks('admin@example.com')).toBe(true);
    expect(await requestCompleteLinks('admin@example.com')).toBe(false);
    const d = await db();
    await d.exec(`UPDATE spo.tasks SET state = N'done' WHERE kind = N'archive-complete-links'`);
    expect(await requestCompleteLinks('admin@example.com')).toBe(true);
  });
});
