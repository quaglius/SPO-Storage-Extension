import type { FastifyInstance } from 'fastify';
import { APP_VERSION, getBuildInfo, getRole } from '../../config.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    status: 'ok',
    version: APP_VERSION,
    build: getBuildInfo(),
    role: getRole(),
    engine: process.env.SPOSTORAGE_ENGINE_V2 === '1',
  }));
}
