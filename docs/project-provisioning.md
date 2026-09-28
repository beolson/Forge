# Project creation: local stack with real providers

The form accepts a 1–50 character project name using ASCII letters, digits, spaces, and hyphens; a unique five-letter code (case-insensitive); and a required 1–500 character description. Repositories are private and empty. Any member or guest signed in to the configured Entra tenant can create a project. Creators see their own projects; a configured security group can inspect all projects and retry failed ones.

## Runtime flow

1. TanStack Start inserts the project and a request into PostgreSQL in one transaction. Its outbox publisher sends the request to `forge-requests`.
2. A separate DBOS service owns the durable workflow and launches Azure and GitHub containers in parallel. Each task gets three total attempts, with a configurable timeout defaulting to 30 minutes. The source snapshot and Docker image ID are pinned before creation. Containers use deterministic names so recovery finds the original execution after an interrupted API response.
3. Privileged task containers hold provider credentials through a read-only volume. Azure creation uses a subscription-scoped Bicep template and Bash; GitHub uses Python. Creation adopts only matching `forgeProjectId` tags or `forge_project_id` custom properties. Separate rollback tasks delete only resources with those ownership markers.
4. Automatic retries and rollback keep the original source and image. An admin retry cleans up using the preceding creation attempt's versions before resolving current source for fresh creation. An uncertain execution remains `cleanup_failed` for investigation.
5. DBOS sends project progress to `forge-results`. Independently, the runner observer captures redacted stdout/stderr and persists run-event batches in a filesystem outbox. It resends those batches until the website commits them and sends an acknowledgement through `forge-requests`.
6. The website saves run records and logs in PostgreSQL before notifying browsers over SSE. Creators receive their own progress and status; only admins can retrieve scripts, parameters, run details, and full logs. Reconnecting log views fetch by arrival cursor, so late or out-of-order batches are not skipped.

The Service Bus emulator has a one-hour maximum message lifetime and loses messages on restart. The website requeues unfinished project requests hourly; DBOS replays their durable terminal result. Runner events stay in the local outbox until the website acknowledges them, and repeat deliveries are deduplicated. Neither a browser disconnect nor a log-delivery outage causes provisioning retries or rollback.

Detailed logs default to 90-day retention, configurable with `RUNNER_LOG_RETENTION_DAYS`; source snapshots, parameters, image IDs, and outcomes remain. The local observer also removes completed task containers after retention. Pinned image IDs and the `runner_data` volume must remain available for later rollback or admin retry.

This Compose slice runs one web server and one orchestrator. Additional web replicas require a shared SSE fanout mechanism. The project runner profile is reserved; per-project service principals, Key Vault injection, in-group deployments, and Azure Container Apps deployment come later. See [the agreed runner design](container-job-runners.md).

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

The template is [project-resource-group.bicep](../04_Infrastructure/runners/resources/project-resource-group.bicep). It creates `az-{lowercase-app-code}-resgp` and writes the `forgeProjectId` and `forgeCode` ownership tags in the resource definition. It accepts `appCode`, `projectId`, and `location`; credentials remain inside the privileged task container.

The **Create Azure resource group** task runs `scripts/azure_create.sh` as a Bash task. Its wrapper validates the request, logs in with the service principal, and checks whether the group exists. An existing group must have the same `forgeProjectId`; otherwise the task fails without deploying. For a missing group, it runs:

```sh
az deployment sub create --subscription "$AZURE_SUBSCRIPTION_ID" \
  --name "az-${app_code,,}-rgdep" \
  --location "$deployment_location" \
  --template-file resources/project-resource-group.bicep \
  --parameters "appCode=$app_code" "projectId=$project_id" "location=$AZURE_REGION"
```

The subscription deployment record uses the registered `rgdep` designation. For its first deployment, `deployment_location` is the configured `AZURE_REGION`. On retry, the task looks up and retains the record's original location to avoid Azure's immutable deployment-location constraint if the system region changes. The template's `location` parameter still uses `AZURE_REGION` for a newly created group. Existing project groups are adopted without changing their location. See [subscription deployments with Bicep](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-to-subscription).

**Roll back Azure resource group** remains a separate Bash task. After checking the same ownership tag, it calls `az group delete` and waits up to 25 minutes for deletion. Removing a resource from an incremental Bicep template does not delete it, so rollback uses an explicit CLI deletion. Subscription deployment history is retained for diagnosis. This is provisioning rollback; retirement remains a future feature.

The runner image includes pinned Azure CLI and Bicep versions and currently targets Linux x86_64. Each task uses a private temporary `AZURE_CONFIG_DIR`, removed when the task exits, so parallel tasks do not share CLI token caches or subscription settings. The Bicep executable is installed when the image is built; tasks do not download it at runtime.

Rebuild the runner image and start the stack with `just up`. The orchestrator pins the image ID for each project creation attempt; changing the tag does not change an existing workflow's image.

Run the Azure task tests without cloud credentials or provisioning:

```sh
python3 -m unittest discover -s 04_Infrastructure/runners/tests -v
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

   Set `GITHUB_APP_PRIVATE_KEY_PATH` in `.env` to the absolute path printed by `realpath`. The credential seed service copies the key into the private runner volume and sets ownership for runner UID 10001. Set `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_ORG` in `.env`. Only the credential seed service and privileged task containers mount this PEM. The script uses a signed [GitHub App JWT and installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app).

## Website admin group

Create an Entra security group for Forge admins and set its object ID as `FORGE_ADMIN_GROUP_ID`. In the existing Forge app registration, add a **groups** claim to the **ID token** that emits security group object IDs. Group members can see all projects and retry failures. [Microsoft group claims guidance](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles).

If a user's group list exceeds the ID-token limit, Entra emits an overage indicator instead of `groups`. This slice treats that user as a regular creator; use groups assigned to the application or a future Graph-backed check for such users. [Microsoft group overage guidance](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles#group-overages).

## Script-loading GitHub App

Create a **separate** GitHub App for fetching the approved task source:

1. Open GitHub **Settings → Developer settings → GitHub Apps → New GitHub App** (or your organization's GitHub App settings). Disable the webhook if you do not need it. Give this app repository **Contents: read-only** permission. Metadata read access is implicit. No provisioning or organization administration permissions are needed.
2. Install the app using **Only select repositories**, selecting the Forge repository. The repository may be in a different organization from the repositories Forge provisions.
3. Copy the **App ID** from the app's settings into `AUTOMATION_GITHUB_APP_ID`.
4. Open the installed app's configuration. Copy the installation ID from the final numeric segment in the URL, for example `/settings/installations/123456`, into `AUTOMATION_GITHUB_INSTALLATION_ID`.
5. In the app's **Private keys** section click **Generate a private key**. GitHub generates and downloads the registered PEM; generating a PEM with OpenSSL does not register it with GitHub. Store it using:

   ```sh
   install -d -m 700 "$HOME/.config/forge"
   install -m 600 "$HOME/Downloads/<downloaded-source-key>.pem" "$HOME/.config/forge/source-app.pem"
   openssl pkey -in "$HOME/.config/forge/source-app.pem" -check -noout
   realpath "$HOME/.config/forge/source-app.pem"
   ```

   Put the printed absolute path in `AUTOMATION_GITHUB_PRIVATE_KEY_PATH`. The website container runs as UID 1000 and must be able to read this file. The orchestrator and website mount only this read-only app's key; provisioning containers never receive it.
6. Set `AUTOMATION_REPOSITORY=owner/Forge`. By default, the loader fetches `04_Infrastructure/runners/tasks.json` from `main`, resolves its exact commit, and fetches only the manifest's declared scripts and dependencies at that commit. Installation tokens are restricted to that repository and Contents read permission.

The manifest declares task IDs, friendly names, runner profile, resource, operation, runtime, entrypoint, and dependencies. Paths cannot escape the source root. An admin can inspect the catalog at `/admin/tasks`, and inspect each execution's saved source at `/admin/runs/<run-id>`. Editing links open GitHub's `main` branch; they never change an already pinned execution.

Before this branch is merged to `main`, you can **explicitly** enable local development snapshots with `AUTOMATION_SOURCE_DIRECTORY=/approved-source`. This uses the read-only local runner folder mounted by Compose and records a content hash labeled **Local development snapshot**. It still provisions real resources. Leave that setting empty to use the approved GitHub source, including when deploying to Azure.

## Run

Copy `.env.example` to `.env`, fill the database, authentication, provider, and source-app settings, then run `just up`. Existing provider credentials remain usable; old Semaphore settings are no longer used. The Compose image service builds `forge-runner:local`, and the credential seed service prepares the private runner volume.

Browse to `http://localhost:5321` and create a project. Creators see provisioning milestones. Admins can open **Provisioning runs** for individual task attempts, parameters, exact source and image versions, exit codes, and live logs. Detailed log retention can be configured using `RUNNER_LOG_RETENTION_DAYS=90`; timeout uses `RUNNER_TASK_TIMEOUT_MS=1800000`.

If a task fails, inspect its admin run page and `just logs`. An admin can correct credentials, permissions, or provider state and use **Try again**. Failed projects retain their code and progress. There is no project deletion or retirement flow in this slice. No Semaphore execution history is imported.

`just down` keeps database and runner volumes. Ephemeral task containers are launched directly by DBOS rather than as Compose services; active tasks can finish while the orchestrator is down, and it recovers them when restarted. Stop active provisioning through the orchestrator's timeout handling before removing its runtime volumes.
