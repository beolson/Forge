import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/projects/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireUser, database, ensureMessaging, subscribeProjects } =
          await import("@/lib/projects.server");
        const { isAdmin } = await import("@/lib/auth.server");
        let user: Awaited<ReturnType<typeof requireUser>>;
        try {
          user = await requireUser();
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }
        await ensureMessaging();
        const admin = isAdmin(user);
        const { eventResponse } = await import("@/lib/events.server");
        return eventResponse(request, (send, close) =>
          subscribeProjects(async (projectId) => {
            try {
              const found = await (await database()).query(
                "SELECT 1 FROM forge_projects WHERE id=$1 AND ($2::boolean OR (creator_tenant_id=$3 AND creator_object_id=$4))",
                [projectId, admin, user.tenantId, user.objectId],
              );
              if (found.rowCount) send({ projectId });
            } catch {
              close();
            }
          }),
        );
      },
    },
  },
});
