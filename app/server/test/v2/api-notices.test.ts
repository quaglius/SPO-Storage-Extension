import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/v2/db.js';
import { putSetting } from '../../src/v2/settings.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

describe('v2 API /notices', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
  });

  afterEach(async () => {
    await closeTestDb();
  });

  it('lists sites with a Preservation Hold Library and the pending audit consent', async () => {
    const d = await db();
    await d.exec(`
      SET IDENTITY_INSERT spo.sites ON;
      INSERT INTO spo.sites (id, url, title) VALUES (1, N'https://t.sharepoint.com/sites/a', N'A'), (2, N'https://t.sharepoint.com/sites/b', N'B');
      SET IDENTITY_INSERT spo.sites OFF;
      INSERT INTO spo.libraries (site_id, web_url, list_guid, title, root_url, base_template, hidden, item_count)
      VALUES (1, N'https://t.sharepoint.com/sites/a', NEWID(), N'Preservation Hold Library', N'/sites/a/PreservationHoldLibrary', 1310, 1, 7),
             (2, N'https://t.sharepoint.com/sites/b', NEWID(), N'Documentos', N'/sites/b/Shared Documents', 101, 0, 3);`);
    const app = await buildApp({ logger: false });
    let body = (await app.inject({ method: 'GET', url: '/api/v2/notices' })).json();
    const retention = body.notices.find((n: { id: string }) => n.id === 'retention');
    expect(retention.sites).toEqual([{ siteId: 1, title: 'A', url: 'https://t.sharepoint.com/sites/a', detail: '7 retained items' }]);
    expect(retention.links[0].href).toContain('purview.microsoft.com');
    expect(body.notices.some((n: { id: string }) => n.id === 'audit-consent')).toBe(true);

    await putSetting('audit.status', { consented: true });
    body = (await app.inject({ method: 'GET', url: '/api/v2/notices' })).json();
    expect(body.notices.some((n: { id: string }) => n.id === 'audit-consent')).toBe(false);
  });
});
