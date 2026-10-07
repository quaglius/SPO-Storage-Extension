import type { FastifyInstance } from 'fastify';

/**
 * The engine App Service (SPOSTORAGE_ENGINE_V2=1) has no Easy Auth: it must not serve the API or the UI.
 * Only GET /api/health stays public (CI and monitoring read the deployed commit there).
 */
export async function registerEngineLockdown(app: FastifyInstance): Promise<void> {
  if (process.env.SPOSTORAGE_ENGINE_V2 !== '1') return;
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (request.method === 'GET' && path === '/api/health') return;
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
}
