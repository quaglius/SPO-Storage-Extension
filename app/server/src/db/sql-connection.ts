import sql from 'mssql';
import { getAzureSqlConnectionString } from '../config.js';

let pool: sql.ConnectionPool | null = null;
let poolPromise: Promise<sql.ConnectionPool> | null = null;

export function isMigrationDbConfigured(): boolean {
  return Boolean(getAzureSqlConnectionString());
}

export async function getMigrationPool(): Promise<sql.ConnectionPool | null> {
  const cs = getAzureSqlConnectionString();
  if (!cs) return null;
  if (pool?.connected) return pool;
  if (!poolPromise) {
    // DDL over large tables (e.g. a persisted column on 1M files) can take minutes: no 15 s default here.
    poolPromise = new sql.ConnectionPool({
      ...sql.ConnectionPool.parseConnectionString(cs),
      requestTimeout: 15 * 60_000,
      connectionTimeout: 60_000,
    })
      .connect()
      .then((p) => {
        pool = p;
        p.on('error', (err) => {
          console.warn(`[azure-sql] pool error: ${err.message}`);
          pool = null;
          poolPromise = null;
        });
        return p;
      })
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

export async function closeMigrationPool(): Promise<void> {
  const p = pool;
  pool = null;
  poolPromise = null;
  if (p) await p.close();
}

/** Run parameterized SQL. Placeholders: @p0, @p1, … (or legacy $1, $2 rewritten). */
export async function migrationQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number } | null> {
  const p = await getMigrationPool();
  if (!p) return null;
  const request = p.request();
  params.forEach((value, i) => {
    request.input(`p${i}`, value);
  });
  let rewritten = text;
  for (let i = params.length; i >= 1; i--) {
    rewritten = rewritten.replace(new RegExp(`\\$${i}\\b`, 'g'), `@p${i - 1}`);
  }
  const result = await request.query(rewritten);
  return {
    rows: (result.recordset ?? []) as T[],
    rowCount: result.rowsAffected?.[0] ?? result.recordset?.length ?? 0,
  };
}
