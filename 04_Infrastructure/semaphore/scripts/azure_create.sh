#!/bin/bash
# shellcheck source-path=SCRIPTDIR
operation=create
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=azure_common.sh
source "$script_directory/azure_common.sh"

if [[ $exists == true ]]; then
    echo "Resource group $resource_group already belongs to this project"
    exit 0
fi

az config set bicep.use_binary_from_path=true --output none
deployment_name="az-${app_code,,}-rgdep"
# Deployment metadata keeps its original location, even if AZURE_REGION changes.
deployment_location=$(az deployment sub list --subscription "$AZURE_SUBSCRIPTION_ID" \
    --query "[?name=='${deployment_name}'].location | [0]" --output tsv)
deployment_location=${deployment_location:-$AZURE_REGION}
az deployment sub create --subscription "$AZURE_SUBSCRIPTION_ID" \
    --name "$deployment_name" \
    --location "$deployment_location" \
    --template-file "$script_directory/../resources/project-resource-group.bicep" \
    --parameters "appCode=$app_code" "projectId=$project_id" "location=$AZURE_REGION" \
    --output none
echo "Created resource group $resource_group using Bicep"
