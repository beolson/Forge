import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseManifest } from "@hero4hire/automation";

console.log(
  JSON.stringify(
    parseManifest(
      JSON.parse(
        readFileSync(resolve(import.meta.dirname, "../tasks.json"), "utf8"),
      ),
    ),
  ),
);
