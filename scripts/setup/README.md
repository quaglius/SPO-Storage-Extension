# SpoStorage — tenant and Azure setup

Step-by-step guide to deploy SpoStorage in **your own** Microsoft 365 tenant and Azure subscription.
Infrastructure lives in `infra/`; Entra registrations are created by the script in this folder.

## Prerequisites

- Azure CLI (`az`) signed in with rights to create app registrations in Entra ID and to deploy to a subscription (Owner or Contributor + User Access Administrator for role assignments).
- PowerShell 7 **or** Windows PowerShell 5.1.
- An empty (or dedicated) Azure resource group, or permission to create one.
- A Global Admin (or Privileged Role Admin) available once to grant **admin consent** for the engine application permissions.
- Globally unique names for: two App Service apps, one Azure SQL server, one storage account.

Copy `infra/main.parameters.example.json` to a private parameters file (do **not** commit it) and replace every `contoso` / zero-GUID placeholder.

## 1. Create Entra app registrations

From the repository root:

```powershell
pwsh ./scripts/setup/New-SpoStorageEntraApps.ps1 `
  -TenantId contoso.onmicrosoft.com `
  -WebAppName spostorage-web-contoso
```

Optional — also create a GitHub Actions OIDC deploy app (after the App Services exist, or run again later):

```powershell
pwsh ./scripts/setup/New-SpoStorageEntraApps.ps1 `
  -TenantId contoso.onmicrosoft.com `
  -WebAppName spostorage-web-contoso `
  -EngineAppName spostorage-engine-contoso `
  -ResourceGroup rg-spostorage `
  -GitHubRepo contoso/spostorage
```

The script:

- Creates **SpoStorage Engine** with a self-signed certificate (private key never leaves the machine), uploads the public certificate, and requests application permissions (SharePoint, Microsoft Graph, Office 365 Management APIs).
- Creates **SpoStorage Web** for Easy Auth with redirect URI `https://<WebAppName>.azurewebsites.net/.auth/login/aad/callback`, a client secret, and ID tokens enabled.
- Optionally creates **SpoStorage GitHub Deploy** with a federated credential for `repo:<owner>/<name>:ref:refs/heads/main` and **Website Contributor** on both web apps.
- Prints the admin-consent URL, the PEM base64 for `SPOSTORAGE_APP_ONLY_CERT_PEM_BASE64`, and the Easy Auth client secret.

Secrets are printed to the console only. Pass `-OutFile path.json` if you want them written to disk.

## 2. Fill Bicep parameters

In your private parameters file set at least:

| Parameter | Source |
|---|---|
| `appOnlyClientId` / `appOnlyTenantId` / `appOnlyCertPemBase64` | Engine app output |
| `entraWebClientId` / `entraWebClientSecret` / `entraTenantId` | Web app output |
| `spoTenant` | SharePoint hostname (e.g. `contoso.sharepoint.com`) |
| `spoStorageAdmins` | Comma-separated admin e-mails |
| `sqlAdministratorLoginPassword` | Choose a strong password |
| App / SQL / storage names | Your unique names |

Defaults: App Service plan **B2**, Azure SQL **S1**, storage **Standard_ZRS** + **Cold**.

## 3. Deploy the Bicep template

```bash
az group create --name rg-spostorage --location eastus

az deployment group create \
  --resource-group rg-spostorage \
  --template-file infra/main.bicep \
  --parameters @infra/main.parameters.private.json
```

Validate the template without deploying:

```bash
az bicep build --file infra/main.bicep
```

Outputs: web URL, engine URL, storage account name, SQL server FQDN.

## 4. GitHub Actions variables

If you created the deploy app, set these **repository variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | Deploy app (client) ID |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID |
| `WEB_APP_NAME` | Web App Service name |
| `ENGINE_APP_NAME` | Engine App Service name |

No Azure client secret is required; the workflow uses OIDC (`id-token: write`).

## 5. Grant admin consent

Open the admin-consent URL printed by the setup script (Global Admin):

`https://login.microsoftonline.com/<tenant-id>/adminconsent?client_id=<engine-app-id>`

Accept SharePoint `Sites.FullControl.All`, Graph `Sites.Read.All` / `GroupMember.Read.All` / `AuditLogsQuery-SharePoint.Read.All`, and Office 365 Management `ActivityFeed.Read`.

## 6. First deploy

Push to `main` (or `master`) so `.github/workflows/deploy.yml` builds and zip-deploys to both App Services, **or** deploy a local build package with Azure CLI / Visual Studio Code.

Startup command (already set by Bicep): `node server/dist/index.js`. Oryx build during deploy is disabled; ship a package that already contains `server/dist` and production `node_modules`.

## 7. Verify

```bash
curl -sS "https://<web-app>.azurewebsites.net/api/health"
```

`/api/health` is excluded from Easy Auth. Expect JSON with status and commit metadata after a successful deploy. Then open the web URL in a browser and sign in with a user from your tenant (admins listed in `SPOSTORAGE_ADMINS`).
