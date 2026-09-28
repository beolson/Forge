# Local Docker stack

The stack runs the Forge production website, separate DBOS orchestrator,
PostgreSQL, CloudBeaver, and Microsoft's Service Bus emulator with SQL Server.
DBOS launches an isolated Docker container for each provisioning or deletion task.
There is no Semaphore service.

## Setup

From the repository root:

```sh
cp .env.example .env
```

Fill the passwords and complete the Azure, GitHub provisioning App, and Entra admin-group instructions in
[project-provisioning.md](../../docs/project-provisioning.md).
Use URL-safe characters for `FORGE_DB_PASSWORD`, which is part of a database URL.
Set a strong `SERVICEBUS_SQL_PASSWORD`. Read the
[emulator terms](https://github.com/Azure/azure-service-bus-emulator-installer/blob/main/EMULATOR_EULA.txt)
and [SQL Server Linux terms](https://go.microsoft.com/fwlink/?LinkId=746388), then
set `SERVICEBUS_ACCEPT_EULA=Y` if you accept both. The emulator needs 2 GB RAM and
5 GB free disk in addition to the rest of the stack.

The runner image pins Azure CLI and Bicep versions and targets Linux x86_64.
`runner-image` builds the image and exits. `runner-credentials` seeds a private
volume with the existing service-principal and provisioning GitHub App credentials.
Only privileged task containers mount that volume. Changing provider values and
running `just up` reseeds credentials; the PEM is not baked into an image.

The orchestrator mounts the local Docker socket, giving it control over the Docker
host. Run this development stack on a trusted development machine. Each task uses
its pinned image with packaged scripts and templates, a private writable temporary directory,
and no restart policy. The restricted project runner profile is reserved for later
project deployments and receives no credentials in this slice.

The TypeScript provisioner lives in `02_Apps/forge.provisioner`. The image includes
whatever code, templates, and task configuration are in that folder when built.
No runtime source download is required. The orchestrator pins the immutable image
ID for every attempt; rebuild to change future attempts.

```sh
just up
just ps
just logs
just down
```

With Compose directly, prepare the CloudBeaver connection first:

```sh
python3 04_Infrastructure/local/write-cloudbeaver-seed.py
docker compose --env-file .env -f 04_Infrastructure/local/compose.yaml up --build -d --remove-orphans
```

## Endpoints and administration

- Forge: <http://localhost:5321>
- Admin provisioning runs: <http://localhost:5321/admin/runs>
- Admin task configuration: <http://localhost:5321/admin/tasks>
- CloudBeaver: <http://localhost:8081>
- PostgreSQL: `localhost:5432`
- Service Bus AMQP: `localhost:5672`; health: <http://localhost:5300/health>

The emulator has `forge-requests` and `forge-results` queues. For host applications:

```text
Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;
```

Inside Compose replace `localhost` with `servicebus-emulator`. The emulator's fixed
key is for local development and does not support Entra authentication. Queue
configuration changes require an emulator restart; its messages do not survive
restarts. The website's project outbox and the runner's acknowledged event outbox
provide replay. The first stack uses one web instance for SSE fanout.

Creators see their own project progress and status. Admins can see every run,
parameters, pinned image IDs, and redacted live stdout/stderr. Logs default to 90-day
retention (`RUNNER_LOG_RETENTION_DAYS`); summaries and versions remain. Each task
has three total attempts and a default 30-minute timeout
(`RUNNER_TASK_TIMEOUT_MS`).

## Persistent data

PostgreSQL holds the `forge` database, including DBOS's durable workflow schema.
`runner_data` stores pinned image versions and task catalogs, recovery records, redacted log
archives, and unacknowledged run events. `runner_credentials` stores provider secrets. Task containers are
retained until completed output is captured and their retention period expires.
Preserve runner data and pinned images to allow later deletion/admin retry.

`just down` preserves named volumes. Tasks launched by DBOS are separate from
Compose services and may finish while DBOS is stopped; DBOS recovers them on restart.
Do not remove task containers before their outcome is recorded. The new TypeScript contract assumes a clean start and does not resume or migrate
legacy runner records or workflows. Before running this version, use a fresh local
PostgreSQL database, DBOS state, and runner-data volume. Database initialization
runs only for an empty PostgreSQL volume. This change does not erase existing data.

CloudBeaver permits anonymous access on this localhost-only stack. Its initial
connection uses PostgreSQL's local admin account. The admin login is `forgeadmin`
with `CLOUDBEAVER_ADMIN_PASSWORD`. `just up` writes an ignored
`.cloudbeaver-seed.json`; the CloudBeaver workspace contains the local database
password. Password changes after the first startup require changing the stored
settings as well. Database initialization runs only for an empty PostgreSQL volume.
