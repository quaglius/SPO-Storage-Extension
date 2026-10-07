-- Drop v1 dbo.* tables (D3: discard v1 data). Keep dbo.schema_migrations.
-- Idempotent: drop all foreign keys in dbo first, then DROP TABLE IF EXISTS.

DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql = @sql + N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id))
  + N'.' + QUOTENAME(OBJECT_NAME(parent_object_id))
  + N' DROP CONSTRAINT ' + QUOTENAME(name) + N';'
FROM sys.foreign_keys
WHERE OBJECT_SCHEMA_NAME(parent_object_id) = N'dbo';
IF LEN(@sql) > 0 EXEC sp_executesql @sql;
GO

DROP TABLE IF EXISTS dbo.actions;
DROP TABLE IF EXISTS dbo.alerts;
DROP TABLE IF EXISTS dbo.archived_files;
DROP TABLE IF EXISTS dbo.automation_jobs;
DROP TABLE IF EXISTS dbo.automation_log;
DROP TABLE IF EXISTS dbo.data_events;
DROP TABLE IF EXISTS dbo.files;
DROP TABLE IF EXISTS dbo.hub_analytics;
DROP TABLE IF EXISTS dbo.imports;
DROP TABLE IF EXISTS dbo.libraries;
DROP TABLE IF EXISTS dbo.migration_access_audit;
DROP TABLE IF EXISTS dbo.migration_archive_objects;
DROP TABLE IF EXISTS dbo.migration_candidates;
DROP TABLE IF EXISTS dbo.migration_sites;
DROP TABLE IF EXISTS dbo.policies;
DROP TABLE IF EXISTS dbo.policy_runs;
DROP TABLE IF EXISTS dbo.report_jobs;
DROP TABLE IF EXISTS dbo.settings;
DROP TABLE IF EXISTS dbo.site_coverage;
DROP TABLE IF EXISTS dbo.site_storage_history;
DROP TABLE IF EXISTS dbo.sites;
DROP TABLE IF EXISTS dbo.versions;
DROP TABLE IF EXISTS dbo.work_items;
DROP TABLE IF EXISTS dbo.work_progress;
GO
