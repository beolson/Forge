import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfiguration, requiredVariables } from "./config.mjs";

const root = mkdtempSync(join(tmpdir(), "forge-aspire-config-"));
const key = join(root, "app.pem");
writeFileSync(key, "test fixture");
after(() => rmSync(root, { recursive: true, force: true }));

function writeEnvironment(overrides: Record<string, string> = {}): void {
  const values = {
    ...Object.fromEntries(
      requiredVariables.map((name) => [name, "test-value"]),
    ),
    SERVICEBUS_ACCEPT_EULA: "Y",
    FORGE_SESSION_SECRET: "s".repeat(32),
    GITHUB_APP_PRIVATE_KEY_PATH: key,
    ...overrides,
  };
  writeFileSync(
    join(root, ".env"),
    Object.entries(values)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n"),
  );
}

test("loads quoted .env values, defaults, and explicit environment overrides", () => {
  writeEnvironment({
    POSTGRES_PASSWORD: "password with # and spaces",
    FORGE_DB_PASSWORD: "password@with:special/characters",
  });
  const config = loadConfiguration(root, { GITHUB_ORG: "override-org" });
  assert.equal(config.POSTGRES_PASSWORD, "password with # and spaces");
  assert.equal(config.FORGE_DB_PASSWORD, "password@with:special/characters");
  assert.equal(config.GITHUB_ORG, "override-org");
  assert.equal(config.RUNNER_TASK_TIMEOUT_MS, "1800000");
  assert.equal(config.RUNNER_LOG_RETENTION_DAYS, "90");
});

test("reports missing configuration keys without exposing other values", () => {
  writeEnvironment({
    AZURE_CLIENT_SECRET: "",
    POSTGRES_PASSWORD: "do-not-display",
  });
  assert.throws(
    () => loadConfiguration(root, {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AZURE_CLIENT_SECRET/);
      assert.doesNotMatch(error.message, /do-not-display/);
      return true;
    },
  );
});

test("rejects unaccepted terms, short sessions, unreadable keys, and invalid task limits", () => {
  for (const [overrides, message] of [
    [{ SERVICEBUS_ACCEPT_EULA: "N" }, /SERVICEBUS_ACCEPT_EULA/],
    [{ FORGE_SESSION_SECRET: "short" }, /FORGE_SESSION_SECRET/],
    [{ GITHUB_APP_PRIVATE_KEY_PATH: "relative.pem" }, /absolute path/],
    [
      { GITHUB_APP_PRIVATE_KEY_PATH: join(root, "missing.pem") },
      /readable PEM/,
    ],
    [{ RUNNER_TASK_TIMEOUT_MS: "1000" }, /RUNNER_TASK_TIMEOUT_MS/],
    [{ RUNNER_TASK_TIMEOUT_MS: "NaN" }, /RUNNER_TASK_TIMEOUT_MS/],
    [{ RUNNER_LOG_RETENTION_DAYS: "0" }, /RUNNER_LOG_RETENTION_DAYS/],
    [{ RUNNER_LOG_RETENTION_DAYS: "1.5" }, /RUNNER_LOG_RETENTION_DAYS/],
  ] as const) {
    writeEnvironment(overrides);
    assert.throws(() => loadConfiguration(root, {}), message);
  }
});

test("explains how to initialize a missing root .env", () => {
  assert.throws(
    () => loadConfiguration(join(root, "missing"), {}),
    /Copy .env.example/,
  );
});
