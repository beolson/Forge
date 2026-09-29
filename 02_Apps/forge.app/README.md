# Forge app

TanStack Start app with server-side rendering, Tailwind CSS, and app-local shadcn/ui components built on Base UI.

From the repository root:

```sh
bun install
just aspire
bun run ci
```

To run the production server locally:

```sh
bun run build
cd 02_Apps/forge.app
bun run start
```

The development server runs at http://localhost:5321. [Aspire](../../04_Infrastructure/aspire/README.md) starts its database, messaging dependencies, and containerized DBOS worker. `bun run dev` still starts workspace development scripts when dependencies are managed separately. Add routes in `src/routes`; the generated `src/routeTree.gen.ts` is committed. Keep server-only helpers in `*.server.ts` files and expose them through `*.functions.ts` server functions when client code needs to call them. Only client-safe types and values belong in ordinary shared modules.

## Microsoft sign-in

Create a Microsoft Entra app registration with **Accounts in this organizational directory only** and a **Web** redirect URI of `http://localhost:5321/auth/callback`. Create a client secret. Copy the repository-root `.env.example` to `.env` and set `FORGE_ENTRA_TENANT_ID` (Directory ID), `FORGE_ENTRA_CLIENT_ID` (Application ID), `FORGE_ENTRA_CLIENT_SECRET` (secret **value**), and a random `FORGE_SESSION_SECRET` of at least 32 characters. Leave `FORGE_AUTH_REDIRECT_URI` at its local default. Run `just aspire` from the repository root, or `just up` for the Compose fallback. The root `.env` is ignored by Git.

For another environment, register its HTTPS `/auth/callback` URI and set `FORGE_AUTH_REDIRECT_URI` and the other variables in that environment's secret configuration. Keep the session secret stable across app replicas and restarts. Forge accepts tenant members and guests, stores no Microsoft access or refresh tokens, and clears only its own session on sign-out. Future private server functions and routes must call `currentUser()` and reject unauthenticated requests; the page guard is for navigation and rendering.

Add shadcn/ui components from this directory with `bunx shadcn@latest add <component>`. Components stay in `src/components/ui` until another app needs a shared UI package.
