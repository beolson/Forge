import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecuteCommandResult } from "./.aspire/modules/aspire.mjs";

const execute = promisify(execFile);

export async function clearCompletedRuns(): Promise<ExecuteCommandResult> {
  try {
    const { stdout } = await execute(
      "docker",
      ["exec", "forge-orchistrator", "bun", "src/clear-runs.ts"],
      { timeout: 120_000, maxBuffer: 64 * 1024 },
    );
    const result = JSON.parse(stdout) as { removed: number; skipped: number };
    if (
      !Number.isSafeInteger(result.removed) ||
      result.removed < 0 ||
      !Number.isSafeInteger(result.skipped) ||
      result.skipped < 0
    )
      throw new Error("Invalid cleanup result");
    return {
      success: true,
      message: `Cleared ${result.removed} completed runs. ${result.skipped} runs retained because they are active, uncertain, or not ready for cleanup. Forge history and logs are preserved.`,
    };
  } catch {
    return {
      success: false,
      errorMessage:
        "Could not finish clearing completed runs. Ensure forge-orchistrator and Docker are available, then retry. Runs already cleared remain recorded in Forge.",
    };
  }
}
