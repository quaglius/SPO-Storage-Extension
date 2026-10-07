import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/v2/db.js';
import type { TaskRow } from '../../src/v2/engine/queue.js';
import type { TaskContext, TaskResult } from '../../src/v2/engine/types.js';
import { libraryScan } from '../../src/v2/crawl/library.js';
import { planRecurringWork } from '../../src/v2/crawl/planner.js';
import { siteStructure } from '../../src/v2/crawl/site.js';
import { tenantUsage } from '../../src/v2/crawl/tenant.js';
import { fileVersions } from '../../src/v2/crawl/versions.js';
import { putSetting } from '../../src/v2/settings.js';
import { SpoClient } from '../../src/v2/spo/client.js';
import { resetSpo } from './helpers.js';

const MB = 1024 * 1024;
const ROOT = 'https://test.sharepoint.com';
const ADMIN = 'https://test-admin.sharepoint.com';
const LIST = '11111111-2222-3333-4444-555555555555';

function fileRow(id: number, name: string, size: number, total: number, modified: string) {
  return {
    ID: String(id),
    FSObjType: '0',
    UniqueId: `{0000000${id}-0000-0000-0000-000000000000}`,
    FileRef: `/sites/a/Shared Documents/${name}`,
    FileLeafRef: name,
    File_x0020_Type: name.split('.').pop(),
    File_x0020_Size: String(size),
    SMTotalSize: String(total),
    'Modified.': modified,
    'Created.': '2020-01-01T00:00:00Z',
    Editor: [{ title: 'Ana', email: 'ana@test.co' }],
    Author: [{ title: 'Ana', email: 'ana@test.co' }],
    _UIVersionString: '3.0',
    ScopeId: '{AAAAAAAA-0000-0000-0000-000000000000}',
  };
}

let libraryPages: Array<Array<Record<string, unknown>>> = [];

function resetLibrary(): void {
  libraryPages = [
    [
      fileRow(1, 'big.pptx', 50 * MB, 200 * MB, '2021-01-01T00:00:00Z'),
      fileRow(2, 'small.docx', 1 * MB, 1 * MB, '2026-09-01T00:00:00Z'),
    ],
    [
      fileRow(3, 'video.mp4', 500 * MB, 500 * MB, '2019-05-01T00:00:00Z'),
      { ID: '9', FSObjType: '1', UniqueId: '{00000009-0000-0000-0000-000000000000}', FileRef: '/sites/a/Shared Documents/folder' },
    ],
  ];
}

const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.startsWith(`${ADMIN}/_api/StorageQuotas`)) {
    return json({ value: [{ GeoUsedStorageMB: '1000', GeoUsedVersionSizeStorageMB: '300', TenantStorageMB: '100' }] });
  }
  if (url.startsWith(`${ADMIN}/_api/web/lists/GetByTitle`)) {
    return json({
      value: [
        {
          SiteUrl: `${ROOT}/sites/a`,
          Title: 'Sitio A',
          StorageUsed: String(800 * MB),
          NumOfFiles: '3',
          TemplateName: 'GROUP#0',
          SiteId: '{aaaaaaaa-0000-0000-0000-000000000001}',
          LastActivityOn: '2026-09-20T10:00:00Z',
        },
        { SiteUrl: 'https://test-my.sharepoint.com/personal/x', Title: 'OneDrive', StorageUsed: '5' },
      ],
    });
  }
  if (url.startsWith(`${ROOT}/sites/a/_api/web/webs`)) return json({ value: [] });
  if (url.startsWith(`${ROOT}/sites/a/_api/web/lists?`)) {
    return json({
      value: [
        {
          Id: LIST,
          Title: 'Documentos',
          BaseTemplate: 101,
          Hidden: false,
          ItemCount: 4,
          EnableVersioning: true,
          MajorVersionLimit: 500,
          RootFolder: { ServerRelativeUrl: '/sites/a/Shared Documents' },
        },
      ],
    });
  }
  if (url.startsWith(`${ROOT}/sites/a/_api/site/RecycleBin`)) {
    return json({
      value: [
        { Size: String(10 * MB), ItemState: 1, DeletedDate: '2026-08-01T00:00:00Z' },
        { Size: String(5 * MB), ItemState: 2 },
      ],
    });
  }
  if (url.includes('/RenderListDataAsStream')) {
    const second = url.includes('Paged=TRUE');
    const body = JSON.parse(String(init?.body)) as { parameters: { ViewXml: string } };
    if (!body.parameters.ViewXml.includes('SMTotalSize')) throw new Error('ViewXml missing SMTotalSize');
    return json(second ? { Row: libraryPages[1] } : { Row: libraryPages[0], NextHref: '?Paged=TRUE&p_ID=2' });
  }
  if (url.includes('/Versions')) {
    return json({
      value: [
        { ID: 512, VersionLabel: '1.0', Size: String(80 * MB), Created: '2020-02-01T00:00:00Z', CreatedBy: { Email: 'ana@test.co' } },
        { ID: 1024, VersionLabel: '2.0', Size: String(70 * MB), Created: '2020-03-01T00:00:00Z' },
      ],
    });
  }
  return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
}) as typeof fetch;

const spo = new SpoClient({ tenant: 'test', tokenProvider: async () => 't', fetchImpl: fakeFetch });

type AnyHandler = (ctx: TaskContext<never>) => Promise<TaskResult>;

async function run(handler: unknown, task: Partial<TaskRow>, payload: unknown = null): Promise<TaskResult> {
  const base: TaskRow = {
    id: 1,
    kind: 'k',
    target_key: 't',
    site_id: null,
    library_id: null,
    state: 'leased',
    priority: 1,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 8,
    lease_owner: 'x',
    lease_until: null,
    payload_json: null,
    last_error: null,
  };
  const ctx = {
    task: { ...base, ...task },
    payload,
    signal: new AbortController().signal,
    spo,
    progress: () => undefined,
    status: () => undefined,
    event: async () => undefined,
  };
  return (handler as AnyHandler)(ctx as never);
}

function payloadOf(r: TaskResult): unknown {
  return r.outcome === 'again' ? r.payload : undefined;
}

describe('v2 crawlers', () => {
  beforeEach(async () => {
    await resetSpo();
    resetLibrary();
    await putSetting('engine', { tenant: 'test', heavyVersionsThresholdBytes: 20 * MB });
  });

  it('builds sites, libraries, files, rollups and version detail; a second pass detects deletions', async () => {
    const d = await db();
    const t = await run(tenantUsage, {});
    expect(t.outcome).toBe('again');
    const sites = await d.all<{ id: number; url: string; storage_used_bytes: number }>(
      `SELECT id, url, storage_used_bytes FROM spo.sites`,
    );
    expect(sites).toHaveLength(1); // OneDrive excluded
    expect(Number(sites[0].storage_used_bytes)).toBe(800 * MB);
    const snap = await d.one<{ quota_bytes: number }>(`SELECT quota_bytes FROM spo.tenant_snapshots`);
    expect(Number(snap!.quota_bytes)).toBe(100 * MB);

    await run(siteStructure, { site_id: sites[0].id });
    const lib = await d.one<{ id: number; title: string }>(`SELECT id, title FROM spo.libraries`);
    expect(lib!.title).toBe('Documentos');
    const rb = await d.one<{ first_stage_bytes: number }>(`SELECT first_stage_bytes FROM spo.recycle_bin`);
    expect(Number(rb!.first_stage_bytes)).toBe(10 * MB);

    await planRecurringWork();
    const kinds = await d.all<{ kind: string }>(`SELECT kind FROM spo.tasks ORDER BY kind`);
    expect(kinds.map((k) => k.kind)).toEqual(
      expect.arrayContaining(['library-scan', 'site-structure', 'tenant-usage', 'maintenance']),
    );

    let r = await run(libraryScan, { site_id: sites[0].id, library_id: lib!.id });
    expect(r).toMatchObject({ outcome: 'again', afterMs: 0 });
    r = await run(libraryScan, { site_id: sites[0].id, library_id: lib!.id }, payloadOf(r));
    expect(r.outcome === 'again' && r.afterMs).toBeGreaterThan(3_600_000);

    const files = await d.all<{ name: string }>(`SELECT name FROM spo.files WHERE deleted_at IS NULL ORDER BY name`);
    expect(files.map((f) => f.name)).toEqual(['big.pptx', 'small.docx', 'video.mp4']);
    const roll = await d.one<{ file_count: number; total_bytes: number; heavy_versions_files: number; age_old_bytes: number }>(
      `SELECT file_count, total_bytes, heavy_versions_files, age_old_bytes FROM spo.library_rollups`,
    );
    expect(Number(roll!.file_count)).toBe(3);
    expect(Number(roll!.total_bytes)).toBe(701 * MB);
    expect(Number(roll!.heavy_versions_files)).toBe(1);
    expect(Number(roll!.age_old_bytes)).toBe(700 * MB);
    const libState = await d.one<{ baseline_state: string }>(`SELECT baseline_state FROM spo.libraries`);
    expect(libState!.baseline_state).toBe('done');

    await run(fileVersions, { library_id: lib!.id });
    const versions = await d.all<{ label: string }>(`SELECT label FROM spo.file_versions ORDER BY version_id`);
    expect(versions.map((v) => v.label)).toEqual(['1.0', '2.0']);
    const idle = await run(fileVersions, { library_id: lib!.id });
    expect(idle.outcome === 'again' && idle.afterMs).toBeGreaterThan(0);

    // Second pass: small.docx disappeared.
    libraryPages = [[libraryPages[0][0]], libraryPages[1]];
    await d.exec(`UPDATE spo.libraries SET baseline_done_at = DATEADD(day, -2, SYSUTCDATETIME())`);
    await new Promise((res) => setTimeout(res, 20));
    r = await run(libraryScan, { site_id: sites[0].id, library_id: lib!.id }, {});
    r = await run(libraryScan, { site_id: sites[0].id, library_id: lib!.id }, payloadOf(r));
    const alive = await d.all<{ name: string }>(`SELECT name FROM spo.files WHERE deleted_at IS NULL ORDER BY name`);
    expect(alive.map((f) => f.name)).toEqual(['big.pptx', 'video.mp4']);
  });
});
