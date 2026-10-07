@description('Globally unique storage account name (3-24 lowercase letters/digits).')
param name string

@description('Tags applied to every resource.')
param tags object = {}

@description('Azure region for the storage account.')
param location string

@description('Storage SKU. Default Standard_ZRS.')
param skuName string = 'Standard_ZRS'

@description('Default blob access tier.')
@allowed([
  'Hot'
  'Cool'
  'Cold'
])
param accessTier string = 'Cold'

@description('Blob container name for archives.')
param containerName string = 'archive'

@description('Principal IDs (managed identities) that receive Storage Blob Data Contributor.')
param blobDataContributorPrincipalIds array

var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  kind: 'StorageV2'
  properties: {
    accessTier: accessTier
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: 90
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 90
    }
  }
}

resource archiveContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

resource canNotDeleteLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: 'no-delete-archive'
  scope: storageAccount
  properties: {
    level: 'CanNotDelete'
    notes: 'Protects the SpoStorage archive storage account from accidental deletion.'
  }
}

resource blobDataContributorAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (principalId, i) in blobDataContributorPrincipalIds: {
    name: guid(storageAccount.id, principalId, storageBlobDataContributorRoleId)
    scope: storageAccount
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        storageBlobDataContributorRoleId
      )
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

output name string = storageAccount.name
output id string = storageAccount.id
output containerName string = archiveContainer.name
