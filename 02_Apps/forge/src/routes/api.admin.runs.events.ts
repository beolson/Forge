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
        const encoder = new TextEncoder();
        let unsubscribe = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let closed = false;
        const cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
        };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (value: object) => {
              if (!closed)
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
                );
            };
            unsubscribe = subscribeRuns((event) => {
              if (!runId || event.runId === runId) send(event);
            });
            send({ ready: true });
            heartbeat = setInterval(() => {
              if (!closed)
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
            }, 15_000);
            request.signal.addEventListener(
              "abort",
              () => {
                cleanup();
                controller.close();
              },
              { once: true },
            );
            if (request.signal.aborted) {
              cleanup();
              controller.close();
            }
          },
          cancel: cleanup,
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
