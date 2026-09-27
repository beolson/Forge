import { ServiceBusClient } from "@azure/service-bus";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  type ProjectEvent,
  type ProjectRequest,
  type ProjectStatus,
  parseProjectInput,
  type Resource,
  repositoryName,
} from "@hero4hire/project";
import { startTask, stopTask, taskFailure, taskStatus } from "./semaphore";

const busConnection = process.env.SERVICEBUS_CONNECTION_STRING;
if (!busConnection)
  throw new Error("SERVICEBUS_CONNECTION_STRING must be configured");
const bus = new ServiceBusClient(busConnection);
const sender = bus.createSender("forge-results");
const timeoutMS = Number(process.env.SEMAPHORE_TASK_TIMEOUT_MS || 1_800_000);
if (!Number.isFinite(timeoutMS) || timeoutMS < 60_000)
  throw new Error("SEMAPHORE_TASK_TIMEOUT_MS must be at least 60000");

async function emit(
  request: ProjectRequest,
  suffix: string,
  status: ProjectStatus,
  detail: string,
  resource?: Resource,
) {
  const event: ProjectEvent = {
    eventId: `${request.projectId}:${request.attempt}:${suffix}`,
    projectId: request.projectId,
    attempt: request.attempt,
    status,
    resource,
    detail,
  };
  await DBOS.runStep(
    async () => {
      await sender.sendMessages({ messageId: event.eventId, body: event });
    },
    { name: `publish-${suffix}` },
  );
}

type RunResult =
  | { ok: true }
  | { ok: false; detail: string; uncertain?: boolean };

async function runAttempt(
  request: ProjectRequest,
  resource: Resource,
  operation: "Create" | "Rollback",
  phase: string,
  attempt: number,
): Promise<RunResult> {
  try {
    const taskId = await DBOS.runStep(
      () => startTask(request, resource, operation, phase, attempt),
      {
        name: `start-${resource}-${operation}-${attempt}`,
        retriesAllowed: true,
        maxAttempts: 3,
      },
    );
    const deadline = await DBOS.runStep(async () => Date.now() + timeoutMS, {
      name: `deadline-${resource}-${operation}-${attempt}`,
    });
    for (let poll = 0; ; poll++) {
      const status = await DBOS.runStep(() => taskStatus(taskId), {
        name: `status-${resource}-${operation}-${attempt}-${poll}`,
        retriesAllowed: true,
        maxAttempts: 3,
      });
      if (status === "success") return { ok: true };
      if (["error", "stopped", "rejected"].includes(status)) {
        const detail = await DBOS.runStep(
          async () => {
            try {
              return await taskFailure(taskId);
            } catch {
              return `Semaphore task ${taskId} ended ${status}`;
            }
          },
          { name: `failure-${resource}-${operation}-${attempt}` },
        );
        return { ok: false, detail };
      }
      const now = await DBOS.runStep(async () => Date.now(), {
        name: `clock-${resource}-${operation}-${attempt}-${poll}`,
      });
      if (now >= deadline) {
        await DBOS.runStep(() => stopTask(taskId), {
          name: `stop-${resource}-${operation}-${attempt}`,
        });
        for (let stoppedPoll = 0; stoppedPoll < 24; stoppedPoll++) {
          await DBOS.sleep(5000);
          const stoppedStatus = await DBOS.runStep(() => taskStatus(taskId), {
            name: `stopped-${resource}-${operation}-${attempt}-${stoppedPoll}`,
          });
          if (
            ["success", "error", "stopped", "rejected"].includes(stoppedStatus)
          ) {
            return {
              ok: stoppedStatus === "success",
              detail: `${resource} ${operation.toLowerCase()} task ${taskId} timed out and ended ${stoppedStatus}`,
            };
          }
        }
        return {
          ok: false,
          detail: `${resource} ${operation.toLowerCase()} task ${taskId} did not stop after timeout`,
          uncertain: true,
        };
      }
      await DBOS.sleep(5000);
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      uncertain: true,
    };
  }
}

async function runWithRetries(
  request: ProjectRequest,
  resource: Resource,
  operation: "Create" | "Rollback",
  phase: string,
): Promise<RunResult> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await emit(
      request,
      `${phase}-${resource}-${operation}-${attempt}-start`,
      operation === "Create" ? "provisioning" : "rolling_back",
      `${resource} ${operation.toLowerCase()} attempt ${attempt}/3 started`,
      resource,
    );
    const result = await runAttempt(
      request,
      resource,
      operation,
      phase,
      attempt,
    );
    if (result.ok) {
      await emit(
        request,
        `${phase}-${resource}-${operation}-${attempt}-ok`,
        operation === "Create" ? "provisioning" : "rolling_back",
        `${resource} ${operation.toLowerCase()} completed`,
        resource,
      );
      return result;
    }
    await emit(
      request,
      `${phase}-${resource}-${operation}-${attempt}-fail`,
      operation === "Create" ? "provisioning" : "rolling_back",
      result.detail,
      resource,
    );
    if (result.uncertain) return result;
    lastFailure = result.detail;
    if (attempt < 3) await DBOS.sleep(1000 * 2 ** attempt);
  }
  return {
    ok: false,
    detail: `${resource} ${operation.toLowerCase()} failed after three attempts: ${lastFailure}`,
  };
}

const resourceWorkflow = DBOS.registerWorkflow(
  (
    request: ProjectRequest,
    resource: Resource,
    operation: "Create" | "Rollback",
    phase: string,
  ) => runWithRetries(request, resource, operation, phase),
  { name: "resourceTask" },
);

async function runResources(
  request: ProjectRequest,
  operation: "Create" | "Rollback",
  phase: string,
  resources: Resource[],
): Promise<RunResult[]> {
  const runs: Promise<RunResult>[] = [];
  for (const resource of resources) {
    try {
      const handle = await DBOS.startWorkflow(resourceWorkflow, {
        workflowID: `${request.projectId}:${request.attempt}:${phase}:${resource}`,
      })(request, resource, operation, phase);
      runs.push(
        handle.getResult().catch((error) => ({
          ok: false as const,
          uncertain: true,
          detail: `${resource} ${operation.toLowerCase()} result is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        })),
      );
    } catch (error) {
      runs.push(
        Promise.resolve({
          ok: false,
          uncertain: true,
          detail: `${resource} ${operation.toLowerCase()} could not start: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    }
  }
  const settled = await Promise.allSettled(runs);
  return settled.map((result) =>
    result.status === "fulfilled"
      ? result.value
      : {
          ok: false as const,
          uncertain: true,
          detail:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
  );
}

async function rollback(
  request: ProjectRequest,
  phase: string,
  resources: Resource[] = ["azure", "github"],
): Promise<RunResult[]> {
  await emit(
    request,
    `${phase}-rollback-start`,
    "rolling_back",
    "Rolling back project resources",
  );
  return runResources(request, "Rollback", phase, resources);
}

type TerminalResult = {
  status: "ready" | "failed" | "cleanup_failed";
  detail: string;
};

async function finish(
  request: ProjectRequest,
  suffix: string,
  status: TerminalResult["status"],
  detail: string,
): Promise<TerminalResult> {
  await emit(request, suffix, status, detail);
  return { status, detail };
}

async function workflowFunction(
  request: ProjectRequest,
): Promise<TerminalResult> {
  try {
    if (request.attempt > 1) {
      const oldCleanup = await rollback(request, "prior");
      if (oldCleanup.some((result) => !result.ok)) {
        return finish(
          request,
          "prior-cleanup-failed",
          "cleanup_failed",
          "Previous resources could not be cleaned up; an admin must investigate.",
        );
      }
    }
    await emit(request, "start", "provisioning", "Provisioning started");
    const [azure, github] = await runResources(request, "Create", "create", [
      "azure",
      "github",
    ]);
    if (azure.ok && github.ok) {
      return finish(
        request,
        "ready",
        "ready",
        "Azure resource group and GitHub repository are ready.",
      );
    }
    const details = [azure, github]
      .filter((result) => !result.ok)
      .map((result) => result.detail)
      .join("; ");
    if ((!azure.ok && azure.uncertain) || (!github.ok && github.uncertain)) {
      const safeToRollback: Resource[] = [];
      if (azure.ok || !azure.uncertain) safeToRollback.push("azure");
      if (github.ok || !github.uncertain) safeToRollback.push("github");
      const cleanup = safeToRollback.length
        ? await rollback(request, "uncertain", safeToRollback)
        : [];
      return finish(
        request,
        "uncertain",
        "cleanup_failed",
        `A task has an uncertain outcome. ${safeToRollback.length ? `Known completed tasks were rolled back${cleanup.some((result) => !result.ok) ? " with errors" : ""}. ` : ""}Admin investigation required: ${details}`,
      );
    }
    const cleanup = await rollback(request, "failure");
    const cleanupFailed = cleanup.some((result) => !result.ok);
    return finish(
      request,
      "failed",
      cleanupFailed ? "cleanup_failed" : "failed",
      cleanupFailed
        ? `Provisioning failed (${details}); rollback also failed.`
        : `Provisioning failed (${details}); resources were rolled back.`,
    );
  } catch (error) {
    return finish(
      request,
      "workflow-error",
      "cleanup_failed",
      `Workflow error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const projectWorkflow = DBOS.registerWorkflow(workflowFunction, {
  name: "createProject",
});

function validRequest(body: unknown): body is ProjectRequest {
  if (!body || typeof body !== "object") return false;
  const value = body as Partial<ProjectRequest>;
  if (
    value.kind !== "create-project" ||
    typeof value.projectId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.projectId) ||
    !Number.isInteger(value.attempt) ||
    (value.attempt ?? 0) < 1 ||
    typeof value.name !== "string" ||
    typeof value.code !== "string" ||
    typeof value.description !== "string" ||
    typeof value.repositoryName !== "string"
  )
    return false;
  try {
    const parsed = parseProjectInput({
      name: value.name,
      code: value.code,
      description: value.description,
    });
    return (
      parsed.code === value.code &&
      parsed.name === value.name &&
      parsed.description === value.description &&
      repositoryName(value.code, value.name) === value.repositoryName
    );
  } catch {
    return false;
  }
}

DBOS.setConfig({
  name: "forge-orchestrator",
  applicationVersion: "0.1.0",
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
});
await DBOS.launch();
const receiver = bus.createReceiver("forge-requests");
receiver.subscribe({
  processMessage: async (message) => {
    if (!validRequest(message.body))
      throw new Error("Invalid Forge request message");
    const request = message.body;
    const handle = await DBOS.startWorkflow(projectWorkflow, {
      workflowID: `forge-project-${request.projectId}-${request.attempt}`,
    })(request);
    if (String(message.messageId ?? "").includes(":reconcile:")) {
      void handle
        .getResult()
        .catch(() => ({
          status: "cleanup_failed" as const,
          detail:
            "Workflow stopped unexpectedly; admin investigation required.",
        }))
        .then((result) =>
          sender.sendMessages({
            messageId: `${request.projectId}:${request.attempt}:terminal-replay`,
            body: {
              eventId: `${request.projectId}:${request.attempt}:terminal-replay`,
              projectId: request.projectId,
              attempt: request.attempt,
              status: result.status,
              detail: result.detail,
            } satisfies ProjectEvent,
          }),
        )
        .catch((error) => console.error("Forge reconciliation:", error));
    }
  },
  processError: async (args) =>
    console.error("Forge request consumer:", args.error),
});
console.log("Forge DBOS orchestrator is ready");
