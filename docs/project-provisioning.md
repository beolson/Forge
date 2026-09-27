# Project creation: local stack with real providers

The form accepts a 1–50 character project name using ASCII letters, digits, spaces, and hyphens; a unique five-letter code (case-insensitive); and a required 1–500 character description. Repositories are private and empty. Any member or guest signed in to the configured Entra tenant can create a project. Creators see their own projects; a configured security group can inspect all projects and retry failed ones.

## Runtime flow

1. TanStack Start inserts the project and a request into PostgreSQL in one transaction. Its in-process outbox publisher sends the request to `forge-requests`.
2. DBOS starts a durable workflow for that project attempt. It starts Azure and GitHub Semaphore creation tasks in parallel. Each task gets one initial run plus up to two retries. The configured task timeout defaults to 30 minutes. The task message is a short run key; the project request travels as a base64 JSON task argument. The templates must allow task argument overrides. Semaphore explicitly forwards the provider environment variables listed in `SEMAPHORE_FORWARDED_ENV_VARS` to its task processes.
3. The Semaphore tasks alone hold provider credentials. Azure creation deploys a subscription-scoped Bicep template through Azure CLI; GitHub provisioning uses Python. They identify resources with an Azure `forgeProjectId` tag or a GitHub `forge_project_id` custom property. Repeated creation adopts only a matching resource; rollback deletes only a matching resource.
4. If creation fails, DBOS calls both Semaphore rollback templates. A failed or uncertain cleanup remains visible as `cleanup_failed`. Admin retry first runs rollback again, then starts a fresh creation attempt.
5. DBOS publishes progress to `forge-results`. The web server saves each result and pushes a refresh signal through SSE. On reconnect, the page loads the saved status and activity from PostgreSQL.

The local Service Bus emulator limits message lifetime to one hour, so both local queues use that maximum with expiration dead-lettering. While a project remains unfinished, the web outbox resends its request hourly. DBOS uses the same workflow ID and replies with the durable terminal result after completion, allowing the web database to recover if a prior result expired during an outage. Inspect the Service Bus dead-letter queues for prolonged outages and investigate any project still unfinished after services recover. A cloud Service Bus deployment can use a longer queue lifetime.

The first Compose deployment has one web server instance. If it is replicated, the result consumer and SSE clients need a shared fanout mechanism so an event consumed by one instance reaches clients on another.

## Azure setup

Use a dedicated test subscription for the first real run. The signed-in user needs both:

- **Microsoft Entra:** permission to register an application. Tenant members can do this by default. If **Users can register applications** is disabled, ask for the **Application Developer**, **Application Administrator**, or **Cloud Application Administrator** role. [Entra role guidance](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/delegate-app-roles).
- **Azure subscription:** permission to create a role assignment at the subscription scope, such as **Owner**, **User Access Administrator**, or **Role Based Access Control Administrator** at that scope. **Contributor** alone cannot assign roles. [Azure RBAC role guidance](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/privileged).

Set `AZURE_SUBSCRIPTION_ID` in `.env`. For the **East US** region, set `AZURE_REGION=eastus` ([Azure region list](https://learn.microsoft.com/en-us/azure/reliability/regions-list)).

Create a service principal and assign it access at the subscription scope, because it must create and delete resource groups at that scope:

```sh
az ad sp create-for-rbac --name forge-provisioner --role Contributor --scopes /subscriptions/<subscription-id>
```

If the application is created but the role assignment fails with `Microsoft.Authorization/roleAssignments/write`, ask an administrator with subscription **Owner**, **User Access Administrator**, or **Role Based Access Control Administrator** to assign the role separately. Do not rerun `create-for-rbac` just to retry the assignment, because it can patch the existing application and its credentials. Find the service principal **object ID** using the application ID from the command output, then have the administrator run:

```sh
az ad sp show --id <application-id> --query id -o tsv
az role assignment create --assignee-object-id <service-principal-object-id> --assignee-principal-type ServicePrincipal --role Contributor --scope /subscriptions/<subscription-id>
```

Copy `appId`, `password`, and `tenant` from the command output into `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_TENANT_ID`. Keep the secret out of source control. Contributor includes the required permissions. For a shared or production subscription, a custom role needs `Microsoft.Resources/subscriptions/resourceGroups/read`, `write`, and `delete`, plus `Microsoft.Resources/deployments/*`, at the subscription scope. Bicep requires permissions for both the deployed resources and the deployment record. [Bicep deployment permissions](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-cli#required-permissions).

### Azure Bicep task

The template is [project-resource-group.bicep](../04_Infrastructure/semaphore/resources/project-resource-group.bicep). It creates `az-{lowercase-app-code}-resgp` and writes the `forgeProjectId` and `forgeCode` ownership tags in the resource definition. It accepts `appCode`, `projectId`, and `location`; credentials remain in the Semaphore task environment.

The **Create Azure resource group** template runs `scripts/azure_create.sh` as a Bash task. Its wrapper validates the request, logs in with the service principal, and checks whether the group exists. An existing group must have the same `forgeProjectId`; otherwise the task fails without deploying. For a missing group, it runs:

```sh
az deployment sub create --subscription "$AZURE_SUBSCRIPTION_ID" \
  --name "az-${app_code,,}-rgdep" \
  --location "$deployment_location" \
  --template-file resources/project-resource-group.bicep \
  --parameters "appCode=$app_code" "projectId=$project_id" "location=$AZURE_REGION"
```

The subscription deployment record uses the registered `rgdep` designation. For its first deployment, `deployment_location` is the configured `AZURE_REGION`. On retry, the task looks up and retains the record's original location to avoid Azure's immutable deployment-location constraint if the system region changes. The template's `location` parameter still uses `AZURE_REGION` for a newly created group. Existing project groups are adopted without changing their location. See [subscription deployments with Bicep](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-to-subscription).

**Roll back Azure resource group** remains a separate Bash task. After checking the same ownership tag, it calls `az group delete` and waits up to 25 minutes for deletion. Removing a resource from an incremental Bicep template does not delete it, so rollback uses an explicit CLI deletion. Subscription deployment history is retained for diagnosis. This is provisioning rollback; retirement remains a future feature.

The Semaphore image includes pinned Azure CLI and Bicep versions and currently targets Linux x86_64. Each task uses a private temporary `AZURE_CONFIG_DIR`, removed when the task exits, so parallel tasks do not share CLI token caches or subscription settings. The Bicep executable is installed when the image is built; tasks do not download it at runtime.

After upgrading an existing local stack, rebuild Semaphore and rerun bootstrap to change the Azure templates from Python to Bash while preserving their IDs:

```sh
docker compose --env-file .env -f 04_Infrastructure/local/compose.yaml up -d --no-deps --build semaphore
docker compose --env-file .env -f 04_Infrastructure/local/compose.yaml run --rm --no-deps semaphore-bootstrap
```

Wait for active Semaphore tasks to finish before recreating its container.

Run the Azure task tests without cloud credentials or provisioning:

```sh
python3 -m unittest discover -s 04_Infrastructure/semaphore/tests -v
```

## GitHub organization setup

1. As an organization owner, create a repository custom property named `forge_project_id`. Use **Text string**, allow repository actors to set it, and do not require a default value. This property is written in the same [repository creation request](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository), so a retry can identify an earlier successful create. [GitHub custom property setup](https://docs.github.com/en/organizations/managing-organization-settings/managing-custom-properties-for-repositories-in-your-organization).
2. Create a GitHub App owned by the organization. Give it **Administration: read and write** and **Custom properties: read and write** repository permissions. Install it on **All repositories** so it can see repositories it creates. GitHub documents the [repository creation permission](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository) and [custom property permission](https://docs.github.com/en/rest/repos/custom-properties#create-or-update-custom-property-values-for-a-repository). The app must also be able to delete repositories during rollback.
3. In the app's GitHub settings, open **Private keys** and click **Generate a private key**. GitHub downloads a PEM file. There is no CLI command to generate a signing key for an existing GitHub App: GitHub must generate and register it. See [GitHub's private-key instructions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps#generating-private-keys). Copy the downloaded file to a private location with these commands, replacing the source filename:

   ```sh
   install -d -m 700 "$HOME/.config/forge"
   install -m 600 "$HOME/Downloads/<downloaded-key>.pem" "$HOME/.config/forge/github-app.pem"
   openssl pkey -in "$HOME/.config/forge/github-app.pem" -check -noout
   realpath "$HOME/.config/forge/github-app.pem"
   ```

   Set `GITHUB_APP_PRIVATE_KEY_PATH` in `.env` to the absolute path printed by `realpath`. The file must be readable by UID 1001 inside the Semaphore container; if needed, grant that UID read access with `setfacl -m u:1001:r "$HOME/.config/forge/github-app.pem"`. Set `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_ORG` in `.env`. The Semaphore container alone mounts the PEM. The script uses a signed [GitHub App JWT and installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app).

## Website admin group

Create an Entra security group for Forge admins and set its object ID as `FORGE_ADMIN_GROUP_ID`. In the existing Forge app registration, add a **groups** claim to the **ID token** that emits security group object IDs. Group members can see all projects and retry failures. [Microsoft group claims guidance](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles).

If a user's group list exceeds the ID-token limit, Entra emits an overage indicator instead of `groups`. This slice treats that user as a regular creator; use groups assigned to the application or a future Graph-backed check for such users. [Microsoft group overage guidance](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles#group-overages).

## Run

Copy `.env.example` to `.env`, fill the existing database, authentication, and Semaphore settings plus the provider settings above, then run `just up`. The Semaphore bootstrap registers four templates and writes its API connection file into a local Docker volume for the DBOS service. Browse to `http://localhost:5321` and create a test project.

Check `just logs` and the Semaphore UI at `http://localhost:3001` if a task fails. A failed project retains its code and activity log. An admin can correct credentials, permissions, or provider state manually and use **Try again**. There is no project deletion or retirement flow in this slice.
