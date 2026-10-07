-- Restore of archived files back to SharePoint (docs/ARCHIVE-LINK-SECURITY.md §7).
IF COL_LENGTH(N'spo.archived_files', N'restore_state') IS NULL
  ALTER TABLE spo.archived_files ADD
    restore_state        NVARCHAR(20)   NULL,  -- requested|uploaded|done|failed
    restore_requested_by NVARCHAR(200)  NULL,
    restore_requested_at DATETIME2(3)   NULL,
    restored_at          DATETIME2(3)   NULL,
    restore_error        NVARCHAR(2000) NULL;
GO
