import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/v2/db.js';
import { QuickXorHash } from '../../src/v2/actions/quickxor.js';
import { pickVersionsToDelete } from '../../src/v2/actions/execute.js';
import { policyDefinitionSchema } from '../../src/v2/policies/definitions.js';
import { materializePlan, simulate } from '../../src/v2/policies/plan.js';
import { resetSpo } from './helpers.js';

const MB = 1024 * 1024;

describe('QuickXorHash', () => {
  it('is all zeros for empty input and independent of chunking', () => {
    expect(new QuickXorHash().digestBase64()).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    const data = Buffer.alloc(100_003);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    const whole = new QuickXorHash().update(data).digestBase64();
    const chunked = new QuickXorHash();
    for (let i = 0; i < data.length; i += 4099) chunked.update(data.subarray(i, i + 4099));
    expect(chunked.digestBase64()).toBe(whole);
    expect(whole).not.toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  });
});

describe('pickVersionsToDelete', () => {
  const versions = [
    { id: 512, label: '1.0', created: '2020-01-01T00:00:00Z' },
    { id: 1024, label: '2.0', created: '2021-01-01T00:00:00Z' },
    { id: 1536, label: '3.0', created: '2026-09-20T00:00:00Z' },
  ];
  it('keeps the newest N historic versions and honours age', () => {
    const now = new Date('2026-09-24T00:00:00Z');
    expect(pickVersionsToDelete(versions, { keepLatest: 1 }, now).map((v) => v.label)).toEqual(['1.0', '2.0']);
    expect(pickVersionsToDelete(versions, { keepLatest: 0, olderThanDays: 30 }, now).map((v) => v.label)).toEqual(['1.0', '2.0']);
    expect(pickVersionsToDelete(versions, { keepLatest: 5 }, now)).toEqual([]);
    expect(pickVersionsToDelete(versions, { labels: ['2.0'] }, now).map((v) => v.label)).toEqual(['2.0']);
  });
});

describe('policy plan', () => {
  beforeEach(async () => {
    await resetSpo();
    const d = await db();
    await d.exec(`
      SET IDENTITY_INSERT spo.sites ON;
      INSERT INTO spo.sites (id, url, title) VALUES (1, N'https://t.sharepoint.com/sites/a', N'A'), (2, N'https://t.sharepoint.com/sites/b', N'B');
      SET IDENTITY_INSERT spo.sites OFF;
      SET IDENTITY_INSERT spo.libraries ON;
      INSERT INTO spo.libraries (id, site_id, web_url, list_guid, title, root_url, base_template, hidden)
      VALUES (10, 1, N'https://t.sharepoint.com/sites/a', NEWID(), N'Documentos', N'/sites/a/Shared Documents', 101, 0),
             (11, 1, N'https://t.sharepoint.com/sites/a', NEWID(), N'Preservation Hold Library', N'/sites/a/PreservationHoldLibrary', 101, 1),
             (20, 2, N'https://t.sharepoint.com/sites/b', NEWID(), N'Documentos', N'/sites/b/Shared Documents', 101, 0);
      SET IDENTITY_INSERT spo.libraries OFF;`);
    const files = [
      // id, site, lib, name, size, total, modified
      [1, 1, 10, 'viejo.mp4', 500 * MB, 900 * MB, '2020-01-01'],
      [2, 1, 10, 'nuevo.pptx', 50 * MB, 300 * MB, '2026-09-01'],
      [3, 1, 11, 'retenido.mp4', 500 * MB, 900 * MB, '2020-01-01'],
      [4, 2, 20, 'chico.docx', 1 * MB, 1 * MB, '2019-01-01'],
      [5, 2, 20, 'viejo2.psd', 200 * MB, 200 * MB, '2022-01-01'],
    ];
    for (const [id, site, lib, name, size, total, modified] of files) {
      await d.exec(
        `SET IDENTITY_INSERT spo.files ON;
         INSERT INTO spo.files (id, site_id, library_id, unique_id, list_item_id, server_relative_url, name, extension, size_bytes, total_bytes, modified_at, seen_at)
         VALUES (@id, @site, @lib, NEWID(), @id, CONCAT(N'/x/', @name), @name, RIGHT(@name, CHARINDEX(N'.', REVERSE(@name))), @size, @total, @modified, SYSUTCDATETIME());
         SET IDENTITY_INSERT spo.files OFF;`,
        { id, site, lib, name, size, total, modified: new Date(String(modified)) },
      );
    }
    await d.exec(`INSERT INTO spo.file_versions (file_id, version_id, label, size_bytes, created_at, captured_at) VALUES
      (2, 512, N'1.0', ${100 * MB}, '2026-01-01', SYSUTCDATETIME()),
      (2, 1024, N'2.0', ${100 * MB}, '2026-02-01', SYSUTCDATETIME()),
      (2, 1536, N'3.0', ${50 * MB}, '2026-09-20', SYSUTCDATETIME())`);
  });

  it('delete_versions: never touches hidden libraries; precise bytes when version detail exists', async () => {
    const def = policyDefinitionSchema.parse({ kind: 'delete_versions', scope: {}, minVersionsBytes: 100 * MB, keepLatest: 1, olderThanDays: 30 });
    const sim = await simulate(def);
    expect(sim.preview.map((p) => p.fileId).sort()).toEqual([1, 2]);
    const f2 = sim.preview.find((p) => p.fileId === 2)!;
    expect(f2.bytes).toBe(200 * MB); // 1.0 + 2.0; 3.0 is the newest historic (kept) and too recent
    const f1 = sim.preview.find((p) => p.fileId === 1)!;
    expect(f1.bytes).toBe(400 * MB); // no detail: whole historic weight
  });

  it('archive_files: old and big only, scoped by site and extension; plan materializes', async () => {
    const def = policyDefinitionSchema.parse({ kind: 'archive_files', scope: { siteIds: [2] }, minSizeBytes: 10 * MB, notModifiedDays: 365 });
    const sim = await simulate(def);
    expect(sim.preview.map((p) => p.fileId)).toEqual([5]);
    const all = await simulate(policyDefinitionSchema.parse({ kind: 'archive_files', scope: { extensions: ['.mp4'] }, minSizeBytes: 10 * MB, notModifiedDays: 365 }));
    expect(all.preview.map((p) => p.fileId)).toEqual([1]); // retenido.mp4 lives in a hidden library

    const d = await db();
    const run = await d.one<{ id: number }>(
      `INSERT INTO spo.policy_runs (scope, mode, status, definition_json) OUTPUT inserted.id VALUES (N'tenant', N'execute', N'planned', @def)`,
      { def: JSON.stringify(def) },
    );
    const plan = await materializePlan(run!.id, def);
    expect(plan).toEqual({ count: 1, bytes: 200 * MB });
  });
});
