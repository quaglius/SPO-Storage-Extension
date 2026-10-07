# Configuration

Everything that identifies a tenant, subscription or organization is configured through **environment variables**
(App Service application settings). Behaviour that an administrator may want to tune at runtime lives in the database
(`spo.settings`) and is editable from the **Settings** screen.

## Environment variables

### Both apps (web and engine)

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `AZURE_SQL_CONNECTION_STRING` | yes | `Server=tcp:<server>.database.windows.net,1433;Database=spostorage;User ID=…;Password=…;Encrypt=true` | Operational database (schema `spo.*`). Migrations run at start-up. |
| `SPO_TENANT` | yes | `contoso` | SharePoint tenant name — the part before `.sharepoint.com`. |
| `SPOSTORAGE_APP_ONLY_CLIENT_ID` | yes | `00000000-…` | Engine app registration (application permissions). |
| `SPOSTORAGE_APP_ONLY_TENANT_ID` | yes | `00000000-…` or `contoso.onmicrosoft.com` | Entra tenant of that app. |
| `SPOSTORAGE_APP_ONLY_CERT_PEM_BASE64` | yes* | base64 of a PEM with private key + certificate | App-only credential. SharePoint REST **rejects client-secret tokens**, so a certificate is required. *Alternatively `SPOSTORAGE_APP_ONLY_CERT_PATH` pointing to a PEM file. |
| `SPOSTORAGE_PUBLIC_URL` | yes | `https://spostorage-web.azurewebsites.net` | Public URL of the web app; the `.url` links left in SharePoint point to `<this>/archive/<id>`. |
| `ARCHIVE_STORAGE_ACCOUNT` | yes | `stspoarchive01` | Storage account for archived files (accessed with the app's managed identity). |
| `ARCHIVE_CONTAINER` | no | `archive` | Container name (default `archive`). |
| `ARCHIVE_TIER` | no | `Cold` | Access tier for new blobs: `Hot`, `Cool`, `Cold` (default) or `Archive` (hours to rehydrate — the portal does not handle that). |
| `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` | no | | Only used to build "open in Azure portal" links. |
| `API_PORT` | no | `8080` | Port the server listens on (App Service: `8080`, same as `WEBSITES_PORT`). |
| `NODE_ENV` | yes in Azure | `production` | Serves the built web UI and enables production checks. |
| `REPO_ROOT` | App Service | `/home/site/wwwroot` | Location of `build-info.json` (commit shown in `/api/health`). |

### Engine app only

| Variable | Value | Purpose |
|---|---|---|
| `SPOSTORAGE_ENGINE_V2` | `1` | Starts the background engine **and locks the app down** to `GET /api/health` only (the engine has no authentication in front of it). |

### Web app only

| Variable | Example | Purpose |
|---|---|---|
| `SPOSTORAGE_ADMINS` | `alice@contoso.com,bob@contoso.com` | Platform administrators (comma-separated UPNs). **No default** — an empty list means nobody can use the admin screens. Everyone else in the tenant can only use the download portal. |
| `WEBSITE_AUTH_ENABLED` | set by App Service | The user identity header is only trusted when App Service Authentication is enabled. |

## Runtime settings (`spo.settings`, **Settings** screen)

| Key | Fields (defaults) |
|---|---|
| `engine` | `concurrency` (4 parallel tasks), `requestsPerMinute` (600), `heavyVersionsThresholdBytes` (20 MB — files whose versions weigh more get version detail), `tenantUsageIntervalMinutes` (60), `siteStructureIntervalHours` (12), `libraryScanIntervalHours` (24 — full pass), `versionsRescanDays` (7), `maxSubwebDepth` (5), `retryFailedAfterHours` (6), `tenant` (overrides `SPO_TENANT`) |
| `archive` | `maxFileBytes` (15 GB — larger files are skipped by automatic archiving), optional overrides for `account`, `container`, `tier`, `portalBaseUrl`, `subscriptionId`, `resourceGroup` |
| `pricing.extraStorageUsdPerGbMonth` | price used to estimate the monthly cost of the overage (default 0.20) |
| `audit.backfillDays` | how far back the audit log is read on first run (default 180) |
| `audit.status` | written by the engine (coverage of the audit log; read-only) |

## Entra ID permissions

See [deployment.md](deployment.md#2-entra-id-app-registrations) for the two app registrations and
[archive-and-access.md](archive-and-access.md#6-permissions-the-platform-needs) for why each permission is needed.
