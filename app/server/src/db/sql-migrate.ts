import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { getMigrationPool, isMigrationDbConfigured, migrationQuery } from './sql-connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  const candidates = [
    path.join(__dirname, 'migrations-sql'),
    path.join(__dirname, '../db/migrations-sql'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(__dirname, 'migrations-sql');
}

export async function runSqlMigrations(): Promise<{ applied: string[]; skipped: boolean }> {
  if (!isMigrationDbConfigured()) {
    return { applied: [], skipped: true };
  }
  const pool = await getMigrationPool();
  if (!pool) return { applied: [], skipped: true };

  const applied: string[] = [];
  await migrationQuery(`
    IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.schema_migrations (
        id NVARCHAR(200) NOT NULL PRIMARY KEY,
        applied_at NVARCHAR(40) NOT NULL
      );
    END
  `);

  const dir = migrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const exists = await migrationQuery<{ id: string }>(
      'SELECT id FROM dbo.schema_migrations WHERE id = @p0',
      [id],
    );
    if (exists && exists.rows.length > 0) continue;

    const sqlText = fs.readFileSync(path.join(dir, file), 'utf8');
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      // Both App Services boot together: serialize migrations and re-check inside the lock.
      await new sql.Request(tx).query(
        "EXEC sp_getapplock @Resource = 'spostorage-migrations', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 900000",
      );
      const again = new sql.Request(tx);
      again.input('p0', id);
      const done = await again.query('SELECT id FROM dbo.schema_migrations WHERE id = @p0');
      if (done.recordset.length > 0) {
        await tx.commit();
        continue;
      }
      console.log(`[migrations] applying ${id}…`);
      // `GO` lines split batches (T-SQL needs ALTER/CREATE SCHEMA visible before later statements compile).
      const batches = sqlText.split(/^\s*GO\s*$/im).filter((b) => b.trim().length > 0);
      for (const batch of batches) {
        await new sql.Request(tx).batch(batch);
      }
      const insert = new sql.Request(tx);
      insert.input('p0', id);
      insert.input('p1', new Date().toISOString());
      await insert.query('INSERT INTO dbo.schema_migrations (id, applied_at) VALUES (@p0, @p1)');
      await tx.commit();
      applied.push(id);
    } catch (err) {
      console.error(`[migrations] ${id} failed: ${(err as Error).message}`);
      try {
        await tx.rollback();
      } catch {
        // already aborted by the server; the original error is the one that matters
      }
      throw err;
    }
  }

  return { applied, skipped: false };
}
