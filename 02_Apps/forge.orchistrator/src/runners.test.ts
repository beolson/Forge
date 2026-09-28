import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceBusSender } from "@azure/service-bus";
import type { ExecutionVersion, RunEvent } from "@hero4hire/automation";
import type { ProjectRequest } from "@hero4hire/project";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

let directory: string;
let server: Server;
let runners: typeof import("./runners");
const containers = new Map<
  string,
  {
    Config: { Image: string; Labels: Record<string, string> };
    State: {
      Status: string;
      Running: boolean;
      ExitCode: number;
      StartedAt: string;
      FinishedAt: string;
    };
  }
>();
let creates = 0;
let starts = 0;
let loseCreate = false;
let loseStart = false;
let catalogInspections = 0;
const request: ProjectRequest = {
  kind: "create-project",
  projectId: "e513e0da-08e4-4f64-a111-bb6bb9cfdc38",
  attempt: 1,
  code: "ABCDE",
  name: "Example",
  description: "Example project",
  repositoryName: "gh-abcde-example",
};
const version: ExecutionVersion = {
  settings: {
    azureSubscriptionId: "test-subscription",
    azureRegion: "eastus",
    githubOrganization: "example",
  },
  image: `sha256:${"a".repeat(64)}`,
  manifest: {
    version: 1,
    tasks: [
      {
        id: "azure-create",
        name: "Create group",
        runner: "privileged",
        resource: "azure",
        operation: "Create",
        runtime: "bun",
        entrypoint: "scripts/bicep.js",
        action: "deploy",
        bicepFile: "resources/project-resource-group.bicep",
      },
      {
        id: "azure-delete",
        name: "Delete group",
        runner: "privileged",
        resource: "azure",
        operation: "Delete",
        runtime: "bun",
        entrypoint: "scripts/bicep.js",
        action: "delete",
      },
      {
        id: "github-create",
        name: "Create repository",
        runner: "privileged",
        resource: "github",
        operation: "Create",
        runtime: "bun",
        entrypoint: "scripts/github.js",
        action: "create",
      },
      {
        id: "github-delete",
        name: "Delete repository",
        runner: "privileged",
        resource: "github",
        operation: "Delete",
        runtime: "bun",
        entrypoint: "scripts/github.js",
        action: "delete",
      },
    ],
  },
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-runners-"));
  process.env.RUNNER_DATA_DIRECTORY = directory;
  process.env.DOCKER_SOCKET = join(directory, "docker.sock");
  server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://docker");
    const path = url.pathname.replace("/v1.45", "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const respond = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path.startsWith("/images/")) return respond({ Id: version.image });
    if (
      path === "/containers/create" &&
      url.searchParams.get("name")?.startsWith("forge-catalog-")
    ) {
      const name = url.searchParams.get("name") as string;
      expect(body.Image).toBe(version.image);
      expect(body.HostConfig.NetworkMode).toBe("none");
      expect(body.HostConfig.Mounts).toBeUndefined();
      catalogInspections++;
      containers.set(name, {
        Config: { Image: body.Image, Labels: {} },
        State: {
          Status: "created",
          Running: false,
          ExitCode: 0,
          StartedAt: "",
          FinishedAt: "",
        },
      });
      return respond({ Id: name }, 201);
    }
    if (path === "/containers/create") {
      expect(body.HostConfig.LogConfig).toEqual({
        Type: "json-file",
        Config: { "max-size": "20m", "max-file": "2", mode: "blocking" },
      });
      expect(body.HostConfig.Mounts).toContainEqual({
        Type: "volume",
        Source: "forge-local-runner-data",
        Target: "/run/forge-output",
        VolumeOptions: {
          Subpath: `runs/${url.searchParams.get("name")?.replace("forge-run-", "")}/output`,
        },
      });
      const name = url.searchParams.get("name") || "";
      if (containers.has(name)) return respond({}, 409);
      creates++;
      containers.set(name, {
        Config: { Image: body.Image, Labels: body.Labels },
        State: {
          Status: "created",
          Running: false,
          ExitCode: 0,
          StartedAt: "0001-01-01T00:00:00Z",
          FinishedAt: "0001-01-01T00:00:00Z",
        },
      });
      if (loseCreate) {
        loseCreate = false;
        req.socket.destroy();
        return;
      }
      return respond({ Id: name }, 201);
    }
    const name = path.split("/")[2];
    const container = containers.get(name);
    if (!container) return respond({}, 404);
    if (req.method === "DELETE") {
      containers.delete(name);
      return respond(null);
    }
    if (name.startsWith("forge-catalog-")) {
      if (path.endsWith("/start")) return respond(null);
      if (path.endsWith("/wait")) return respond({ StatusCode: 0 });
      if (path.endsWith("/logs")) {
        const payload = Buffer.from(JSON.stringify(version.manifest));
        const header = Buffer.alloc(8);
        header[0] = 1;
        header.writeUInt32BE(payload.length, 4);
        res.end(Buffer.concat([header, payload]));
        return;
      }
    }
    if (path.endsWith("/json")) return respond(container);
    if (path.endsWith("/start")) {
      starts++;
      container.State.Status = "running";
      container.State.Running = true;
      container.State.StartedAt = "2026-09-27T12:00:00Z";
      if (loseStart) {
        loseStart = false;
        req.socket.destroy();
        return;
      }
      return respond(null);
    }
    return respond({}, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(process.env.DOCKER_SOCKET, resolve);
  });
  runners = await import("./runners");
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

test("recovering a lost create response and replaying a task starts only one container", async () => {
  const beforeCreates = creates;
  const beforeStarts = starts;
  loseCreate = true;
  const id = await runners.startTask(
    request,
    "azure",
    "Create",
    "create",
    1,
    version,
  );
  expect(
    await runners.startTask(request, "azure", "Create", "create", 1, version),
  ).toBe(id);
  expect(creates - beforeCreates).toBe(1);
  expect(starts - beforeStarts).toBe(1);
  expect(containers.get(`forge-run-${id}`)?.Config.Labels).toMatchObject({
    "forge.runId": id,
    "forge.projectId": request.projectId,
    "forge.projectCode": request.code,
    "forge.projectAttempt": "1",
    "forge.taskId": "azure-create",
    "forge.taskAttempt": "1",
    "forge.resource": "azure",
    "forge.operation": "Create",
  });
  expect(await runners.taskStatus(id)).toBe("running");
});
test("recovering a lost start response does not restart an execution", async () => {
  const beforeStarts = starts;
  loseStart = true;
  const id = await runners.startTask(
    request,
    "azure",
    "Create",
    "create",
    2,
    version,
  );
  await runners.startTask(request, "azure", "Create", "create", 2, version);
  expect(starts - beforeStarts).toBe(1);
  const container = containers.get(`forge-run-${id}`);
  if (!container) throw new Error("Expected execution");
  container.State.Status = "exited";
  container.State.Running = false;
  container.State.ExitCode = 0;
  container.State.FinishedAt = "2026-09-27T12:00:10Z";
  expect(await runners.taskStatus(id)).toBe("succeeded");
});
test("an execution which disappeared after starting remains uncertain and is not recreated", async () => {
  const id = await runners.startTask(
    request,
    "azure",
    "Create",
    "create",
    3,
    version,
  );
  await runners.taskStatus(id);
  containers.delete(`forge-run-${id}`);
  expect(await runners.taskStatus(id)).toBe("unknown");
  const beforeCreates = creates;
  await expect(
    runners.startTask(request, "azure", "Create", "create", 3, version),
  ).rejects.toThrow("uncertain");
  expect(creates).toBe(beforeCreates);
});
test("an admin retry finds the original creation version across failed cleanup attempts", async () => {
  await mkdir(join(directory, "versions"), { recursive: true });
  await writeFile(
    join(directory, "versions", `${request.projectId}-1.json`),
    JSON.stringify(version),
  );
  await runners.initializeAttempt({ ...request, attempt: 2 });
  await runners.initializeAttempt({ ...request, attempt: 3 });
  expect(await runners.previousVersion({ ...request, attempt: 3 })).toEqual(
    version,
  );
});

test("durable log capture recovers partial writes without reading Docker logs", async () => {
  const id = await runners.startTask(
    request,
    "azure",
    "Create",
    "create",
    4,
    version,
  );
  const path = join(directory, "runs", id, "output", "logs.jsonl");
  const entry = (text: string) =>
    JSON.stringify({
      timestamp: "2026-09-27T12:00:01Z",
      stream: "stderr",
      text,
    });
  await writeFile(
    path,
    `${entry("first diagnostic")}\n${entry("second diagnostic").slice(0, 15)}`,
  );
  const delivered: RunEvent[] = [];
  const sender = {
    sendMessages: async (message: { body: RunEvent }) => {
      delivered.push(message.body);
      await runners.acknowledgeRunnerEvent(message.body.eventId);
    },
  };
  const stop = await runners.observeRunners(sender as ServiceBusSender);
  try {
    await vi.waitFor(
      () =>
        expect(
          delivered
            .filter((event) => event.run.id === id)
            .flatMap((event) => event.logs),
        ).toHaveLength(1),
      { timeout: 2500 },
    );
    await appendFile(path, `${entry("second diagnostic").slice(15)}\n`);
    await vi.waitFor(
      () =>
        expect(
          delivered
            .filter((event) => event.run.id === id)
            .flatMap((event) => event.logs)
            .map((log) => [log.sequence, log.text]),
        ).toEqual([
          [1, "first diagnostic"],
          [2, "second diagnostic"],
        ]),
      { timeout: 2500 },
    );
  } finally {
    stop();
  }
});

test("an attempt pins the catalog from its image once and retains original settings", async () => {
  const project = {
    ...request,
    projectId: "c513e0da-08e4-4f64-a111-bb6bb9cfdc38",
  };
  process.env.AZURE_SUBSCRIPTION_ID = "original-subscription";
  process.env.AZURE_REGION = "eastus";
  process.env.GITHUB_ORG = "original-org";
  const before = catalogInspections;
  const pinned = await runners.pinVersion(project);
  expect(pinned.image).toBe(version.image);
  expect(pinned.manifest).toEqual(version.manifest);
  expect(pinned).not.toHaveProperty("source");
  process.env.AZURE_SUBSCRIPTION_ID = "changed-subscription";
  expect(await runners.pinVersion(project)).toEqual(pinned);
  expect(catalogInspections - before).toBe(1);
  expect(
    [...containers.keys()].some((name) => name.startsWith("forge-catalog-")),
  ).toBe(false);
});

test("delete runs the packaged handler with concrete ownership arguments and no source snapshot", async () => {
  const id = await runners.startTask(
    request,
    "azure",
    "Delete",
    "failure",
    1,
    version,
  );
  const work = join(directory, "runs", id, "work");
  expect((await readdir(work)).sort()).toEqual([
    "arguments.json",
    "request.json",
    "settings.json",
    "task.json",
  ]);
  const args = JSON.parse(await readFile(join(work, "arguments.json"), "utf8"));
  expect(args[0]).toBe("delete");
  expect(JSON.parse(args[1])).toEqual({
    resourceGroup: "az-abcde-resgp",
    projectId: request.projectId,
  });
  await expect(
    runners.startTask(request, "azure", "Delete", "failure", 1, {
      ...version,
      settings: { ...version.settings, azureSubscriptionId: "changed" },
    }),
  ).rejects.toThrow("version");
});
