import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runGithub } from "./github";

const project = {
  kind: "create-project",
  projectId: "e513e0da-08e4-4f64-a111-bb6bb9cfdc38",
  attempt: 1,
  code: "ABCDE",
  name: "Example",
  description: "Example project",
  repositoryName: "gh-abcde-example",
};
let root: string;
let exists: boolean;
let privateRepo: boolean;
let marker: string;
let providerStatus: number;
let calls: { method: string; url: string; body: unknown }[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-github-"));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(join(root, "key.pem"), privateKey);
  for (const [key, value] of Object.entries({
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_APP_PRIVATE_KEY_FILE: join(root, "key.pem"),
    GITHUB_ORG: "example",
  }))
    vi.stubEnv(key, value);
  exists = false;
  privateRepo = true;
  marker = project.projectId;
  providerStatus = 0;
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/access_tokens"))
      return Response.json({ token: "ghs_testinstallationtoken" });
    if (providerStatus)
      return new Response("sensitive provider response", {
        status: providerStatus,
      });
    if (url.endsWith("/properties/values"))
      return Response.json([
        { property_name: "forge_project_id", value: marker },
      ]);
    if (method === "GET")
      return exists
        ? Response.json({ private: privateRepo })
        : new Response(null, { status: 404 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ private: true }, { status: 201 });
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const run = (action: string) => runGithub([action, JSON.stringify(project)]);

test("create makes a private repository with ownership and adopts an existing owned repository", async () => {
  await run("create");
  expect(
    calls.find((call) => call.url.endsWith("/orgs/example/repos"))?.body,
  ).toEqual({
    name: "gh-abcde-example",
    description: "Example project",
    private: true,
    auto_init: false,
    custom_properties: { forge_project_id: project.projectId },
  });
  exists = true;
  calls = [];
  await run("create");
  expect(calls.some((call) => call.url.endsWith("/orgs/example/repos"))).toBe(
    false,
  );
});

test("delete removes only an owned private repository and succeeds when already absent", async () => {
  exists = true;
  await run("delete");
  expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  exists = false;
  calls = [];
  await run("delete");
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
});

test("create and delete refuse public or foreign repositories", async () => {
  exists = true;
  privateRepo = false;
  await expect(run("create")).rejects.toThrow("not private");
  await expect(run("delete")).rejects.toThrow("not private");
  privateRepo = true;
  marker = "another-project";
  await expect(run("create")).rejects.toThrow("ownership");
  await expect(run("delete")).rejects.toThrow("ownership");
  expect(
    calls.some(
      (call) =>
        call.method === "DELETE" || call.url.endsWith("/orgs/example/repos"),
    ),
  ).toBe(false);
});

test("API failures expose status without including sensitive response bodies", async () => {
  providerStatus = 403;
  await expect(run("create")).rejects.toThrow("HTTP 403");
  await expect(run("delete")).rejects.not.toThrow(
    "sensitive provider response",
  );
});

test("invalid actions and mismatched project names fail before provider calls", async () => {
  await expect(run("rollback")).rejects.toThrow("Usage");
  await expect(
    runGithub([
      "delete",
      JSON.stringify({ ...project, repositoryName: "gh-abcde-other" }),
    ]),
  ).rejects.toThrow("arguments");
  expect(calls).toHaveLength(0);
});
