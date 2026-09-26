# Local Docker stack

This stack runs Forge's production build, its DBOS orchestrator, PostgreSQL, Semaphore UI, CloudBeaver,
and Microsoft's Azure Service Bus emulator with its SQL Server dependency.
PostgreSQL has separate `forge` and `semaphore` databases and users.
`just up` also creates a `Forge local` project in Semaphore with a repository
pointing at the local [`../semaphore`](../semaphore) folder. That folder is
mounted read-only at `/opt/forge/semaphore` in the Semaphore container, so edits
to its scripts and other files are available without rebuilding the image.
The setup step is safe to run again and keeps an existing local project.
It also registers the four project creation and rollback templates and shares a
Semaphore API token with the DBOS container through a local Docker volume.
Open the `Forge local` project, select **Task Templates**, and run **Verify local
scripts**. A successful task prints `Forge local Semaphore script ran successfully.`
in its log.

From the repository root:

```sh
cp .env.example .env
```

Set the empty passwords in the root `.env`. Use URL-safe characters (letters,
numbers, hyphens, or underscores) for `FORGE_DB_PASSWORD`, because Compose puts
it in a database URL. Generate
`SEMAPHORE_ACCESS_KEY_ENCRYPTION` with
`head -c32 /dev/urandom | base64` and keep it with the persisted Semaphore data.
Set a strong `SERVICEBUS_SQL_PASSWORD`. Read the
[Service Bus emulator terms](https://github.com/Azure/azure-service-bus-emulator-installer/blob/main/EMULATOR_EULA.txt)
and [SQL Server Linux terms](https://go.microsoft.com/fwlink/?LinkId=746388),
then set `SERVICEBUS_ACCEPT_EULA=Y` if you accept both. The Microsoft emulator
requires 2 GB of RAM and 5 GB of free disk space in addition to the rest of
the stack.
The Semaphore admin account is created on first startup; changing the admin
password in `.env` later does not reset it.
For real project provisioning, complete the Azure service principal, GitHub App,
and Entra admin group steps in [project-provisioning.md](../../docs/project-provisioning.md)
before starting the stack. A project submission creates real Azure and GitHub
resources in the configured subscription and organization.

```sh
just up
just ps
just logs
just down
```

To use Compose directly, prepare CloudBeaver's initial connection first:

```sh
python3 04_Infrastructure/local/write-cloudbeaver-seed.py
docker compose --env-file .env -f 04_Infrastructure/local/compose.yaml up --build -d --remove-orphans
```

Forge is at <http://localhost:5321>, Semaphore UI at
<http://localhost:3001>, CloudBeaver at <http://localhost:8081>, and PostgreSQL
is available on `localhost:5432`. The Service Bus emulator listens on
`localhost:5672`; its health endpoint is <http://localhost:5300/health>.
It starts with `forge-requests` and `forge-results` queues. For an application
running on the host, use:

```text
Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;
```

For another container in this Compose stack, replace `localhost` with
`servicebus-emulator`. The emulator uses its fixed development key; do not use
this connection string for Azure. It does not support Entra authentication,
and messages are cleared when the emulator restarts. Queue changes in
`servicebus-config.json` also require restarting the emulator.

CloudBeaver allows anonymous access for this
localhost-only development stack. Open its "Local PostgreSQL" connection to
browse both the `forge` and `semaphore` databases. The connection uses PostgreSQL's
local admin account and has "Show all databases" enabled. CloudBeaver's admin login is `forgeadmin` with
`CLOUDBEAVER_ADMIN_PASSWORD` from the root `.env`.

`just up` writes an ignored root `.cloudbeaver-seed.json` from `.env`. The init
container copies it into CloudBeaver's named workspace volume on first startup.
The generated seed and CloudBeaver workspace contain the local PostgreSQL admin
password, so keep them on this development machine. Changing the PostgreSQL
password or CloudBeaver admin password later requires updating the stored settings
or recreating only the `cloudbeaver_data` volume.
The Forge app stores projects, activity, and its Service Bus outbox in the `forge`
database. DBOS stores its durable workflow state in the same database under its
own schema.
Compose stores PostgreSQL, Semaphore, and CloudBeaver data in named volumes. `just down`
keeps them; running the equivalent Compose `down -v` command deletes them.
Database creation runs only when the PostgreSQL volume is empty, so changing
database passwords in `.env` later also requires changing the passwords inside
PostgreSQL or recreating that volume.
