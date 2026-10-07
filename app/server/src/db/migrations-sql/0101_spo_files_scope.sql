-- Permission scope of each file (RenderListDataAsStream ScopeId). Files sharing a scope share permissions;
-- the library's inherited scope is its most common ScopeId. Used by the archive ACL copy and the lab.
IF COL_LENGTH(N'spo.files', N'scope_id') IS NULL
  ALTER TABLE spo.files ADD scope_id UNIQUEIDENTIFIER NULL;
GO
IF COL_LENGTH(N'spo.libraries', N'item_count_files') IS NULL
  ALTER TABLE spo.libraries ADD item_count_files BIGINT NULL;
GO
