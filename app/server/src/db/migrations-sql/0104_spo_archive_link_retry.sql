-- Deferred archive links: the .url link may be created later (site over quota, read-only). A row waits for its link when
-- state = 'uploaded' (original still in SharePoint) or state = 'original_deleted' with link_url IS NULL.
IF COL_LENGTH(N'spo.archived_files', N'link_error') IS NULL
  ALTER TABLE spo.archived_files ADD
    link_error        NVARCHAR(2000) NULL,
    link_attempted_at DATETIME2(3)   NULL;
GO
