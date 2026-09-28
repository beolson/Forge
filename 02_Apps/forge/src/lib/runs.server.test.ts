// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  session: {
    user: {
      tenantId: "tenant",
      objectId: "creator",
      name: "Creator",
      groups: [] as string[],
    },
    expiresAt: Date.now() + 60_000,
  },
}));
vi.mock("@tanstack/react-start/server", () => ({
  useSession: async () => ({ data: mocks.session }),
}));
vi.mock("pg", () => ({
  Pool: class {
    query = mocks.query;
  },
}));
vi.mock("@azure/service-bus", () => ({
  ServiceBusClient: class {
    createReceiver() {
      return { subscribe() {} };
    }
    createSender() {
      return { sendMessages: async () => {} };
    }
  },
}));

import { listProjects } from "./projects.server";
import { listRuns, runDetail, runLogs, taskCatalog } from "./runs.server";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FORGE_ENTRA_TENANT_ID = "tenant";
  process.env.FORGE_SESSION_SECRET = "0123456789abcdefghijklmnopqrstuv";
  process.env.FORGE_AUTH_REDIRECT_URI = "http://localhost:5321/auth/callback";
  process.env.FORGE_ADMIN_GROUP_ID = "admins";
  process.env.SERVICEBUS_CONNECTION_STRING = "emulator";
  mocks.session.user.groups = [];
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM forge_projects WHERE"))
      return {
        rows: [
          {
            id: "e513e0da-08e4-4f64-a111-bb6bb9cfdc38",
            code: "ABCDE",
            name: "Example",
            description: "Example",
            repository_name: "gh-abcde-example",
            resource_group_name: "az-abcde-resgp",
            status: "failed",
            attempt: 1,
            error: "PRIVATE_PROVIDER_DIAGNOSTIC",
            created_at: "2026-09-27T12:00:00Z",
          },
        ],
      };
    if (sql.includes("FROM forge_project_events"))
      return {
        rows: [
          {
            id: "1",
            project_id: "e513e0da-08e4-4f64-a111-bb6bb9cfdc38",
            status: "provisioning",
            resource: "github",
            detail: "GitHub repository task attempt failed.",
            admin_detail: "PRIVATE_PROVIDER_DIAGNOSTIC",
          },
        ],
      };
    return { rows: [], rowCount: 0 };
  });
});
test("creators receive project progress without provider diagnostics", async () => {
  const result = await listProjects();
  expect(result.admin).toBe(false);
  expect(result.projects[0].events[0].detail).toBe(
    "GitHub repository task attempt failed.",
  );
  expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
});
test("administrators can see the diagnostic associated with project progress", async () => {
  mocks.session.user.groups = ["admins"];
  const result = await listProjects();
  expect(result.admin).toBe(true);
  expect(result.projects[0].events[0].detail).toBe(
    "PRIVATE_PROVIDER_DIAGNOSTIC",
  );
});
test("creators cannot retrieve run metadata, logs, or script contents", async () => {
  await expect(listRuns(0)).rejects.toThrow("Only Forge admins");
  await expect(runDetail("a".repeat(32))).rejects.toThrow("Only Forge admins");
  await expect(runLogs("a".repeat(32), 0)).rejects.toThrow("Only Forge admins");
  await expect(taskCatalog()).rejects.toThrow("Only Forge admins");
  expect(mocks.query).not.toHaveBeenCalled();
});
