import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type ProviderSettings,
  parseManifest,
  type Task,
} from "@hero4hire/automation";
import { logger, redactor } from "./logging";

type Options = {
  workspace?: string;
  imageRoot?: string;
  credentials?: string;
  keyFile?: string;
  logFile?: string;
};
const readJSON = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));

export async function execute(options: Options = {}): Promise<number> {
  const workspace = options.workspace ?? process.cwd();
  const imageRoot = options.imageRoot ?? resolve(import.meta.dirname, "..");
  const logFile = options.logFile ?? "/run/forge-output/logs.jsonl";
  let output: ReturnType<typeof logger> | undefined;
  try {
    const manifest = parseManifest(
      await readJSON(resolve(imageRoot, "tasks.json")),
    );
    const supplied: Task = await readJSON(resolve(workspace, "task.json"));
    const task = manifest.tasks.find((task) => task.id === supplied.id);
    if (
      !task ||
      JSON.stringify(task) !== JSON.stringify(supplied) ||
      task.runner !== "privileged"
    )
      throw new Error("Task does not match the packaged catalog");
    const args: string[] = await readJSON(resolve(workspace, "arguments.json"));
    if (
      !Array.isArray(args) ||
      !args.every((arg) => typeof arg === "string") ||
      args[0] !== task.action
    )
      throw new Error("Invalid task arguments");
    const settings: ProviderSettings = await readJSON(
      resolve(workspace, "settings.json"),
    );
    const credentials: Record<string, string> = await readJSON(
      options.credentials ?? "/run/secrets/forge/providers.json",
    );
    const prefix = task.resource === "azure" ? "AZURE_" : "GITHUB_";
    const environment: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(AZURE_|GITHUB_)/.test(key),
      ),
    );
    for (const [key, value] of Object.entries(credentials)) {
      if (key.startsWith(prefix)) {
        if (typeof value !== "string")
          throw new Error("Invalid provider credential");
        environment[key] = value;
      }
    }
    if (task.resource === "azure") {
      environment.AZURE_SUBSCRIPTION_ID = settings.azureSubscriptionId;
      environment.AZURE_REGION = settings.azureRegion;
    } else {
      environment.GITHUB_ORG = settings.githubOrganization;
      environment.GITHUB_APP_PRIVATE_KEY_FILE =
        options.keyFile ?? "/run/secrets/forge/github-app.pem";
    }
    output = logger(
      logFile,
      redactor(environment, environment.GITHUB_APP_PRIVATE_KEY_FILE),
    );
    output.log("system", `Starting ${task.name}`);
    const child = spawn(
      process.execPath,
      [resolve(imageRoot, task.entrypoint), ...args],
      {
        env: environment,
        cwd: imageRoot,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    const stop = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {}
      }
    };
    const term = () => stop("SIGTERM");
    const interrupt = () => stop("SIGINT");
    process.on("SIGTERM", term);
    process.on("SIGINT", interrupt);
    const forward = async (
      pipe: NodeJS.ReadableStream,
      stream: "stdout" | "stderr",
    ) => {
      for await (const line of createInterface({
        input: pipe,
        crlfDelay: Number.POSITIVE_INFINITY,
      }))
        output?.log(stream, line);
    };
    try {
      const exited = new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) =>
          resolve(code ?? (signal === "SIGINT" ? 130 : 143)),
        );
      });
      const [result] = await Promise.all([
        exited,
        forward(child.stdout, "stdout"),
        forward(child.stderr, "stderr"),
      ]);
      output.log("system", `Task exited with code ${result}`);
      return result;
    } finally {
      process.off("SIGTERM", term);
      process.off("SIGINT", interrupt);
    }
  } catch {
    output ??= logger(logFile, (text) => text);
    output.log(
      "system",
      "Runner initialization failed; verify the task and credential configuration.",
    );
    return 1;
  } finally {
    output?.close();
  }
}

if (import.meta.main) process.exitCode = await execute();
