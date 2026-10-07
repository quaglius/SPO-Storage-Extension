import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { closeTestDb, createTestDb } from './helpers.js';

describe('engine lockdown', () => {

  beforeEach(async () => {
    await createTestDb();
    process.env.SPOSTORAGE_ENGINE_V2 = '1';
  });

  afterEach(async () => {
    delete process.env.SPOSTORAGE_ENGINE_V2;
    await closeTestDb();
  });

  it('serves only /api/health on the engine App Service, even with a forged principal header', async () => {
    const app = await buildApp({ logger: false });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const forged = { 'x-ms-client-principal-name': 'admin@example.com' };
    expect((await app.inject({ method: 'GET', url: '/api/v2/status', headers: forged })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: forged })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v2/engine/pause', headers: forged, payload: {} })).statusCode).toBe(404);
  });
});
