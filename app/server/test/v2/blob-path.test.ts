import { describe, expect, it } from 'vitest';
import { azurePortalBlobUrl, blobPathFor, resolveArchiveSettings } from '../../src/v2/actions/blob.js';

describe('blob naming', () => {
  it('mirrors the SharePoint path under the site slug', () => {
    expect(blobPathFor('https://contoso.sharepoint.com/sites/marketing', '/sites/marketing/Shared Documents/General/Videos/a b.zip')).toBe(
      'marketing/Shared Documents/General/Videos/a b.zip',
    );
  });

  it('builds an Azure portal link to the blob only when subscription and resource group are known', () => {
    const base = { account: 'starchive', portalBaseUrl: 'https://spostorage.example.com' };
    const url = azurePortalBlobUrl(
      resolveArchiveSettings({ ...base, subscriptionId: '00000000-0000-0000-0000-000000000000', resourceGroup: 'rg-test' }),
      'marketing/Shared Documents/a.zip',
    );
    expect(url).toContain('BlobPropertiesBladeV2');
    expect(url).toContain(encodeURIComponent('archive/marketing/Shared Documents/a.zip'));
    expect(url).toContain(encodeURIComponent('/storageAccounts/starchive'));
    const saved = { sub: process.env.AZURE_SUBSCRIPTION_ID, rg: process.env.AZURE_RESOURCE_GROUP };
    delete process.env.AZURE_SUBSCRIPTION_ID;
    delete process.env.AZURE_RESOURCE_GROUP;
    try {
      expect(azurePortalBlobUrl(resolveArchiveSettings(base), 'x')).toBeNull();
    } finally {
      process.env.AZURE_SUBSCRIPTION_ID = saved.sub;
      process.env.AZURE_RESOURCE_GROUP = saved.rg;
    }
  });
});
