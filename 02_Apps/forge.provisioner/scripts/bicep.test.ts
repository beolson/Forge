import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runBicep } from "./bicep";

let root: string;
const owner = {
  resourceGroup: "az-abcde-resgp",
  projectId: "e513e0da-08e4-4f64-a111-bb6bb9cfdc38",
};
const args = {
  scope: "subscription",
  deploymentName: "az-abcde-rgdep",
  location: "eastus",
  parameters: {
    appCode: "ABCDE",
    projectId: owner.projectId,
    location: "eastus",
    extra: { nested: "a value with spaces" },
  },
  ownership: owner,
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-az-"));
  await writeFile(
    join(root, "az"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({args, config:process.env.AZURE_CONFIG_DIR}) + '\\n');
if (args[0] === 'group' && args[1] === 'exists') console.log(process.env.FAKE_EXISTS ?? 'true');
if (args[0] === 'group' && args[1] === 'show') console.log(process.env.FAKE_OWNER);
if (args[0] === 'deployment' && args[2] === 'list') console.log(process.env.FAKE_LOCATION ?? '');
if (args[0] === 'deployment' && args[2] === 'create') process.exit(Number(process.env.FAKE_EXIT ?? 0));
`,
  );
  await chmod(join(root, "az"), 0o755);
  for (const [key, value] of Object.entries({
    PATH: `${root}:${process.env.PATH}`,
    FAKE_CALLS: join(root, "calls"),
    FAKE_OWNER: owner.projectId,
    AZURE_SUBSCRIPTION_ID: "subscription",
    AZURE_TENANT_ID: "tenant",
    AZURE_CLIENT_ID: "client",
    AZURE_CLIENT_SECRET: "secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function calls(): Promise<{ args: string[]; config: string }[]> {
  return (await readFile(join(root, "calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
const deploy = () =>
  runBicep([
    "deploy",
    "resources/project-resource-group.bicep",
    JSON.stringify(args),
  ]);

test("subscription deployment reapplies an owned group with structured parameters and the original metadata location", async () => {
  vi.stubEnv("FAKE_LOCATION", "westus");
  await deploy();
  const recorded = await calls();
  const command = recorded.find(
    ({ args }) => args[0] === "deployment" && args[2] === "create",
  )?.args;
  expect(command).toBeDefined();
  expect(command?.[command.indexOf("--location") + 1]).toBe("westus");
  expect(
    JSON.parse(command?.[command.indexOf("--parameters") + 1] ?? "{}"),
  ).toEqual({
    appCode: { value: "ABCDE" },
    projectId: { value: owner.projectId },
    location: { value: "eastus" },
    extra: { value: { nested: "a value with spaces" } },
  });
  expect(recorded.every((call) => call.config === recorded[0].config)).toBe(
    true,
  );
  await expect(access(recorded[0].config)).rejects.toThrow();
});

test("deployment and deletion refuse foreign resource groups", async () => {
  vi.stubEnv("FAKE_OWNER", "another-project");
  await expect(deploy()).rejects.toThrow("ownership");
  await expect(runBicep(["delete", JSON.stringify(owner)])).rejects.toThrow(
    "ownership",
  );
  expect(
    (await calls()).some(
      ({ args }) => args.includes("create") || args.includes("delete"),
    ),
  ).toBe(false);
});

test("delete waits for an owned group and succeeds repeatedly when absent", async () => {
  await runBicep(["delete", JSON.stringify(owner)]);
  expect(
    (await calls()).some(
      ({ args }) => args[1] === "wait" && args.includes("--deleted"),
    ),
  ).toBe(true);
  vi.stubEnv("FAKE_EXISTS", "false");
  await writeFile(join(root, "calls"), "");
  await runBicep(["delete", JSON.stringify(owner)]);
  expect((await calls()).some(({ args }) => args.includes("delete"))).toBe(
    false,
  );
});

test("deployment preserves provider failures and uses an isolated cache on each call", async () => {
  vi.stubEnv("FAKE_EXIT", "9");
  await expect(deploy()).rejects.toMatchObject({ exitCode: 9 });
  vi.stubEnv("FAKE_EXISTS", "false");
  await runBicep(["delete", JSON.stringify(owner)]);
  const configs = new Set((await calls()).map((call) => call.config));
  expect(configs.size).toBe(2);
  for (const config of configs) await expect(access(config)).rejects.toThrow();
});

test("only subscription scope and packaged Bicep paths are accepted", async () => {
  await expect(
    runBicep(["deploy", "../outside.bicep", JSON.stringify(args)]),
  ).rejects.toThrow("arguments");
  await expect(
    runBicep([
      "deploy",
      "resources/project-resource-group.bicep",
      JSON.stringify({ ...args, scope: "resourceGroup" }),
    ]),
  ).rejects.toThrow("arguments");
  await expect(access(join(root, "calls"))).rejects.toThrow();
});
