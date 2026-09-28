# Local development with Aspire

The TypeScript AppHost runs Forge on the host with Bun and Vite hot reload. DBOS,
PostgreSQL, CloudBeaver, and the Service Bus emulator with SQL Server run in Docker.
DBOS continues launching isolated provisioning-task containers itself.

## Setup and commands

Use Aspire CLI **13.5.4**, Node.js **24 or newer**, Bun **1.3.14**, .NET SDK **10**,
Docker, and Python 3. The existing provisioner image requires Linux x86_64. Aspire
manages its TypeScript SDK and managed hosting dependencies. The AppHost remains
TypeScript; `Forge.Aspire.Hosting` is a small .NET adapter for dynamic task status
and console logs, which the generated TypeScript API does not fully expose.
The root start and restore commands check that the CLI matches the pinned version.

From the repository root:

```sh
cp .env.example .env
# Configure .env using docs/project-provisioning.md.
bun install
just aspire
# Equivalent: bun run aspire:start
```

Keep the existing Entra callback registration at
`http://localhost:5321/auth/callback`. Accept the emulator and SQL Server terms
linked in the [Compose README](../local/README.md) before setting
`SERVICEBUS_ACCEPT_EULA=Y`. The AppHost validates required configuration, session
secret length, task limits, and the readable absolute
GitHub App PEM path before starting resources. Process environment variables
override the root `.env`; secret parameters are marked as secrets in Aspire.
Aspire URL-encodes the database password in connection strings. Keep using
URL-safe passwords when also running the existing Compose fallback.

The dashboard is at `http://localhost:15100`; use the authenticated login link
printed by Aspire. Forge remains at `http://localhost:5321`, CloudBeaver at
`http://localhost:8081`, PostgreSQL at `localhost:5432`, and Service Bus at
`localhost:5672` with health at `http://localhost:5300/health`. These endpoints bind
to localhost. The dashboard and internal resource transport use HTTP locally.

```sh
aspire describe
aspire logs forge-app
aspire logs forge-orchistrator
aspire resource forge-orchistrator restart
aspire stop
```

Ctrl+C also stops a foreground AppHost. Startup/status and console logs are
available in the dashboard; application traces and metrics need separate
OpenTelemetry instrumentation.

## Startup and persistent data

The main app entries use the repository names with Aspire-compatible hyphens:
`forge-app`, `forge-orchistrator`, and `forge-provisioner`. The provisioner entry
observes DBOS-owned task containers; DBOS still launches individual tasks. Its
image, network and
credential setup jobs are grouped beneath it. SQL Server is grouped beneath the
Service Bus emulator, and database/UI setup jobs beneath their dependencies.

Successful setup jobs disappear from the default list; failed jobs remain visible
for troubleshooting. Use the dashboard's hidden-resource filter or
`aspire describe --include-hidden` to inspect completed jobs and parameters.
Configuration parameters are hidden. Forge runs its existing Bun/Vite dev script
directly, so Aspire does not generate an unused package installer.
DBOS starts after both dependencies are ready and its setup jobs succeed. Forge
starts after PostgreSQL and Service Bus are ready. Inspect a failed setup job's
logs when its dependents remain waiting.

## Provisioner task visibility

Expand `forge-provisioner` in the dashboard to see each task's status and console
logs. New runs include the project code, task ID, and stable run ID in their name;
details include the project and task attempts, provider, operation, and pinned
image. Earlier containers without those labels remain visible by run ID. The
parent shows active and retained task counts.

The observer polls Docker every two seconds using GET requests only. It discovers
retained containers on startup, so tasks completed while Aspire was stopped also
appear. Finished tasks remain visible until DBOS prunes their containers. Docker
outages show unavailable/unknown states and observation retries automatically.
There are no start/stop/restart actions on observed tasks; DBOS owns their lifecycle.

Console logs start with the last 200 Docker log lines on attachment, then stream
new output without replaying overlap. Only the executor's redacted JSON records
are forwarded. Container environment variables and credential mounts are not
copied into task details. The full durable log archive remains in Forge's admin
run view; Aspire's console history is temporary.

Aspire 13.5.4's one-shot `aspire describe` lists the static application model and
omits dynamically observed tasks. The dashboard and `aspire describe --follow`
use the resource event stream and include them.

The AppHost reuses these existing Compose volumes:

| Volume | Contents |
| --- | --- |
| `forge-local_postgres_data` | Forge database and durable DBOS state |
| `forge-local_cloudbeaver_data` | CloudBeaver workspace and saved connection |
| `forge-local-runner-data` | Runner versions, recovery records, output and outbox |
| `forge-local-runner-credentials` | Provider credentials and GitHub App PEM |

Database initialization runs only for an empty PostgreSQL volume. CloudBeaver's
initial connection is seeded only when absent; existing saved credentials still
need updating manually after changing a database password.

Aspire builds `forge-provisioner:local` before starting DBOS. Task attempts pin the
image ID exactly as before. Aspire stop preserves volumes, built/pinned images,
the `forge-local_default` runner network, and DBOS-managed task containers.
Tasks may finish while the AppHost is stopped; DBOS observes their retained output
when restarted. Preserve that data and those containers for recovery and retries.

## Compose fallback

Run only one stack at a time because ports and volumes are shared. The preflight
job detects running Forge Compose containers and asks you to stop them first.

```sh
# Switch from Compose to Aspire, preserving volumes.
just down
just aspire

# Switch from Aspire to Compose, preserving volumes.
aspire stop
just up
```

## Checks and generated files

The AppHost is a standalone Bun package outside the Turbo workspaces. Aspire
restores its dependencies and generates `.aspire/modules/`; those generated
modules are ignored by Git and Biome. Do not edit them.

```sh
bun run aspire:restore
bun run aspire:build
bun run aspire:test
bun run ci
```

`aspire:build` restores dependencies and SDK modules before typechecking and
compiling. `aspire:test` also runs the .NET adapter harness against a fake Docker
API and real Aspire resource and console-log services. These checks do not start
Docker resources or require a configured
`.env`. Azure deployment and application instrumentation are separate follow-ups.
