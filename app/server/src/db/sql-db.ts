/**
 * Azure SQL operational database (sole production store).
 * Async API with placeholders: @p0, @p1, … (or $1 rewritten).
 */
import sql from 'mssql';
import { getAzureSqlConnectionString } from '../config.js';

export type SqlRow = Record<string, unknown>;

/** Typed view of a single query row (SqlRow lacks index signature for strict interfaces). */
export function rowAs<T>(row: SqlRow | undefined): T | undefined {
  return row as unknown as T | undefined;
}

/** Typed view of query rows (SqlRow lacks index signature for strict interfaces). */
export function rowsAs<T>(rows: SqlRow[]): T[] {
  return rows as unknown as T[];
}

function rewriteSqliteDialect(text: string): string {
  let rewritten = text
    .replace(/\bINSERT OR IGNORE\b/gi, 'INSERT')
    .replace(/\bINSERT OR REPLACE\b/gi, 'MERGE_PLACEHOLDER');

  // LIMIT n OFFSET m  →  OFFSET m ROWS FETCH NEXT n ROWS ONLY (requires ORDER BY)
  rewritten = rewritten.replace(
    /\bLIMIT\s+(\d+|@p\d+)\s+OFFSET\s+(\d+|@p\d+)\b/gi,
    'OFFSET $2 ROWS FETCH NEXT $1 ROWS ONLY',
  );

  // Trailing / remaining LIMIT n → SELECT TOP (n) …
  rewritten = rewritten.replace(
    /^(\s*SELECT\s+)(DISTINCT\s+)?([\s\S]*?)\bLIMIT\s+(\d+|@p\d+)\s*;?\s*$/i,
    (_m, sel: string, distinct: string | undefined, body: string, lim: string) => {
      if (/\bTOP\s*\(/i.test(`${sel}${distinct ?? ''}${body}`)) {
        return `${sel}${distinct ?? ''}${body}`.replace(/\s+$/, '');
      }
      return `${sel}${distinct ?? ''}TOP (${lim}) ${body}`.replace(/\s+$/, '');
    },
  );

  // Subquery-style LIMIT still present → TOP on innermost SELECT when possible
  rewritten = rewritten.replace(
    /\bSELECT\s+(DISTINCT\s+)?(?!TOP\s*\()/gi,
    (full, distinct?: string) => {
      // only rewrite if a LIMIT remains later in string — handled below
      return full;
    },
  );
  rewritten = rewritten.replace(/\bLIMIT\s+(\d+|@p\d+)\b/gi, (_m, lim: string) => {
    // Last resort: FETCH requires ORDER BY; prefer harmless no-op comment + rely on TOP rewrite
    // If we get here, inject as FETCH only when ORDER BY already present upstream is unknown —
    // use TOP via wrapping is too risky; return empty string to drop LIMIT after TOP pass failed.
    return `/*LIMIT ${lim}*/`;
  });

  return rewritten;
}

export class SqlDb {
  constructor(private readonly pool: sql.ConnectionPool) {}

  async query<T extends SqlRow = SqlRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const request = this.pool.request();
    params.forEach((value, i) => request.input(`p${i}`, value as never));
    return this.execRequest<T>(request, text, params.length);
  }

  /**
   * Like query(), but allows explicit mssql types (e.g. NVarChar(MAX) for OPENJSON payloads).
   * `inputs` use names p0, p1, … matching @p0 in the SQL text.
   */
  async queryTyped<T extends SqlRow = SqlRow>(
    text: string,
    inputs: Array<{ type: Parameters<sql.Request['input']>[1]; value: unknown }>,
  ): Promise<{ rows: T[]; rowCount: number }> {
    const request = this.pool.request();
    inputs.forEach((input, i) => {
      request.input(`p${i}`, input.type, input.value as never);
    });
    return this.execRequest<T>(request, text, inputs.length);
  }

  private async execRequest<T extends SqlRow>(
    request: sql.Request,
    text: string,
    paramCount: number,
  ): Promise<{ rows: T[]; rowCount: number }> {
    let rewritten = text;
    for (let i = paramCount; i >= 1; i--) {
      rewritten = rewritten.replace(new RegExp(`\\$${i}\\b`, 'g'), `@p${i - 1}`);
    }
    if (paramCount > 0 && rewritten.includes('?')) {
      let qi = 0;
      rewritten = rewritten.replace(/\?/g, () => `@p${qi++}`);
    }
    rewritten = rewriteSqliteDialect(rewritten);
    const result = await request.query(rewritten);
    return {
      rows: (result.recordset ?? []) as T[],
      rowCount: result.rowsAffected?.[0] ?? result.recordset?.length ?? 0,
    };
  }

  async get<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<T | undefined> {
    const { rows } = await this.query<T>(text, params);
    return rows[0];
  }

  async all<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await this.query<T>(text, params);
    return rows;
  }

  async run(
    text: string,
    params: unknown[] = [],
  ): Promise<{ changes: number; lastInsertRowid: number | null }> {
    const hasInsert = /^\s*INSERT\b/i.test(text);
    let sqlText = text;
    if (hasInsert && !/OUTPUT\s+INSERTED/i.test(text)) {
      // Append identity capture when inserting into a table with IDENTITY
      sqlText = `${text};\nSELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS lastInsertRowid;`;
    }
    const { rows, rowCount } = await this.query<{ lastInsertRowid?: number }>(sqlText, params);
    const last = rows.find((r) => r.lastInsertRowid != null)?.lastInsertRowid ?? null;
    return { changes: rowCount, lastInsertRowid: last != null ? Number(last) : null };
  }

  async transaction<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    const txDb = new SqlDb(this.pool);
    // Bind requests to this transaction by overriding query
    const origQuery = txDb.query.bind(txDb);
    txDb.query = async <R extends SqlRow = SqlRow>(text: string, params: unknown[] = []) => {
      const request = new sql.Request(tx);
      params.forEach((value, i) => request.input(`p${i}`, value as never));
      let rewritten = text;
      for (let i = params.length; i >= 1; i--) {
        rewritten = rewritten.replace(new RegExp(`\\$${i}\\b`, 'g'), `@p${i - 1}`);
      }
      if (params.length > 0 && rewritten.includes('?')) {
        let qi = 0;
        rewritten = rewritten.replace(/\?/g, () => `@p${qi++}`);
      }
      rewritten = rewriteSqliteDialect(rewritten);
      const result = await request.query(rewritten);
      return {
        rows: (result.recordset ?? []) as R[],
        rowCount: result.rowsAffected?.[0] ?? result.recordset?.length ?? 0,
      };
    };
    void origQuery;
    try {
      const result = await fn(txDb);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}

let pool: sql.ConnectionPool | null = null;
let poolPromise: Promise<sql.ConnectionPool> | null = null;
let dbSingleton: SqlDb | null = null;

export function isAzureSqlConfigured(): boolean {
  return Boolean(getAzureSqlConnectionString());
}

export async function getSqlPool(): Promise<sql.ConnectionPool> {
  const cs = getAzureSqlConnectionString();
  if (!cs) {
    throw new Error(
      'AZURE_SQL_CONNECTION_STRING es obligatorio: SpoStorage usa solo Azure SQL (sin SQLite).',
    );
  }
  if (pool?.connected) return pool;
  if (!poolPromise) {
    const config = {
      ...sql.ConnectionPool.parseConnectionString(cs),
      requestTimeout: 120_000,
      connectionTimeout: 30_000,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    };
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((p) => {
        pool = p;
        p.on('error', (err) => {
          console.warn(`[azure-sql] ${err.message}`);
          pool = null;
          poolPromise = null;
          dbSingleton = null;
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

export async function getDb(): Promise<SqlDb> {
  if (dbSingleton) return dbSingleton;
  const p = await getSqlPool();
  dbSingleton = new SqlDb(p);
  return dbSingleton;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  poolPromise = null;
  dbSingleton = null;
  if (p) await p.close();
}

export async function withDb<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
  return fn(await getDb());
}
