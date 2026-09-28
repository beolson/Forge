import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { logger, redactor } from "./logging";

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "forge-logs-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test("complete diagnostics redact boundary-spanning secrets and preserve bounded Unicode output", () => {
  const root = directory();
  const path = join(root, "archive.jsonl");
  const stdout = openSync(join(root, "stdout.jsonl"), "w");
  const secret = "boundary-secret";
  const original = `${"x".repeat(8185)}${secret}${"😀界".repeat(9000)}`;
  const output = logger(
    path,
    redactor({ AZURE_CLIENT_SECRET: secret }),
    stdout,
  );
  output.log("stderr", original);
  output.close();
  closeSync(stdout);
  const records = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map((record) => record.text).join("")).toBe(
    original.replace(secret, "[REDACTED]"),
  );
  expect(
    records.every(
      (record) =>
        Buffer.byteLength(record.text) <= 8192 && record.stream === "stderr",
    ),
  ).toBe(true);
  expect(readFileSync(join(root, "stdout.jsonl"), "utf8")).toBe(
    readFileSync(path, "utf8"),
  );
});

test("stdout failure leaves redacted diagnostics in the durable archive", () => {
  const path = join(directory(), "logs.jsonl");
  const output = logger(path, redactor({ AZURE_CLIENT_SECRET: "secret" }), -1);
  output.log("stderr", "diagnostic secret");
  output.log("stderr", "later diagnostic");
  output.close();
  expect(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).text),
  ).toEqual(["diagnostic [REDACTED]", "later diagnostic"]);
});

test("private key contents and generated GitHub tokens stay out of logs", () => {
  const path = join(directory(), "key.pem");
  writeFileSync(
    path,
    "-----BEGIN PRIVATE KEY-----\nkey-material\n-----END PRIVATE KEY-----\n",
  );
  const redact = redactor({ AZURE_CLIENT_SECRET: "example-secret" }, path);
  expect(
    redact(
      "example-secret key-material ghs_exampletoken eyJheader.payload.signature organization",
    ),
  ).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] organization");
});
