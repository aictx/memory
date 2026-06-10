import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("memory projects CLI", () => {
  it("adds, lists, removes, and prunes registered projects", async () => {
    const memoryHome = await createTempRoot("memory-cli-projects-home-");
    const projectRoot = await createInitializedProject("memory-cli-projects-project-", memoryHome);

    const empty = await runCli(["node", "memory", "projects", "list", "--json"], projectRoot, memoryHome);
    expect(empty.exitCode).toBe(0);
    expect(parseJson<{ ok: true; data: { projects: unknown[] } }>(empty.stdout).data.projects)
      .toHaveLength(0);

    const added = await runCli(["node", "memory", "projects", "add", projectRoot, "--json"], projectRoot, memoryHome);
    expect(added.exitCode).toBe(0);
    const addedEnvelope = parseJson<{
      ok: true;
      data: { project: { registry_id: string; project_root: string } };
    }>(added.stdout);
    expect(addedEnvelope.data.project.project_root).toBe(projectRoot);

    const listed = await runCli(["node", "memory", "projects", "list", "--json"], projectRoot, memoryHome);
    expect(parseJson<{ ok: true; data: { projects: unknown[] } }>(listed.stdout).data.projects)
      .toHaveLength(1);

    const removed = await runCli(
      ["node", "memory", "projects", "remove", addedEnvelope.data.project.registry_id, "--json"],
      projectRoot,
      memoryHome
    );
    expect(removed.exitCode).toBe(0);
    expect(parseJson<{ ok: true; data: { removed: { registry_id: string } } }>(removed.stdout)
      .data.removed.registry_id).toBe(addedEnvelope.data.project.registry_id);

    await runCli(["node", "memory", "projects", "add", projectRoot, "--json"], projectRoot, memoryHome);
    await rm(join(projectRoot, ".memory"), { recursive: true, force: true });

    const pruned = await runCli(["node", "memory", "projects", "prune", "--json"], projectRoot, memoryHome);
    const prunedEnvelope = parseJson<{
      ok: true;
      data: { projects: unknown[]; removed: unknown[] };
    }>(pruned.stdout);

    expect(pruned.exitCode).toBe(0);
    expect(prunedEnvelope.data.projects).toHaveLength(0);
    expect(prunedEnvelope.data.removed).toHaveLength(1);
  });

  it("auto-registers successful project-scoped commands", async () => {
    const memoryHome = await createTempRoot("memory-cli-auto-home-");
    const projectRoot = await createTempRoot("memory-cli-auto-project-");

    const init = await runCli(["node", "memory", "init", "--json"], projectRoot, memoryHome, true);
    expect(init.exitCode).toBe(0);
    await expectRegisteredProjectCount(projectRoot, memoryHome, 1);

    const listed = await runCli(["node", "memory", "projects", "list", "--json"], projectRoot, memoryHome);
    const registryId = parseJson<{
      ok: true;
      data: { projects: Array<{ registry_id: string }> };
    }>(listed.stdout).data.projects[0]?.registry_id;

    expect(registryId).toBeTruthy();
    await runCli(["node", "memory", "projects", "remove", registryId ?? "", "--json"], projectRoot, memoryHome);
    await expectRegisteredProjectCount(projectRoot, memoryHome, 0);

    const check = await runCli(["node", "memory", "check", "--json"], projectRoot, memoryHome, true);
    expect(check.exitCode).toBe(0);
    await expectRegisteredProjectCount(projectRoot, memoryHome, 1);

    const afterCheck = await runCli(["node", "memory", "projects", "list", "--json"], projectRoot, memoryHome);
    const registryIdAfterCheck = parseJson<{
      ok: true;
      data: { projects: Array<{ registry_id: string }> };
    }>(afterCheck.stdout).data.projects[0]?.registry_id;

    await runCli(["node", "memory", "projects", "remove", registryIdAfterCheck ?? "", "--json"], projectRoot, memoryHome);
    await expectRegisteredProjectCount(projectRoot, memoryHome, 0);

    const search = await runCli(["node", "memory", "search", "project context", "--json"], projectRoot, memoryHome, true);
    expect(search.exitCode).toBe(0);
    await expectRegisteredProjectCount(projectRoot, memoryHome, 1);
  });
});

async function createInitializedProject(prefix: string, memoryHome: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const init = await runCli(["node", "memory", "init", "--json"], projectRoot, memoryHome, false);

  expect(init.exitCode).toBe(0);
  return projectRoot;
}

async function expectRegisteredProjectCount(
  cwd: string,
  memoryHome: string,
  count: number
): Promise<void> {
  const listed = await runCli(["node", "memory", "projects", "list", "--json"], cwd, memoryHome);

  expect(listed.exitCode).toBe(0);
  expect(parseJson<{ ok: true; data: { projects: unknown[] } }>(listed.stdout).data.projects)
    .toHaveLength(count);
}

async function runCli(
  argv: string[],
  cwd: string,
  memoryHome: string,
  autoRegister = false
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const output = createCapturedOutput();
  const exitCode = await main(argv, {
    ...output.writers,
    cwd,
    registry: {
      enabled: autoRegister,
      memoryHome
    }
  });

  return {
    exitCode,
    stdout: output.stdout(),
    stderr: output.stderr()
  };
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

function createCapturedOutput(): {
  writers: { stdout: CliOutputWriter; stderr: CliOutputWriter };
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";

  return {
    writers: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}
