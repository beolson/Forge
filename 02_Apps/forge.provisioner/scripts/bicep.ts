import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import type { AzureOwnership, BicepArguments } from "@hero4hire/automation";
import { safeResourcePath } from "@hero4hire/automation";
import { azureCommand, cli, required } from "../src/process";

function ownership(value: AzureOwnership): void {
  if (
    !value ||
    !/^az-[a-z]{5}-resgp$/.test(value.resourceGroup) ||
    !/^[0-9a-f-]{36}$/.test(value.projectId)
  )
    throw new Error("Invalid Azure ownership arguments");
}

export async function runBicep(argv: string[]): Promise<void> {
  const [action, input, options] = argv;
  if (
    !(
      (action === "deploy" && argv.length === 3) ||
      (action === "delete" && argv.length === 2)
    )
  )
    throw new Error(
      "Usage: bicep deploy <Bicep file> <JSON arguments> | delete <JSON ownership>",
    );
  const args =
    action === "deploy" ? (JSON.parse(options) as BicepArguments) : null;
  const owner: AzureOwnership = args ? args.ownership : JSON.parse(input);
  ownership(owner);
  let template: string | undefined;
  if (args) {
    if (
      args.scope !== "subscription" ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(args.deploymentName) ||
      typeof args.location !== "string" ||
      !args.location ||
      !args.parameters ||
      typeof args.parameters !== "object" ||
      Array.isArray(args.parameters) ||
      !safeResourcePath(input)
    )
      throw new Error("Invalid subscription deployment arguments");
    const resources = await realpath(
      resolve(import.meta.dirname, "../resources"),
    );
    template = await realpath(resolve(import.meta.dirname, "..", input));
    if (!template.startsWith(resources + sep))
      throw new Error("Bicep file must be packaged under resources/");
  }
  const subscription = required("AZURE_SUBSCRIPTION_ID");
  const tenant = required("AZURE_TENANT_ID");
  const client = required("AZURE_CLIENT_ID");
  const secret = required("AZURE_CLIENT_SECRET");
  const directory = await mkdtemp(resolve(tmpdir(), "forge-azure-"));
  const environment = {
    ...process.env,
    AZURE_CONFIG_DIR: directory,
    AZURE_CORE_COLLECT_TELEMETRY: "false",
    AZURE_CORE_ONLY_SHOW_ERRORS: "true",
  };
  const az = (command: string[]) => azureCommand(command, environment);
  try {
    await az([
      "login",
      "--service-principal",
      "--username",
      client,
      "--password",
      secret,
      "--tenant",
      tenant,
      "--output",
      "none",
    ]);
    const target = [
      "--subscription",
      subscription,
      "--name",
      owner.resourceGroup,
    ];
    const exists = await az(["group", "exists", ...target, "--output", "tsv"]);
    if (exists !== "true" && exists !== "false")
      throw new Error("Could not determine whether resource group exists");
    if (exists === "true") {
      const marker = await az([
        "group",
        "show",
        ...target,
        "--query",
        "tags.forgeProjectId",
        "--output",
        "tsv",
      ]);
      if (marker !== owner.projectId)
        throw new Error(
          `Resource group ${owner.resourceGroup} exists without matching Forge ownership`,
        );
    }
    if (!args) {
      if (exists === "false") {
        console.log(`Resource group ${owner.resourceGroup} is absent`);
        return;
      }
      await az(["group", "delete", ...target, "--yes", "--no-wait"]);
      await az([
        "group",
        "wait",
        ...target,
        "--deleted",
        "--interval",
        "10",
        "--timeout",
        "1500",
      ]);
      console.log(`Deleted resource group ${owner.resourceGroup}`);
      return;
    }
    await az([
      "config",
      "set",
      "bicep.use_binary_from_path=true",
      "--output",
      "none",
    ]);
    const location = await az([
      "deployment",
      "sub",
      "list",
      "--subscription",
      subscription,
      "--query",
      `[?name=='${args.deploymentName}'].location | [0]`,
      "--output",
      "tsv",
    ]);
    const parameters = Object.fromEntries(
      Object.entries(args.parameters).map(([name, value]) => [name, { value }]),
    );
    await az([
      "deployment",
      "sub",
      "create",
      "--subscription",
      subscription,
      "--name",
      args.deploymentName,
      "--location",
      location || args.location,
      "--template-file",
      template as string,
      "--parameters",
      JSON.stringify(parameters),
      "--output",
      "none",
    ]);
    console.log(
      `Applied Bicep ${input} to resource group ${owner.resourceGroup}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await cli(() => runBicep(process.argv.slice(2)));
