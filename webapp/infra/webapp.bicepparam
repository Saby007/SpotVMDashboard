using './webapp.bicep'

param baseName = 'spotvm'

param location = 'centralindia'

param appServiceSkuName = 'B1'

param tags = {
  Environment: 'Production'
  Project: 'SpotVM-Dashboard'
  DataClassification: 'Confidential'
}
