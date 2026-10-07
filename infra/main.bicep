targetScope = 'resourceGroup'

@description('Tags applied to every resource (makes the platform easy to find in Cost Management).')
param tags object = {
  app: 'spostorage'
}

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('App Service plan name.')
param appServicePlanName string = 'plan-spostorage'

@description('App Service plan SKU (Linux). Default B2.')
param appServiceSkuName string = 'B2'

@description('Web app name (UI + API). Must be globally unique.')
param webAppName string

@description('Engine app name (background worker). Must be globally unique.')
param engineAppName string

@description('Azure SQL logical server name. Must be globally unique.')
param sqlServerName string

@description('Azure SQL database name.')
param sqlDatabaseName string = 'spostorage'

@description('SQL administrator login.')
param sqlAdministratorLogin string

@secure()
@description('SQL administrator password.')
param sqlAdministratorLoginPassword string

@description('Azure SQL database SKU name (S0, S1, S2, …). Default S1.')
param sqlSkuName string = 'S1'

@description('Azure SQL DTU capacity matching the SKU (S1 = 20, S2 = 50).')
param sqlCapacity int = 20

@description('Storage account name (3-24 lowercase letters/digits). Must be globally unique.')
param storageAccountName string

@description('Storage account SKU. Default Standard_ZRS.')
param storageSkuName string = 'Standard_ZRS'

@description('Storage default access tier.')
@allowed([
  'Hot'
  'Cool'
  'Cold'
])
param storageAccessTier string = 'Cold'

@description('Blob container name for archives.')
param archiveContainerName string = 'archive'

@description('SharePoint / M365 tenant hostname or id (SPO_TENANT).')
param spoTenant string

@description('Comma-separated admin e-mails (SPOSTORAGE_ADMINS on the web app).')
param spoStorageAdmins string

@description('App-only Entra application (client) ID.')
param appOnlyClientId string

@description('App-only Entra tenant ID.')
param appOnlyTenantId string

@secure()
@description('Base64-encoded PEM (certificate + private key) for app-only auth.')
param appOnlyCertPemBase64 string

@description('Entra app (client) ID for Easy Auth on the web app.')
param entraWebClientId string

@description('App setting name that stores the Easy Auth client secret.')
param entraWebClientSecretSettingName string = 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'

@secure()
@description('Easy Auth client secret value.')
param entraWebClientSecret string

@description('Entra tenant ID for the Easy Auth OpenID issuer.')
param entraTenantId string

var webPublicUrl = 'https://${webAppName}.azurewebsites.net'

module sql 'modules/sql.bicep' = {
  name: 'sql'
  params: {
    serverName: sqlServerName
    databaseName: sqlDatabaseName
    location: location
    tags: tags
    administratorLogin: sqlAdministratorLogin
    administratorLoginPassword: sqlAdministratorLoginPassword
    skuName: sqlSkuName
    edition: 'Standard'
    capacity: sqlCapacity
  }
}

// Built here (not as a module output) so the SQL password is not echoed through outputs.
var azureSqlConnectionString = 'Server=tcp:${sql.outputs.fullyQualifiedDomainName},1433;Initial Catalog=${sql.outputs.databaseName};Persist Security Info=False;User ID=${sqlAdministratorLogin};Password=${sqlAdministratorLoginPassword};MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;'

var sharedAppSettings = [
  {
    name: 'API_PORT'
    value: '8080'
  }
  {
    name: 'WEBSITES_PORT'
    value: '8080'
  }
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'REPO_ROOT'
    value: '/home/site/wwwroot'
  }
  {
    name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
    value: 'false'
  }
  {
    name: 'ENABLE_ORYX_BUILD'
    value: 'false'
  }
  {
    name: 'WEBSITES_CONTAINER_START_TIME_LIMIT'
    value: '600'
  }
  {
    name: 'SPO_TENANT'
    value: spoTenant
  }
  {
    name: 'SPOSTORAGE_PUBLIC_URL'
    value: webPublicUrl
  }
  {
    name: 'ARCHIVE_STORAGE_ACCOUNT'
    value: storageAccountName
  }
  {
    name: 'ARCHIVE_CONTAINER'
    value: archiveContainerName
  }
  {
    name: 'AZURE_SUBSCRIPTION_ID'
    value: subscription().subscriptionId
  }
  {
    name: 'AZURE_RESOURCE_GROUP'
    value: resourceGroup().name
  }
  {
    name: 'AZURE_SQL_CONNECTION_STRING'
    value: azureSqlConnectionString
  }
  {
    name: 'SPOSTORAGE_APP_ONLY_CLIENT_ID'
    value: appOnlyClientId
  }
  {
    name: 'SPOSTORAGE_APP_ONLY_TENANT_ID'
    value: appOnlyTenantId
  }
  {
    name: 'SPOSTORAGE_APP_ONLY_CERT_PEM_BASE64'
    value: appOnlyCertPemBase64
  }
]

module webapps 'modules/webapps.bicep' = {
  name: 'webapps'
  params: {
    planName: appServicePlanName
    location: location
    tags: tags
    skuName: appServiceSkuName
    webAppName: webAppName
    engineAppName: engineAppName
    sharedAppSettings: sharedAppSettings
    webExtraAppSettings: [
      {
        name: 'SPOSTORAGE_ADMINS'
        value: spoStorageAdmins
      }
    ]
    engineExtraAppSettings: [
      {
        name: 'SPOSTORAGE_ENGINE_V2'
        value: '1'
      }
    ]
    entraClientId: entraWebClientId
    entraClientSecretSettingName: entraWebClientSecretSettingName
    entraTenantId: entraTenantId
    entraClientSecret: entraWebClientSecret
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    name: storageAccountName
    location: location
    tags: tags
    skuName: storageSkuName
    accessTier: storageAccessTier
    containerName: archiveContainerName
    blobDataContributorPrincipalIds: [
      webapps.outputs.webAppPrincipalId
      webapps.outputs.engineAppPrincipalId
    ]
  }
}

output webAppUrl string = webPublicUrl
output engineAppUrl string = 'https://${engineAppName}.azurewebsites.net'
output storageAccountName string = storage.outputs.name
output sqlServerFqdn string = sql.outputs.fullyQualifiedDomainName
