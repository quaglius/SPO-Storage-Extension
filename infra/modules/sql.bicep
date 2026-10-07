@description('Azure SQL logical server name (globally unique).')
param serverName string

@description('Azure SQL database name.')
param databaseName string

@description('Tags applied to every resource.')
param tags object = {}

@description('Azure region.')
param location string

@description('SQL server administrator login.')
param administratorLogin string

@secure()
@description('SQL server administrator password.')
param administratorLoginPassword string

@description('Database SKU name (S0, S1, S2, …). Default S1.')
param skuName string = 'S1'

@description('Database edition / tier.')
param edition string = 'Standard'

@description('DTU capacity matching the SKU (S1 = 20, S2 = 50).')
param capacity int = 20

resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: serverName
  location: location
  tags: tags
  properties: {
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    version: '12.0'
    publicNetworkAccess: 'Enabled'
    minimalTlsVersion: '1.2'
  }
}

resource sqlDatabase 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: databaseName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: edition
    capacity: capacity
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
  }
}

resource allowAzureServices 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output serverName string = sqlServer.name
output fullyQualifiedDomainName string = sqlServer.properties.fullyQualifiedDomainName
output databaseName string = sqlDatabase.name
