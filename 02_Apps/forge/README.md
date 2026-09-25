# Forge app

TanStack Start app with server-side rendering, Tailwind CSS, and app-local shadcn/ui components built on Base UI.

From the repository root:

```sh
bun install
bun run dev
bun run ci
```

To run the production server locally:

```sh
bun run build
cd 02_Apps/forge
bun run start
```

The development server runs at http://localhost:5321. Add routes in `src/routes`; the generated `src/routeTree.gen.ts` is committed. Keep server-only helpers in `*.server.ts` files and expose them through `*.functions.ts` server functions when client code needs to call them. Only client-safe types and values belong in ordinary shared modules.

Add shadcn/ui components from this directory with `bunx shadcn@latest add <component>`. Components stay in `src/components/ui` until another app needs a shared UI package.
