#!/bin/bash
# Sourced by the separate Azure creation and rollback tasks.
set -Eeuo pipefail
umask 077
operation=${operation:?Azure task operation is not set}

fail() {
    echo "Forge azure ${operation} failed: $*" >&2
    exit 1
}

trap 'echo "Forge azure ${operation} failed: Azure task command failed; see the admin run log" >&2' ERR

[[ $# == 1 ]] || fail "Forge task requires one payload argument"
project=$(printf '%s' "$1" | base64 -d) || fail "Invalid Forge task payload"
jq -e '
    type == "object" and
    (.projectId | type == "string" and test("^[0-9a-f-]{36}$")) and
    (.code | type == "string" and test("^[A-Z]{5}$"))
' <<< "$project" > /dev/null || fail "Invalid project ID or code"
project_id=$(jq -r '.projectId' <<< "$project")
app_code=$(jq -r '.code' <<< "$project")
resource_group="az-${app_code,,}-resgp"

for variable in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_SUBSCRIPTION_ID AZURE_REGION; do
    [[ -n ${!variable:-} ]] || fail "$variable is not configured"
done

# Parallel tasks must not share Azure CLI tokens, settings, or subscription context.
export AZURE_CONFIG_DIR
AZURE_CONFIG_DIR=$(mktemp -d)
trap 'rm -rf -- "$AZURE_CONFIG_DIR"' EXIT
export AZURE_CORE_COLLECT_TELEMETRY=false
export AZURE_CORE_ONLY_SHOW_ERRORS=true
az login --service-principal --username "$AZURE_CLIENT_ID" \
    --password "$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID" --output none

exists=$(az group exists --subscription "$AZURE_SUBSCRIPTION_ID" \
    --name "$resource_group" --output tsv)
case "$exists" in
    true)
        marker=$(az group show --subscription "$AZURE_SUBSCRIPTION_ID" \
            --name "$resource_group" --query tags.forgeProjectId --output tsv)
        [[ $marker == "$project_id" ]] || fail "Resource group $resource_group exists without matching Forge ownership"
        ;;
    false) ;;
    *) fail "Could not determine whether resource group $resource_group exists" ;;
esac
