export type ProjectInput = { name: string; code: string; description: string };

export type ProjectRequest = ProjectInput & {
  kind: "create-project";
  projectId: string;
  attempt: number;
  repositoryName: string;
};

export type Resource = "azure" | "github";
export type ProjectStatus =
  | "queued"
  | "provisioning"
  | "rolling_back"
  | "ready"
  | "failed"
  | "cleanup_failed";

export type ProjectEvent = {
  eventId: string;
  projectId: string;
  attempt: number;
  status: ProjectStatus;
  resource?: Resource;
  detail: string;
  adminDetail?: string;
};

export function parseProjectInput(value: ProjectInput): ProjectInput {
  if (
    !value ||
    typeof value.name !== "string" ||
    typeof value.code !== "string" ||
    typeof value.description !== "string"
  ) {
    throw new Error("Name, code, and description are required.");
  }
  const name = value.name.trim();
  const code = value.code.toUpperCase();
  const description = value.description.trim();
  if (
    name.length < 1 ||
    name.length > 50 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9 -]*[A-Za-z0-9])?$/.test(name)
  ) {
    throw new Error(
      "Name must be 1–50 characters, using letters, digits, spaces, or hyphens, and start and end with a letter or digit.",
    );
  }
  if (!/^[A-Z]{5}$/.test(code))
    throw new Error("Code must contain exactly five letters.");
  if (description.length < 1 || description.length > 500) {
    throw new Error("Description must be 1–500 characters.");
  }
  return { name, code, description };
}

export function resourceGroupName(code: string): string {
  return `az-${code.toLowerCase()}-resgp`;
}

export function repositoryName(code: string, name: string): string {
  return `gh-${code.toLowerCase()}-${name.toLowerCase().trim().replace(/[ -]+/g, "-")}`;
}
