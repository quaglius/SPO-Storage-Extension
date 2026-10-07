# Deployment

SpoStorage runs in **your** Azure subscription against **your** Microsoft 365 tenant. You need:

- an Azure subscription where you can create resources and role assignments;
- a Global Administrator (or Privileged Role Administrator) to grant admin consent to the app permissions;
- Azure CLI (`az`), PowerShell 7 or Windows PowerShell 5.1, and a fork of this repository if you want CI/CD.

The step-by-step script guide is in [`scripts/setup/README.md`](../scripts/setup/README.md); this page explains what
gets created and why.

## 1. Azure resources

[`infra/main.bicep`](../infra/main.bicep) creates, in one resource group (every resource tagged `app=spostorage`;
expected cost in [operations.md](operations.md#monthly-cost-per-component)):

| Resource | Default | Notes |
|---|---|---|
| App Service plan (Linux) | B2 | both apps share it |
| Web app | Node 22, Always On, system identity | App Service Authentication with Entra ID (sign-in required, `/api/health` excluded) |
| Engine app | Node 22, Always On, system identity | `SPOSTORAGE_ENGINE_V2=1` |
| Azure SQL server + database | Standard S1 | "Allow Azure services" firewall rule; scale to S2 temporarily for faster first scans |
| Storage account | StorageV2, Cold, ZRS, TLS 1.2 | no public access, no shared keys, soft delete + versioning, `CanNotDelete` lock, container `archive`, *Storage Blob Data Contributor* for both app identities |

Copy `infra/main.parameters.example.json` to `infra/main.parameters.json` (git-ignored), fill in your values and deploy:

```bash
az deployment group create -g <resource-group> -f infra/main.bicep -p @infra/main.parameters.json
```

## 2. Entra ID app registrations

[`scripts/setup/New-SpoStorageEntraApps.ps1`](../scripts/setup/New-SpoStorageEntraApps.ps1) creates:

1. **Engine app** (app-only) with a self-signed **certificate** — SharePoint REST does not accept app-only tokens
   obtained with a client secret. Application permissions:
   - SharePoint: `Sites.FullControl.All`
   - Microsoft Graph: `Sites.Read.All`, `GroupMember.Read.All`, `AuditLogsQuery-SharePoint.Read.All`
   - Office 365 Management APIs: `ActivityFeed.Read`

   The script prints the certificate as base64 PEM for `SPOSTORAGE_APP_ONLY_CERT_PEM_BASE64` and the admin-consent URL.
2. **Web sign-in app** for App Service Authentication (redirect URI `https://<web app>/.auth/login/aad/callback`).
3. Optionally, a **deployment app** with a federated credential for GitHub Actions (OIDC, no secrets) and *Website
   Contributor* on the two web apps.

**Grant admin consent** for the engine app (Entra admin center → App registrations → the app → API permissions →
Grant admin consent). Without it the engine cannot read SharePoint.

Why each permission is needed: [archive-and-access.md §6](archive-and-access.md#6-permissions-the-platform-needs).

## 3. Application settings

Set the variables described in [configuration.md](configuration.md) (the Bicep template sets them from parameters).
At minimum: `AZURE_SQL_CONNECTION_STRING`, `SPO_TENANT`, `SPOSTORAGE_APP_ONLY_*`, `SPOSTORAGE_PUBLIC_URL`,
`ARCHIVE_STORAGE_ACCOUNT`, and `SPOSTORAGE_ADMINS` on the web app.

## 4. Build and deploy (GitHub Actions)

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs on every push to `main`: typecheck → tests (with
a SQL Server service container) → build → package → deploy to both apps → wait until `/api/health` reports the new
commit. Set these **repository variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | deployment app client id |
| `AZURE_TENANT_ID` | your Entra tenant id |
| `AZURE_SUBSCRIPTION_ID` | your subscription id |
| `WEB_APP_NAME` | web app name |
| `ENGINE_APP_NAME` | engine app name |

No secrets are stored in GitHub: login uses OpenID Connect.

Without GitHub: build locally (`cd app && npm ci && npm run build`), stage the package with
`node scripts/ci/stage-package.mjs <dir>`, run `npm install --omit=dev` in that directory, copy `shared` into
`node_modules/@spostorage/shared`, zip it and deploy with `az webapp deploy --type zip` to both apps.

## 5. First run

1. Open the web app and sign in with an account listed in `SPOSTORAGE_ADMINS`.
2. The engine starts immediately: tenant quota and sites within minutes, the first full file pass in roughly 20
   minutes per million files, version detail and the audit backfill over the following hours.
3. Check **Status** → notices (retention holds, pending consents).
4. Try each policy in the **Lab** on a non-critical site before planning tenant-wide runs.
