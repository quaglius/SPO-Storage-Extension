import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { closeDb } from '../../src/db/sql-db.js';
import { closeMigrationPool } from '../../src/db/sql-connection.js';
import { runSqlMigrations } from '../../src/db/sql-migrate.js';
import { db } from '../../src/v2/db.js';

export const TEST_SQL_CATALOG = 'spostorage-test';

/** spo.* tables, children before parents. */
const SPO_TABLES = [
  'archive_access_log',
  'archived_files',
  'policy_actions',
  'policy_runs',
  'policies',
  'engine_events',
  'engine_throughput',
  'tasks',
  'recycle_bin',
  'library_rollups',
  'file_access',
  'file_versions',
  'files',
  'libraries',
  'sites',
  'tenant_snapshots',
  'settings',
] as const;

let migrated = false;

export function rewriteSqlCatalog(connectionString: string, catalog: string): string {
  if (/Initial Catalog=/i.test(connectionString)) {
    return connectionString.replace(/Initial Catalog=[^;]*/i, `Initial Catalog=${catalog}`);
  }
  if (/Database=/i.test(connectionString)) {
    return connectionString.replace(/Database=[^;]*/i, `Database=${catalog}`);
  }
  return `${connectionString};Initial Catalog=${catalog}`;
}

export function resolveTestConnectionString(): string {
  const explicit = process.env.AZURE_SQL_TEST_CONNECTION_STRING?.trim();
  if (explicit) return explicit;

  const base = process.env.AZURE_SQL_CONNECTION_STRING?.trim() || process.env.DATABASE_URL?.trim();
  if (!base) {
    throw new Error(
      'Tests require AZURE_SQL_CONNECTION_STRING (or AZURE_SQL_TEST_CONNECTION_STRING) pointing at Azure SQL.',
    );
  }
  return rewriteSqlCatalog(base, TEST_SQL_CATALOG);
}

export async function resetSpo(): Promise<void> {
  if (!migrated) {
    await runSqlMigrations();
    migrated = true;
  }
  const d = await db();
  for (const table of SPO_TABLES) {
    await d.exec(`DELETE FROM spo.[${table}]`);
  }
  await d.exec(
    `UPDATE spo.engine_state SET paused = 0, pause_reason = NULL, current_json = NULL, heartbeat_at = NULL, last_progress_at = NULL`,
  );
}

/** Runs migrations, resets spo.*, returns a Fastify app with no v1 DB. */
export async function createTestApp(): Promise<FastifyInstance> {
  process.env.AZURE_SQL_CONNECTION_STRING = resolveTestConnectionString();
  await resetSpo();
  return buildApp({ logger: false });
}

export async function closeTestApp(app?: FastifyInstance): Promise<void> {
  if (app) await app.close();
  await closeDb();
  await closeMigrationPool();
}

/** @deprecated Prefer createTestApp — kept for gradual test updates. */
export async function createTestDb(): Promise<void> {
  process.env.AZURE_SQL_CONNECTION_STRING = resolveTestConnectionString();
  await runSqlMigrations();
  await resetSpo();
}

/** @deprecated Prefer closeTestApp. */
export async function closeTestDb(): Promise<void> {
  await closeDb();
  await closeMigrationPool();
}
