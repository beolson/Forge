import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function waitUntilReady(
  name: string,
  check: () => Promise<boolean>,
  timeout = 120000,
  interval = 1000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        console.log(`${name} is ready.`);
        return;
      }
    } catch {
      // Dependencies can refuse connections while their containers initialize.
    }
    await setTimeout(interval);
  }
  throw new Error(
    `${name} did not become ready within ${timeout / 1000} seconds. Check its dashboard logs.`,
  );
}

async function setup(command: string | undefined): Promise<void> {
  switch (command) {
    case "preflight": {
      await execute("docker", ["info", "--format", "{{.ServerVersion}}"]);
      const { stdout } = await execute("docker", [
        "ps",
        "--filter",
        "label=com.docker.compose.project=forge-local",
        "--format",
        "{{.Names}}",
      ]);
      if (stdout.trim()) {
        throw new Error(
          "The Compose stack is running. Run just down before starting Aspire; its volumes will be preserved.",
        );
      }
      console.log("Docker is available and Compose is stopped.");
      break;
    }
    case "network": {
      const network = "forge-local_default";
      try {
        await execute("docker", ["network", "inspect", network]);
      } catch {
        await execute("docker", [
          "network",
          "create",
          "--driver",
          "bridge",
          "--label",
          "com.docker.compose.project=forge-local",
          "--label",
          "com.docker.compose.network=default",
          network,
        ]);
      }
      console.log("Runner network is available.");
      break;
    }
    case "postgres":
      await waitUntilReady("PostgreSQL", async () => {
        await execute(
          "docker",
          [
            "exec",
            "forge-aspire-postgres",
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "postgres",
            "-d",
            "postgres",
          ],
          { timeout: 3000 },
        );
        return true;
      });
      break;
    case "servicebus":
      await waitUntilReady("Service Bus emulator", async () => {
        const response = await fetch("http://localhost:5300/health", {
          signal: AbortSignal.timeout(3000),
        });
        await response.body?.cancel();
        return response.ok;
      });
      break;
    default:
      throw new Error(
        "Expected setup command: preflight, network, postgres, or servicebus.",
      );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await setup(process.argv[2]);
  } catch (error) {
    // execFile errors can contain command output; do not dump their full objects.
    console.error(
      error instanceof Error ? error.message : "Local setup failed.",
    );
    process.exitCode = 1;
  }
}
