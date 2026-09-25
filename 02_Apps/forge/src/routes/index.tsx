import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
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
          A server-rendered foundation for what comes next.
        </p>
        <a
          href="https://tanstack.com/start"
          className={buttonVariants({ variant: "default" })}
        >
          Explore TanStack Start
        </a>
      </div>
    </main>
  );
}
