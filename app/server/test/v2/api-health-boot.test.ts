import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { closeTestDb, createTestDb } from './helpers.js';

describe('v2-only boot surface', () => {
  beforeEach(async () => {
    await createTestDb();
    process.env.SPOSTORAGE_ROLE = 'hub';
    process.env.SPOSTORAGE_ADMIN_ALLOWLIST = 'admin@example.com';
  });

  afterEach(async () => {
    delete process.env.SPOSTORAGE_ROLE;
    delete process.env.SPOSTORAGE_ADMIN_ALLOWLIST;
    await closeTestDb();
  });

  it('serves /api/health without touching the database', async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBeTruthy();
    expect(body.build).toMatchObject({ version: expect.any(String) });
    expect(['hub', 'collector']).toContain(body.role);
    expect(typeof body.engine).toBe('boolean');
    await app.close();
  });

  it('serves /api/v2/status for an admin and 404s legacy v1 routes', async () => {
    const app = await buildApp({ logger: false });
    const headers = { 'x-ms-client-principal-name': 'admin@example.com' };
    expect((await app.inject({ method: 'GET', url: '/api/v2/status', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/overview', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/sync/status', headers })).statusCode).toBe(404);
    await app.close();
  });
});
