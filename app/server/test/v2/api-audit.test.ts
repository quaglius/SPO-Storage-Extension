import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { putSetting } from '../../src/v2/settings.js';
import { closeTestDb, createTestDb, resetSpo } from './helpers.js';

describe('v2 API /audit', () => {

  beforeEach(async () => {
    await createTestDb();
    await resetSpo();
  });

  afterEach(async () => {
    await closeTestDb();
  });

  it('returns empty coverage when audit.status is missing', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/v2/audit' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      consented: false,
      coverageFrom: null,
      coverageTo: null,
      records: 0,
    });
    await app.close();
  });

  it('reads audit.status from settings', async () => {
    await putSetting('audit.status', {
      consented: true,
      coverageFrom: '2025-01-01T00:00:00.000Z',
      coverageTo: '2025-06-01T00:00:00.000Z',
      records: 12345,
    });
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/v2/audit' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      consented: true,
      coverageFrom: '2025-01-01T00:00:00.000Z',
      coverageTo: '2025-06-01T00:00:00.000Z',
      records: 12345,
    });
    await app.close();
  });
});
