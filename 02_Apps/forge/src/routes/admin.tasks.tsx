import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AdminHeader } from "@/components/admin-header";
import { getTaskCatalog } from "@/lib/runs.functions";

export const Route = createFileRoute("/admin/tasks")({ component: Tasks });
function Tasks() {
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<typeof getTaskCatalog>
  > | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setCatalog(await getTaskCatalog());
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Tasks are unavailable",
      );
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <main className="min-h-svh bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-6xl space-y-6">
        <AdminHeader title="Provisioning tasks" />
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="rounded border px-3 py-2 disabled:opacity-40"
        >
          {busy ? "Loading…" : "Refresh tasks"}
        </button>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {!busy && !catalog && !error && (
          <p>
            Task configuration will appear after the first provisioning run.
          </p>
        )}
        {catalog && (
          <>
            <ul className="grid gap-3 sm:grid-cols-2">
              {catalog.manifest.tasks.map((task) => (
                <li key={task.id} className="rounded border p-4">
                  <h2 className="font-semibold">{task.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {task.runner} · {task.runtime} · {task.action} ·{" "}
                    {task.entrypoint}
                  </p>
                </li>
              ))}
            </ul>
            <p className="break-all text-sm">
              Most recently used image: <code>{catalog.image}</code>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
