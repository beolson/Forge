import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from "@azure/service-bus";
import {
  type ProjectEvent,
  type ProjectInput,
  type ProjectRequest,
  parseProjectInput,
  repositoryName,
  resourceGroupName,
} from "@hero4hire/project";
import { Pool, type PoolClient } from "pg";
import { currentUser, type ForgeUser, isAdmin } from "./auth.server";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const bus = new EventEmitter();
bus.setMaxListeners(0);
let initialized: Promise<void> | undefined;
let messaging: Promise<void> | undefined;

export type ProjectRow = {
  id: string;
  code: string;
  name: string;
  description: string;
  repository_name: string;
  resource_group_name: string;
  status: string;
  attempt: number;
  error: string | null;
  created_at: string;
};

export async function database(): Promise<Pool> {
  initialized ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS forge_projects (
        id uuid PRIMARY KEY, code char(5) NOT NULL UNIQUE, name varchar(50) NOT NULL,
        description varchar(500) NOT NULL, repository_name varchar(100) NOT NULL,
        resource_group_name varchar(100) NOT NULL, creator_tenant_id text NOT NULL,
        creator_object_id text NOT NULL, status text NOT NULL, attempt integer NOT NULL DEFAULT 1,
        error text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS forge_outbox (
        id bigserial PRIMARY KEY, message_id text NOT NULL UNIQUE, payload jsonb NOT NULL,
        sent_at timestamptz, last_requeued_at timestamptz
      );
      ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS last_requeued_at timestamptz;
      CREATE TABLE IF NOT EXISTS forge_inbox (message_id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS forge_project_events (
        id bigserial PRIMARY KEY, project_id uuid NOT NULL REFERENCES forge_projects(id),
        attempt integer NOT NULL, status text NOT NULL, resource text, detail text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE forge_project_events ADD COLUMN IF NOT EXISTS admin_detail text;
      CREATE TABLE IF NOT EXISTS forge_runs (
        id text PRIMARY KEY, project_id uuid NOT NULL REFERENCES forge_projects(id),
        revision integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL,
        finished_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS forge_runs_created ON forge_runs(created_at DESC, id);
      CREATE TABLE IF NOT EXISTS forge_run_logs (
        run_id text NOT NULL REFERENCES forge_runs(id), sequence integer NOT NULL,
        timestamp text NOT NULL, stream text NOT NULL, text text NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, sequence)
      );
      ALTER TABLE forge_run_logs ADD COLUMN IF NOT EXISTS arrival_id bigserial;
      CREATE INDEX IF NOT EXISTS forge_run_logs_arrival ON forge_run_logs(run_id,arrival_id);
    `);
  })();
  try {
    await initialized;
  } catch (error) {
    initialized = undefined;
    throw error;
  }
  return pool;
}

async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await (await database()).connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function requestFor(row: ProjectRow): ProjectRequest {
  return {
    kind: "create-project",
    projectId: row.id,
    attempt: row.attempt,
    code: row.code.trim(),
    name: row.name,
    description: row.description,
    repositoryName: row.repository_name,
  };
}

export async function requireUser(): Promise<ForgeUser> {
  const user = await currentUser();
  if (!user) throw new Error("Sign in is required.");
  return user;
}

export async function createProject(input: ProjectInput): Promise<ProjectRow> {
  const user = await requireUser();
  const parsed = parseProjectInput(input);
  const row = await transaction(async (client) => {
    const id = randomUUID();
    const result = await client.query<ProjectRow>(
      `INSERT INTO forge_projects (id,code,name,description,repository_name,resource_group_name,creator_tenant_id,creator_object_id,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *`,
      [
        id,
        parsed.code,
        parsed.name,
        parsed.description,
        repositoryName(parsed.code, parsed.name),
        resourceGroupName(parsed.code),
        user.tenantId,
        user.objectId,
      ],
    );
    const project = result.rows[0];
    await client.query(
      "INSERT INTO forge_outbox (message_id,payload) VALUES ($1,$2)",
      [`${id}:1`, requestFor(project)],
    );
    return project;
  }).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new Error("That five-letter code is already in use.");
    }
    throw error;
  });
  void ensureMessaging().catch((error) =>
    console.error("Forge messaging:", error),
  );
  return row;
}

export async function listProjects(): Promise<{
  projects: (ProjectRow & {
    azureUrl: string;
    githubUrl: string;
    events: {
      id: string;
      status: string;
      resource: string | null;
      detail: string;
    }[];
  })[];
  admin: boolean;
}> {
  const user = await requireUser();
  void ensureMessaging().catch((error) =>
    console.error("Forge messaging:", error),
  );
  const admin = isAdmin(user);
  const result = await (await database()).query<ProjectRow>(
    `SELECT id,code,name,description,repository_name,resource_group_name,status,attempt,error,created_at
     FROM forge_projects WHERE ($1::boolean OR (creator_tenant_id=$2 AND creator_object_id=$3)) ORDER BY created_at DESC`,
    [admin, user.tenantId, user.objectId],
  );
  const events = await (await database()).query<{
    id: string;
    project_id: string;
    status: string;
    resource: string | null;
    detail: string;
    admin_detail: string | null;
  }>(
    "SELECT id,project_id,status,resource,detail,admin_detail FROM forge_project_events WHERE project_id = ANY($1::uuid[]) ORDER BY id",
    [result.rows.map((row) => row.id)],
  );
  const subscription = process.env.AZURE_SUBSCRIPTION_ID ?? "";
  const org = process.env.GITHUB_ORG ?? "";
  return {
    projects: result.rows.map((row) => ({
      ...row,
      error: admin
        ? row.error
        : row.error
          ? "Provisioning failed. An admin can investigate and retry."
          : null,
      azureUrl: subscription
        ? `https://portal.azure.com/#@/resource/subscriptions/${encodeURIComponent(subscription)}/resourceGroups/${encodeURIComponent(row.resource_group_name)}/overview`
        : "",
      githubUrl: org
        ? `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(row.repository_name)}`
        : "",
      events: events.rows
        .filter((event) => event.project_id === row.id)
        .map((event) => ({
          id: event.id,
          status: event.status,
          resource: event.resource,
          detail: admin
            ? event.admin_detail || event.detail
            : event.admin_detail !== null
              ? event.detail
              : `${event.resource === "azure" ? "Azure resource group: " : event.resource === "github" ? "GitHub repository: " : ""}${event.status.replaceAll("_", " ")}`,
        })),
    })),
    admin,
  };
}

export async function retryProject(id: string): Promise<void> {
  const user = await requireUser();
  if (!isAdmin(user)) throw new Error("Only Forge admins can retry projects.");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  ) {
    throw new Error("Invalid project ID.");
  }
  await transaction(async (client) => {
    const current = await client.query<ProjectRow>(
      "SELECT * FROM forge_projects WHERE id=$1 FOR UPDATE",
      [id],
    );
    const row = current.rows[0];
    if (!row || (row.status !== "failed" && row.status !== "cleanup_failed")) {
      throw new Error("Only failed projects can be retried.");
    }
    row.attempt += 1;
    await client.query(
      "UPDATE forge_projects SET attempt=$2,status='queued',error=NULL WHERE id=$1",
      [id, row.attempt],
    );
    await client.query(
      "INSERT INTO forge_outbox (message_id,payload) VALUES ($1,$2)",
      [`${id}:${row.attempt}`, requestFor(row)],
    );
  });
  void ensureMessaging().catch((error) =>
    console.error("Forge messaging:", error),
  );
}

async function applyResult(message: ServiceBusReceivedMessage): Promise<void> {
  if (message.body?.kind === "runner-event") {
    const { applyRunEvent, notifyRun } = await import("./runs.server");
    const changed = await transaction((client) =>
      applyRunEvent(message.body, client),
    );
    if (changed !== null) notifyRun(message.body.run.id, changed);
    return;
  }
  const event = message.body as ProjectEvent;
  if (
    !event ||
    typeof event.eventId !== "string" ||
    typeof event.projectId !== "string"
  ) {
    throw new Error("Invalid Forge result message");
  }
  let visible = false;
  await transaction(async (client) => {
    const inserted = await client.query(
      "INSERT INTO forge_inbox (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id",
      [event.eventId],
    );
    if (!inserted.rowCount) return;
    const updated = await client.query(
      `UPDATE forge_projects SET
        status=CASE WHEN status IN ('ready','failed','cleanup_failed') THEN status
                    WHEN status='rolling_back' AND $3='provisioning' THEN status ELSE $3 END,
        error=CASE WHEN $3 IN ('failed','cleanup_failed') THEN $4 ELSE error END
       WHERE id=$1 AND attempt=$2 RETURNING id`,
      [
        event.projectId,
        event.attempt,
        event.status,
        event.adminDetail || event.detail,
      ],
    );
    if (!updated.rowCount) return;
    await client.query(
      "INSERT INTO forge_project_events (project_id,attempt,status,resource,detail,admin_detail) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        event.projectId,
        event.attempt,
        event.status,
        event.resource ?? null,
        event.detail,
        event.adminDetail || event.detail,
      ],
    );
    visible = true;
  });
  if (visible) bus.emit("project", event.projectId);
}

async function dispatchOutbox(
  sender: ReturnType<ServiceBusClient["createSender"]>,
): Promise<void> {
  const db = await database();
  const pending = await db.query<{
    id: string;
    message_id: string;
    payload: ProjectRequest;
  }>(
    "SELECT id,message_id,payload FROM forge_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20",
  );
  for (const row of pending.rows) {
    await sender.sendMessages({ body: row.payload, messageId: row.message_id });
    await pool.query("UPDATE forge_outbox SET sent_at=now() WHERE id=$1", [
      row.id,
    ]);
  }
  const stale = await db.query<{
    id: string;
    message_id: string;
    payload: ProjectRequest;
  }>(
    `SELECT o.id,o.message_id,o.payload FROM forge_outbox o
     JOIN forge_projects p ON p.id=(o.payload->>'projectId')::uuid
     WHERE o.sent_at < now() - interval '1 hour'
       AND (o.last_requeued_at IS NULL OR o.last_requeued_at < now() - interval '1 hour')
       AND p.attempt=(o.payload->>'attempt')::integer
       AND p.status IN ('queued','provisioning','rolling_back')
     ORDER BY o.id LIMIT 20`,
  );
  for (const row of stale.rows) {
    await sender.sendMessages({
      body: row.payload,
      messageId: `${row.message_id}:reconcile:${Date.now()}`,
    });
    await db.query(
      "UPDATE forge_outbox SET last_requeued_at=now() WHERE id=$1",
      [row.id],
    );
  }
}

export async function ensureMessaging(): Promise<void> {
  messaging ??= (async () => {
    await database();
    const connection = process.env.SERVICEBUS_CONNECTION_STRING;
    if (!connection)
      throw new Error("SERVICEBUS_CONNECTION_STRING must be configured");
    const client = new ServiceBusClient(connection);
    const receiver = client.createReceiver("forge-results");
    const sender = client.createSender("forge-requests");
    receiver.subscribe({
      processMessage: async (message) => {
        await applyResult(message);
        if (message.body?.kind === "runner-event")
          await sender.sendMessages({
            messageId: `ack:${message.body.eventId}:${Math.floor(Date.now() / 30_000)}`,
            body: { kind: "runner-ack", eventId: message.body.eventId },
          });
      },
      processError: async (args) => {
        console.error("Forge result consumer:", args.error);
      },
    });
    let dispatching = false;
    const dispatch = async () => {
      if (dispatching) return;
      dispatching = true;
      try {
        await dispatchOutbox(sender);
      } catch (error) {
        console.error("Forge outbox:", error);
      } finally {
        dispatching = false;
      }
    };
    await dispatch();
    setInterval(dispatch, 2000).unref();
    const retentionDays = Number(process.env.RUNNER_LOG_RETENTION_DAYS || 90);
    if (!Number.isInteger(retentionDays) || retentionDays < 1)
      throw new Error("RUNNER_LOG_RETENTION_DAYS must be a positive integer");
    const prune = () =>
      pool.query(
        "DELETE FROM forge_run_logs l USING forge_runs r WHERE l.run_id=r.id AND r.finished_at < now() - $1 * interval '1 day'",
        [retentionDays],
      );
    void prune().catch(() =>
      console.error("Run log retention temporarily unavailable"),
    );
    setInterval(
      () =>
        void prune().catch(() =>
          console.error("Run log retention temporarily unavailable"),
        ),
      3_600_000,
    ).unref();
  })().catch((error) => {
    messaging = undefined;
    throw error;
  });
  await messaging;
}

export function subscribeProjects(
  listener: (projectId: string) => void,
): () => void {
  bus.on("project", listener);
  return () => bus.off("project", listener);
}
