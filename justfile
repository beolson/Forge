compose := "docker compose --env-file .env -f 04_Infrastructure/local/compose.yaml"

default:
    @just --list

# Start the preferred local development stack with the Aspire dashboard.
aspire:
    bun run aspire:start

# Build and start the local stack.
up:
    @test -f .env || (echo "Copy .env.example to .env and set its secrets first." >&2; exit 1)
    @python3 04_Infrastructure/local/write-cloudbeaver-seed.py
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
