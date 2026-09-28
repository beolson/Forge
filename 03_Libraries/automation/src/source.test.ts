import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parseManifest, taskFor } from "./index";
import { loadDevelopmentSource, loadSource } from "./source";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("GitHub source uses a repository-limited read token and fetches every file at the resolved commit", async () => {
  const directory = await fixture();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = join(directory, "app.pem");
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  vi.stubEnv("AUTOMATION_SOURCE_DIRECTORY", "");
  vi.stubEnv("AUTOMATION_REPOSITORY", "example/Forge");
  vi.stubEnv("AUTOMATION_GITHUB_APP_ID", "123");
  vi.stubEnv("AUTOMATION_GITHUB_INSTALLATION_ID", "456");
  vi.stubEnv("AUTOMATION_GITHUB_PRIVATE_KEY_FILE", keyPath);
  const revision = "c".repeat(40);
  const files: Record<string, string> = {
    "tasks.json": JSON.stringify(manifest),
    "scripts/create.sh": "echo pinned\n",
    "resources/group.bicep": "targetScope = 'subscription'\n",
  };
  const contents: string[] = [];
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    const path = new URL(url);
    if (path.pathname.includes("access_tokens")) {
      expect(JSON.parse(String(options.body))).toEqual({
        repositories: ["Forge"],
        permissions: { contents: "read" },
      });
      return Response.json({ token: "read-only-installation-token" });
    }
    expect((options.headers as Record<string, string>).Authorization).toBe(
      "Bearer read-only-installation-token",
    );
    if (path.pathname.endsWith("/commits/main"))
      return Response.json({ sha: revision });
    expect(path.searchParams.get("ref")).toBe(revision);
    const name = path.pathname.split("/04_Infrastructure/runners/")[1];
    contents.push(name);
    return Response.json({
      type: "file",
      size: files[name].length,
      encoding: "base64",
      content: Buffer.from(files[name]).toString("base64"),
    });
  });
  const source = await loadSource();
  expect(source.revision).toBe(revision);
  expect(source.origin).toBe("github");
  expect(contents.sort()).toEqual([
    "resources/group.bicep",
    "scripts/create.sh",
    "tasks.json",
  ]);
  expect(source.files["scripts/create.sh"]).toBe("echo pinned\n");
});
const manifest = {
  version: 1,
  tasks: [
    {
      id: "azure-create",
      name: "Create Azure resource group",
      runner: "privileged",
      resource: "azure",
      operation: "Create",
      runtime: "bash",
      entrypoint: "scripts/create.sh",
      files: ["resources/group.bicep"],
    },
  ],
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-source-"));
  directories.push(directory);
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "resources"));
  await writeFile(join(directory, "tasks.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "scripts/create.sh"), "echo first version\n");
  await writeFile(
    join(directory, "resources/group.bicep"),
    "targetScope = 'subscription'\n",
  );
  return directory;
}
test("a source snapshot keeps the exact scripts even after the approved source changes", async () => {
  const directory = await fixture();
  const original = await loadDevelopmentSource(directory);
  await writeFile(
    join(directory, "scripts/create.sh"),
    "echo second version\n",
  );
  const current = await loadDevelopmentSource(directory);
  expect(original.files["scripts/create.sh"]).toBe("echo first version\n");
  expect(current.revision).not.toBe(original.revision);
  expect(taskFor(original, "azure", "Create").entrypoint).toBe(
    "scripts/create.sh",
  );
});
test("manifest traversal and duplicate task operations cannot be approved", () => {
  expect(() =>
    parseManifest({
      ...manifest,
      tasks: [{ ...manifest.tasks[0], entrypoint: "../outside.sh" }],
    }),
  ).toThrow();
  expect(() =>
    parseManifest({
      ...manifest,
      tasks: [
        manifest.tasks[0],
        { ...manifest.tasks[0], id: "another-create" },
      ],
    }),
  ).toThrow();
});
test("a local source symlink cannot load files outside the approved source directory", async () => {
  const directory = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
  directories.push(outside);
  await writeFile(join(outside, "group.bicep"), "outside");
  await rm(join(directory, "resources/group.bicep"));
  await symlink(
    join(outside, "group.bicep"),
    join(directory, "resources/group.bicep"),
  );
  await expect(loadDevelopmentSource(directory)).rejects.toThrow("escapes");
});
test("project tasks cannot accidentally run with privileged credentials", async () => {
  const source = await loadDevelopmentSource(await fixture());
  source.manifest.tasks[0].runner = "project";
  expect(() => taskFor(source, "azure", "Create")).toThrow("not enabled");
});
