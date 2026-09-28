import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { execute } from "./execute";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture(exitCode: number) {
  const root = await mkdtemp(join(tmpdir(), "forge-executor-"));
  directories.push(root);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "scripts"));
  const task = {
    id: "azure-create",
    name: "Create group",
    runner: "privileged",
    resource: "azure",
    operation: "Create",
    runtime: "bun",
    entrypoint: "scripts/bicep.js",
    action: "deploy",
    bicepFile: "resources/test.bicep",
  };
  await writeFile(
    join(root, "tasks.json"),
    JSON.stringify({ version: 1, tasks: [task] }),
  );
  await writeFile(join(root, "task.json"), JSON.stringify(task));
  await writeFile(
    join(root, "arguments.json"),
    JSON.stringify(["deploy", "resources/test.bicep", "{}"]),
  );
  await writeFile(
    join(root, "settings.json"),
    JSON.stringify({
      azureSubscriptionId: "pinned-subscription",
      azureRegion: "eastus",
    }),
  );
  await writeFile(
    join(root, "providers.json"),
    JSON.stringify({
      AZURE_CLIENT_SECRET: "provider-secret",
      AZURE_SUBSCRIPTION_ID: "current-subscription",
      GITHUB_TOKEN: "other-provider-token",
    }),
  );
  await writeFile(
    join(root, "scripts/bicep.js"),
    `console.error('diagnostic ' + process.env.AZURE_CLIENT_SECRET); console.log(process.env.AZURE_SUBSCRIPTION_ID); console.log(process.env.GITHUB_TOKEN ?? 'no-other-provider'); process.exit(${exitCode});`,
  );
  return {
    workspace: root,
    imageRoot: root,
    credentials: join(root, "providers.json"),
    logFile: join(root, "logs.jsonl"),
  };
}

test("executor retains provider exit status, pins settings and exposes only the selected provider credentials", async () => {
  const options = await fixture(7);
  expect(await execute(options)).toBe(7);
  const logs = await readFile(options.logFile, "utf8");
  expect(logs).toContain("diagnostic [REDACTED]");
  expect(logs).toContain("pinned-subscription");
  expect(logs).toContain("no-other-provider");
  expect(logs).not.toContain("provider-secret");
  expect(logs).not.toContain("other-provider-token");
});

test("archive failure preserves a successful provider result", async () => {
  const options = await fixture(0);
  options.logFile = join(options.workspace, "missing/logs.jsonl");
  expect(await execute(options)).toBe(0);
});

test("executor refuses commands that differ from its packaged task catalog", async () => {
  const options = await fixture(0);
  const task = JSON.parse(
    await readFile(join(options.workspace, "task.json"), "utf8"),
  );
  task.entrypoint = "/tmp/untrusted.js";
  await writeFile(join(options.workspace, "task.json"), JSON.stringify(task));
  expect(await execute(options)).toBe(1);
  expect(await readFile(options.logFile, "utf8")).not.toContain("Starting");
});

test("termination reaches the handler and its child process group", async () => {
  const options = await fixture(0);
  const { spawn } = await import("node:child_process");
  const { vi } = await import("vitest");
  await writeFile(
    join(options.workspace, "scripts/bicep.js"),
    `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => { console.log('grandchild terminated'); process.exit(0); }); console.log('grandchild ready'); setInterval(() => {}, 1000);"], {stdio: ['ignore', 'inherit', 'inherit']});
    process.on('SIGTERM', () => { child.on('exit', () => process.exit(143)); });
    setInterval(() => {}, 1000);
  `,
  );
  const runner = spawn(
    "bun",
    [
      "-e",
      `import {execute} from ${JSON.stringify(join(import.meta.dirname, "execute.ts"))}; process.exitCode = await execute(${JSON.stringify(options)});`,
    ],
    { stdio: "ignore", cwd: options.workspace },
  );
  const ended = new Promise<number | null>((resolve, reject) => {
    runner.on("error", reject);
    runner.on("close", resolve);
  });
  try {
    await vi.waitFor(
      async () =>
        expect(await readFile(options.logFile, "utf8")).toContain(
          "grandchild ready",
        ),
      { timeout: 5000 },
    );
    runner.kill("SIGTERM");
    expect(await ended).toBe(143);
    expect(await readFile(options.logFile, "utf8")).toContain(
      "grandchild terminated",
    );
  } finally {
    runner.kill("SIGKILL");
  }
});
