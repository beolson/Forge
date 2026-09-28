import type { ProjectRequest, Resource } from "@hero4hire/project";

export type RunnerProfile = "privileged" | "project";
export type Operation = "Create" | "Rollback";
export type Task = {
  id: string;
  name: string;
  runner: RunnerProfile;
  resource: Resource;
  operation: Operation;
  runtime: "bash" | "python";
  entrypoint: string;
  files: string[];
};
export type TaskManifest = { version: 1; tasks: Task[] };
export type SourceSnapshot = {
  repository: string;
  revision: string;
  origin: "github" | "development";
  root: string;
  manifest: TaskManifest;
  files: Record<string, string>;
};
export type ExecutionVersion = {
  source: SourceSnapshot;
  image: string;
  settings: {
    azureSubscriptionId: string;
    azureRegion: string;
    githubOrganization: string;
  };
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
export type RunEvent = {
  kind: "runner-event";
  eventId: string;
  run: RunRecord;
  logs: RunLog[];
};

export function safeSourcePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length < 200 &&
    /^[A-Za-z0-9_.\-/]+$/.test(value) &&
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
      !["azure", "github"].includes(task.resource) ||
      !["Create", "Rollback"].includes(task.operation) ||
      !["bash", "python"].includes(task.runtime) ||
      !safeSourcePath(task.entrypoint) ||
      !Array.isArray(task.files) ||
      task.files.length > 30 ||
      !task.files.every(safeSourcePath) ||
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
  source: SourceSnapshot,
  resource: Resource,
  operation: Operation,
): Task {
  const task = source.manifest.tasks.find(
    (task) => task.resource === resource && task.operation === operation,
  );
  if (!task) throw new Error(`No approved ${resource} ${operation} task`);
  // The project profile intentionally has no provisioning credentials in this slice.
  if (task.runner !== "privileged")
    throw new Error("Project-scoped tasks are not enabled yet");
  return task;
}
