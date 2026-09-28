import { spawn } from "node:child_process";

export class ProviderError extends Error {
  constructor(public exitCode: number) {
    super(`Azure CLI exited with code ${exitCode}`);
  }
}

// Shell-free arguments and inherited stderr keep provider diagnostics available to the executor.
export function azureCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("az", args, {
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) reject(new ProviderError(signal === "SIGINT" ? 130 : 143));
      else if (code !== 0) reject(new ProviderError(code ?? 1));
      else resolve(Buffer.concat(output).toString("utf8").trim());
    });
  });
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export async function cli(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Provisioning failed",
    );
    process.exitCode = error instanceof ProviderError ? error.exitCode : 1;
  }
}
