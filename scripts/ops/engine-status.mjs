// Read-only snapshot of the v2 engine and the spo.* data. Runs inside the engine App Service (see kudu-run.ps1),
// where AZURE_SQL_CONNECTION_STRING is available. Never prints secrets.
import sql from 'mssql';

const p = await sql.connect(process.env.AZURE_SQL_CONNECTION_STRING);
const q = async (t) => (await p.request().query(t)).recordset;
const TB = 1099511627776.0;
const out = {};
out.engine = (await q(`SELECT instance, LEFT(build_commit, 7) AS commit_, started_at, heartbeat_at, last_progress_at, paused, current_json FROM spo.engine_state`))[0];
if (out.engine?.current_json) {
  out.engine.slots = JSON.parse(out.engine.current_json).filter((s) => s.taskId).map((s) => `${s.kind} ${s.target} — ${s.status ?? ''}`);
}
if (out.engine) delete out.engine.current_json;
out.tasks = await q(`SELECT kind, state, COUNT(*) c FROM spo.tasks GROUP BY kind, state ORDER BY kind, state`);
out.libraries = await q(`SELECT baseline_state, COUNT(*) c, SUM(CAST(item_count AS BIGINT)) items FROM spo.libraries WHERE deleted_at IS NULL GROUP BY baseline_state`);
out.files = (await q(`SELECT COUNT_BIG(*) n, SUM(CAST(COALESCE(total_bytes, size_bytes) AS FLOAT))/${TB} tb FROM spo.files WHERE deleted_at IS NULL`))[0];
out.sites = (await q(`SELECT COUNT(*) n, SUM(CAST(storage_used_bytes AS FLOAT))/${TB} tb, SUM(CASE WHEN access_state='denied' THEN 1 ELSE 0 END) denied FROM spo.sites WHERE deleted_at IS NULL`))[0];
out.rollups = (await q(`SELECT SUM(CAST(total_bytes AS FLOAT))/${TB} tb, SUM(CAST(versions_bytes AS FLOAT))/${TB} versions_tb, SUM(CAST(heavy_versions_bytes AS FLOAT))/${TB} heavy_tb, SUM(CAST(age_730_bytes + age_old_bytes AS FLOAT))/${TB} older_1y_tb FROM spo.library_rollups`))[0];
out.recycle = (await q(`SELECT SUM(CAST(first_stage_bytes + second_stage_bytes AS FLOAT))/${TB} tb FROM spo.recycle_bin`))[0];
out.tenant = (await q(`SELECT TOP 1 captured_at, CAST(quota_bytes AS FLOAT)/${TB} quota_tb, CAST(used_bytes AS FLOAT)/${TB} used_tb FROM spo.tenant_snapshots ORDER BY captured_at DESC`))[0];
out.throughput = await q(`SELECT TOP 6 minute, items, requests, throttled, errors FROM spo.engine_throughput ORDER BY minute DESC`);
out.events = await q(`SELECT TOP 10 at, level, kind, LEFT(message, 200) m FROM spo.engine_events ORDER BY id DESC`);
out.errors = await q(`SELECT TOP 8 kind, target_key, state, attempts, LEFT(last_error, 220) e FROM spo.tasks WHERE last_error IS NOT NULL ORDER BY updated_at DESC`);
out.dtu = await q(`SELECT TOP 4 end_time, avg_cpu_percent cpu, avg_data_io_percent io, avg_log_write_percent logw FROM sys.dm_db_resource_stats ORDER BY end_time DESC`);
console.log(JSON.stringify(out, null, 1));
await p.close();
