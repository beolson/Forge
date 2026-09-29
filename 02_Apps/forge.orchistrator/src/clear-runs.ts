import { clearCompletedRuns } from "./runners";

try {
  console.log(JSON.stringify(await clearCompletedRuns()));
} catch {
  console.error(
    "Could not clear completed runs. Check Docker and runner data availability.",
  );
  process.exitCode = 1;
}
