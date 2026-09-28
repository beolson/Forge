import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";

export const requiredVariables = [
  "POSTGRES_PASSWORD",
  "FORGE_DB_PASSWORD",
  "CLOUDBEAVER_ADMIN_PASSWORD",
  "SERVICEBUS_ACCEPT_EULA",
  "SERVICEBUS_SQL_PASSWORD",
  "FORGE_ENTRA_TENANT_ID",
  "FORGE_ENTRA_CLIENT_ID",
  "FORGE_ENTRA_CLIENT_SECRET",
  "FORGE_AUTH_REDIRECT_URI",
  "FORGE_SESSION_SECRET",
  "FORGE_ADMIN_GROUP_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_REGION",
  "GITHUB_ORG",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
] as const;

export type Configuration = Record<
  (typeof requiredVariables)[number],
  string
> & {
  RUNNER_TASK_TIMEOUT_MS: string;
  RUNNER_LOG_RETENTION_DAYS: string;
};

export function loadConfiguration(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Configuration {
  let file: string;
  try {
    file = readFileSync(join(root, ".env"), "utf8");
  } catch {
    throw new Error(
      "Copy .env.example to the root .env and configure it first.",
    );
  }
  const values = { ...parseEnv(file), ...environment };
  const missing = requiredVariables.filter((name) => !values[name]?.trim());
  if (missing.length) {
    throw new Error(
      `Set these variables in the root .env: ${missing.join(", ")}`,
    );
  }
  if (values.SERVICEBUS_ACCEPT_EULA !== "Y") {
    throw new Error(
      "Set SERVICEBUS_ACCEPT_EULA=Y after accepting the emulator and SQL Server terms.",
    );
  }
  if ((values.FORGE_SESSION_SECRET?.length ?? 0) < 32) {
    throw new Error(
      "FORGE_SESSION_SECRET must contain at least 32 characters.",
    );
  }
  const keyPath = values.GITHUB_APP_PRIVATE_KEY_PATH as string;
  if (!isAbsolute(keyPath)) {
    throw new Error("GITHUB_APP_PRIVATE_KEY_PATH must be an absolute path.");
  }
  try {
    accessSync(keyPath, constants.R_OK);
  } catch {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY_PATH must point to a readable PEM file.",
    );
  }
  const timeout = values.RUNNER_TASK_TIMEOUT_MS || "1800000";
  const retention = values.RUNNER_LOG_RETENTION_DAYS || "90";
  if (!Number.isFinite(Number(timeout)) || Number(timeout) < 60000) {
    throw new Error("RUNNER_TASK_TIMEOUT_MS must be at least 60000.");
  }
  if (!Number.isInteger(Number(retention)) || Number(retention) < 1) {
    throw new Error("RUNNER_LOG_RETENTION_DAYS must be a positive integer.");
  }
  return Object.fromEntries([
    ...requiredVariables.map((name) => [name, values[name]]),
    ["RUNNER_TASK_TIMEOUT_MS", timeout],
    ["RUNNER_LOG_RETENTION_DAYS", retention],
  ]) as Configuration;
}
