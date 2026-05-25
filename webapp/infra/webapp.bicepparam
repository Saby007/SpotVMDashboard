using './webapp.bicep'

param baseName = 'spotvm-hdfc'

param location = 'centralindia'

param appServiceSkuName = 'B1'

param tags = {
  Environment: 'Production'
  Project: 'SpotVM-Dashboard'
  DataClassification: 'Confidential'
}
