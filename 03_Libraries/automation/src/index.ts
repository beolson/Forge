import type { ProjectRequest, Resource } from "@hero4hire/project";

export type RunnerProfile = "privileged" | "project";
export type Operation = "Create" | "Delete";
type TaskBase = {
  id: string;
  name: string;
  runner: RunnerProfile;
  operation: Operation;
  runtime: "bun";
};
export type Task = TaskBase &
  (
    | {
        resource: "azure";
        entrypoint: "scripts/bicep.js";
        action: "deploy";
        bicepFile: string;
      }
    | { resource: "azure"; entrypoint: "scripts/bicep.js"; action: "delete" }
    | {
        resource: "github";
        entrypoint: "scripts/github.js";
        action: "create" | "delete";
      }
  );
export type TaskManifest = { version: 1; tasks: Task[] };
export type ProviderSettings = {
  azureSubscriptionId: string;
  azureRegion: string;
  githubOrganization: string;
};
export type ExecutionVersion = {
  manifest: TaskManifest;
  image: string;
  settings: ProviderSettings;
};
export type AzureOwnership = { resourceGroup: string; projectId: string };
export type BicepArguments = {
  scope: "subscription";
  deploymentName: string;
  location: string;
  parameters: Record<string, unknown>;
  ownership: AzureOwnership;
};
export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "unknown";
export type RunRecord = {
  id: string;
  revision: number;
  projectId: string;
  projectAttempt: number;
  taskAttempt: number;
  phase: string;
  task: Task;
  parameters: ProjectRequest;
  arguments: string[];
  version: ExecutionVersion;
  container: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
};
export type RunLog = {
  sequence: number;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
};
export type RunSummary = RunRecord;
export type RunEvent = {
  kind: "runner-event";
  eventId: string;
  run: RunRecord;
  logs: RunLog[];
};

export function safeResourcePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length < 200 &&
    /^resources\/[A-Za-z0-9_.\-/]+\.bicep$/.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function parseManifest(value: unknown): TaskManifest {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("tasks" in value) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length < 1 ||
    value.tasks.length > 50
  ) {
    throw new Error("Invalid task manifest");
  }
  const ids = new Set<string>();
  const operations = new Set<string>();
  for (const task of value.tasks) {
    if (
      !task ||
      !/^[a-z][a-z0-9-]{1,49}$/.test(task.id) ||
      typeof task.name !== "string" ||
      task.name.length > 100 ||
      !["privileged", "project"].includes(task.runner) ||
      task.runtime !== "bun" ||
      !["Create", "Delete"].includes(task.operation) ||
      !(task.resource === "azure"
        ? task.entrypoint === "scripts/bicep.js" &&
          (task.operation === "Create"
            ? task.action === "deploy" && safeResourcePath(task.bicepFile)
            : task.action === "delete")
        : task.resource === "github" &&
          task.entrypoint === "scripts/github.js" &&
          task.action === task.operation.toLowerCase()) ||
      ids.has(task.id) ||
      operations.has(`${task.resource}:${task.operation}`)
    ) {
      throw new Error("Invalid or duplicate task definition");
    }
    ids.add(task.id);
    operations.add(`${task.resource}:${task.operation}`);
  }
  return value as TaskManifest;
}

export function taskFor(
  manifest: TaskManifest,
  resource: Resource,
  operation: Operation,
): Task {
  const task = manifest.tasks.find(
    (task) => task.resource === resource && task.operation === operation,
  );
  if (!task) throw new Error(`No packaged ${resource} ${operation} task`);
  if (task.runner !== "privileged")
    throw new Error("Project-scoped tasks are not enabled yet");
  return task;
}

export function taskArguments(
  task: Task,
  project: ProjectRequest,
  settings: ProviderSettings,
): string[] {
  if (task.resource === "github") return [task.action, JSON.stringify(project)];
  const ownership: AzureOwnership = {
    resourceGroup: `az-${project.code.toLowerCase()}-resgp`,
    projectId: project.projectId,
  };
  if (task.action === "delete") return ["delete", JSON.stringify(ownership)];
  const args: BicepArguments = {
    scope: "subscription",
    deploymentName: `az-${project.code.toLowerCase()}-rgdep`,
    location: settings.azureRegion,
    parameters: {
      appCode: project.code,
      projectId: project.projectId,
      location: settings.azureRegion,
    },
    ownership,
  };
  return ["deploy", task.bicepFile, JSON.stringify(args)];
}
