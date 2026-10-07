/**
 * Deployment-specific configuration. Everything that identifies a tenant, a subscription or an organization comes
 * from environment variables — never from code — so the same build runs for any Microsoft 365 tenant.
 * See docs/configuration.md for the full list.
 */

function read(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

/**
 * SharePoint tenant name: the part before ".sharepoint.com" (e.g. "contoso" for contoso.sharepoint.com).
 * Required by anything that talks to SharePoint.
 */
export function spoTenant(): string {
  const tenant = read('SPO_TENANT');
  if (!tenant) throw new Error('SPO_TENANT is not set (e.g. "contoso" for contoso.sharepoint.com).');
  return tenant.replace(/\.sharepoint\.com$/i, '').replace(/^https?:\/\//i, '');
}

/** Public base URL of the web app (used in the .url links left in SharePoint), without trailing slash. */
export function publicBaseUrl(): string | null {
  return read('SPOSTORAGE_PUBLIC_URL')?.replace(/\/$/, '') ?? null;
}

/** Client id of the app-only Entra application the engine uses. */
export function appOnlyClientId(): string | null {
  return read('SPOSTORAGE_APP_ONLY_CLIENT_ID');
}

export interface ArchiveEnv {
  account: string | null;
  container: string | null;
  tier: string | null;
  subscriptionId: string | null;
  resourceGroup: string | null;
}

/** Blob storage used for archived files; subscription/resource group only enable Azure portal deep links. */
export function archiveEnv(): ArchiveEnv {
  return {
    account: read('ARCHIVE_STORAGE_ACCOUNT'),
    container: read('ARCHIVE_CONTAINER'),
    tier: read('ARCHIVE_TIER'),
    subscriptionId: read('AZURE_SUBSCRIPTION_ID'),
    resourceGroup: read('AZURE_RESOURCE_GROUP'),
  };
}
