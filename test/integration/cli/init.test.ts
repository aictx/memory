import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import { runSubprocess } from "../../../src/core/subprocess.js";

const tempRoots: string[] = [];

interface InitSuccessEnvelope {
  ok: true;
  data: {
    created: boolean;
    index_built: boolean;
    agent_guidance: {
      enabled: boolean;
      targets: Array<{ path: string; status: string }>;
      optional_skills: string[];
    };
  };
  warnings: string[];
  meta: {
    project_root: string;
    memory_root: string;
    git: {
      available: boolean;
      branch: string | null;
      commit: string | null;
      dirty: boolean | null;
    };
  };
}

interface InitErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

interface CheckSuccessEnvelope {
  ok: true;
  data: {
    valid: boolean;
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory init CLI", () => {
  it("prints a success envelope for JSON output in a Git repo", async () => {
    const repo = await createRepo("json-git");
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "init", "--json"], {
      ...output.writers,
      cwd: repo
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const envelope = parseInitSuccessEnvelope(output.stdout());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.created).toBe(true);
    expect(envelope.data.index_built).toBe(true);
    expect(envelope.data.agent_guidance.enabled).toBe(true);
    expect(envelope.data.agent_guidance.targets).toEqual([
      {
        path: "AGENTS.md",
        status: "created"
      },
      {
        path: "CLAUDE.md",
        status: "created"
      }
    ]);
    expect(envelope.meta.project_root).toBe(repo);
    expect(envelope.meta.memory_root).toBe(join(repo, ".memory"));
    expect(envelope.meta.git.available).toBe(true);
  });

  it("prints a success envelope outside Git with unavailable Git metadata", async () => {
    const projectRoot = await createTempRoot("memory-cli-init-local-");
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "init", "--json"], {
      ...output.writers,
      cwd: projectRoot
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const envelope = parseInitSuccessEnvelope(output.stdout());
    expect(envelope.meta).toEqual({
      project_root: projectRoot,
      memory_root: join(projectRoot, ".memory"),
      git: {
        available: false,
        branch: null,
        commit: null,
        dirty: null
      }
    });
    await expect(access(join(projectRoot, ".memory", "config.json"))).resolves.toBeUndefined();
    await expect(access(join(projectRoot, ".memory", "events.jsonl"))).resolves.toBeUndefined();
  });

  it("migrates legacy .aictx storage on the first memory command", async () => {
    const projectRoot = await createTempRoot("memory-cli-legacy-migration-");
    let output = createCapturedOutput();

    expect(await main(["node", "memory", "init", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      registry: { enabled: false }
    })).toBe(0);

    await rename(join(projectRoot, ".memory"), join(projectRoot, ".aictx"));
    await writeFile(
      join(projectRoot, ".gitignore"),
      [
        ".aictx/index/",
        ".aictx/context/",
        ".aictx/exports/",
        ".aictx/recovery/",
        ".aictx/.backup/",
        ".aictx/.lock",
        ""
      ].join("\n")
    );

    output = createCapturedOutput();
    expect(await main(["node", "memory", "query", "legacy migration", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      registry: { enabled: false }
    })).toBe(0);
    expect(output.stderr()).toBe("");
    await expect(access(join(projectRoot, ".memory", "config.json"))).resolves.toBeUndefined();
    await expect(access(join(projectRoot, ".aictx"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(projectRoot, ".gitignore"), "utf8")).resolves.toBe(
      [
        ".memory/index/",
        ".memory/context/",
        ".memory/exports/",
        ".memory/recovery/",
        ".memory/.backup/",
        ".memory/.lock",
        ""
      ].join("\n")
    );
  });

  it("prints concise human output", async () => {
    const projectRoot = await createTempRoot("memory-cli-init-human-");
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "init"], {
      ...output.writers,
      cwd: projectRoot
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(() => JSON.parse(output.stdout()) as unknown).toThrow();
    expect(output.stdout()).toContain("Initialized Memory.");
    expect(output.stdout()).toContain("Created files:");
    expect(output.stdout()).toContain(".memory/config.json");
    expect(output.stdout()).toContain(".memory/events.jsonl");
    expect(output.stdout()).toContain("Index built.");
    expect(output.stdout()).toContain("Agent guidance installed:");
    expect(output.stdout()).toContain("AGENTS.md: created");
    expect(output.stdout()).toContain("CLAUDE.md: created");
    expect(output.stdout()).toContain("Optional bundled guidance:");
    expect(output.stdout()).toContain("Next steps:");
    expect(output.stdout()).toContain("memory load");
    expect(output.stdout()).toContain("memory suggest --bootstrap --patch");
    expect(output.stdout()).toContain("memory save --file bootstrap-memory.json");

    const agentGuidance = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    expect(agentGuidance).toContain("product-layer memory");
    expect(agentGuidance).toContain('memory query "<question>"');
    expect(agentGuidance).toContain("memory save --stdin");
    expect(agentGuidance).toContain("memory sync");
    expect(agentGuidance).toContain("Do not save refactors, formatting details, or task diaries.");
    expect(agentGuidance).toContain("<!-- memory:map:start -->");
    expect(agentGuidance).toContain("## Product map");
  });

  it("skips repo agent guidance when requested", async () => {
    const projectRoot = await createTempRoot("memory-cli-init-no-guidance-");
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "init", "--no-agent-guidance", "--json"], {
      ...output.writers,
      cwd: projectRoot
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const envelope = parseInitSuccessEnvelope(output.stdout());
    expect(envelope.data.agent_guidance).toEqual({
      enabled: false,
      targets: [
        {
          path: "AGENTS.md",
          status: "skipped"
        },
        {
          path: "CLAUDE.md",
          status: "skipped"
        }
      ],
      optional_skills: [
        "integrations/codex/memory/SKILL.md",
        "integrations/claude/memory/SKILL.md",
        "integrations/cursor/memory.mdc",
        "integrations/cline/memory.md"
      ]
    });
    await expect(access(join(projectRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(join(projectRoot, "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("requires --force before reinitializing tracked dirty Memory state", async () => {
    const repo = await createRepo("force-reset");
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({
        name: "@example/force-reset",
        type: "module",
        packageManager: "pnpm@10.0.0",
        engines: {
          node: ">=22"
        },
        scripts: {
          build: "tsc --noEmit",
          test: "vitest run"
        },
        devDependencies: {
          vitest: "^4.0.0"
        }
      })}\n`
    );
    await writeFile(join(repo, "tsconfig.json"), "{}\n");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "index.ts"), "export const value = 1;\n");
    await git(repo, ["add", "package.json", "tsconfig.json", "src/index.ts"]);
    await git(repo, ["commit", "-m", "Add package metadata"]);
    let output = createCapturedOutput();

    expect(await main(["node", "memory", "init", "--json"], {
      ...output.writers,
      cwd: repo
    })).toBe(0);

    await git(repo, ["add", ".gitignore", "AGENTS.md", "CLAUDE.md", ".memory"]);
    await git(repo, ["commit", "-m", "Initialize Memory"]);
    await rm(join(repo, ".memory"), { recursive: true, force: true });

    output = createCapturedOutput();
    expect(await main(["node", "memory", "init", "--json"], {
      ...output.writers,
      cwd: repo
    })).not.toBe(0);
    expect(output.stderr()).toBe("");
    const errorEnvelope = JSON.parse(output.stdout()) as InitErrorEnvelope;
    expect(errorEnvelope.error.code).toBe("MemoryDirtyMemory");
    expect(JSON.stringify(errorEnvelope.error.details)).toContain(".memory/config.json");
    expect(errorEnvelope.error.message).toContain("--force");

    output = createCapturedOutput();
    expect(await main(["node", "memory", "init", "--force", "--json"], {
      ...output.writers,
      cwd: repo
    })).toBe(0);
    const forceEnvelope = parseInitSuccessEnvelope(output.stdout());
    expect(forceEnvelope.data.created).toBe(true);
    expect(forceEnvelope.data.index_built).toBe(true);

    output = createCapturedOutput();
    expect(await main(["node", "memory", "check", "--json"], {
      ...output.writers,
      cwd: repo
    })).toBe(0);
    const checkEnvelope = JSON.parse(output.stdout()) as CheckSuccessEnvelope;
    expect(checkEnvelope.data.valid).toBe(true);
  });
});

function parseInitSuccessEnvelope(stdout: string): InitSuccessEnvelope {
  return JSON.parse(stdout) as InitSuccessEnvelope;
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

async function createRepo(name: string): Promise<string> {
  const repo = await createTempRoot(`memory-cli-init-${name}-`);
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
