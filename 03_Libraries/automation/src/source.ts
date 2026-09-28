import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parseManifest, type SourceSnapshot, safeSourcePath } from "./index";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

async function github<T>(
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`GitHub source API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function sourceToken(repository: string): Promise<string> {
  const issued = Math.floor(Date.now() / 1000);
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: issued - 60, exp: issued + 540, iss: required("AUTOMATION_GITHUB_APP_ID") })}`;
  const key = createPrivateKey(
    await readFile(required("AUTOMATION_GITHUB_PRIVATE_KEY_FILE")),
  );
  const jwt = `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
  const result = await github<{ token: string }>(
    `/app/installations/${required("AUTOMATION_GITHUB_INSTALLATION_ID")}/access_tokens`,
    jwt,
    {
      repositories: [repository.split("/")[1]],
      permissions: { contents: "read" },
    },
  );
  return result.token;
}

async function readSnapshot(file: (path: string) => Promise<string>) {
  const manifestText = await file("tasks.json");
  const manifest = parseManifest(JSON.parse(manifestText));
  const paths = new Set(
    manifest.tasks.flatMap((task) => [task.entrypoint, ...task.files]),
  );
  const files: Record<string, string> = { "tasks.json": manifestText };
  for (const path of paths) files[path] = await file(path);
  if (Buffer.byteLength(JSON.stringify({ manifest, files }), "utf8") > 180_000)
    throw new Error("Task source snapshot is too large");
  return { manifest, files };
}

export async function loadSource(): Promise<SourceSnapshot> {
  const directory = process.env.AUTOMATION_SOURCE_DIRECTORY;
  if (directory) return loadDevelopmentSource(directory);
  const repository = required("AUTOMATION_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid automation repository");
  const root =
    process.env.AUTOMATION_SOURCE_ROOT || "04_Infrastructure/runners";
  if (!safeSourcePath(root)) throw new Error("Invalid automation source root");
  const token = await sourceToken(repository);
  const commit = await github<{ sha: string }>(
    `/repos/${repository}/commits/main`,
    token,
  );
  if (!/^[0-9a-f]{40}$/.test(commit.sha))
    throw new Error("Invalid source commit");
  const file = async (path: string) => {
    const result = await github<{
      type: string;
      content: string;
      encoding: string;
      size: number;
    }>(
      `/repos/${repository}/contents/${root}/${path}?ref=${commit.sha}`,
      token,
    );
    if (
      result.type !== "file" ||
      result.encoding !== "base64" ||
      result.size > 128_000
    )
      throw new Error(`Invalid source file: ${path}`);
    return Buffer.from(result.content, "base64").toString("utf8");
  };
  return {
    repository,
    revision: commit.sha,
    root,
    origin: "github",
    ...(await readSnapshot(file)),
  };
}

export async function loadDevelopmentSource(
  directory: string,
): Promise<SourceSnapshot> {
  const root = await realpath(directory);
  const file = async (path: string) => {
    const target = await realpath(resolve(root, path));
    if (!target.startsWith(`${root}${sep}`))
      throw new Error("Source file escapes approved directory");
    const content = await readFile(target, "utf8");
    if (Buffer.byteLength(content, "utf8") > 128_000)
      throw new Error("Source file is too large");
    return content;
  };
  const { manifest, files } = await readSnapshot(file);
  return {
    repository: "local development",
    root: "",
    origin: "development",
    revision: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    manifest,
    files,
  };
}
