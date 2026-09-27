import { readFile } from "node:fs/promises";
import type { ProjectRequest, Resource } from "@hero4hire/project";

type SemaphoreConfig = {
  url: string;
  token: string;
  projectId: number;
  templates: Record<
    "azureCreate" | "azureRollback" | "githubCreate" | "githubRollback",
    number
  >;
};

async function config(): Promise<SemaphoreConfig> {
  const file = process.env.SEMAPHORE_CONNECTION_FILE;
  if (file) return JSON.parse(await readFile(file, "utf8")) as SemaphoreConfig;
  const token = process.env.SEMAPHORE_TOKEN;
  const url = process.env.SEMAPHORE_URL;
  const projectId = Number(process.env.SEMAPHORE_PROJECT_ID);
  if (!token || !url || !projectId)
    throw new Error("Semaphore connection is not configured");
  return {
    token,
    url,
    projectId,
    templates: {
      azureCreate: Number(process.env.SEMAPHORE_AZURE_CREATE_TEMPLATE_ID),
      azureRollback: Number(process.env.SEMAPHORE_AZURE_ROLLBACK_TEMPLATE_ID),
      githubCreate: Number(process.env.SEMAPHORE_GITHUB_CREATE_TEMPLATE_ID),
      githubRollback: Number(process.env.SEMAPHORE_GITHUB_ROLLBACK_TEMPLATE_ID),
    },
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const current = await config();
  const response = await fetch(`${current.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${current.token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok)
    throw new Error(`Semaphore API ${response.status} for ${path}`);
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

export async function startTask(
  request: ProjectRequest,
  resource: Resource,
  operation: "Create" | "Rollback",
  phase: string,
  attempt: number,
): Promise<number> {
  const current = await config();
  const template = current.templates[`${resource}${operation}`];
  if (!template)
    throw new Error(
      `Semaphore ${resource}${operation} template is not configured`,
    );
  const message = `${request.projectId}:${request.attempt}:${phase}:${resource}:${operation}:${attempt}`;
  const argumentsJSON = JSON.stringify([
    Buffer.from(JSON.stringify(request), "utf8").toString("base64"),
  ]);
  const existing = async () => {
    const tasks = await api<{ id: number; message: string }[]>(
      `/api/project/${current.projectId}/tasks?limit=200`,
    );
    return tasks.find((task) => task.message === message)?.id;
  };
  const found = await existing();
  if (found) return found;
  try {
    const task = await api<{ id: number }>(
      `/api/project/${current.projectId}/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          template_id: template,
          message,
          arguments: argumentsJSON,
        }),
      },
    );
    return task.id;
  } catch (error) {
    // The API may have accepted a task before the response was lost.
    for (let check = 0; check < 3; check++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const recovered = await existing();
      if (recovered) return recovered;
    }
    throw error;
  }
}

export async function taskStatus(taskId: number): Promise<string> {
  const current = await config();
  const task = await api<{ status: string }>(
    `/api/project/${current.projectId}/tasks/${taskId}`,
  );
  return task.status;
}

export async function stopTask(taskId: number): Promise<void> {
  const current = await config();
  await api(`/api/project/${current.projectId}/tasks/${taskId}/stop`, {
    method: "POST",
  });
}

export async function taskFailure(taskId: number): Promise<string> {
  const current = await config();
  const lines = await api<{ output: string }[]>(
    `/api/project/${current.projectId}/tasks/${taskId}/output`,
  );
  const detail = lines
    .map((line) => line.output)
    .reverse()
    .find((line) => line.includes("Forge ") && line.includes(" failed:"));
  return detail ? detail.slice(0, 300) : `Semaphore task ${taskId} failed`;
}
