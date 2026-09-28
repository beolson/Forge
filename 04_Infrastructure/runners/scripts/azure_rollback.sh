#!/bin/bash
# shellcheck source-path=SCRIPTDIR
operation=rollback
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=azure_common.sh
source "$script_directory/azure_common.sh"

if [[ $exists == false ]]; then
    echo "Resource group $resource_group is absent"
    exit 0
fi

az group delete --subscription "$AZURE_SUBSCRIPTION_ID" \
    --name "$resource_group" --yes --no-wait
az group wait --subscription "$AZURE_SUBSCRIPTION_ID" \
    --name "$resource_group" --deleted --interval 10 --timeout 1500
echo "Rolled back resource group $resource_group"
