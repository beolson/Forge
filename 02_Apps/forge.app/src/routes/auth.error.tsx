import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

export const Route = createFileRoute("/auth/error")({ component: AuthError });

function AuthError() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-md space-y-5 text-center">
        <h1 className="text-3xl font-semibold">Sign-in failed</h1>
        <p className="text-muted-foreground">
          Forge could not complete Microsoft sign-in. Please try again.
        </p>
        <a href="/auth/login" className={buttonVariants()}>
          Try again
        </a>
      </div>
    </main>
  );
}
