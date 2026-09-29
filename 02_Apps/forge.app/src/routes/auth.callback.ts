import { createFileRoute } from "@tanstack/react-router";
import { finishLogin } from "@/lib/auth.server";

export const Route = createFileRoute("/auth/callback")({
  server: { handlers: { GET: ({ request }) => finishLogin(request) } },
});
