import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { z } from 'zod';
import { archiveEnv, publicBaseUrl } from '../env.js';
import { getSetting } from '../settings.js';

/** Stored overrides (spo.settings 'archive'); unset fields come from environment variables. */
export const archiveSettingsSchema = z.object({
  account: z.string().optional(),
  container: z.string().optional(),
  tier: z.enum(['Hot', 'Cool', 'Cold', 'Archive']).optional(),
  /** Base URL of the web app; the .url link left in SharePoint points to `${portalBaseUrl}/archive/<id>`. */
  portalBaseUrl: z.string().url().optional(),
  /** Files larger than this are not archived automatically. */
  maxFileBytes: z.number().int().positive().default(15 * 1024 ** 3),
  subscriptionId: z.string().optional(),
  resourceGroup: z.string().optional(),
});

export interface ArchiveSettings {
  account: string;
  container: string;
  tier: 'Hot' | 'Cool' | 'Cold' | 'Archive';
  portalBaseUrl: string;
  maxFileBytes: number;
  subscriptionId: string | null;
  resourceGroup: string | null;
}


export function resolveArchiveSettings(stored: unknown): ArchiveSettings {
  const parsed = archiveSettingsSchema.safeParse(stored ?? {});
  const s = parsed.success ? parsed.data : archiveSettingsSchema.parse({});
  const env = archiveEnv();
  const account = s.account ?? env.account;
  if (!account) throw new Error('ARCHIVE_STORAGE_ACCOUNT is not set.');
  const portalBaseUrl = s.portalBaseUrl ?? publicBaseUrl();
  if (!portalBaseUrl) throw new Error('SPOSTORAGE_PUBLIC_URL is not set.');
  const tier = (s.tier ?? env.tier ?? 'Cold') as ArchiveSettings['tier'];
  return {
    account,
    container: s.container ?? env.container ?? 'archive',
    tier,
    portalBaseUrl: portalBaseUrl.replace(/\/$/, ''),
    maxFileBytes: s.maxFileBytes,
    subscriptionId: s.subscriptionId ?? env.subscriptionId,
    resourceGroup: s.resourceGroup ?? env.resourceGroup,
  };
}

export async function getArchiveSettings(): Promise<ArchiveSettings> {
  return resolveArchiveSettings(await getSetting<unknown>('archive'));
}

let cached: { key: string; client: ContainerClient; ensured: Promise<unknown> } | null = null;

/** Managed identity in App Service (Storage Blob Data Contributor), Azure CLI locally. */
export function containerClient(settings: ArchiveSettings): ContainerClient {
  const key = `${settings.account}/${settings.container}`;
  if (cached?.key === key) return cached.client;
  const service = new BlobServiceClient(`https://${settings.account}.blob.core.windows.net`, new DefaultAzureCredential());
  const client = service.getContainerClient(settings.container);
  cached = { key, client, ensured: client.createIfNotExists().catch(() => undefined) };
  return client;
}

/** Waits until the container exists (created on first use). */
export async function ensureContainer(settings: ArchiveSettings): Promise<ContainerClient> {
  const client = containerClient(settings);
  await cached?.ensured;
  return client;
}

/**
 * Blob name mirrors the SharePoint location: "<site slug>/<path inside the site>", e.g.
 * "marketing/Shared Documents/General/Videos/file.zip". Re-archiving the same path overwrites the blob,
 * and blob versioning keeps the previous copy.
 */
export function blobPathFor(siteUrl: string, serverRelativeUrl: string): string {
  const sitePath = new URL(siteUrl).pathname.replace(/\/$/, '');
  const slug = sitePath.split('/').filter(Boolean).pop() ?? 'site';
  const inside = serverRelativeUrl.startsWith(`${sitePath}/`)
    ? serverRelativeUrl.slice(sitePath.length + 1)
    : serverRelativeUrl.replace(/^\//, '');
  return `${slug}/${inside}`;
}

/** Azure portal page of one blob (properties blade), for the Archivados explorer. */
export function azurePortalBlobUrl(settings: ArchiveSettings, blobPath: string): string | null {
  if (!settings.subscriptionId || !settings.resourceGroup) return null;
  const accountId = `/subscriptions/${settings.subscriptionId}/resourceGroups/${settings.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${settings.account}`;
  return (
    'https://portal.azure.com/#view/Microsoft_Azure_Storage/BlobPropertiesBladeV2/storageAccountId/' +
    encodeURIComponent(accountId) +
    '/path/' +
    encodeURIComponent(`${settings.container}/${blobPath}`) +
    '/isDeleted~/false/tabToload~/0'
  );
}

/** Azure portal page of the archive container (fallback when a deep link does not open). */
export function azurePortalContainerUrl(settings: ArchiveSettings): string | null {
  if (!settings.subscriptionId || !settings.resourceGroup) return null;
  const accountId = `/subscriptions/${settings.subscriptionId}/resourceGroups/${settings.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${settings.account}`;
  return `https://portal.azure.com/#view/Microsoft_Azure_Storage/ContainerMenuBlade/~/overview/storageAccountId/${encodeURIComponent(accountId)}/path/${encodeURIComponent(settings.container)}`;
}
