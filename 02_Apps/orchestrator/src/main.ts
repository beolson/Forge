import { ServiceBusClient } from "@azure/service-bus";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ExecutionVersion } from "@hero4hire/automation";
import {
  type ProjectEvent,
  type ProjectRequest,
  type ProjectStatus,
  parseProjectInput,
  type Resource,
  repositoryName,
} from "@hero4hire/project";
import {
  acknowledgeRunnerEvent,
  initializeAttempt,
  observeRunners,
  pinVersion,
  previousVersion,
  startTask,
  stopTask,
  taskFailure,
  taskStatus,
} from "./runners";

const busConnection = process.env.SERVICEBUS_CONNECTION_STRING;
if (!busConnection)
  throw new Error("SERVICEBUS_CONNECTION_STRING must be configured");
const bus = new ServiceBusClient(busConnection);
const sender = bus.createSender("forge-results");
const timeoutMS = Number(process.env.RUNNER_TASK_TIMEOUT_MS || 1_800_000);
if (!Number.isFinite(timeoutMS) || timeoutMS < 60_000)
  throw new Error("RUNNER_TASK_TIMEOUT_MS must be at least 60000");

async function emit(
  request: ProjectRequest,
  suffix: string,
  status: ProjectStatus,
  detail: string,
  resource?: Resource,
) {
  const label =
    resource === "azure" ? "Azure resource group" : "GitHub repository";
  const publicDetail =
    status === "failed"
      ? "Provisioning failed; resources were rolled back. An admin can investigate and retry."
      : status === "cleanup_failed"
        ? "Provisioning needs admin investigation before it can be retried."
        : suffix.endsWith("-fail")
          ? `${label} task attempt failed.`
          : detail;
  const event: ProjectEvent = {
    eventId: `${request.projectId}:${request.attempt}:${suffix}`,
    projectId: request.projectId,
    attempt: request.attempt,
    status,
    resource,
    detail: publicDetail,
    adminDetail: detail,
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
  version: ExecutionVersion,
): Promise<RunResult> {
  try {
    const taskId = await DBOS.runStep(
      () => startTask(request, resource, operation, phase, attempt, version),
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
      if (status === "succeeded") return { ok: true };
      if (status === "unknown")
        return {
          ok: false,
          detail: `Task ${taskId} has an uncertain outcome`,
          uncertain: true,
        };
      if (["failed", "stopped"].includes(status)) {
        const detail = await DBOS.runStep(
          async () => {
            try {
              return await taskFailure(taskId);
            } catch {
              return `Provisioning task ${taskId} ended ${status}`;
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
          if (["succeeded", "failed", "stopped"].includes(stoppedStatus)) {
            return {
              ok: stoppedStatus === "succeeded",
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
  version: ExecutionVersion,
): Promise<RunResult> {
  let lastFailure = "";
  const label =
    resource === "azure" ? "Azure resource group" : "GitHub repository";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await emit(
      request,
      `${phase}-${resource}-${operation}-${attempt}-start`,
      operation === "Create" ? "provisioning" : "rolling_back",
      `${operation === "Create" ? "Provisioning" : "Rolling back"} ${label} (attempt ${attempt}/3)`,
      resource,
    );
    const result = await runAttempt(
      request,
      resource,
      operation,
      phase,
      attempt,
      version,
    );
    if (result.ok) {
      await emit(
        request,
        `${phase}-${resource}-${operation}-${attempt}-ok`,
        operation === "Create" ? "provisioning" : "rolling_back",
        `${label} ${operation === "Create" ? "provisioned" : "rolled back"}`,
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
    version: ExecutionVersion,
  ) => runWithRetries(request, resource, operation, phase, version),
  { name: "resourceTaskV2" },
);

async function runResources(
  request: ProjectRequest,
  operation: "Create" | "Rollback",
  phase: string,
  resources: Resource[],
  version: ExecutionVersion,
): Promise<RunResult[]> {
  const runs: Promise<RunResult>[] = [];
  for (const resource of resources) {
    try {
      const handle = await DBOS.startWorkflow(resourceWorkflow, {
        workflowID: `${request.projectId}:${request.attempt}:${phase}:${resource}`,
      })(request, resource, operation, phase, version);
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
  version: ExecutionVersion,
  resources: Resource[] = ["azure", "github"],
): Promise<RunResult[]> {
  await emit(
    request,
    `${phase}-rollback-start`,
    "rolling_back",
    "Rolling back project resources",
  );
  return runResources(request, "Rollback", phase, resources, version);
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
    await DBOS.runStep(() => initializeAttempt(request), {
      name: "initialize-attempt",
    });
    if (request.attempt > 1) {
      const oldVersion = await DBOS.runStep(() => previousVersion(request), {
        name: "previous-source",
      });
      const oldCleanup = oldVersion
        ? await rollback(request, "prior", oldVersion)
        : [];
      if (oldCleanup.some((result) => !result.ok)) {
        return finish(
          request,
          "prior-cleanup-failed",
          "cleanup_failed",
          "Previous resources could not be cleaned up; an admin must investigate.",
        );
      }
    }
    const version = await DBOS.runStep(() => pinVersion(request), {
      name: "pin-source",
      retriesAllowed: true,
      maxAttempts: 3,
    });
    await emit(request, "start", "provisioning", "Provisioning started");
    const [azure, github] = await runResources(
      request,
      "Create",
      "create",
      ["azure", "github"],
      version,
    );
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
        ? await rollback(request, "uncertain", version, safeToRollback)
        : [];
      return finish(
        request,
        "uncertain",
        "cleanup_failed",
        `A task has an uncertain outcome. ${safeToRollback.length ? `Known completed tasks were rolled back${cleanup.some((result) => !result.ok) ? " with errors" : ""}. ` : ""}Admin investigation required: ${details}`,
      );
    }
    const cleanup = await rollback(request, "failure", version);
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
  name: "createProjectV2",
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
  applicationVersion: "container-runners-v1",
  systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
});
await DBOS.launch();
await observeRunners(sender);
const receiver = bus.createReceiver("forge-requests");
receiver.subscribe({
  processMessage: async (message) => {
    if (message.body?.kind === "runner-ack") {
      await acknowledgeRunnerEvent(message.body.eventId);
      return;
    }
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
              detail:
                result.status === "ready"
                  ? "Azure resource group and GitHub repository are ready."
                  : result.status === "failed"
                    ? "Provisioning failed; resources were rolled back. An admin can investigate and retry."
                    : "Provisioning needs admin investigation before it can be retried.",
              adminDetail: result.detail,
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
