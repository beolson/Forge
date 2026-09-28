import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AdminHeader } from "@/components/admin-header";
import { SourceViewer } from "@/components/source-viewer";
import { getTaskCatalog } from "@/lib/runs.functions";

export const Route = createFileRoute("/admin/tasks")({ component: Tasks });
function Tasks() {
  const [source, setSource] = useState<Awaited<
    ReturnType<typeof getTaskCatalog>
  > | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setSource(await getTaskCatalog());
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Scripts are unavailable",
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
        <AdminHeader title="Provisioning scripts" />
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="rounded border px-3 py-2 disabled:opacity-40"
        >
          {busy ? "Loading…" : "Refresh approved source"}
        </button>
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {source && (
          <>
            <ul className="grid gap-3 sm:grid-cols-2">
              {source.manifest.tasks.map((task) => (
                <li key={task.id} className="rounded border p-4">
                  <h2 className="font-semibold">{task.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {task.runner} · {task.runtime} · {task.entrypoint}
                  </p>
                </li>
              ))}
            </ul>
            <SourceViewer key={source.revision} source={source} />
          </>
        )}
      </div>
    </main>
  );
}
