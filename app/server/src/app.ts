import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAdminAllowlistPlugin } from './plugins/admin-allowlist.js';
import { registerEngineLockdown } from './plugins/engine-lockdown.js';
import { registerHealthRoutes } from './v2/api/health.js';
import { registerV2Routes } from './v2/api/index.js';

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  await app.register(cors, {
    origin: true,
  });

  await registerEngineLockdown(app);
  await registerAdminAllowlistPlugin(app);

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: error.message || 'Internal server error',
      },
    });
  });

  await registerHealthRoutes(app);
  await registerV2Routes(app);

  return app;
}
