import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkProject, initProject, saveMemory } from "../../../src/app/operations.js";
import { runSubprocess } from "../../../src/core/subprocess.js";
import {
  createFixedTestClock,
  FIXED_TIMESTAMP_NEXT_MINUTE
} from "../../fixtures/time.js";

const MAP_START = "<!-- memory:map:start -->";
const MAP_END = "<!-- memory:map:end -->";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("product map refresh on save", () => {
  it("rewrites the map section in AGENTS.md and CLAUDE.md after a save", async () => {
    const repo = await createRepo("memory-map-save-");
    await writeProjectFile(repo, "src/query/select.ts", "export {};\n");
    await initialize(repo);

    const agentsBefore = await readFile(join(repo, "AGENTS.md"), "utf8");
    expect(agentsBefore).toContain(MAP_START);
    expect(agentsBefore).toContain("No features recorded yet.");

    const saved = await saveMemory({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Record query feature",
        nodes: [
          {
            kind: "feature",
            title: "Query verb",
            body: "# Query verb\n\nAnswers product questions from the graph.\n",
            stage: "building",
            anchors: ["src/query/"]
          },
          {
            kind: "feature",
            title: "Ghost surface",
            body: "# Ghost surface\n\nAnchored to a path that does not exist.\n",
            stage: "idea",
            anchors: ["src/ghost/"]
          }
        ]
      }
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    expect(saved.warnings).toEqual([]);

    for (const target of ["AGENTS.md", "CLAUDE.md"]) {
      const contents = await readFile(join(repo, target), "utf8");
      const mapSection = contents.slice(
        contents.indexOf(MAP_START),
        contents.indexOf(MAP_END)
      );

      expect(mapSection).toContain(
        "**Building:** query-verb — Answers product questions from the graph. — src/query/"
      );
      expect(mapSection).toContain("**Idea:** ghost-surface");
      expect(mapSection).toContain(
        "**Stale:** feature.ghost-surface — anchor src/ghost/ matches no files"
      );
      expect(mapSection).not.toContain("No features recorded yet.");
    }
  });

  it("warns without failing when a target has no map markers", async () => {
    const repo = await createRepo("memory-map-save-missing-markers-");
    await initialize(repo);
    await writeFile(join(repo, "CLAUDE.md"), "# Hand-written instructions\n", "utf8");

    const saved = await saveMemory({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Record decision",
        nodes: [
          {
            kind: "decision",
            title: "Stay marker-scoped",
            body: "# Stay marker-scoped\n\nThe map only rewrites between its markers.\n"
          }
        ]
      }
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }

    expect(saved.warnings.join("\n")).toContain(
      "Product map in CLAUDE.md was not refreshed because Memory map markers are missing or ambiguous."
    );
    await expect(readFile(join(repo, "CLAUDE.md"), "utf8")).resolves.toBe(
      "# Hand-written instructions\n"
    );
    const agents = await readFile(join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("**Recent decisions:** stay-marker-scoped — Stay marker-scoped");
  });

  it("warns without failing when a target file is missing", async () => {
    const repo = await createRepo("memory-map-save-missing-file-");
    await initialize(repo);
    await rm(join(repo, "CLAUDE.md"));

    const saved = await saveMemory({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Record gotcha",
        nodes: [
          {
            kind: "gotcha",
            title: "Maps are best-effort",
            body: "# Maps are best-effort\n\nMissing files are skipped, never created.\n"
          }
        ]
      }
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }

    expect(saved.warnings.join("\n")).toContain(
      "Product map in CLAUDE.md was not refreshed because the file is missing."
    );
    await expect(readFile(join(repo, "CLAUDE.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

describe("product graph check warnings", () => {
  it("reports orphaned anchors and stale or missing map sections as warnings", async () => {
    const repo = await createRepo("memory-map-check-");
    await initialize(repo);

    const saved = await saveMemory({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Record orphaned feature",
        nodes: [
          {
            kind: "feature",
            title: "Orphaned anchor",
            body: "# Orphaned anchor\n\nPoints nowhere.\n",
            stage: "building",
            anchors: ["src/nowhere/"]
          }
        ]
      }
    });

    expect(saved.ok).toBe(true);

    const agents = await readFile(join(repo, "AGENTS.md"), "utf8");
    await writeFile(
      join(repo, "AGENTS.md"),
      agents.replace("Points nowhere.", "Drifted intent."),
      "utf8"
    );
    await writeFile(join(repo, "CLAUDE.md"), "# No markers here\n", "utf8");

    const checked = await checkProject({ cwd: repo });

    expect(checked.ok).toBe(true);
    if (!checked.ok) {
      return;
    }

    expect(checked.data.valid).toBe(true);
    expect(checked.data.errors).toEqual([]);
    expect(checked.data.warnings).toContainEqual(
      expect.objectContaining({
        code: "AnchorOrphaned",
        path: ".memory/memory/features/orphaned-anchor.json",
        field: "/anchors"
      })
    );
    expect(checked.data.warnings).toContainEqual(
      expect.objectContaining({
        code: "ProductMapStale",
        path: "AGENTS.md"
      })
    );
    expect(checked.data.warnings).toContainEqual(
      expect.objectContaining({
        code: "ProductMapMissing",
        path: "CLAUDE.md"
      })
    );
  });

  it("stays warning-free when the map is fresh and anchors resolve", async () => {
    const repo = await createRepo("memory-map-check-fresh-");
    await writeProjectFile(repo, "src/query/select.ts", "export {};\n");
    await initialize(repo);

    const saved = await saveMemory({
      cwd: repo,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      input: {
        task: "Record anchored feature",
        nodes: [
          {
            kind: "feature",
            title: "Anchored feature",
            body: "# Anchored feature\n\nAnchored to real code.\n",
            stage: "building",
            anchors: ["src/query/"]
          }
        ]
      }
    });

    expect(saved.ok).toBe(true);

    const checked = await checkProject({ cwd: repo });

    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.data.valid).toBe(true);
      expect(checked.data.errors).toEqual([]);
      expect(checked.data.warnings).toEqual([]);
    }
  });
});

async function initialize(repo: string): Promise<void> {
  const initialized = await initProject({
    cwd: repo,
    clock: createFixedTestClock()
  });

  expect(initialized.ok).toBe(true);
}

async function createRepo(prefix: string): Promise<string> {
  const repo = await createTempRoot(prefix);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Memory Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function writeProjectFile(
  projectRoot: string,
  path: string,
  contents: string
): Promise<void> {
  const absolutePath = join(projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runSubprocess("git", args, { cwd });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  if (result.data.exitCode !== 0) {
    throw new Error(
      [
        `git ${args.join(" ")} failed with exit code ${result.data.exitCode}`,
        result.data.stderr
      ].join("\n")
    );
  }

  return result.data.stdout;
}
