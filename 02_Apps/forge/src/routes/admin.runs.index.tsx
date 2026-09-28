import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AdminHeader } from "@/components/admin-header";
import { getRuns } from "@/lib/runs.functions";

export const Route = createFileRoute("/admin/runs/")({
  component: Runs,
  loader: () => getRuns({ data: { offset: 0 } }),
});

function Runs() {
  const [page, setPage] = useState(0);
  const [listing, setListing] = useState<Awaited<
    ReturnType<typeof getRuns>
  > | null>(Route.useLoaderData());
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setListing(await getRuns({ data: { offset: page * 50 } }));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runs are unavailable");
    }
  }, [page]);
  useEffect(() => {
    void refresh();
    const stream = new EventSource("/api/admin/runs/events");
    stream.onmessage = (event) => {
      const value = JSON.parse(event.data);
      if (value.ready || value.changed) void refresh();
    };
    return () => stream.close();
  }, [refresh]);
  return (
    <main className="min-h-svh bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-6xl space-y-6">
        <AdminHeader title="Provisioning runs" />
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {listing && listing.runs.length === 0 && <p>No runs yet.</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-3">Project</th>
                <th className="p-3">Task</th>
                <th className="p-3">Attempt</th>
                <th className="p-3">Status</th>
                <th className="p-3">Started</th>
              </tr>
            </thead>
            <tbody>
              {listing?.runs.map(({ data: run, name, code }) => (
                <tr key={run.id} className="border-b">
                  <td className="p-3">
                    {name} <span className="font-mono">{code}</span>
                  </td>
                  <td className="p-3">
                    <Link
                      to="/admin/runs/$runId"
                      params={{ runId: run.id }}
                      className="underline"
                    >
                      {run.task.name}
                    </Link>
                  </td>
                  <td className="p-3">
                    Project {run.projectAttempt} · task {run.taskAttempt}/3 ·{" "}
                    {run.phase}
                  </td>
                  <td className="p-3 capitalize">{run.status}</td>
                  <td className="p-3">
                    {new Date(run.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="rounded border px-3 py-2 disabled:opacity-40"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>Page {page + 1}</span>
          <button
            type="button"
            className="rounded border px-3 py-2 disabled:opacity-40"
            disabled={!listing?.hasMore}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </main>
  );
}
