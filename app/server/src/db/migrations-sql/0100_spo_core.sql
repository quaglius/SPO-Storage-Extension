-- SpoStorage v2 core schema (docs/PLAN-V2.md §4.4).
-- Lives in its own schema [spo] so v1 tables in [dbo] can be dropped independently (phase 8).
-- Conventions: datetime2(3) UTC timestamps, BIGINT bytes, NVARCHAR text. Batches separated by GO.

IF SCHEMA_ID(N'spo') IS NULL EXEC(N'CREATE SCHEMA spo');
GO

-- ---------------------------------------------------------------- settings
CREATE TABLE spo.settings (
  [key]       NVARCHAR(100) NOT NULL PRIMARY KEY,
  value_json  NVARCHAR(MAX) NOT NULL,
  updated_at  DATETIME2(3)  NOT NULL CONSTRAINT df_settings_updated DEFAULT SYSUTCDATETIME()
);
GO

-- ---------------------------------------------------------------- L0 tenant
CREATE TABLE spo.tenant_snapshots (
  id              BIGINT IDENTITY PRIMARY KEY,
  captured_at     DATETIME2(3)  NOT NULL,
  quota_bytes     BIGINT        NULL,
  used_bytes      BIGINT        NULL,
  sites_count     INT           NULL,
  spo_file_count  BIGINT        NULL,
  source          NVARCHAR(60)  NOT NULL
);
CREATE INDEX ix_tenant_snapshots_at ON spo.tenant_snapshots (captured_at DESC);
GO

-- ---------------------------------------------------------------- L1 sites
CREATE TABLE spo.sites (
  id                   INT IDENTITY PRIMARY KEY,
  site_guid            UNIQUEIDENTIFIER NULL,
  url                  NVARCHAR(400) NOT NULL,
  title                NVARCHAR(400) NULL,
  template             NVARCHAR(80)  NULL,
  is_group             BIT           NOT NULL CONSTRAINT df_sites_group DEFAULT 0,
  state                NVARCHAR(40)  NULL,
  storage_used_bytes   BIGINT        NULL,
  storage_quota_bytes  BIGINT        NULL,
  spo_file_count       BIGINT        NULL,
  last_activity_at     DATETIME2(3)  NULL,
  usage_captured_at    DATETIME2(3)  NULL,
  excluded             BIT           NOT NULL CONSTRAINT df_sites_excluded DEFAULT 0,
  access_state         NVARCHAR(20)  NOT NULL CONSTRAINT df_sites_access DEFAULT N'unknown', -- unknown|ok|denied
  access_error         NVARCHAR(1000) NULL,
  first_seen_at        DATETIME2(3)  NOT NULL CONSTRAINT df_sites_first DEFAULT SYSUTCDATETIME(),
  last_seen_at         DATETIME2(3)  NOT NULL CONSTRAINT df_sites_last DEFAULT SYSUTCDATETIME(),
  deleted_at           DATETIME2(3)  NULL,
  CONSTRAINT uq_sites_url UNIQUE (url)
);
CREATE UNIQUE INDEX uq_sites_guid ON spo.sites (site_guid) WHERE site_guid IS NOT NULL;
GO

-- ---------------------------------------------------------------- L2 libraries (every list with files, hidden ones included)
CREATE TABLE spo.libraries (
  id                     INT IDENTITY PRIMARY KEY,
  site_id                INT NOT NULL REFERENCES spo.sites(id),
  web_url                NVARCHAR(600) NOT NULL,
  list_guid              UNIQUEIDENTIFIER NOT NULL,
  drive_id               NVARCHAR(200) NULL,
  title                  NVARCHAR(400) NOT NULL,
  root_url               NVARCHAR(800) NOT NULL,
  base_template          INT NOT NULL,
  hidden                 BIT NOT NULL,
  item_count             INT NULL,
  -- StorageMetrics of RootFolder (authoritative bytes, includes versions)
  metrics_total_bytes    BIGINT NULL,
  metrics_stream_bytes   BIGINT NULL,
  metrics_file_count     BIGINT NULL,
  metrics_captured_at    DATETIME2(3) NULL,
  -- version settings
  versioning_enabled     BIT NULL,
  major_version_limit    INT NULL,
  -- crawl state
  crawl_mode             NVARCHAR(20) NOT NULL CONSTRAINT df_lib_mode DEFAULT N'full', -- full|metrics_only|skip
  baseline_state         NVARCHAR(20) NOT NULL CONSTRAINT df_lib_baseline DEFAULT N'pending', -- pending|running|done|failed
  baseline_cursor        NVARCHAR(MAX) NULL,
  baseline_run_id        UNIQUEIDENTIFIER NULL,
  baseline_started_at    DATETIME2(3) NULL,
  baseline_done_at       DATETIME2(3) NULL,
  delta_link             NVARCHAR(MAX) NULL,
  delta_at               DATETIME2(3) NULL,
  last_error             NVARCHAR(2000) NULL,
  first_seen_at          DATETIME2(3) NOT NULL CONSTRAINT df_lib_first DEFAULT SYSUTCDATETIME(),
  last_seen_at           DATETIME2(3) NOT NULL CONSTRAINT df_lib_last DEFAULT SYSUTCDATETIME(),
  deleted_at             DATETIME2(3) NULL,
  CONSTRAINT uq_libraries_site_list UNIQUE (site_id, list_guid)
);
CREATE INDEX ix_libraries_site ON spo.libraries (site_id);
GO

-- ---------------------------------------------------------------- L3 files (metadata only, never content)
CREATE TABLE spo.files (
  id                   BIGINT IDENTITY PRIMARY KEY,
  site_id              INT NOT NULL,
  library_id           INT NOT NULL REFERENCES spo.libraries(id),
  unique_id            UNIQUEIDENTIFIER NOT NULL,
  list_item_id         INT NULL,
  server_relative_url  NVARCHAR(800) NOT NULL,
  name                 NVARCHAR(400) NOT NULL,
  extension            NVARCHAR(40)  NULL,
  size_bytes           BIGINT NOT NULL,
  total_bytes          BIGINT NULL,          -- SMTotalSize: current + historic versions
  versions_bytes       AS (CASE WHEN total_bytes > size_bytes THEN total_bytes - size_bytes ELSE 0 END) PERSISTED,
  version_label        NVARCHAR(20) NULL,
  version_count        INT NULL,
  created_at           DATETIME2(3) NULL,
  modified_at          DATETIME2(3) NULL,
  author               NVARCHAR(200) NULL,
  editor               NVARCHAR(200) NULL,
  has_unique_perms     BIT NULL,
  last_access_at       DATETIME2(3) NULL,
  last_access_source   NVARCHAR(20) NULL,
  versions_scanned_at  DATETIME2(3) NULL,
  seen_at              DATETIME2(3) NOT NULL,
  deleted_at           DATETIME2(3) NULL,
  archived_id          BIGINT NULL,
  CONSTRAINT uq_files_library_unique UNIQUE (library_id, unique_id)
);
CREATE INDEX ix_files_site_modified ON spo.files (site_id, modified_at) INCLUDE (size_bytes, total_bytes) WHERE deleted_at IS NULL;
CREATE INDEX ix_files_versions_bytes ON spo.files (versions_bytes DESC) INCLUDE (site_id, library_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_files_size ON spo.files (size_bytes DESC) INCLUDE (site_id, modified_at, last_access_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_files_library ON spo.files (library_id) INCLUDE (size_bytes, total_bytes, modified_at, deleted_at);
GO

-- ---------------------------------------------------------------- L4 version detail (only heavy files)
CREATE TABLE spo.file_versions (
  file_id      BIGINT NOT NULL REFERENCES spo.files(id),
  version_id   INT NOT NULL,               -- major * 512 + minor
  label        NVARCHAR(20) NOT NULL,
  size_bytes   BIGINT NOT NULL,
  created_at   DATETIME2(3) NULL,
  created_by   NVARCHAR(200) NULL,
  captured_at  DATETIME2(3) NOT NULL,
  CONSTRAINT pk_file_versions PRIMARY KEY (file_id, version_id)
);
GO

-- ---------------------------------------------------------------- rollups (the UI reads these, never spo.files scans)
CREATE TABLE spo.library_rollups (
  library_id            INT NOT NULL PRIMARY KEY REFERENCES spo.libraries(id),
  site_id               INT NOT NULL,
  file_count            BIGINT NOT NULL,
  current_bytes         BIGINT NOT NULL,
  total_bytes           BIGINT NOT NULL,
  versions_bytes        BIGINT NOT NULL,
  heavy_versions_files  BIGINT NOT NULL,   -- versions_bytes >= settings threshold
  heavy_versions_bytes  BIGINT NOT NULL,
  age_30_bytes          BIGINT NOT NULL,   -- modified within 30 days
  age_120_bytes         BIGINT NOT NULL,   -- 30..120 days
  age_365_bytes         BIGINT NOT NULL,   -- 120..365 days
  age_730_bytes         BIGINT NOT NULL,   -- 365..730 days
  age_old_bytes         BIGINT NOT NULL,   -- > 730 days
  computed_at           DATETIME2(3) NOT NULL
);
CREATE INDEX ix_library_rollups_site ON spo.library_rollups (site_id);
GO

CREATE TABLE spo.recycle_bin (
  site_id              INT NOT NULL PRIMARY KEY REFERENCES spo.sites(id),
  first_stage_bytes    BIGINT NOT NULL,
  first_stage_items    INT NOT NULL,
  second_stage_bytes   BIGINT NOT NULL,
  second_stage_items   INT NOT NULL,
  oldest_deleted_at    DATETIME2(3) NULL,
  captured_at          DATETIME2(3) NOT NULL
);
GO

-- ---------------------------------------------------------------- engine
CREATE TABLE spo.tasks (
  id            BIGINT IDENTITY PRIMARY KEY,
  kind          NVARCHAR(40)  NOT NULL,
  target_key    NVARCHAR(200) NOT NULL,     -- e.g. 'tenant', 'site:12', 'library:345'
  site_id       INT NULL,
  library_id    INT NULL,
  state         NVARCHAR(20)  NOT NULL,     -- ready|leased|done|failed
  priority      INT NOT NULL CONSTRAINT df_tasks_priority DEFAULT 100, -- lower runs first
  run_after     DATETIME2(3)  NOT NULL,
  attempts      INT NOT NULL CONSTRAINT df_tasks_attempts DEFAULT 0,
  max_attempts  INT NOT NULL CONSTRAINT df_tasks_max DEFAULT 8,
  lease_owner   NVARCHAR(100) NULL,
  lease_until   DATETIME2(3)  NULL,
  payload_json  NVARCHAR(MAX) NULL,
  last_error    NVARCHAR(2000) NULL,
  created_at    DATETIME2(3)  NOT NULL CONSTRAINT df_tasks_created DEFAULT SYSUTCDATETIME(),
  updated_at    DATETIME2(3)  NOT NULL CONSTRAINT df_tasks_updated DEFAULT SYSUTCDATETIME(),
  finished_at   DATETIME2(3)  NULL
);
-- one open task per (kind, target): the planner can enqueue idempotently
CREATE UNIQUE INDEX uq_tasks_open ON spo.tasks (kind, target_key) WHERE state IN (N'ready', N'leased');
CREATE INDEX ix_tasks_claim ON spo.tasks (state, priority, run_after) INCLUDE (kind, target_key, lease_until);
CREATE INDEX ix_tasks_finished ON spo.tasks (finished_at) WHERE finished_at IS NOT NULL;
GO

CREATE TABLE spo.engine_state (
  id                TINYINT NOT NULL PRIMARY KEY CONSTRAINT ck_engine_single CHECK (id = 1),
  instance          NVARCHAR(100) NULL,
  build_commit      NVARCHAR(60)  NULL,
  started_at        DATETIME2(3)  NULL,
  heartbeat_at      DATETIME2(3)  NULL,
  last_progress_at  DATETIME2(3)  NULL,
  paused            BIT NOT NULL CONSTRAINT df_engine_paused DEFAULT 0,
  pause_reason      NVARCHAR(400) NULL,
  current_json      NVARCHAR(MAX) NULL      -- what each slot is doing right now
);
INSERT INTO spo.engine_state (id) VALUES (1);
GO

CREATE TABLE spo.engine_throughput (
  minute      DATETIME2(0) NOT NULL PRIMARY KEY,
  items       INT NOT NULL,
  requests    INT NOT NULL,
  throttled   INT NOT NULL,
  errors      INT NOT NULL
);
GO

CREATE TABLE spo.engine_events (
  id          BIGINT IDENTITY PRIMARY KEY,
  at          DATETIME2(3) NOT NULL,
  level       NVARCHAR(10) NOT NULL,        -- info|warn|error
  kind        NVARCHAR(60) NOT NULL,
  site_id     INT NULL,
  library_id  INT NULL,
  message     NVARCHAR(1000) NOT NULL,      -- Spanish, user-facing
  data_json   NVARCHAR(MAX) NULL
);
CREATE INDEX ix_engine_events_at ON spo.engine_events (at DESC);
GO

-- ---------------------------------------------------------------- policies, runs, actions
CREATE TABLE spo.policies (
  id               INT IDENTITY PRIMARY KEY,
  name             NVARCHAR(200) NOT NULL,
  kind             NVARCHAR(40)  NOT NULL,  -- delete_versions|archive_files|purge_recycle|version_limit
  enabled          BIT NOT NULL CONSTRAINT df_policies_enabled DEFAULT 0,
  definition_json  NVARCHAR(MAX) NOT NULL,
  created_by       NVARCHAR(200) NULL,
  created_at       DATETIME2(3) NOT NULL CONSTRAINT df_policies_created DEFAULT SYSUTCDATETIME(),
  updated_at       DATETIME2(3) NOT NULL CONSTRAINT df_policies_updated DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE spo.policy_runs (
  id               BIGINT IDENTITY PRIMARY KEY,
  policy_id        INT NULL REFERENCES spo.policies(id),
  scope            NVARCHAR(20) NOT NULL,   -- lab|tenant
  mode             NVARCHAR(20) NOT NULL,   -- simulate|execute
  status           NVARCHAR(20) NOT NULL,   -- planned|awaiting_approval|running|done|failed|cancelled
  definition_json  NVARCHAR(MAX) NOT NULL,  -- snapshot at run time
  selection_json   NVARCHAR(MAX) NULL,      -- lab: chosen files/sites
  requested_by     NVARCHAR(200) NULL,
  approvals_json   NVARCHAR(MAX) NULL,
  planned_count    INT NULL,
  planned_bytes    BIGINT NULL,
  done_count       INT NULL,
  freed_bytes      BIGINT NULL,
  created_at       DATETIME2(3) NOT NULL CONSTRAINT df_runs_created DEFAULT SYSUTCDATETIME(),
  started_at       DATETIME2(3) NULL,
  finished_at      DATETIME2(3) NULL,
  error            NVARCHAR(2000) NULL
);
GO

CREATE TABLE spo.policy_actions (
  id              BIGINT IDENTITY PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES spo.policy_runs(id),
  site_id         INT NULL,
  library_id      INT NULL,
  file_id         BIGINT NULL,
  target_url      NVARCHAR(800) NOT NULL,
  action          NVARCHAR(40) NOT NULL,    -- delete_version|archive_file|purge_recycle_item|set_version_limit
  version_label   NVARCHAR(20) NULL,
  bytes           BIGINT NOT NULL,
  status          NVARCHAR(20) NOT NULL,    -- planned|done|skipped|failed
  detail          NVARCHAR(2000) NULL,
  evidence_json   NVARCHAR(MAX) NULL,       -- lab before/after checks
  executed_at     DATETIME2(3) NULL
);
CREATE INDEX ix_policy_actions_run ON spo.policy_actions (run_id, status);
GO

-- ---------------------------------------------------------------- archive (Blob Cold)
CREATE TABLE spo.archived_files (
  id                   BIGINT IDENTITY PRIMARY KEY,
  file_id              BIGINT NULL,
  site_id              INT NOT NULL,
  original_url         NVARCHAR(800) NOT NULL,
  web_url              NVARCHAR(600) NOT NULL,
  name                 NVARCHAR(400) NOT NULL,
  extension            NVARCHAR(40) NULL,
  size_bytes           BIGINT NOT NULL,
  sha256               CHAR(64) NOT NULL,
  content_type         NVARCHAR(200) NULL,
  blob_container       NVARCHAR(100) NOT NULL,
  blob_path            NVARCHAR(1000) NOT NULL,
  blob_tier            NVARCHAR(20) NOT NULL,
  link_url             NVARCHAR(800) NULL,  -- server-relative URL of the .url shortcut left in place
  unique_perms         BIT NOT NULL,
  acl_json             NVARCHAR(MAX) NULL,  -- principals snapshot for audit
  original_modified_at DATETIME2(3) NULL,
  original_modified_by NVARCHAR(200) NULL,
  state                NVARCHAR(20) NOT NULL, -- uploading|linked|original_deleted|failed
  run_id               BIGINT NULL,
  archived_by          NVARCHAR(200) NULL,
  archived_at          DATETIME2(3) NOT NULL,
  CONSTRAINT uq_archived_original UNIQUE (original_url)
);
GO

CREATE TABLE spo.archive_access_log (
  id           BIGINT IDENTITY PRIMARY KEY,
  archived_id  BIGINT NOT NULL REFERENCES spo.archived_files(id),
  at           DATETIME2(3) NOT NULL,
  user_upn     NVARCHAR(200) NOT NULL,
  granted      BIT NOT NULL,
  reason       NVARCHAR(400) NULL
);
GO
