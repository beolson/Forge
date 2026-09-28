# Forge provisioner

This app is the short-lived container that applies Forge infrastructure. Bun runs
all TypeScript code. Build from the repository root:

```sh
docker build -f 02_Apps/forge.provisioner/Dockerfile -t forge-provisioner:local .
```

The build bundles the executor and two handlers, then packages the task catalog
and resources into the image. The orchestrator pins the image ID and reads its
catalog before launching tasks. Code and templates are changed by rebuilding.

## Handler interfaces

`bicep.ts` accepts either:

```text
bun scripts/bicep.ts deploy resources/<file>.bicep '<JSON arguments>'
bun scripts/bicep.ts delete '<JSON ownership>'
```

Deployment arguments have `scope: "subscription"`, `deploymentName`, `location`,
`parameters`, and `ownership: { resourceGroup, projectId }`. Values in `parameters`
can be strings, numbers, arrays, or objects. The script verifies the target group's
ownership, then deploys every time. Delete verifies ownership and waits for the
group to disappear. An absent group succeeds. Template paths must remain within
the packaged resources directory, including after resolving symlinks.

`github.ts` accepts `create` or `delete` followed by a JSON project request:

```text
bun scripts/github.ts create '<JSON project>'
bun scripts/github.ts delete '<JSON project>'
```

It validates the project and repository name, authenticates as a GitHub App, and
requires a private repository with the matching `forge_project_id` property before
adopting or deleting it.

## Executor contract

The manager mounts `task.json`, `arguments.json`, `request.json`, and `settings.json`
read-only at `/workspace`. The executor checks the task against the packaged
`tasks.json`, injects only that provider's credentials from
`/run/secrets/forge/providers.json`, and overrides targets with pinned settings.
GitHub's key is mounted at `/run/secrets/forge/github-app.pem`. Secrets stay out of
task configuration and messages.

Compiled handlers run from `/opt/forge/scripts/*.js`. The executor forwards signals
to the complete handler process group, drains both output streams, and preserves
provider exit status. Redacted JSONL records are bounded to 8192 UTF-8 bytes and
fsynced to `/run/forge-output/logs.jsonl`; logging failure preserves the task result.

```sh
bun run typecheck
bun run test
bun run build
```

The tests use fake Azure CLI commands and GitHub responses; they do not provision
resources. See [setup](../../docs/project-provisioning.md) and the
[execution design](../../docs/container-job-runners.md). This version assumes a
clean start and provides no legacy Python/Bash workflow migration.
