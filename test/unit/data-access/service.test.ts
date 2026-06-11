import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  diffMemory,
  initProject,
  inspectMemory
} from "../../../src/app/operations.js";
import { dataAccessService } from "../../../src/data-access/index.js";
import { createFixedTestClock, FIXED_TIMESTAMP } from "../../fixtures/time.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("data-access service", () => {
  it("exposes exactly the host-neutral contract operations", () => {
    expect(Object.keys(dataAccessService).sort()).toEqual([
      "diff",
      "inspect",
      "query",
      "save",
      "status"
    ]);
  });

  it("targets explicit project roots independently", async () => {
    const alphaRoot = await createInitializedProject("memory-data-access-alpha-");
    const betaRoot = await createInitializedProject("memory-data-access-beta-");

    const alphaSaved = await dataAccessService.save({
      target: {
        kind: "project-root",
        projectRoot: alphaRoot
      },
      input: createGotchaInput(
        "gotcha.alpha-deployment-fact",
        "Alpha-only deployment fact"
      ),
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });
    const betaSaved = await dataAccessService.save({
      target: {
        kind: "project-root",
        projectRoot: betaRoot
      },
      input: createGotchaInput("gotcha.beta-deployment-fact", "Beta-only deployment fact"),
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(alphaSaved.ok).toBe(true);
    expect(betaSaved.ok).toBe(true);

    const alphaQuery = await dataAccessService.query({
      target: {
        kind: "project-root",
        projectRoot: alphaRoot
      },
      question: "deployment fact"
    });
    const betaQuery = await dataAccessService.query({
      target: {
        kind: "project-root",
        projectRoot: betaRoot
      },
      question: "deployment fact"
    });

    expect(alphaQuery.ok).toBe(true);
    expect(betaQuery.ok).toBe(true);

    if (!alphaQuery.ok || !betaQuery.ok) {
      return;
    }

    expect(alphaQuery.meta.project_root).toBe(alphaRoot);
    expect(alphaQuery.meta.memory_root).toBe(join(alphaRoot, ".memory"));
    expect(betaQuery.meta.project_root).toBe(betaRoot);
    expect(betaQuery.meta.memory_root).toBe(join(betaRoot, ".memory"));

    expect(alphaQuery.data.included_ids).toContain("gotcha.alpha-deployment-fact");
    expect(alphaQuery.data.included_ids).not.toContain("gotcha.beta-deployment-fact");
    expect(betaQuery.data.included_ids).toContain("gotcha.beta-deployment-fact");
    expect(betaQuery.data.included_ids).not.toContain("gotcha.alpha-deployment-fact");
  });

  it("resolves nested cwd targets to the initialized project boundary", async () => {
    const projectRoot = await createInitializedProject("memory-data-access-nested-");
    const nestedCwd = join(projectRoot, "packages", "app", "src");
    await mkdir(nestedCwd, { recursive: true });

    const saved = await dataAccessService.save({
      target: {
        kind: "project-root",
        projectRoot
      },
      input: createGotchaInput("gotcha.nested-target-memory", "Nested target memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(saved.ok).toBe(true);

    const inspected = await dataAccessService.inspect({
      target: {
        kind: "cwd",
        cwd: nestedCwd
      },
      id: "gotcha.nested-target-memory"
    });

    expect(inspected.ok).toBe(true);
    expect(inspected.meta.project_root).toBe(projectRoot);
    expect(inspected.meta.memory_root).toBe(join(projectRoot, ".memory"));

    if (!inspected.ok) {
      return;
    }

    expect(inspected.data.object).toMatchObject({
      id: "gotcha.nested-target-memory",
      title: "Nested target memory"
    });
  });

  it("preserves current app result envelopes for inspect success and errors", async () => {
    const projectRoot = await createInitializedProject("memory-data-access-envelope-");
    const id = "gotcha.envelope-preserved";

    const saved = await dataAccessService.save({
      target: {
        kind: "project-root",
        projectRoot
      },
      input: createGotchaInput(id, "Envelope preserved"),
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(saved.ok).toBe(true);

    const serviceInspect = await dataAccessService.inspect({
      target: {
        kind: "project-root",
        projectRoot
      },
      id
    });
    const appInspect = await inspectMemory({
      cwd: projectRoot,
      id
    });

    expect(serviceInspect).toEqual(appInspect);

    const serviceMissing = await dataAccessService.inspect({
      target: {
        kind: "project-root",
        projectRoot
      },
      id: "decision.missing"
    });
    const appMissing = await inspectMemory({
      cwd: projectRoot,
      id: "decision.missing"
    });

    expect(serviceMissing).toEqual(appMissing);
    expect(serviceMissing.ok).toBe(false);

    if (serviceMissing.ok) {
      return;
    }

    expect(serviceMissing.error).toMatchObject({
      code: "MemoryObjectNotFound",
      details: {
        id: "decision.missing"
      }
    });
  });

  it("preserves the no-Git diff error envelope", async () => {
    const projectRoot = await createInitializedProject("memory-data-access-diff-");

    const serviceDiff = await dataAccessService.diff({
      target: {
        kind: "project-root",
        projectRoot
      }
    });
    const appDiff = await diffMemory({
      cwd: projectRoot
    });

    expect(serviceDiff).toEqual(appDiff);
    expect(serviceDiff.ok).toBe(false);

    if (serviceDiff.ok) {
      return;
    }

    expect(serviceDiff.error.code).toBe("MemoryGitRequired");
    expect(serviceDiff.meta).toMatchObject({
      project_root: projectRoot,
      memory_root: join(projectRoot, ".memory"),
      git: {
        available: false
      }
    });
  });
});

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const initialized = await initProject({
    cwd: projectRoot,
    agentGuidance: false,
    clock: createFixedTestClock(FIXED_TIMESTAMP)
  });

  if (!initialized.ok) {
    throw new Error(`Project initialization failed: ${initialized.error.message}`);
  }

  return projectRoot;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

function createGotchaInput(id: string, title: string) {
  return {
    task: "Exercise data-access service targeting.",
    nodes: [
      {
        id,
        kind: "gotcha",
        title,
        body: `# ${title}\n\n${title}.\n`
      }
    ]
  };
}
