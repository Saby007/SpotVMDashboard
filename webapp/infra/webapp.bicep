// ============================================================================
// Spot VM Dashboard Web App — Azure App Service (Node.js 22)
// Deploys: App Service Plan + Web App with System-assigned Managed Identity.
//
// After deployment, assign the managed identity two read-only roles on the
// target subscription: 'Reader' (SKUs, quota, eviction rates) and
// 'Spot Placement Score Reader' (the Spot placement score API).
// ============================================================================

targetScope = 'resourceGroup'

@description('Base resource name prefix')
param baseName string = 'spotvm'

@description('Azure region')
param location string = resourceGroup().location

@description('App Service Plan SKU (B1 = Basic, S1 = Standard, P1v3 = Premium)')
@allowed(['B1', 'B2', 'S1', 'S2', 'P1v3', 'P2v3'])
param appServiceSkuName string = 'B1'

@description('Resource tags')
param tags object = {}

// --- App Service Plan ---

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${baseName}-plan'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: appServiceSkuName
  }
  properties: {
    reserved: true // required for Linux
  }
}

// --- Web App ---

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: '${baseName}-webapp'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node server.js'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      alwaysOn: appServiceSkuName != 'B1' && appServiceSkuName != 'B2'
      appSettings: [
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~22'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        // Subscription the web app is deployed into — the backend reads these at startup
        // to build its allowed-subscription list. Override or add AZURE_SUBSCRIPTIONS
        // (JSON array) for multi-subscription dashboards.
        {
          name: 'AZURE_SUBSCRIPTION_ID'
          value: subscription().subscriptionId
        }
        {
          name: 'AZURE_SUBSCRIPTION_NAME'
          value: subscription().displayName
        }
      ]
    }
  }
}

// --- Outputs ---

output webAppName string = webApp.name
output webAppDefaultHostName string = webApp.properties.defaultHostName
output webAppPrincipalId string = webApp.identity.principalId
output webAppResourceId string = webApp.id
