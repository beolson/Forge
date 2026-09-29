targetScope = 'subscription'

@description('The five-letter Forge project code. Resource names use its lowercase form.')
@minLength(5)
@maxLength(5)
param appCode string

@description('The Forge project ID used to identify ownership during retries and deletion.')
@minLength(36)
@maxLength(36)
param projectId string

@description('The system-configured Azure region for the resource group.')
param location string

resource projectResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: 'az-${toLower(appCode)}-resgp'
  location: location
  tags: {
    forgeProjectId: projectId
    forgeCode: toUpper(appCode)
  }
}

output resourceGroupId string = projectResourceGroup.id
output resourceGroupName string = projectResourceGroup.name
