import { createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

export const Route = createFileRoute("/auth/signed-out")({
  component: SignedOut,
});

function SignedOut() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-md space-y-5 text-center">
        <h1 className="text-3xl font-semibold">Signed out of Forge</h1>
        <p className="text-muted-foreground">
          Your Microsoft account may still be signed in on this device.
        </p>
        <a href="/auth/login" className={buttonVariants()}>
          Sign in again
        </a>
      </div>
    </main>
  );
}
