import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { logout } from "@/lib/auth.functions";
import {
  getProjects,
  retryFailedProject,
  submitProject,
} from "@/lib/projects.functions";

export const Route = createFileRoute("/")({ component: Home });

type Listing = Awaited<ReturnType<typeof getProjects>>;

function Home() {
  const { user } = Route.useRouteContext();
  const [listing, setListing] = useState<Listing | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setListing(await getProjects());
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/projects/events");
    events.onmessage = () => {
      void refresh();
    };
    return () => events.close();
  }, [refresh]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await submitProject({ data: { name, code, description } });
      setName("");
      setCode("");
      setDescription("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function retry(id: string) {
    setError("");
    try {
      await retryFailedProject({ data: { id } });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className="min-h-svh bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-4xl space-y-10">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Forge
            </p>
            <h1 className="text-3xl font-semibold">Projects</h1>
            <p className="text-sm text-muted-foreground">
              Signed in as {user?.name}
            </p>
          </div>
          <button
            type="button"
            className="rounded-md border px-4 py-2"
            onClick={async () => {
              await logout();
              window.location.assign("/auth/signed-out");
            }}
          >
            Sign out
          </button>
        </header>
        {listing?.admin && (
          <nav className="flex gap-5 text-sm">
            <Link to="/admin/runs" className="underline">
              Provisioning runs
            </Link>
            <Link to="/admin/tasks" className="underline">
              Scripts
            </Link>
          </nav>
        )}

        <section className="rounded-xl border p-6">
          <h2 className="mb-4 text-xl font-semibold">Create a project</h2>
          <form onSubmit={create} className="grid gap-4">
            <label className="grid gap-1 text-sm font-medium">
              Name
              <input
                required
                maxLength={50}
                pattern="[A-Za-z0-9]([A-Za-z0-9 -]*[A-Za-z0-9])?"
                title="Use letters, digits, spaces, and hyphens; start and end with a letter or digit."
                className="rounded-md border bg-background px-3 py-2"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Five-letter code
              <input
                required
                minLength={5}
                maxLength={5}
                pattern="[A-Za-z]{5}"
                className="w-36 rounded-md border bg-background px-3 py-2 uppercase"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Description
              <textarea
                required
                maxLength={500}
                rows={3}
                className="rounded-md border bg-background px-3 py-2"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <p className="text-sm text-muted-foreground">
              Creates a private GitHub repository and an Azure resource group.
            </p>
            <button
              disabled={busy}
              className="w-fit rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
              type="submit"
            >
              {busy ? "Submitting…" : "Create project"}
            </button>
          </form>
          {error && (
            <p role="alert" className="mt-4 text-sm text-red-600">
              {error}
            </p>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">
            {listing?.admin ? "All projects" : "Your projects"}
          </h2>
          {listing?.projects.length === 0 && (
            <p className="text-muted-foreground">No projects yet.</p>
          )}
          {listing?.projects.map((project) => (
            <article key={project.id} className="rounded-xl border p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">
                    {project.name}{" "}
                    <span className="font-mono text-sm text-muted-foreground">
                      {project.code}
                    </span>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {project.description}
                  </p>
                </div>
                <span className="rounded-full border px-3 py-1 text-sm capitalize">
                  {project.status.replaceAll("_", " ")}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-sm">
                <span>
                  Azure:{" "}
                  {project.azureUrl ? (
                    <a
                      className="underline"
                      href={project.azureUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {project.resource_group_name}
                    </a>
                  ) : (
                    project.resource_group_name
                  )}
                </span>
                <span>
                  GitHub:{" "}
                  {project.githubUrl ? (
                    <a
                      className="underline"
                      href={project.githubUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {project.repository_name}
                    </a>
                  ) : (
                    project.repository_name
                  )}
                </span>
              </div>
              {project.status === "ready" && (
                <p className="mt-2 text-sm">Resources are ready.</p>
              )}
              {project.error && (
                <p role="alert" className="mt-3 text-sm text-red-600">
                  {project.error}
                </p>
              )}
              {project.events.length > 0 && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer">
                    Provisioning activity
                  </summary>
                  <ol className="mt-2 space-y-1 border-l pl-4">
                    {project.events.map((entry) => (
                      <li key={entry.id}>
                        {entry.resource ? `${entry.resource}: ` : ""}
                        {entry.detail}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {listing.admin &&
                (project.status === "failed" ||
                  project.status === "cleanup_failed") && (
                  <button
                    type="button"
                    className="mt-4 rounded-md border px-3 py-2 text-sm"
                    onClick={() => void retry(project.id)}
                  >
                    Try again
                  </button>
                )}
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
