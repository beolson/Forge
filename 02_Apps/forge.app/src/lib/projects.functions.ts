import type { ProjectInput } from "@hero4hire/project";
import { createServerFn } from "@tanstack/react-start";

export const getProjects = createServerFn({ method: "GET" }).handler(
  async () => {
    const { listProjects } = await import("./projects.server");
    return listProjects();
  },
);

export const submitProject = createServerFn({ method: "POST" })
  .validator((value: ProjectInput) => value)
  .handler(async ({ data }) => {
    const { createProject } = await import("./projects.server");
    return createProject(data);
  });

export const retryFailedProject = createServerFn({ method: "POST" })
  .validator((value: { id: string }) => value)
  .handler(async ({ data }) => {
    const { retryProject } = await import("./projects.server");
    await retryProject(data.id);
    return { ok: true };
  });
