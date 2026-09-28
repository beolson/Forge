#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v forge_password="$FORGE_DB_PASSWORD" <<'SQL'
CREATE ROLE forge LOGIN PASSWORD :'forge_password';
CREATE DATABASE forge OWNER forge;
REVOKE CONNECT ON DATABASE forge FROM PUBLIC;
SQL
