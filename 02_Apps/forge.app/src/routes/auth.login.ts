import { createFileRoute } from "@tanstack/react-router";
import { beginLogin } from "@/lib/auth.server";

export const Route = createFileRoute("/auth/login")({
  server: { handlers: { GET: ({ request }) => beginLogin(request) } },
});
