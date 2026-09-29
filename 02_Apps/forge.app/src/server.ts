import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { ensureMessaging } from "./lib/projects.server";

void ensureMessaging().catch((error) => {
  console.error("Forge messaging startup:", error);
});

export default createServerEntry({
  fetch(request) {
    return handler.fetch(request);
  },
});
