@description('App Service plan name.')
param planName string

@description('Tags applied to every resource.')
param tags object = {}

@description('Azure region.')
param location string

@description('App Service plan SKU name (e.g. B2).')
param skuName string = 'B2'

@description('Web (UI + API) app name.')
param webAppName string

@description('Engine (background worker) app name.')
param engineAppName string

@description('App settings shared by both apps (name/value objects).')
param sharedAppSettings array

@description('Additional app settings for the web app only.')
param webExtraAppSettings array = []

@description('Additional app settings for the engine app only.')
param engineExtraAppSettings array = []

@description('Entra app (client) ID for Easy Auth on the web app.')
param entraClientId string

@description('App setting name that holds the Easy Auth client secret.')
param entraClientSecretSettingName string

@description('Entra tenant ID used in the OpenID issuer URL.')
param entraTenantId string

@secure()
@description('Client secret value stored under entraClientSecretSettingName.')
param entraClientSecret string

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

var commonSiteConfig = {
  linuxFxVersion: 'NODE|22-lts'
  appCommandLine: 'node server/dist/index.js'
  alwaysOn: true
  ftpsState: 'Disabled'
  http20Enabled: true
  minTlsVersion: '1.2'
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: union(commonSiteConfig, {
      appSettings: concat(
        sharedAppSettings,
        webExtraAppSettings,
        [
          {
            name: entraClientSecretSettingName
            value: entraClientSecret
          }
        ]
      )
    })
  }
}

resource webAuth 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: webApp
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [
        '/api/health'
      ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: entraClientId
          clientSecretSettingName: entraClientSecretSettingName
          openIdIssuer: 'https://sts.windows.net/${entraTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            'api://${entraClientId}'
          ]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: true
      }
    }
  }
}

resource engineApp 'Microsoft.Web/sites@2023-12-01' = {
  name: engineAppName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: union(commonSiteConfig, {
      appSettings: concat(sharedAppSettings, engineExtraAppSettings)
    })
  }
}

output webAppName string = webApp.name
output webAppHostName string = webApp.properties.defaultHostName
output webAppPrincipalId string = webApp.identity.principalId
output engineAppName string = engineApp.name
output engineAppHostName string = engineApp.properties.defaultHostName
output engineAppPrincipalId string = engineApp.identity.principalId
output planName string = plan.name
