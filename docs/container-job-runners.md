# Container job runners

## Agreed scope

The website submits project requests through Service Bus. A separate DBOS service
owns orchestration and dispatches individual executions directly. There is no
additional dispatcher or command queue between DBOS and the runners.

The first delivery uses Docker locally and provisions real Azure resource groups
and private, empty GitHub repositories. Azure Container Apps deployment is a later
delivery; its jobs will use the Manual trigger type.

There are two runner profiles: `privileged` and `project`. The existing Azure and
GitHub create and rollback tasks use the privileged profile. The project profile
is reserved for later resource-group deployments. Creating project service
principals, Key Vault credentials, and Entra resources is deferred until those
tasks are introduced. A project principal's Azure RBAC assignments, rather than
the token audience or CLI target, will restrict it to its resource group.

## Execution and recovery

Tasks are defined by a manifest in the Forge repository. Source is loaded from
`main` using a separate GitHub App with Contents read permission installed only
on this repository. The workflow records the exact source commit and runner image
ID before execution. Local development can explicitly select a filesystem source
snapshot; this mode is identified in the admin UI and does not represent a GitHub
commit. Production source is always GitHub.

Each task has a stable run ID and Docker container name. Recovery inspects that
container before creating or starting anything. Containers and their logs remain
until a terminal run has been recorded and the configured retention period has
elapsed. An unavailable execution is treated as uncertain, never blindly retried.
Each local execution writes a durable, redacted JSONL log file before forwarding
output to Docker. DBOS reads this file independently of Docker log rotation, so
an orchestrator outage cannot rotate away uncaptured diagnostics. Local disk must
accommodate output until retention removes completed log files and containers.
Long lines are redacted in full before being split into bounded records.

Azure and GitHub creation remain parallel. DBOS allows three total attempts for
each task, with a configurable timeout defaulting to 30 minutes. The runner has no
independent retry policy. Automatic retries and rollback use the original source
snapshot and image. An admin retry first cleans up with the preceding attempt's
versions, then resolves current approved versions for fresh creation.

Nonsecret subscription, region, and GitHub organization are recorded with each
version. Cleanup keeps the original targets even if system configuration changes.

Creation adopts only resources with matching Forge ownership. Rollback is a
separate task and deletes only matching resources. Uncertain execution or failed
cleanup remains visible for admin investigation and retry. Retirement and project
deletion are outside this slice.

## Credentials and trust

The website receives no provisioning credentials. Local provider credentials are
seeded into a dedicated Docker volume and mounted only into privileged task
containers. Source access uses a separate read-only GitHub App. Credentials never
appear in task manifests, parameters, or Service Bus messages.

DBOS is a trusted launcher. Access to the local Docker socket confers host-level
control; future Container Apps job-start permission also permits using job secrets
and identities. In Azure, project credentials will be injected using selected
Key Vault secret references, with the vault identity unavailable to script code.

## Visibility

Creators see their own projects, progress, and status. Admins see all projects,
task definitions, the exact scripts used, parameters, individual attempts,
execution statuses, and full live logs. Script editing happens in GitHub.

Execution records and log batches travel through Service Bus. The website saves
them before notifying browsers over SSE. Reconnects reload saved state. Neither a
browser disconnect nor a logging outage triggers rollback. Workflow progress is
separate from provider diagnostics so creator APIs cannot expose admin logs.

Detailed logs are retained for a configurable 90 days by default. Run summaries,
parameters, versions, and outcomes remain. The new UI displays only new runs; no
Semaphore history is imported.
