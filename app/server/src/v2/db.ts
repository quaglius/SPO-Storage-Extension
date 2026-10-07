/**
 * v2 data access: plain T-SQL with named parameters (@name), no dialect rewriting.
 * Shares the process-wide mssql pool with v1 until v1 is removed (PLAN-V2 phase 8).
 */
import sql from 'mssql';
import { getSqlPool } from '../db/sql-db.js';

export type Params = Record<string, unknown>;

type Queryable = sql.ConnectionPool | sql.Transaction;

export interface Db {
  all<T>(text: string, params?: Params): Promise<T[]>;
  one<T>(text: string, params?: Params): Promise<T | undefined>;
  exec(text: string, params?: Params): Promise<number>;
  /** Pass a large JSON array as NVARCHAR(MAX) parameter @json (for OPENJSON bulk MERGE). */
  execJson(text: string, rows: unknown[], params?: Params): Promise<number>;
}

function bind(request: sql.Request, params: Params): sql.Request {
  for (const [name, value] of Object.entries(params)) {
    if (value instanceof Date) {
      request.input(name, sql.DateTime2(3), value);
    } else if (typeof value === 'bigint') {
      request.input(name, sql.BigInt, value.toString());
    } else if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) > 2_147_483_647) {
      request.input(name, sql.BigInt, value);
    } else if (typeof value === 'string' && value.length > 4000) {
      request.input(name, sql.NVarChar(sql.MAX), value);
    } else {
      request.input(name, value as never);
    }
  }
  return request;
}

function makeDb(target: Queryable): Db {
  const request = () => new sql.Request(target as sql.ConnectionPool);
  return {
    async all<T>(text: string, params: Params = {}) {
      const r = await bind(request(), params).query(text);
      return (r.recordset ?? []) as T[];
    },
    async one<T>(text: string, params: Params = {}) {
      const r = await bind(request(), params).query(text);
      return (r.recordset ?? [])[0] as T | undefined;
    },
    async exec(text: string, params: Params = {}) {
      const r = await bind(request(), params).query(text);
      return r.rowsAffected.reduce((a, b) => a + b, 0);
    },
    async execJson(text: string, rows: unknown[], params: Params = {}) {
      const req = bind(request(), params);
      req.input('json', sql.NVarChar(sql.MAX), JSON.stringify(rows));
      const r = await req.query(text);
      return r.rowsAffected.reduce((a, b) => a + b, 0);
    },
  };
}

export async function db(): Promise<Db> {
  return makeDb(await getSqlPool());
}

/** Runs fn inside one transaction; commits on success, rolls back on throw. */
export async function tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const result = await fn(makeDb(transaction));
    await transaction.commit();
    return result;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      // already rolled back by the server (e.g. deadlock victim)
    }
    throw err;
  }
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** ISO string without the trailing Z: OPENJSON ... WITH (x DATETIME2) rejects the 'Z' suffix. Input must be UTC. */
export function sqlDate(value: string | Date | null | undefined): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace('Z', '');
}
