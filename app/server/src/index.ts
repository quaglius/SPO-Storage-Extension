import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';
import { getPort } from './config.js';
import { closeMigrationPool } from './db/sql-connection.js';
import { runSqlMigrations } from './db/sql-migrate.js';
import { isEngineV2Enabled, startEngineV2 } from './v2/start.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const sqlMig = await runSqlMigrations();
  if (!sqlMig.skipped && sqlMig.applied.length > 0) {
    console.log(`[migration-store] applied Azure SQL migrations: ${sqlMig.applied.join(', ')}`);
  }

  const app = await buildApp({ logger: true });
  let stopEngine: (() => Promise<void>) | undefined;
  const port = getPort();

  if (process.env.NODE_ENV === 'production') {
    const webDist = path.resolve(__dirname, '../../web/dist');
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Route not found' },
        });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port, host: '0.0.0.0' });
  if (isEngineV2Enabled()) {
    const engine = await startEngineV2();
    stopEngine = () => engine.stop();
  }

  const shutdown = async () => {
    if (stopEngine) {
      await stopEngine();
    }
    await app.close();
    await closeMigrationPool();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
