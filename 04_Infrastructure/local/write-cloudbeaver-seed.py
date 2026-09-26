"""Prepare CloudBeaver's initial PostgreSQL connection from the root .env."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read_password() -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("POSTGRES_PASSWORD="):
            password = line.partition("=")[2].strip().strip('"\'')
            if password:
                return password
    raise SystemExit("Set POSTGRES_PASSWORD in the root .env file first.")


seed = {
    "folders": {},
    "connections": {
        "forge-local-postgres": {
            "provider": "postgresql",
            "driver": "postgres-jdbc",
            "name": "Local PostgreSQL",
            "save-password": True,
            "configuration": {
                "host": "postgres",
                "port": "5432",
                "database": "postgres",
                "configurationType": "MANUAL",
                "type": "dev",
                "provider-properties": {"@dbeaver-show-non-default-db@": "true"},
                "auth-model": "native",
                "auth-properties": {
                    "userName": "postgres",
                    "userPassword": read_password(),
                },
            },
        }
    },
}

output = ROOT / ".cloudbeaver-seed.json"
output.touch(mode=0o600, exist_ok=True)
output.chmod(0o600)
output.write_text(json.dumps(seed, indent=2) + "\n")
