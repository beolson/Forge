import { spawn, spawnSync } from "node:child_process";

const expectedVersion = "13.5.4";
const version = spawnSync("aspire", ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0) {
  console.error(
    `Install Aspire CLI ${expectedVersion} and ensure aspire is on PATH.`,
  );
  process.exit(1);
}
if (version.stdout.trim().split("+")[0] !== expectedVersion) {
  console.error(
    `Forge requires Aspire CLI ${expectedVersion}; install that version before running this command.`,
  );
  process.exit(1);
}

const child = spawn("aspire", process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", () => {
  console.error("Could not start the Aspire CLI.");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
