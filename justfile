compose := "docker compose --env-file .env -f 04_Infrastucture/local/compose.yaml"

default:
    @just --list

# Build and start the local stack.
up:
    @test -f .env || (echo "Copy .env.example to .env and set its secrets first." >&2; exit 1)
    @python3 04_Infrastucture/local/write-cloudbeaver-seed.py
    {{compose}} up --build -d --remove-orphans

# Stop the local stack while keeping its data volumes.
down:
    {{compose}} down

# Show local service status.
ps:
    {{compose}} ps

# Follow local service logs.
logs:
    {{compose}} logs -f
