import type { RunLog } from "@hero4hire/automation";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AdminHeader } from "@/components/admin-header";
import { getRun, getRunLogs } from "@/lib/runs.functions";

export const Route = createFileRoute("/admin/runs/$runId")({
  component: RunDetail,
  loader: ({ params }) => getRun({ data: { id: params.runId } }),
});

function RunDetail() {
  const { runId } = Route.useParams();
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof getRun>
  > | null>(Route.useLoaderData());
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const logBottom = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let cursor = 0;
    let pending = Promise.resolve();
    setDetail(null);
    setLogs([]);
    setError("");
    const refresh = (changed: boolean) => {
      pending = pending.then(async () => {
        if (cancelled) return;
        try {
          if (changed) {
            const value = await getRun({ data: { id: runId } });
            if (!cancelled) setDetail(value);
          }
          for (;;) {
            const batch = await getRunLogs({
              data: { id: runId, after: cursor },
            });
            if (cancelled) return;
            if (batch.logs.length) {
              cursor = batch.nextCursor;
              setLogs((value) =>
                [...value, ...batch.logs].sort(
                  (a, b) => a.sequence - b.sequence,
                ),
              );
            }
            if (!batch.hasMore) break;
          }
          if (!cancelled) setError("");
        } catch (cause) {
          if (!cancelled)
            setError(
              cause instanceof Error ? cause.message : "Run is unavailable",
            );
        }
      });
    };
    refresh(true);
    const stream = new EventSource(`/api/admin/runs/events?runId=${runId}`);
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = (event) => {
      const value = JSON.parse(event.data);
      refresh(!!(value.ready || value.changed));
    };
    return () => {
      cancelled = true;
      stream.close();
    };
  }, [runId]);
  useEffect(() => {
    if (follow) logBottom.current?.scrollIntoView({ block: "nearest" });
  });
  const run = detail?.data;
  return (
    <main className="min-h-svh bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-6xl space-y-6">
        <AdminHeader title={run?.task.name || "Provisioning run"} />
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {run && (
          <>
            <section className="grid gap-2 rounded-xl border p-5 text-sm">
              <p>
                {detail.name} · <strong>{detail.code}</strong> ·{" "}
                <span className="capitalize">{run.status}</span>
              </p>
              <p>
                Project attempt {run.projectAttempt} · task attempt{" "}
                {run.taskAttempt}/3 · {run.phase} · runner {run.task.runner}
              </p>
              <p>
                Started:{" "}
                {run.startedAt
                  ? new Date(run.startedAt).toLocaleString()
                  : "Pending"}{" "}
                · Finished:{" "}
                {run.finishedAt
                  ? new Date(run.finishedAt).toLocaleString()
                  : "—"}{" "}
                · Exit code: {run.exitCode ?? "—"}
              </p>
              <p className="break-all">
                Image: <code>{run.version.image}</code>
              </p>
              <p className="break-all">
                Execution: <code>{run.container}</code>
              </p>
              {run.error && <p className="text-red-600">{run.error}</p>}
            </section>
            <section>
              <h2 className="mb-2 text-xl font-semibold">Parameters</h2>
              <pre className="overflow-auto rounded border bg-muted p-4 text-xs">
                {JSON.stringify(
                  { project: run.parameters, settings: run.version.settings },
                  null,
                  2,
                )}
              </pre>
            </section>
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">Execution log</h2>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(event) => setFollow(event.target.checked)}
                  />
                  Follow output
                </label>
              </div>
              <p className="text-sm text-muted-foreground">
                {connected
                  ? "Live updates connected"
                  : "Reconnecting; saved logs remain available"}
              </p>
              {detail.logsExpired && (
                <p>Detailed logs have expired under the retention policy.</p>
              )}
              <section
                className="max-h-[32rem] overflow-auto rounded-lg border bg-muted p-4 font-mono text-xs"
                aria-label="Execution log"
              >
                {logs.length === 0 && <p>No output received yet.</p>}
                {logs.map((log) => (
                  <div
                    key={log.sequence}
                    className={`whitespace-pre-wrap break-words ${log.stream === "stderr" ? "text-red-600" : ""}`}
                  >
                    <span className="text-muted-foreground">
                      {new Date(log.timestamp).toLocaleTimeString()} [
                      {log.stream}]{" "}
                    </span>
                    {log.text}
                  </div>
                ))}
                <div ref={logBottom} />
              </section>
            </section>
            <section>
              <h2 className="mb-3 text-xl font-semibold">Task configuration</h2>
              <pre className="overflow-auto rounded border bg-muted p-4 text-xs">
                {JSON.stringify(
                  { task: run.task, arguments: run.arguments },
                  null,
                  2,
                )}
              </pre>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
