# Forge

Bun workspaces for apps in `02_Apps/*` and libraries in `03_Libraries/*`.
Each package should have its own `package.json`. Use `workspace:*` for dependencies between local packages.

The Forge SSR app lives in [`02_Apps/forge`](02_Apps/forge/README.md).

```sh
bun install
bun run build
bun run dev
bun run test
bun run typecheck
bun run check
bun run format
bun run ci
```

`check` runs Biome's format and lint checks without writing files. `format` writes formatting changes. `ci` checks formatting and linting, runs package type checks and tests, then builds. Turbo runs package scripts for builds, development, tests, and type checks.
