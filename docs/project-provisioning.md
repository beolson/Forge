# Project creation: local stack with real providers

The form accepts a 1–50 character project name using ASCII letters, digits, spaces, and hyphens; a unique five-letter code (case-insensitive); and a required 1–500 character description. Repositories are private and empty. Any member or guest signed in to the configured Entra tenant can create a project. Creators see their own projects; a configured security group can inspect all projects and retry failed ones.

## Runtime flow

1. TanStack Start inserts the project and a request into PostgreSQL in one transaction. Its in-process outbox publisher sends the request to `forge-requests`.
2. DBOS starts a durable workflow for that project attempt. It starts Azure and GitHub Semaphore creation tasks in parallel. Each task gets one initial run plus up to two retries. The configured task timeout defaults to 30 minutes.
3. The Semaphore Python scripts alone hold provider credentials. They identify resources with an Azure `forgeProjectId` tag or a GitHub `forge_project_id` custom property. Repeated creation adopts only a matching resource; rollback deletes only a matching resource.
4. If creation fails, DBOS calls both Semaphore rollback templates. A failed or uncertain cleanup remains visible as `cleanup_failed`. Admin retry first runs rollback again, then starts a fresh creation attempt.
5. DBOS publishes progress to `forge-results`. The web server saves each result and pushes a refresh signal through SSE. On reconnect, the page loads the saved status and activity from PostgreSQL.

Requests and results have a 14-day queue lifetime with expiration dead-lettering. While a project remains unfinished, the web outbox resends its request hourly. DBOS uses the same workflow ID and replies with the durable terminal result after completion, allowing the web database to recover if a prior result expired during an outage. Inspect the Service Bus dead-letter queues for prolonged outages and investigate any project still unfinished after services recover.

The first Compose deployment has one web server instance. If it is replicated, the result consumer and SSE clients need a shared fanout mechanism so an event consumed by one instance reaches clients on another.

## Azure setup

Use a dedicated test subscription for the first real run. Sign in with Azure CLI as a user who can create service principals and assign subscription roles. Set `AZURE_SUBSCRIPTION_ID` and `AZURE_REGION` in `.env`.

Create a service principal and assign it access at the subscription scope, because it must create and delete resource groups at that scope:

```sh
az ad sp create-for-rbac --name forge-provisioner --role Contributor --scopes /subscriptions/<subscription-id>
```

Copy `appId`, `password`, and `tenant` from the command output into `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_TENANT_ID`. Keep the secret out of source control. For a shared or production subscription, replace broad Contributor access with a custom role allowing only resource group read, write, and delete at the subscription scope. The scripts use the [resource group REST API](https://learn.microsoft.com/en-us/rest/api/resources/resource-groups/create-or-update) and [OAuth client credentials](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).

## GitHub organization setup

1. As an organization owner, create a repository custom property named `forge_project_id`. Use **Text string**, allow repository actors to set it, and do not require a default value. This property is written in the same [repository creation request](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository), so a retry can identify an earlier successful create. [GitHub custom property setup](https://docs.github.com/en/organizations/managing-organization-settings/managing-custom-properties-for-repositories-in-your-organization).
2. Create a GitHub App owned by the organization. Give it **Administration: read and write** and **Custom properties: read and write** repository permissions. Install it on **All repositories** so it can see repositories it creates. GitHub documents the [repository creation permission](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository) and [custom property permission](https://docs.github.com/en/rest/repos/custom-properties#create-or-update-custom-property-values-for-a-repository). The app must also be able to delete repositories during rollback.
3. Generate a private key for the app. Store the PEM outside the repository or under an ignored local path, set `GITHUB_APP_PRIVATE_KEY_PATH` to its absolute host path, and restrict file access. The file must be readable by UID 1001 inside the Semaphore container; grant that UID read access with a host ACL if the file is otherwise private. Set `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_ORG` in `.env`. The Semaphore container alone mounts the PEM. The script uses a signed [GitHub App JWT and installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app).

## Website admin group

Create an Entra security group for Forge admins and set its object ID as `FORGE_ADMIN_GROUP_ID`. In the existing Forge app registration, add a **groups** claim to the **ID token** that emits security group object IDs. Group members can see all projects and retry failures. [Microsoft group claims guidance](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles).

If a user's group list exceeds the ID-token limit, Entra emits an overage indicator instead of `groups`. This slice treats that user as a regular creator; use groups assigned to the application or a future Graph-backed check for such users. [Microsoft group overage guidance](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles#group-overages).

## Run

Copy `.env.example` to `.env`, fill the existing database, authentication, and Semaphore settings plus the provider settings above, then run `just up`. The Semaphore bootstrap registers four templates and writes its API connection file into a local Docker volume for the DBOS service. Browse to `http://localhost:5321` and create a test project.

Check `just logs` and the Semaphore UI at `http://localhost:3001` if a task fails. A failed project retains its code and activity log. An admin can correct credentials, permissions, or provider state manually and use **Try again**. There is no project deletion or retirement flow in this slice.
