import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/admin/runs/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { requireAdmin, subscribeRuns } = await import(
          "@/lib/runs.server"
        );
        const { ensureMessaging } = await import("@/lib/projects.server");
        try {
          await requireAdmin();
        } catch {
          return new Response("Forbidden", { status: 403 });
        }
        await ensureMessaging();
        const runId = new URL(request.url).searchParams.get("runId");
        if (runId && !/^[a-f0-9]{32}$/.test(runId))
          return new Response("Invalid run ID", { status: 400 });
        const { eventResponse } = await import("@/lib/events.server");
        return eventResponse(request, (send) =>
          subscribeRuns((event) => {
            if (!runId || event.runId === runId) send(event);
          }),
        );
      },
    },
  },
});
