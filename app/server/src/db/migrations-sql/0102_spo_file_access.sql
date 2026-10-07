-- Last access from the Microsoft 365 audit log (Graph auditLogQuery, SharePoint file operations).
-- Audit records identify files by URL, so both sides are joined on SHA-256(LOWER(server-relative URL)).
IF OBJECT_ID(N'spo.file_access', N'U') IS NULL
CREATE TABLE spo.file_access (
  url_hash        BINARY(32)     NOT NULL PRIMARY KEY,
  url             NVARCHAR(800)  NOT NULL,
  last_access_at  DATETIME2(3)   NOT NULL,
  last_user       NVARCHAR(200)  NULL,
  last_operation  NVARCHAR(60)   NULL,
  events          INT            NOT NULL,
  updated_at      DATETIME2(3)   NOT NULL
);
GO
IF COL_LENGTH(N'spo.files', N'url_hash') IS NULL
  ALTER TABLE spo.files ADD url_hash AS CAST(HASHBYTES('SHA2_256', LOWER(server_relative_url)) AS BINARY(32)) PERSISTED;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'ix_files_url_hash' AND object_id = OBJECT_ID(N'spo.files'))
  CREATE INDEX ix_files_url_hash ON spo.files (url_hash);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'ix_file_access_updated' AND object_id = OBJECT_ID(N'spo.file_access'))
  CREATE INDEX ix_file_access_updated ON spo.file_access (updated_at);
GO
