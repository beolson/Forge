import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServiceBusSender } from "@azure/service-bus";
import {
  type ExecutionVersion,
  type Operation,
  parseManifest,
  type RunEvent,
  type RunLog,
  type RunRecord,
  taskArguments,
  taskFor,
} from "@hero4hire/automation";
import type { ProjectRequest, Resource } from "@hero4hire/project";
import { DockerError, decodeDockerLogs, docker, dockerBytes } from "./docker";

const root = process.env.RUNNER_DATA_DIRECTORY || "/var/lib/forge/runners";
const dataVolume = process.env.RUNNER_DATA_VOLUME || "forge-local-runner-data";
const credentialVolume =
  process.env.RUNNER_CREDENTIAL_VOLUME || "forge-local-runner-credentials";
const terminal = new Set(["succeeded", "failed", "stopped", "unknown"]);
const completed = (record: RunRecord) =>
  terminal.has(record.status) &&
  record.status !== "unknown" &&
  !!record.finishedAt;

async function readJSON<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function saveJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o644 });
  await rename(temporary, path);
}
const runPath = (id: string) => join(root, "runs", id, "record.json");
const versionPath = (request: ProjectRequest, attempt = request.attempt) =>
  join(root, "versions", `${request.projectId}-${attempt}.json`);

export async function initializeAttempt(
  request: ProjectRequest,
): Promise<void> {
  await mkdir(join(root, "versions"), { recursive: true });
  try {
    await writeFile(versionPath(request), "null", { flag: "wx", mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

// Read the catalog from the exact image that will execute it, without provider credentials.
async function imageManifest(image: string) {
  const name = `forge-catalog-${randomUUID()}`;
  try {
    await docker("POST", `/containers/create?name=${name}`, {
      Image: image,
      Entrypoint: ["bun", "/opt/forge/src/catalog.js"],
      HostConfig: {
        Init: true,
        ReadonlyRootfs: true,
        NetworkMode: "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 268_435_456,
        NanoCpus: 1_000_000_000,
      },
    });
    await docker("POST", `/containers/${name}/start`);
    const result = await docker<{ StatusCode: number }>(
      "POST",
      `/containers/${name}/wait?condition=not-running`,
    );
    if (result.StatusCode !== 0)
      throw new Error("Provisioner image catalog could not be read");
    const bytes = await dockerBytes(
      "GET",
      `/containers/${name}/logs?stdout=true&stderr=true`,
    );
    if (bytes.length > 180_000)
      throw new Error("Provisioner image catalog is too large");
    const manifest = parseManifest(JSON.parse(decodeDockerLogs(bytes)));
    for (const resource of ["azure", "github"] as const)
      for (const operation of ["Create", "Delete"] as const)
        taskFor(manifest, resource, operation);
    return manifest;
  } finally {
    // Includes recovery of a lost create response, using the unique inspection name.
    try {
      await docker("DELETE", `/containers/${name}?force=true`);
    } catch {}
  }
}

export async function pinVersion(
  request: ProjectRequest,
): Promise<ExecutionVersion> {
  const existing = await readJSON<ExecutionVersion>(versionPath(request));
  if (existing) return existing;
  const image = await docker<{ Id: string }>(
    "GET",
    `/images/${encodeURIComponent(process.env.RUNNER_IMAGE || "forge-provisioner:local")}/json`,
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id))
    throw new Error("Invalid runner image ID");
  const settings = {
    azureSubscriptionId: process.env.AZURE_SUBSCRIPTION_ID || "",
    azureRegion: process.env.AZURE_REGION || "",
    githubOrganization: process.env.GITHUB_ORG || "",
  };
  if (Object.values(settings).some((value) => !value))
    throw new Error(
      "Runner subscription, region, and GitHub organization must be configured",
    );
  const manifest = await imageManifest(image.Id);
  const version = { manifest, image: image.Id, settings };
  await saveJSON(versionPath(request), version);
  return version;
}

export async function previousVersion(
  request: ProjectRequest,
): Promise<ExecutionVersion | null> {
  for (let attempt = request.attempt - 1; attempt >= 1; attempt--) {
    let version: ExecutionVersion | null;
    try {
      version = JSON.parse(
        await readFile(versionPath(request, attempt), "utf8"),
      );
    } catch {
      throw new Error(
        "The previous attempt's provisioner version is unavailable; admin investigation is required",
      );
    }
    if (version) return version;
    // A null version records an attempt which never launched a new creation task.
  }
  return null;
}

export function runId(
  request: ProjectRequest,
  resource: Resource,
  operation: Operation,
  phase: string,
  attempt: number,
): string {
  return createHash("sha256")
    .update(
      `${request.projectId}:${request.attempt}:${phase}:${resource}:${operation}:${attempt}`,
    )
    .digest("hex")
    .slice(0, 32);
}

async function event(run: RunRecord, logs: RunLog[] = []): Promise<void> {
  const eventId = `${run.id}:${run.revision}:${logs.at(-1)?.sequence ?? 0}`;
  const message: RunEvent = { kind: "runner-event", eventId, run, logs };
  await saveJSON(
    join(
      root,
      "outbox",
      `${createHash("sha256").update(eventId).digest("hex")}.json`,
    ),
    message,
  );
}

type Container = {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: {
    Status: string;
    Running: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Error: string;
  };
};
async function inspect(container: string): Promise<Container | null> {
  try {
    return await docker<Container>("GET", `/containers/${container}/json`);
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return null;
    throw error;
  }
}

export async function startTask(
  request: ProjectRequest,
  resource: Resource,
  operation: Operation,
  phase: string,
  attempt: number,
  version: ExecutionVersion,
): Promise<string> {
  const id = runId(request, resource, operation, phase, attempt);
  const container = `forge-run-${id}`;
  const task = taskFor(version.manifest, resource, operation);
  let record = await readJSON<RunRecord>(runPath(id));
  let current = await inspect(container);
  if (record && JSON.stringify(record.version) !== JSON.stringify(version))
    throw new Error("Run version does not match its recovery record");
  if (!record && current)
    throw new Error("An execution exists without its recovery record");
  if (!record) {
    const work = join(root, "runs", id, "work");
    const output = join(root, "runs", id, "output");
    await mkdir(output, { recursive: true });
    await chmod(output, 0o777);
    await mkdir(work, { recursive: true });
    await saveJSON(join(work, "request.json"), request);
    const args = taskArguments(task, request, version.settings);
    await saveJSON(join(work, "arguments.json"), args);
    await saveJSON(join(work, "task.json"), task);
    await saveJSON(join(work, "settings.json"), version.settings);
    record = {
      id,
      revision: 0,
      projectId: request.projectId,
      projectAttempt: request.attempt,
      taskAttempt: attempt,
      phase,
      task,
      parameters: request,
      arguments: args,
      version,
      container,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
    };
    await saveJSON(runPath(id), record);
    await event(record);
  }
  if (
    current &&
    (current.Config.Labels["forge.runId"] !== id ||
      current.Config.Image !== version.image)
  )
    throw new Error(
      "Execution identity or image does not match its pinned version",
    );
  // Cleared containers still have an authoritative outcome for workflow replay.
  if (completed(record)) return id;
  if (!current) {
    if (
      record.status !== "queued" ||
      (await readJSON<boolean>(join(root, "runs", id, "launch.json")))
    )
      throw new Error(
        "The previous execution is missing; its outcome is uncertain",
      );
    try {
      await docker("POST", `/containers/create?name=${container}`, {
        Image: version.image,
        Labels: {
          "forge.runId": id,
          "forge.projectId": request.projectId,
          "forge.runner": task.runner,
          "forge.projectCode": request.code,
          "forge.projectAttempt": String(request.attempt),
          "forge.taskId": task.id,
          "forge.taskAttempt": String(attempt),
          "forge.resource": resource,
          "forge.operation": operation,
        },
        WorkingDir: "/workspace",
        HostConfig: {
          Init: true,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          NetworkMode: process.env.RUNNER_NETWORK || "forge-local_default",
          Memory: 1_610_612_736,
          NanoCpus: 1_000_000_000,
          Tmpfs: {
            "/tmp": "rw,nosuid,size=512m,mode=1777",
            "/home/runner": "rw,nosuid,size=64m,uid=10001,gid=10001",
          },
          RestartPolicy: { Name: "no" },
          Mounts: [
            {
              Type: "volume",
              Source: dataVolume,
              Target: "/workspace",
              ReadOnly: true,
              VolumeOptions: { Subpath: `runs/${id}/work` },
            },
            {
              Type: "volume",
              Source: dataVolume,
              Target: "/run/forge-output",
              VolumeOptions: { Subpath: `runs/${id}/output` },
            },
            {
              Type: "volume",
              Source: credentialVolume,
              Target: "/run/secrets/forge",
              ReadOnly: true,
            },
          ],
          LogConfig: {
            Type: "json-file",
            // The separate durable spool preserves output through log rotation.
            Config: { "max-size": "20m", "max-file": "2", mode: "blocking" },
          },
        },
      });
    } catch (error) {
      // A lost create response is recovered by its deterministic name, never a new name.
      current = await inspect(container);
      if (!current) throw error;
      if (
        current.Config.Labels["forge.runId"] !== id ||
        current.Config.Image !== version.image
      )
        throw new Error("Existing execution does not match this run");
    }
    current ??= await inspect(container);
  }
  if (!current) throw new Error("Execution could not be located");
  if (current.State.Status === "created") {
    // Once a start was requested, a missing container can never safely be recreated.
    await saveJSON(join(root, "runs", id, "launch.json"), true);
    try {
      await docker("POST", `/containers/${container}/start`);
    } catch (error) {
      const recovered = await inspect(container);
      if (!recovered || recovered.State.Status === "created") throw error;
    }
  }
  return id;
}

export async function taskStatus(id: string): Promise<RunRecord["status"]> {
  const record = await readJSON<RunRecord>(runPath(id));
  if (!record) throw new Error("Execution recovery record is unavailable");
  if (completed(record)) return record.status;
  const current = await inspect(record.container);
  const stopRequested = await readJSON<boolean>(
    join(root, "runs", id, "stop.json"),
  );
  const status = !current
    ? "unknown"
    : current.State.Running
      ? "running"
      : current.State.Status === "created"
        ? "queued"
        : current.State.Status === "exited"
          ? current.State.ExitCode === 0
            ? "succeeded"
            : stopRequested
              ? "stopped"
              : "failed"
          : "unknown";
  if (status !== record.status) {
    record.status = status;
    record.revision++;
    record.startedAt =
      current?.State.StartedAt && !current.State.StartedAt.startsWith("0001")
        ? current.State.StartedAt
        : null;
    if (terminal.has(status)) {
      record.finishedAt =
        current?.State.FinishedAt &&
        !current.State.FinishedAt.startsWith("0001")
          ? current.State.FinishedAt
          : new Date().toISOString();
      record.exitCode = current?.State.ExitCode ?? null;
      record.error =
        status === "succeeded"
          ? null
          : status === "unknown"
            ? "Execution outcome is uncertain"
            : `Task ended ${status} with exit code ${record.exitCode}`;
    }
    await saveJSON(runPath(id), record);
    // Event delivery is asynchronous; a messaging outage cannot cause resource deletion.
    await event(record);
  }
  return status;
}

export async function stopTask(id: string): Promise<void> {
  const record = await readJSON<RunRecord>(runPath(id));
  if (!record) throw new Error("Execution recovery record is unavailable");
  await saveJSON(join(root, "runs", id, "stop.json"), true);
  await docker("POST", `/containers/${record.container}/stop?t=10`);
}
export async function taskFailure(id: string): Promise<string> {
  return (
    (await readJSON<RunRecord>(runPath(id)))?.error ||
    "Provisioning task failed; see the admin run log"
  );
}

export async function acknowledgeRunnerEvent(eventId: string): Promise<void> {
  if (!/^[a-f0-9]{32}:\d+:\d+$/.test(eventId))
    throw new Error("Invalid runner acknowledgement");
  await rm(
    join(
      root,
      "outbox",
      `${createHash("sha256").update(eventId).digest("hex")}.json`,
    ),
    { force: true },
  );
}

type Cursor = {
  timestamp: string;
  sequence: number;
  complete: boolean;
  offset?: number;
};

/** Remove completed containers only; preserve history, logs, and recovery data. */
export async function clearCompletedRuns(): Promise<{
  removed: number;
  skipped: number;
}> {
  const result = { removed: 0, skipped: 0 };
  await mkdir(join(root, "runs"), { recursive: true });
  for (const id of await readdir(join(root, "runs"))) {
    if (!/^[a-f0-9]{32}$/.test(id)) continue;
    const record = await readJSON<RunRecord>(runPath(id));
    if (!record) continue;
    const cursor = await readJSON<Cursor>(
      join(root, "runs", id, "cursor.json"),
    );
    if (!completed(record) || !cursor?.complete) {
      result.skipped++;
      continue;
    }
    const current = await inspect(record.container);
    if (!current) continue;
    if (
      record.id !== id ||
      record.container !== `forge-run-${id}` ||
      current.Config.Labels["forge.runId"] !== id ||
      current.Config.Image !== record.version.image ||
      current.State.Running ||
      current.State.Status !== "exited"
    ) {
      result.skipped++;
      continue;
    }
    try {
      // Never force removal: Docker also rejects a concurrent restart.
      await docker("DELETE", `/containers/${current.Id}`);
      result.removed++;
    } catch (error) {
      if (!(error instanceof DockerError)) throw error;
      if (error.status === 409) result.skipped++;
      else if (error.status !== 404) throw error;
    }
  }
  return result;
}

async function* logLines(record: RunRecord, cursor: Cursor) {
  const output = join(root, "runs", record.id, "output");
  const path = join(output, "logs.jsonl");
  const archived = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!archived) {
    // Compatibility with old executions, or fallback if the archive is unavailable.
    const since = cursor.timestamp
      ? Math.floor(Date.parse(cursor.timestamp) / 1000)
      : 0;
    const bytes = await dockerBytes(
      "GET",
      `/containers/${record.container}/logs?stdout=1&stderr=1&timestamps=1&since=${since}`,
    );
    for (const line of decodeDockerLogs(bytes).split("\n").filter(Boolean)) {
      const boundary = line.indexOf(" ");
      const timestamp = line.slice(0, boundary);
      if (timestamp > cursor.timestamp)
        yield { text: line.slice(boundary + 1), timestamp, offset: undefined };
    }
    return;
  }
  let offset = cursor.offset || 0;
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { start: offset })) {
    pending = Buffer.concat([pending, chunk]);
    let end = pending.indexOf(10);
    while (end !== -1) {
      offset += end + 1;
      yield {
        text: pending.subarray(0, end).toString("utf8"),
        timestamp: "",
        offset,
      };
      pending = pending.subarray(end + 1);
      end = pending.indexOf(10);
    }
  }
  // A partially written final line is read again on the next observation.
}
async function captureLogs(record: RunRecord): Promise<void> {
  const path = join(root, "runs", record.id, "cursor.json");
  const cursor = (await readJSON<Cursor>(path)) || {
    timestamp: "",
    sequence: 0,
    complete: false,
  };
  if (cursor.complete) return;
  let logs: RunLog[] = [];
  for await (const line of logLines(record, cursor)) {
    let entry: { timestamp?: string; stream?: string; text?: string };
    try {
      entry = JSON.parse(line.text);
    } catch {
      entry = {
        text: "Runner emitted an unstructured diagnostic; consult the local container.",
      };
    }
    const log: RunLog = {
      sequence: ++cursor.sequence,
      timestamp: entry.timestamp || line.timestamp || record.createdAt,
      stream:
        entry.stream === "stdout" || entry.stream === "stderr"
          ? entry.stream
          : "system",
      text: String(entry.text || "").slice(0, 8192),
    };
    if (
      logs.length &&
      Buffer.byteLength(JSON.stringify({ run: record, logs: [...logs, log] })) >
        240_000
    ) {
      await event(record, logs);
      logs = [];
    }
    logs.push(log);
    cursor.timestamp = line.timestamp;
    cursor.offset = line.offset;
    if (logs.length === 20) {
      await event(record, logs);
      logs = [];
    }
  }
  if (logs.length) await event(record, logs);
  // Terminal status comes from a completed container, so its output is now stable.
  cursor.complete = terminal.has(record.status) && record.status !== "unknown";
  await saveJSON(path, cursor);
}

export async function observeRunners(
  sender: ServiceBusSender,
): Promise<() => void> {
  await mkdir(join(root, "runs"), { recursive: true });
  await mkdir(join(root, "outbox"), { recursive: true });
  const retention = Number(process.env.RUNNER_LOG_RETENTION_DAYS || 90);
  if (!Number.isInteger(retention) || retention < 1)
    throw new Error("RUNNER_LOG_RETENTION_DAYS must be a positive integer");
  let busy = false;
  let lastPrune = 0;
  const sent = new Map<string, number>();
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const pruneDue = Date.now() - lastPrune > 3_600_000;
      for (const id of await readdir(join(root, "runs"))) {
        const record = await readJSON<RunRecord>(runPath(id));
        if (!record) continue;
        try {
          await captureLogs(record);
        } catch {
          /* Logs can catch up from the retained container after an outage. */
        }
        if (
          pruneDue &&
          record.finishedAt &&
          terminal.has(record.status) &&
          record.status !== "unknown" &&
          Date.parse(record.finishedAt) < Date.now() - retention * 86_400_000
        ) {
          // Keep run metadata, source, and pinned images available for admin retry.
          const cursor = await readJSON<Cursor>(
            join(root, "runs", id, "cursor.json"),
          );
          if (cursor?.complete) {
            await rm(join(root, "runs", id, "output"), {
              recursive: true,
              force: true,
            });
            try {
              await docker("DELETE", `/containers/${record.container}`);
            } catch {
              /* Already removed or unavailable. */
            }
          }
        }
      }
      if (pruneDue) lastPrune = Date.now();
      for (const file of await readdir(join(root, "outbox"))) {
        if (!file.endsWith(".json")) continue;
        if (Date.now() - (sent.get(file) || 0) < 30_000) continue;
        const path = join(root, "outbox", file);
        const message = await readJSON<RunEvent>(path);
        if (!message) continue;
        if (
          message.logs.length &&
          message.run.finishedAt &&
          Date.parse(message.run.finishedAt) <
            Date.now() - retention * 86_400_000
        ) {
          await event(message.run);
          await rm(path);
          continue;
        }
        await sender.sendMessages({
          messageId: `${message.eventId}:${Math.floor(Date.now() / 30_000)}`,
          body: message,
        });
        sent.set(file, Date.now());
      }
      const pending = new Set(await readdir(join(root, "outbox")));
      for (const file of sent.keys()) if (!pending.has(file)) sent.delete(file);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(
    () =>
      void tick().catch(() =>
        console.error("Runner events temporarily unavailable; retrying"),
      ),
    1000,
  ).unref();
  return () => clearInterval(timer);
}
