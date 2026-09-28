import { expect, test } from "vitest";
import manifestJSON from "../../../02_Apps/forge.provisioner/tasks.json";
import { parseManifest, taskArguments, taskFor } from "./index";

const manifest = parseManifest(manifestJSON);
const project = {
  kind: "create-project" as const,
  projectId: "e513e0da-08e4-4f64-a111-bb6bb9cfdc38",
  attempt: 1,
  code: "ABCDE",
  name: "Example",
  description: "Example",
  repositoryName: "gh-abcde-example",
};
const settings = {
  azureSubscriptionId: "subscription",
  azureRegion: "eastus",
  githubOrganization: "example",
};

test("packaged task configuration creates subscription arguments and uses the same Azure handler for deletion", () => {
  const task = taskFor(manifest, "azure", "Create");
  const args = taskArguments(task, project, settings);
  expect(args.slice(0, 2)).toEqual([
    "deploy",
    "resources/project-resource-group.bicep",
  ]);
  expect(JSON.parse(args[2])).toEqual({
    scope: "subscription",
    deploymentName: "az-abcde-rgdep",
    location: "eastus",
    parameters: {
      appCode: "ABCDE",
      projectId: project.projectId,
      location: "eastus",
    },
    ownership: {
      resourceGroup: "az-abcde-resgp",
      projectId: project.projectId,
    },
  });
  const deletion = taskFor(manifest, "azure", "Delete");
  expect(deletion.entrypoint).toBe(task.entrypoint);
  expect(taskArguments(deletion, project, settings)).toEqual([
    "delete",
    JSON.stringify({
      resourceGroup: "az-abcde-resgp",
      projectId: project.projectId,
    }),
  ]);
});

test("catalog refuses old runtimes, mismatched actions, duplicate operations, and escaping template paths", () => {
  const task = manifest.tasks[0];
  for (const change of [
    { runtime: "python" },
    { operation: "Delete" },
    { bicepFile: "resources/../foreign.bicep" },
  ])
    expect(() =>
      parseManifest({ version: 1, tasks: [{ ...task, ...change }] }),
    ).toThrow();
  expect(() =>
    parseManifest({
      version: 1,
      tasks: [task, { ...task, id: "another-create" }],
    }),
  ).toThrow();
});
