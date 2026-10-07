// Creates the test catalog on the CI SQL Server container (waits for the server to accept logins).
import sql from 'mssql';

const cs = process.env.CI_SQL_MASTER;
if (!cs) throw new Error('CI_SQL_MASTER is required');

for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    const pool = await sql.connect(cs);
    await pool.request().query(`IF DB_ID(N'spostorage-test') IS NULL CREATE DATABASE [spostorage-test]`);
    await pool.close();
    console.log('test database ready');
    process.exit(0);
  } catch (err) {
    console.log(`waiting for SQL Server (${attempt}): ${err.message}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
throw new Error('SQL Server not ready');
