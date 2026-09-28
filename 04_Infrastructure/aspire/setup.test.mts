import assert from "node:assert/strict";
import { test } from "node:test";
import { waitUntilReady } from "./setup.mjs";

test("waits through refused connections and unhealthy responses before proceeding", async () => {
  let attempts = 0;
  await waitUntilReady(
    "test dependency",
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("connection refused");
      return attempts >= 3;
    },
    1000,
    1,
  );
  assert.equal(attempts, 3);
});

test("fails with the dependency name after a bounded readiness deadline", async () => {
  await assert.rejects(
    waitUntilReady("test dependency", async () => false, 10, 1),
    /test dependency did not become ready.*dashboard logs/,
  );
});
