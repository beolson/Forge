import { createServerFn } from "@tanstack/react-start";

function id(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value))
    throw new Error("Invalid run ID");
  return value;
}
export const getRuns = createServerFn({ method: "GET" })
  .validator((value: { offset: number }) => {
    if (
      !Number.isInteger(value.offset) ||
      value.offset < 0 ||
      value.offset > 1_000_000
    )
      throw new Error("Invalid run page");
    return value;
  })
  .handler(async ({ data }) =>
    (await import("./runs.server")).listRuns(data.offset),
  );
export const getRun = createServerFn({ method: "GET" })
  .validator((value: { id: string }) => ({ id: id(value.id) }))
  .handler(async ({ data }) =>
    (await import("./runs.server")).runDetail(data.id),
  );
export const getRunLogs = createServerFn({ method: "GET" })
  .validator((value: { id: string; after: number }) => {
    if (!Number.isSafeInteger(value.after) || value.after < 0)
      throw new Error("Invalid log cursor");
    return { id: id(value.id), after: value.after };
  })
  .handler(async ({ data }) =>
    (await import("./runs.server")).runLogs(data.id, data.after),
  );
export const getTaskCatalog = createServerFn({ method: "GET" }).handler(
  async () => (await import("./runs.server")).taskCatalog(),
);
