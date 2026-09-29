import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type ProjectRequest,
  parseProjectInput,
  repositoryName,
} from "@hero4hire/project";
import { cli, required } from "../src/process";

type Api = <T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  allowMissing?: boolean,
) => Promise<T | null>;
const api: Api = async <T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  allowMissing = false,
) => {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `Provider API returned HTTP ${response.status} for ${method} ${path}`,
    );
  return response.status === 204 ? null : ((await response.json()) as T);
};

async function githubToken(): Promise<string> {
  const issued = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iat: issued - 60,
      exp: issued + 540,
      iss: required("GITHUB_APP_ID"),
    }),
  ).toString("base64url");
  const input = `${header}.${claims}`;
  const key = await readFile(required("GITHUB_APP_PRIVATE_KEY_FILE"), "utf8");
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(key, "base64url");
  const result = await api<{ token: string }>(
    "POST",
    `/app/installations/${encodeURIComponent(required("GITHUB_APP_INSTALLATION_ID"))}/access_tokens`,
    `${input}.${signature}`,
    {},
  );
  if (!result?.token)
    throw new Error("GitHub installation token is unavailable");
  return result.token;
}

export async function runGithub(argv: string[]): Promise<void> {
  const [action, payload] = argv;
  if (argv.length !== 2 || (action !== "create" && action !== "delete"))
    throw new Error("Usage: github <create|delete> <JSON project>");
  const project = JSON.parse(payload) as ProjectRequest;
  const parsed = parseProjectInput(project);
  if (
    !/^[0-9a-f-]{36}$/.test(project.projectId) ||
    parsed.code !== project.code ||
    parsed.name !== project.name ||
    repositoryName(project.code, project.name) !== project.repositoryName
  )
    throw new Error("Invalid GitHub project arguments");
  const org = required("GITHUB_ORG");
  const root = `/repos/${encodeURIComponent(org)}/${encodeURIComponent(project.repositoryName)}`;
  const token = await githubToken();
  const existing = await api<{ private: boolean }>(
    "GET",
    root,
    token,
    undefined,
    true,
  );
  if (existing) {
    if (existing.private !== true)
      throw new Error(
        `Repository ${org}/${project.repositoryName} is not private`,
      );
    const properties = await api<{ property_name: string; value: unknown }[]>(
      "GET",
      `${root}/properties/values`,
      token,
    );
    if (
      !Array.isArray(properties) ||
      properties.find((item) => item.property_name === "forge_project_id")
        ?.value !== project.projectId
    )
      throw new Error(
        `Repository ${org}/${project.repositoryName} exists without matching Forge ownership`,
      );
  }
  if (action === "create") {
    if (existing) {
      console.log(
        `Repository ${org}/${project.repositoryName} already belongs to this project`,
      );
      return;
    }
    await api("POST", `/orgs/${encodeURIComponent(org)}/repos`, token, {
      name: project.repositoryName,
      description: project.description,
      private: true,
      auto_init: false,
      custom_properties: { forge_project_id: project.projectId },
    });
    console.log(`Created private repository ${org}/${project.repositoryName}`);
  } else {
    if (!existing) {
      console.log(`Repository ${org}/${project.repositoryName} is absent`);
      return;
    }
    await api("DELETE", root, token);
    console.log(`Deleted repository ${org}/${project.repositoryName}`);
  }
}

if (import.meta.main) await cli(() => runGithub(process.argv.slice(2)));
