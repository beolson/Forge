# Local Docker stack

This stack runs Forge's production build, PostgreSQL, Semaphore UI, and CloudBeaver.
PostgreSQL has separate `forge` and `semaphore` databases and users.

From the repository root:

```sh
cp .env.example .env
```

Set the empty passwords in the root `.env`. Use URL-safe characters (letters,
numbers, hyphens, or underscores) for `FORGE_DB_PASSWORD`, because Compose puts
it in a database URL. Generate
`SEMAPHORE_ACCESS_KEY_ENCRYPTION` with
`head -c32 /dev/urandom | base64` and keep it with the persisted Semaphore data.
The Semaphore admin account is created on first startup; changing the admin
password in `.env` later does not reset it.

```sh
just up
just ps
just logs
just down
```

To use Compose directly, prepare CloudBeaver's initial connection first:

```sh
python3 04_Infrastucture/local/write-cloudbeaver-seed.py
docker compose --env-file .env -f 04_Infrastucture/local/compose.yaml up --build -d --remove-orphans
```

Forge is at <http://localhost:5321>, Semaphore UI at
<http://localhost:3001>, CloudBeaver at <http://localhost:8081>, and PostgreSQL
is available on `localhost:5432`. CloudBeaver allows anonymous access for this
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
The Forge app receives `DATABASE_URL`, but does not yet use the database.
Compose stores PostgreSQL, Semaphore, and CloudBeaver data in named volumes. `just down`
keeps them; running the equivalent Compose `down -v` command deletes them.
Database creation runs only when the PostgreSQL volume is empty, so changing
database passwords in `.env` later also requires changing the passwords inside
PostgreSQL or recreating that volume.
