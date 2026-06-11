import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyAnchors } from "../../../src/anchors/verify.js";
import { listTrackedFiles } from "../../../src/core/git.js";
import { runSubprocess } from "../../../src/core/subprocess.js";
import type { StoredMemoryObject } from "../../../src/storage/objects.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("listTrackedFiles", () => {
  it("unions tracked files with untracked-but-present additions", async () => {
    const repo = await createRepo("memory-tracked-files-");
    await writeProjectFile(repo, "src/query/select.ts", "export {};\n");
    await git(repo, ["add", "src/query/select.ts"]);
    await git(repo, ["commit", "-m", "Add query module"]);
    await writeProjectFile(repo, "src/anchors/new-untracked.ts", "export {};\n");

    const result = await listTrackedFiles(repo);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data).not.toBeNull();
    expect(result.data).toContain("README.md");
    expect(result.data).toContain("src/query/select.ts");
    expect(result.data).toContain("src/anchors/new-untracked.ts");
  });

  it("returns null outside Git so anchor verification is skipped", async () => {
    const projectRoot = await createTempRoot("memory-tracked-files-nongit-");

    const result = await listTrackedFiles(projectRoot);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it("lets anchors on brand-new uncommitted files count as present", async () => {
    const repo = await createRepo("memory-tracked-files-anchors-");
    await writeProjectFile(repo, "src/fresh/feature.ts", "export {};\n");

    const tracked = await listTrackedFiles(repo);

    expect(tracked.ok).toBe(true);
    if (!tracked.ok || tracked.data === null) {
      expect.fail("expected tracked file list");
    }

    const findings = verifyAnchors(
      [makeAnchoredFeature("feature.fresh", ["src/fresh/"])],
      tracked.data
    );

    expect(findings).toEqual([
      {
        id: "feature.fresh",
        matched_anchors: ["src/fresh/"],
        orphaned_anchors: []
      }
    ]);
  });
});

function makeAnchoredFeature(id: string, anchors: string[]): StoredMemoryObject {
  return {
    path: `.memory/memory/features/${id}.json`,
    bodyPath: `.memory/memory/features/${id}.md`,
    body: `# ${id}\n\nBody.\n`,
    sidecar: {
      id,
      type: "feature",
      status: "active",
      title: id,
      body_path: `memory/features/${id}.md`,
      stage: "building",
      anchors,
      content_hash: "0".repeat(64),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    }
  };
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
