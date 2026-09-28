import { EventEmitter } from "node:events";
import type { RunEvent, RunLog, RunRecord } from "@hero4hire/automation";
import { parseManifest } from "@hero4hire/automation";
import type { PoolClient } from "pg";
import { isAdmin } from "./auth.server";
import { database, ensureMessaging, requireUser } from "./projects.server";

const events = new EventEmitter();
events.setMaxListeners(0);

export async function requireAdmin(): Promise<void> {
  if (!isAdmin(await requireUser()))
    throw new Error("Only Forge admins can view provisioning runs.");
}

export async function applyRunEvent(
  event: RunEvent,
  client: PoolClient,
): Promise<boolean | null> {
  const run = event?.run;
  if (
    !run ||
    !/^[a-f0-9]{32}$/.test(run.id) ||
    event.eventId !==
      `${run.id}:${run.revision}:${event.logs?.at(-1)?.sequence ?? 0}` ||
    !Number.isInteger(run.revision) ||
    run.revision < 0 ||
    !Array.isArray(event.logs) ||
    event.logs.length > 20 ||
    ![
      "queued",
      "running",
      "succeeded",
      "failed",
      "stopped",
      "unknown",
    ].includes(run.status) ||
    !run.version?.source ||
    !run.parameters ||
    run.parameters.projectId !== run.projectId ||
    !Number.isInteger(run.projectAttempt) ||
    !Number.isFinite(Date.parse(run.createdAt))
  )
    throw new Error("Invalid runner event");
  parseManifest(run.version.source.manifest);
  for (const log of event.logs) {
    if (
      !Number.isSafeInteger(log.sequence) ||
      log.sequence < 1 ||
      typeof log.text !== "string" ||
      log.text.length > 8192 ||
      !["stdout", "stderr", "system"].includes(log.stream) ||
      !Number.isFinite(Date.parse(log.timestamp))
    )
      throw new Error("Invalid runner log");
  }
  const inserted = await client.query(
    "INSERT INTO forge_inbox (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id",
    [`run:${event.eventId}`],
  );
  if (!inserted.rowCount) return null;
  const previous = await client.query<{ revision: number }>(
    "SELECT revision FROM forge_runs WHERE id=$1",
    [run.id],
  );
  await client.query(
    `INSERT INTO forge_runs (id,project_id,revision,data,created_at,finished_at) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,finished_at=EXCLUDED.finished_at
    WHERE forge_runs.revision <= EXCLUDED.revision`,
    [run.id, run.projectId, run.revision, run, run.createdAt, run.finishedAt],
  );
  for (const log of event.logs)
    await client.query(
      "INSERT INTO forge_run_logs (run_id,sequence,timestamp,stream,text) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [run.id, log.sequence, log.timestamp, log.stream, log.text],
    );
  return previous.rows[0]?.revision !== run.revision;
}

export function notifyRun(runId: string, changed: boolean): void {
  events.emit("run", { runId, changed });
}
export function subscribeRuns(
  listener: (event: { runId: string; changed: boolean }) => void,
): () => void {
  events.on("run", listener);
  return () => events.off("run", listener);
}

export async function listRuns(offset: number) {
  await requireAdmin();
  await ensureMessaging();
  const rows = await (await database()).query<{
    data: RunRecord;
    name: string;
    code: string;
  }>(
    `SELECT r.data #- '{version,source,files}' AS data,p.name,p.code FROM forge_runs r JOIN forge_projects p ON p.id=r.project_id
     ORDER BY r.created_at DESC,r.id LIMIT 51 OFFSET $1`,
    [offset],
  );
  return { runs: rows.rows.slice(0, 50), hasMore: rows.rows.length > 50 };
}

export async function runDetail(id: string) {
  await requireAdmin();
  await ensureMessaging();
  const row = await (await database()).query<{
    data: RunRecord;
    name: string;
    code: string;
  }>(
    "SELECT r.data,p.name,p.code FROM forge_runs r JOIN forge_projects p ON p.id=r.project_id WHERE r.id=$1",
    [id],
  );
  if (!row.rows[0]) throw new Error("Run not found");
  const retentionDays = Number(process.env.RUNNER_LOG_RETENTION_DAYS || 90);
  return {
    ...row.rows[0],
    logsExpired:
      !!row.rows[0].data.finishedAt &&
      Date.parse(row.rows[0].data.finishedAt) <
        Date.now() - retentionDays * 86_400_000,
  };
}

export async function runLogs(id: string, after: number) {
  await requireAdmin();
  await ensureMessaging();
  const rows = await (await database()).query<RunLog & { arrival_id: string }>(
    "SELECT sequence,timestamp,stream,text,arrival_id FROM forge_run_logs WHERE run_id=$1 AND arrival_id>$2 ORDER BY arrival_id LIMIT 501",
    [id, after],
  );
  const batch = rows.rows.slice(0, 500);
  return {
    logs: batch.map(({ arrival_id: _arrival, ...log }) => log),
    hasMore: rows.rows.length > 500,
    nextCursor: batch.length ? Number(batch.at(-1)?.arrival_id) : after,
  };
}

export async function taskCatalog() {
  await requireAdmin();
  const { loadSource } = await import("@hero4hire/automation/source");
  return loadSource();
}
