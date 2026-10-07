# Operations

## Health and monitoring

- `GET /api/health` (public on both apps): status, version, **deployed commit**, role, whether the engine runs. CI waits
  for the new commit here after each deployment.
- **Status** screen: engine state (working / idle / paused / no signal), what every slot is doing, items per minute,
  throttling and errors in the last hour, queue depth, recent events, notices.
- **Activity** screen: event log, runs, failed tasks with a "retry" button.
- Engine controls: **Pause / Resume** on the Status screen.

### Read-only diagnostics inside the engine app

[`scripts/ops/kudu-run.ps1`](../scripts/ops/kudu-run.ps1) runs a Node script inside the engine App Service (through
Kudu), with the app's environment and packages, so you can query the database without copying secrets:

```powershell
.\scripts\ops\kudu-run.ps1 -App <engine-app-name> -ScriptPath .\scripts\ops\engine-status.mjs
```

`engine-status.mjs` prints engine heartbeat, tasks by state, inventory totals, throughput, recent events, errors and
database DTU usage.

## Sizing and cost

Reference numbers from a tenant with ~1,000,000 files / ~36 TB:

| Resource | Recommendation | Notes |
|---|---|---|
| App Service plan | **B2** (2 cores, 3.5 GB) | Both apps together use ~2.3 GB of memory (~68 %); B1 (1.75 GB) is too small. CPU averages ~15 % and peaks during the daily pass and while archiving (hashing). |
| Azure SQL | **S1** (20 DTU) | Average DTU is 1–3 %; the daily full pass peaks at 100 % for a while (it just takes longer on S1). Scale to S2 temporarily if you want the first scans or a large migration to finish faster. Database size ~1.7 GB for 1 M files. |
| Blob Storage | Cold, ZRS | Cold is much cheaper than SharePoint extra storage and downloads immediately. Reading from Cold has a small retrieval charge. |

Archiving throughput is bound by transfer and hashing: ~15 MB/s per file, 6 files in parallel. Plan large archive runs
accordingly and watch memory on the plan.

### Monthly cost per component

Azure retail list prices (USD, Central US, September 2026; check the linked pricing pages for your region and
currency). Keep everything in **one resource group** and tag it (e.g. `app=spostorage`) so the cost is easy to find in
Cost Management.

| Component | SKU | ≈ USD / month | Pricing |
|---|---|---|---|
| App Service plan (web + engine share it) | Linux B2 | 26 | [App Service Linux](https://azure.microsoft.com/pricing/details/app-service/linux/) |
| Azure SQL Database | Standard S1 (S2 while scanning faster) | 29 (S2: 74) | [Azure SQL DTU](https://azure.microsoft.com/pricing/details/azure-sql-database/single/) |
| Blob Storage, per TB archived | Cold ZRS (LRS is ~10 % cheaper) | 5 per TB | [Blob Storage](https://azure.microsoft.com/pricing/details/storage/blobs/) |
| Entra ID app registrations, Graph, audit log, GitHub Actions | — | 0 | — |
| **Base platform, nothing archived yet** | | **≈ 55** | |

Variable storage charges, usually small: write operations when archiving (~$0.25 per 10,000 files), retrieval when
someone downloads or you restore (~$0.04 per GB), internet egress for downloads beyond the free allowance, and Cold's
90-day minimum (deleting or restoring a blob earlier is billed as if it stayed 90 days). Soft delete and versioning keep
deleted blobs for 90 days, which also counts as stored data.

For comparison, SharePoint extra file storage lists at about $0.20 per GB per month (≈ $205 per TB): archiving 1 TB to
Cold costs roughly 2–3 % of keeping it over quota in SharePoint.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Both apps return 503 after a deploy | a migration running or failing at start-up | Check the container log (Kudu `api/logs/docker`); migrations log `[migrations] <id> failed: …`. |
| Status shows "no signal" | engine app stopped or crashing | Check the engine app log and `/api/health` of the engine. |
| Many `429`/throttled in the last hour | SharePoint throttling | Lower `engine.requestsPerMinute` or `engine.concurrency` in Settings. |
| A site shows "comes out over" in reconciliation | quota accounting (duplicated content) | Not an inventory gap; measure real savings in the Lab. |
| A site shows "comes out under" | libraries not readable, access denied | Check failed tasks and access errors for that site. |
| Deleting versions does not lower usage | a Purview retention policy or hold | See the retention notice on Status; the Lab shows Preservation Hold Library growth. |
| "Last access" filter disabled | audit backfill not finished or permission not consented | Status shows audit coverage and pending consents. |
| Users get "no permission" on an archived file | they cannot open the `.url` link in SharePoint | Grant access in SharePoint as usual; the portal re-checks on every visit. |
