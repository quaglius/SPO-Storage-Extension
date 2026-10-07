# Architecture

## Components

| Component | Where | Responsibility |
|---|---|---|
| **Web app** | Azure App Service (Linux, Node 22), App Service Authentication with Entra ID | React UI + `/api/v2/*`; admin screens; end-user download portal; decides archive downloads against SharePoint. |
| **Engine app** | Same App Service plan, same build, `SPOSTORAGE_ENGINE_V2=1` | Background worker: inventory, version detail, audit ingestion, policy execution, restores. Exposes only `/api/health`. |
| **Azure SQL** | Standard tier (S1–S3) | Everything the platform knows (schema `spo`). No ORM: explicit T-SQL. |
| **Blob Storage** | Cold tier by default | Archived files (the only copy once the original is deleted). |
| **SharePoint Online / Graph** | Your tenant | Accessed app-only with a certificate. |

Both apps run the same package; the engine flag decides whether the worker starts. Neither needs a desktop, a
PowerShell session or interactive sign-in.

## The engine

`app/server/src/v2/engine/`

- **Durable queue** (`spo.tasks`): one open row per `(kind, target_key)` (unique filtered index), so enqueueing is
  idempotent. Claims use `UPDLOCK, READPAST` so several slots (or instances) never take the same task.
- **Leases** renewed while a task runs; an expired lease is picked up again by anyone.
- **Small tasks**: one page of a library, one site, one batch of actions. Recurring work is a single row that goes
  back to `ready` with a future `run_after`; paginated work stores its cursor in `payload_json`. A restart resumes
  exactly where it was.
- **Failures never stop the engine**: transient SharePoint errors (429/5xx, network, truncated JSON) back off with
  `Retry-After`; other errors fail only that task, which is re-armed later by the planner.
- **Client** (`v2/spo/client.ts`): global requests-per-minute limiter and concurrency cap shared by all slots, global
  pause on 429/503.
- **Watchdog**: if work is due and nothing progressed for 20 minutes, the process exits and App Service restarts it.
- **Per-kind time limits** (e.g. 4 h for policy runs that copy multi-GB files).

| Task kind | Target | What it does |
|---|---|---|
| `tenant-usage` | `tenant` | Tenant quota and usage (`/_api/StorageQuotas()`) and every site's usage from the admin aggregated site list. Hourly. |
| `site-structure` | `site:<id>` | Webs and subwebs, every document library (hidden ones included), recycle bin totals. Every 12 h. |
| `library-scan` | `library:<id>` | Full, resumable pass with `RenderListDataAsStream` (5,000 rows per page): size, `SMTotalSize` (current + versions), dates, author/editor, permission scope. Detects deletions. Daily. |
| `file-versions` | `library:<id>` | Version detail (`/Versions`) only for files whose versions weigh more than the threshold. |
| `audit-ingest` | `audit` | Last access per file from the Microsoft 365 audit log (Graph `security/auditLog/queries`), day by day with 4 queries in flight; then a daily overlap every 6 h. |
| `policy-run` | `run:<id>` | Executes an approved run in batches (archive: 6 files in parallel). |
| `archive-restore` | `archived:<id>` | Restores an archived file to SharePoint. |
| `maintenance` | `global` | Retention of events, finished tasks and throughput samples. |

The **planner** (`v2/crawl/planner.ts`, every minute) inserts missing tasks with one set-based statement and re-arms
tasks that failed more than `retryFailedAfterHours` ago.

## Layered reconciliation

| Layer | Data | Source |
|---|---|---|
| L0 Tenant | quota, usage, versions weight | SharePoint admin `StorageQuotas()` |
| L1 Site | usage, file count, last activity | admin list `DO_NOT_DELETE_SPLIST_TENANTADMIN_AGGREGATED_SITECOLLECTIONS` |
| L2 Library | every library + recycle bin | `web/webs`, `web/lists`, `site/RecycleBin` |
| L3 File | size, size incl. versions (`SMTotalSize`), dates, people, permission scope | `RenderListDataAsStream` |
| L4 Version | label, size, date | `/Versions` (heavy files only) |
| L5 Access | last human access | Microsoft 365 audit log |

The Status screen compares, per site, **files + recycle bins** with **what Microsoft counts for the quota**. They
usually match within 2 %. When files add up to *more*, nothing is missing — Microsoft does not appear to charge twice
for duplicated content — but freeing X GB there may lower the quota by less than X (the Lab measures it). When they add
up to *less*, inventory is missing (unreadable libraries, access denied).

`StorageMetrics` of library root folders and Graph `drive.quota` were evaluated and rejected: the former returns zeros
with app-only tokens, the latter reports the whole site on every drive.

## Data model (`spo` schema)

| Table | Contents |
|---|---|
| `tenant_snapshots` | quota and usage over time |
| `sites`, `libraries` | inventory; libraries carry the scan state and cursor |
| `files` | metadata only (never content); `versions_bytes` computed; `url_hash` to join audit records |
| `file_versions` | version detail for heavy files |
| `library_rollups` | per-library totals and age buckets — **the UI reads these, never full scans of `files`** |
| `recycle_bin`, `file_access` | recycle bin totals per site; last access per URL |
| `tasks`, `engine_state`, `engine_throughput`, `engine_events` | engine queue, heartbeat, per-minute throughput, event log |
| `policies`, `policy_runs`, `policy_actions` | policies, runs (with approvals) and every action with its evidence |
| `archived_files`, `archive_access_log` | archived files and every download decision |
| `settings` | runtime settings |

Migrations are numbered T-SQL files in `app/server/src/db/migrations-sql/`, split into batches by `GO`, serialized
across instances with `sp_getapplock` and allowed up to 15 minutes (DDL over a million-row table takes time).

## Security model (summary)

- Users sign in with Entra ID through App Service Authentication; the identity header is only trusted when App Service
  authentication is on. The engine app answers nothing but `/api/health`.
- Admin screens require membership in `SPOSTORAGE_ADMINS`; the download portal is open to any signed-in user of the
  tenant but serves a file only when SharePoint grants that user access to its link.
- Destructive actions require a three-step approval by an administrator; every action is logged with evidence.
- Details: [archive-and-access.md](archive-and-access.md).
