import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";
import { logout } from "@/lib/auth.functions";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user } = Route.useRouteContext();

  async function handleSignOut() {
    await logout();
    window.location.assign("/auth/signed-out");
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="w-full max-w-2xl space-y-6">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          Forge
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Ready to build.
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          Signed in as {user?.name}.
        </p>
        <button
          type="button"
          onClick={handleSignOut}
          className={buttonVariants({ variant: "default" })}
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
