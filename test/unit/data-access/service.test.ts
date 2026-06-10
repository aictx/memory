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
      "applyPatch",
      "diff",
      "inspect",
      "remember",
      "search"
    ]);
  });

  it("targets explicit project roots independently", async () => {
    const alphaRoot = await createInitializedProject("memory-data-access-alpha-");
    const betaRoot = await createInitializedProject("memory-data-access-beta-");

    const alphaSaved = await dataAccessService.applyPatch({
      target: {
        kind: "project-root",
        projectRoot: alphaRoot
      },
      patch: createNotePatch(
        "note.alpha-deployment-fact",
        "Alpha-only deployment fact"
      ),
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });
    const betaSaved = await dataAccessService.applyPatch({
      target: {
        kind: "project-root",
        projectRoot: betaRoot
      },
      patch: createNotePatch("note.beta-deployment-fact", "Beta-only deployment fact"),
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(alphaSaved.ok).toBe(true);
    expect(betaSaved.ok).toBe(true);

    const alphaSearch = await dataAccessService.search({
      target: {
        kind: "project-root",
        projectRoot: alphaRoot
      },
      query: "deployment fact",
      limit: 10
    });
    const betaSearch = await dataAccessService.search({
      target: {
        kind: "project-root",
        projectRoot: betaRoot
      },
      query: "deployment fact",
      limit: 10
    });

    expect(alphaSearch.ok).toBe(true);
    expect(betaSearch.ok).toBe(true);

    if (!alphaSearch.ok || !betaSearch.ok) {
      return;
    }

    expect(alphaSearch.meta.project_root).toBe(alphaRoot);
    expect(alphaSearch.meta.memory_root).toBe(join(alphaRoot, ".memory"));
    expect(betaSearch.meta.project_root).toBe(betaRoot);
    expect(betaSearch.meta.memory_root).toBe(join(betaRoot, ".memory"));

    expect(alphaSearch.data.matches.map((match) => match.title)).toContain(
      "Alpha-only deployment fact"
    );
    expect(alphaSearch.data.matches.map((match) => match.title)).not.toContain(
      "Beta-only deployment fact"
    );
    expect(betaSearch.data.matches.map((match) => match.title)).toContain(
      "Beta-only deployment fact"
    );
    expect(betaSearch.data.matches.map((match) => match.title)).not.toContain(
      "Alpha-only deployment fact"
    );
  });

  it("resolves nested cwd targets to the initialized project boundary", async () => {
    const projectRoot = await createInitializedProject("memory-data-access-nested-");
    const nestedCwd = join(projectRoot, "packages", "app", "src");
    await mkdir(nestedCwd, { recursive: true });

    const saved = await dataAccessService.applyPatch({
      target: {
        kind: "project-root",
        projectRoot
      },
      patch: createNotePatch("note.nested-target-memory", "Nested target memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(saved.ok).toBe(true);

    const inspected = await dataAccessService.inspect({
      target: {
        kind: "cwd",
        cwd: nestedCwd
      },
      id: "note.nested-target-memory"
    });

    expect(inspected.ok).toBe(true);
    expect(inspected.meta.project_root).toBe(projectRoot);
    expect(inspected.meta.memory_root).toBe(join(projectRoot, ".memory"));

    if (!inspected.ok) {
      return;
    }

    expect(inspected.data.object).toMatchObject({
      id: "note.nested-target-memory",
      title: "Nested target memory"
    });
  });

  it("preserves current app result envelopes for inspect success and errors", async () => {
    const projectRoot = await createInitializedProject("memory-data-access-envelope-");
    const id = "note.envelope-preserved";

    const saved = await dataAccessService.applyPatch({
      target: {
        kind: "project-root",
        projectRoot
      },
      patch: createNotePatch(id, "Envelope preserved"),
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

function createNotePatch(id: string, title: string) {
  return {
    source: {
      kind: "agent",
      task: "Exercise data-access service targeting."
    },
    changes: [
      {
        op: "create_object",
        id,
        type: "note",
        title,
        body: `# ${title}\n\n${title}.\n`
      }
    ]
  };
}
