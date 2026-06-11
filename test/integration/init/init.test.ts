import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initProject } from "../../../src/app/operations.js";
import { runSubprocess } from "../../../src/core/subprocess.js";
import { computeObjectContentHash } from "../../../src/storage/hashes.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import { validateProject } from "../../../src/validation/validate.js";
import { createFixedTestClock, FIXED_TIMESTAMP } from "../../fixtures/time.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("initProject", () => {
  it("initializes valid storage at the Git worktree root without committing", async () => {
    const repo = await createRepo("billing-api");
    const nested = join(repo, "packages", "app");
    await mkdir(nested, { recursive: true });
    const commitBefore = await git(repo, ["rev-parse", "HEAD"]);

    const result = await initProject({
      cwd: nested,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.meta.project_root).toBe(repo);
    expect(result.meta.memory_root).toBe(join(repo, ".memory"));
    expect(result.meta.git.available).toBe(true);
    expect(result.meta.git.branch).toBe("main");
    expect(result.meta.git.commit).toBe(commitBefore.trim());
    expect(result.meta.git.dirty).toBe(true);
    expect(result.data.created).toBe(true);
    expect(result.data.git_available).toBe(true);
    expect(result.data.gitignore_updated).toBe(true);
    expect(result.data.index_built).toBe(true);
    expect(result.data.files_created).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "CLAUDE.md",
        ".memory/config.json",
        ".memory/events.jsonl",
        ".memory/memory/project.md",
        ".memory/memory/project.json",
        ".memory/schema/config.schema.json"
      ])
    );
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(commitBefore);
    await expect(readFile(join(repo, ".gitignore"), "utf8")).resolves.toContain(
      ".memory/index/"
    );
    await expect(readFile(join(repo, ".gitignore"), "utf8")).resolves.toContain(
      ".memory/exports/"
    );
    await expect(readFile(join(repo, ".gitignore"), "utf8")).resolves.toContain(
      ".memory/recovery/"
    );
    await expect(readFile(join(repo, ".gitignore"), "utf8")).resolves.toContain(".memory/.lock");
    await expect(access(join(repo, ".memory", "memory", "gotchas"))).resolves.toBeUndefined();
    await expect(access(join(repo, ".memory", "memory", "features"))).resolves.toBeUndefined();
    const agentsGuidance = await readFile(join(repo, "AGENTS.md"), "utf8");
    const claudeGuidance = await readFile(join(repo, "CLAUDE.md"), "utf8");
    for (const guidance of [agentsGuidance, claudeGuidance]) {
      expect(guidance).toContain("<!-- memory:start -->");
      expect(guidance).toContain(
        "This repo uses Memory as its product-layer memory: features, decisions, gotchas, and open questions anchored to code paths."
      );
      expect(guidance).toContain('Run `memory query "<question>"` (MCP: `query_memory`)');
      expect(guidance).toContain("Do not preload anything else.");
      expect(guidance).toContain(
        "`memory save --stdin` with JSON `{task, nodes, stale, supersede, delete}`"
      );
      expect(guidance).toContain("Do not save refactors, formatting details, or task diaries.");
      expect(guidance).toContain(
        "At session end, or after merging others' work, run `memory sync` and act on its report."
      );
      expect(guidance).toContain(
        "`memory status` summarizes features by stage; `memory inspect <id>` shows one node in full."
      );
      expect(guidance).toContain(
        "If memory conflicts with current code or the user, trust the code and the user — and save the correction."
      );
      expect(guidance).toContain("<!-- memory:map:start -->");
      expect(guidance).toContain("## Product map");
      expect(guidance).toContain("No features recorded yet.");
      expect(guidance).toContain("<!-- memory:map:end -->");
      expect(guidance).not.toContain("memory load");
      expect(guidance).not.toContain("memory remember");
      expect(guidance).not.toMatch(/install .*skill/i);
    }
    expect(result.data.agent_guidance).toEqual({
      enabled: true,
      targets: [
        {
          path: "AGENTS.md",
          status: "created"
        },
        {
          path: "CLAUDE.md",
          status: "created"
        }
      ],
      optional_skills: [
        "integrations/codex/memory/SKILL.md",
        "integrations/claude/memory/SKILL.md",
        "integrations/cursor/memory.mdc",
        "integrations/cline/memory.md"
      ]
    });

    const validation = await validateProject(repo);
    expect(validation).toEqual({
      valid: true,
      errors: [],
      warnings: []
    });
  });

  it("initializes valid storage outside Git in local mode", async () => {
    const projectRoot = await createTempRoot("memory-init-local-project-");

    const result = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.meta).toEqual({
      project_root: projectRoot,
      memory_root: join(projectRoot, ".memory"),
      git: {
        available: false,
        branch: null,
        commit: null,
        dirty: null
      }
    });
    expect(result.data.created).toBe(true);
    expect(result.data.git_available).toBe(false);
    expect(result.data.gitignore_updated).toBe(false);
    expect(result.data.index_built).toBe(true);
    const nextSteps = result.data.next_steps.join("\n");
    expect(nextSteps).toContain("memory save --stdin");
    expect(nextSteps).toContain("`memory status`");
    expect(nextSteps).toContain("`memory check`");
    expect(nextSteps).toContain('memory query "<question>"');
    expect(nextSteps).toContain("memory sync");
    expect(nextSteps).toContain("indexing brief");
    expect(nextSteps).toContain("Codex, Claude Code, Cursor, Cline");
    for (const removedVerb of [
      "memory load",
      "memory remember",
      "memory setup",
      "memory suggest",
      "memory wiki",
      "load_memory",
      "remember_memory",
      "save_memory_patch",
      "diff_memory"
    ]) {
      expect(nextSteps).not.toContain(removedVerb);
    }
    expect(result.data.dry_run).toBe(false);
    expect(result.data.brief).toContain("Memory indexing brief");

    const validation = await validateProject(projectRoot);
    expect(validation).toEqual({
      valid: true,
      errors: [],
      warnings: []
    });

    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (storage.ok) {
      expect(storage.data.config.project.id).toMatch(/^project\.memory-init-local-project-/);
      expect(storage.data.objects.map((object) => object.sidecar.id)).toEqual([
        storage.data.config.project.id
      ]);
      expect(storage.data.relations).toHaveLength(0);
      await expect(access(join(projectRoot, ".memory", "memory", "gotchas"))).resolves.toBeUndefined();
      await expect(access(join(projectRoot, ".memory", "memory", "features"))).resolves.toBeUndefined();
      expect(storage.data.events).toEqual([]);
      expect(storage.data.objects[0]?.sidecar.created_at).toBe(FIXED_TIMESTAMP);
    }
  });

  it("does not derive semantic project memory during init", async () => {
    const projectRoot = await createTempRoot("memory-init-no-semantic-bootstrap-");
    await writeProjectFile(
      projectRoot,
      "README.md",
      "# Billing API\n\nHandles recurring billing and webhook processing for Stripe.\n"
    );
    await writeProjectFile(
      projectRoot,
      "package.json",
      `${JSON.stringify({
        description: "Billing API for Stripe webhook processing.",
        scripts: {
          build: "tsc --noEmit"
        }
      })}\n`
    );

    const result = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    await expect(readFile(join(projectRoot, ".memory", "memory", "project.md"), "utf8")).resolves.not.toContain(
      "Stripe webhook processing"
    );
    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (storage.ok) {
      expect(storage.data.objects.map((object) => object.sidecar.id)).toEqual([
        storage.data.config.project.id
      ]);
    }
  });

  it("returns success with a warning when valid storage already exists", async () => {
    const projectRoot = await createTempRoot("memory-init-rerun-");
    const first = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(first.ok).toBe(true);

    const second = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.created).toBe(false);
      expect(second.data.files_created).toEqual([]);
      expect(second.data.index_built).toBe(true);
      expect(second.warnings).toEqual(
        expect.arrayContaining([
          "Memory is already initialized; existing valid storage was left unchanged."
        ])
      );
    }
  });

  it("resets valid existing storage only when force is true", async () => {
    const repo = await createRepo("force-valid-reset");
    const first = await initProject({
      cwd: repo,
      clock: createFixedTestClock()
    });

    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const storage = await readCanonicalStorage(repo);
    expect(storage.ok).toBe(true);
    if (!storage.ok) {
      return;
    }

    await writeExtraMemory(repo);

    const defaultRerun = await initProject({
      cwd: repo,
      clock: createFixedTestClock()
    });

    expect(defaultRerun.ok).toBe(true);
    if (!defaultRerun.ok) {
      return;
    }
    expect(defaultRerun.data.created).toBe(false);
    await expect(
      access(join(repo, ".memory", "memory", "gotchas", "extra-note.md"))
    ).resolves.toBeUndefined();

    const forced = await initProject({
      cwd: repo,
      clock: createFixedTestClock(),
      force: true
    });

    expect(forced.ok).toBe(true);
    if (!forced.ok) {
      return;
    }
    expect(forced.data.created).toBe(true);
    await expect(
      access(join(repo, ".memory", "memory", "gotchas", "extra-note.md"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });

    const resetStorage = await readCanonicalStorage(repo);
    expect(resetStorage.ok).toBe(true);
    if (resetStorage.ok) {
      expect(resetStorage.data.objects.map((object) => object.sidecar.id)).toEqual([
        resetStorage.data.config.project.id
      ]);
      expect(resetStorage.data.events).toEqual([]);
    }
  });

  it("allows untracked first-run Memory files during init", async () => {
    const repo = await createRepo("untracked-first-run");
    await writeProjectFile(repo, ".memory/scratch.txt", "local scratch\n");

    const result = await initProject({
      cwd: repo,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(true);
    }
    await expect(readFile(join(repo, ".memory", "scratch.txt"), "utf8")).resolves.toBe(
      "local scratch\n"
    );
  });

  it("installs missing agent guidance when valid storage already exists", async () => {
    const projectRoot = await createTempRoot("memory-init-existing-guidance-");
    const first = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(first.ok).toBe(true);
    await rm(join(projectRoot, "AGENTS.md"));
    await rm(join(projectRoot, "CLAUDE.md"));

    const second = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.created).toBe(false);
      expect(second.data.files_created).toEqual(["AGENTS.md", "CLAUDE.md"]);
      expect(second.data.agent_guidance.targets).toEqual([
        {
          path: "AGENTS.md",
          status: "created"
        },
        {
          path: "CLAUDE.md",
          status: "created"
        }
      ]);
    }
  });

  it("appends or replaces marked agent guidance without duplicating blocks", async () => {
    const projectRoot = await createTempRoot("memory-init-guidance-update-");
    await writeFile(join(projectRoot, "AGENTS.md"), "# Existing instructions\n");
    await writeFile(
      join(projectRoot, "CLAUDE.md"),
      [
        "# Claude instructions",
        "",
        "<!-- memory:start -->",
        "old guidance",
        "<!-- memory:end -->",
        "",
        "Keep this line."
      ].join("\n")
    );

    const result = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.agent_guidance.targets).toEqual([
      {
        path: "AGENTS.md",
        status: "updated"
      },
      {
        path: "CLAUDE.md",
        status: "updated"
      }
    ]);

    const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    const claude = await readFile(join(projectRoot, "CLAUDE.md"), "utf8");

    expect(agents).toContain("# Existing instructions");
    expect(agents).toContain("<!-- memory:start -->");
    expect(agents).toContain("product-layer memory");
    expect(agents).toContain("<!-- memory:map:start -->");
    expect(claude).not.toContain("old guidance");
    expect(claude).toContain("Keep this line.");
    expect(countOccurrences(claude, "<!-- memory:start -->")).toBe(1);
    expect(countOccurrences(claude, "<!-- memory:map:start -->")).toBe(1);
  });

  it("replaces legacy aictx-memory marked guidance with memory guidance", async () => {
    const projectRoot = await createTempRoot("memory-init-guidance-legacy-update-");
    await writeFile(
      join(projectRoot, "AGENTS.md"),
      [
        "# Existing instructions",
        "",
        "<!-- aictx-memory:start -->",
        "old guidance",
        "<!-- aictx-memory:end -->",
        "",
        "Keep this line."
      ].join("\n")
    );

    const result = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.agent_guidance.targets[0]).toEqual({
      path: "AGENTS.md",
      status: "updated"
    });

    const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    expect(agents).not.toContain("aictx-memory");
    expect(agents).not.toContain("old guidance");
    expect(agents).toContain("<!-- memory:start -->");
    expect(agents).toContain("Keep this line.");
    expect(countOccurrences(agents, "<!-- memory:start -->")).toBe(1);
  });

  it("skips malformed marked agent guidance and reports a warning", async () => {
    const projectRoot = await createTempRoot("memory-init-guidance-malformed-");
    await writeFile(join(projectRoot, "AGENTS.md"), "<!-- memory:start -->\n");

    const result = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.agent_guidance.targets).toEqual([
      {
        path: "AGENTS.md",
        status: "skipped"
      },
      {
        path: "CLAUDE.md",
        status: "created"
      }
    ]);
    expect(result.warnings.join("\n")).toContain("AGENTS.md");
    await expect(readFile(join(projectRoot, "AGENTS.md"), "utf8")).resolves.toBe(
      "<!-- memory:start -->\n"
    );
  });

  it("skips unmarked existing Memory guidance instead of appending a duplicate block", async () => {
    const projectRoot = await createTempRoot("memory-init-guidance-unmarked-");
    await writeFile(
      join(projectRoot, "AGENTS.md"),
      [
        "# Existing instructions",
        "",
        "Memory as project memory:",
        "- Run `memory load \"task\"` before coding.",
        "- Use `save_memory_patch` after meaningful work."
      ].join("\n")
    );

    const result = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.agent_guidance.targets).toEqual([
      {
        path: "AGENTS.md",
        status: "skipped"
      },
      {
        path: "CLAUDE.md",
        status: "created"
      }
    ]);
    expect(result.warnings.join("\n")).toContain("AGENTS.md");

    const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("Memory as project memory");
    expect(agents).not.toContain("<!-- memory:start -->");
  });

  it("returns success when existing storage has additional saved memory", async () => {
    const repo = await createRepo("extra-memory");
    const first = await initProject({
      cwd: repo,
      clock: createFixedTestClock()
    });

    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const storage = await readCanonicalStorage(repo);
    expect(storage.ok).toBe(true);
    if (!storage.ok) {
      return;
    }

    await writeExtraMemory(repo);

    const second = await initProject({
      cwd: repo,
      clock: createFixedTestClock()
    });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.created).toBe(false);
      expect(second.data.index_built).toBe(true);
      expect(second.warnings).toEqual(
        expect.arrayContaining([
          "Memory is already initialized; existing valid storage was left unchanged."
        ])
      );
    }
  });

  it("returns MemoryAlreadyInitializedInvalid for invalid existing storage", async () => {
    const projectRoot = await createTempRoot("memory-init-invalid-");
    await mkdir(join(projectRoot, ".memory"), { recursive: true });
    await writeFile(join(projectRoot, ".memory", "config.json"), "{bad json");

    const result = await initProject({
      cwd: projectRoot,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryAlreadyInitializedInvalid");
      expect(JSON.stringify(result.error.details)).toContain("issues");
    }
  });

  it("requires force before resetting tracked dirty invalid storage", async () => {
    const repo = await createRepo("force-invalid-reset");
    await mkdir(join(repo, ".memory"), { recursive: true });
    await writeFile(join(repo, ".memory", "config.json"), "{bad json");
    await git(repo, ["add", ".memory/config.json"]);
    await git(repo, ["commit", "-m", "Add invalid Memory storage"]);
    await writeFile(join(repo, ".memory", "config.json"), "{still bad json");

    const defaultResult = await initProject({
      cwd: repo,
      clock: createFixedTestClock()
    });

    expect(defaultResult.ok).toBe(false);
    if (!defaultResult.ok) {
      expect(defaultResult.error.code).toBe("MemoryDirtyMemory");
      expect(JSON.stringify(defaultResult.error.details)).toContain(".memory/config.json");
    }

    const forced = await initProject({
      cwd: repo,
      clock: createFixedTestClock(),
      force: true
    });

    expect(forced.ok).toBe(true);
    if (forced.ok) {
      expect(forced.data.created).toBe(true);
    }
    const validation = await validateProject(repo);
    expect(validation.valid).toBe(true);
  });
});

async function createRepo(name: string): Promise<string> {
  const repo = await createTempRoot(`memory-init-${name}-`);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Memory Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
}

async function writeExtraMemory(projectRoot: string): Promise<void> {
  const body = "# Extra note\n\nSaved memory survives an init rerun.\n";
  const sidecarWithoutHash = {
    id: "gotcha.extra-note",
    type: "gotcha",
    status: "active",
    title: "Extra note",
    body_path: "memory/gotchas/extra-note.md",
    tags: [],
    source: {
      kind: "agent"
    },
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  };
  const sidecar = {
    ...sidecarWithoutHash,
    content_hash: computeObjectContentHash(sidecarWithoutHash, body)
  };

  await writeProjectFile(projectRoot, ".memory/memory/gotchas/extra-note.md", body);
  await writeProjectFile(
    projectRoot,
    ".memory/memory/gotchas/extra-note.json",
    stableJson(sidecar)
  );
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
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

async function writeProjectFile(
  projectRoot: string,
  path: string,
  contents: string
): Promise<void> {
  const absolutePath = join(projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}
