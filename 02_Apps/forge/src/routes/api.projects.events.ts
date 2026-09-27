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
        const encoder = new TextEncoder();
        let unsubscribe = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            const send = (data: string) => {
              if (!closed)
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            };
            const close = () => {
              if (closed) return;
              closed = true;
              unsubscribe();
              if (heartbeat) clearInterval(heartbeat);
              controller.close();
            };
            unsubscribe = subscribeProjects(async (projectId) => {
              try {
                const found = await (await database()).query(
                  "SELECT 1 FROM forge_projects WHERE id=$1 AND ($2::boolean OR (creator_tenant_id=$3 AND creator_object_id=$4))",
                  [projectId, admin, user.tenantId, user.objectId],
                );
                if (found.rowCount) send(JSON.stringify({ projectId }));
              } catch {
                close();
              }
            });
            send(JSON.stringify({ ready: true }));
            heartbeat = setInterval(() => {
              if (!closed)
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
            }, 15000);
            request.signal.addEventListener("abort", close, { once: true });
          },
          cancel() {
            unsubscribe();
            if (heartbeat) clearInterval(heartbeat);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
