import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import { searchMemory } from "../../../src/app/operations.js";
import { runSubprocess } from "../../../src/core/subprocess.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import { createFixedTestClock } from "../../fixtures/time.js";

const tempRoots: string[] = [];

interface RememberEnvelope {
  ok: true;
  warnings: string[];
  data: {
    dry_run: boolean;
    patch: unknown;
    files_changed: string[];
    memory_created: string[];
    memory_updated: string[];
    relations_created: string[];
    events_appended: number;
    index_updated: boolean;
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory remember CLI", () => {
  it("saves intent-first memory through the shared write path and makes it immediately searchable", async () => {
    const projectRoot = await createInitializedProject("memory-cli-remember-");
    const output = createCapturedOutput();
    const input = {
      task: "Document billing retry location",
      memories: [
        {
          kind: "decision",
          title: "Billing retries run in the worker",
          body:
            "Billing retry execution happens in the queue worker, not inside the HTTP webhook handler.",
          tags: ["billing", "retries"],
          applies_to: ["services/billing/src/workers/retry.ts"],
          evidence: [{ kind: "file", id: "services/billing/src/workers/retry.ts" }]
        }
      ]
    };

    const exitCode = await main(["node", "memory", "remember", "--stdin", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      stdin: Readable.from([JSON.stringify(input)])
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const envelope = JSON.parse(output.stdout()) as RememberEnvelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.dry_run).toBe(false);
    expect(envelope.data.memory_created).toEqual(["decision.billing-retries-run-in-the-worker"]);
    expect(envelope.data.events_appended).toBe(1);
    expect(envelope.data.index_updated).toBe(true);

    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (storage.ok) {
      const saved = storage.data.objects.find(
        (object) => object.sidecar.id === "decision.billing-retries-run-in-the-worker"
      );
      expect(saved?.sidecar.facets).toEqual({
        category: "decision-rationale",
        applies_to: ["services/billing/src/workers/retry.ts"]
      });
    }

    const searched = await searchMemory({
      cwd: projectRoot,
      query: "billing retries worker",
      clock: createFixedTestClock()
    });
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.data.matches.map((match) => match.id)).toContain(
        "decision.billing-retries-run-in-the-worker"
      );
    }
  });

  it("dry-runs the generated patch without writing canonical memory", async () => {
    const projectRoot = await createInitializedProject("memory-cli-remember-dry-run-");
    const output = createCapturedOutput();
    const eventsBefore = await readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8");
    const input = {
      task: "Preview durable memory",
      memories: [
        {
          kind: "fact",
          title: "Preview fact",
          body: "This fact should only be planned."
        }
      ]
    };

    const exitCode = await main(
      ["node", "memory", "remember", "--stdin", "--dry-run", "--json"],
      {
        ...output.writers,
        cwd: projectRoot,
        stdin: Readable.from([JSON.stringify(input)])
      }
    );

    expect(exitCode).toBe(0);
    const envelope = JSON.parse(output.stdout()) as RememberEnvelope;
    expect(envelope.data.dry_run).toBe(true);
    expect(envelope.data.memory_created).toEqual(["fact.preview-fact"]);
    expect(envelope.data.index_updated).toBe(false);
    await expect(readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8")).resolves.toBe(
      eventsBefore
    );
  });

  it("restores tracked deleted Memory storage before remembering new information", async () => {
    const projectRoot = await createInitializedGitProject("memory-cli-remember-deleted-");
    await git(projectRoot, ["add", ".gitignore", "AGENTS.md", "CLAUDE.md", ".memory"]);
    await git(projectRoot, ["commit", "-m", "Initialize memory"]);
    const storageBeforeDelete = await readCanonicalStorage(projectRoot);
    expect(storageBeforeDelete.ok).toBe(true);
    const originalIds = storageBeforeDelete.ok
      ? storageBeforeDelete.data.objects.map((object) => object.sidecar.id)
      : [];
    await rm(join(projectRoot, ".memory"), { recursive: true, force: true });
    const output = createCapturedOutput();
    const input = {
      task: "Capture dirty Memory behavior",
      memories: [
        {
          kind: "fact",
          title: "Remember restores deleted storage",
          body: "The remember command restores tracked deleted Memory storage before writing new information."
        }
      ]
    };

    const exitCode = await main(["node", "memory", "remember", "--stdin", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      stdin: Readable.from([JSON.stringify(input)])
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const envelope = JSON.parse(output.stdout()) as RememberEnvelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toContain(
      "Memory storage was restored from HEAD before writing because tracked .memory files were deleted."
    );
    expect(envelope.data.memory_created).toEqual([
      "fact.remember-restores-deleted-storage"
    ]);

    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (storage.ok) {
      expect(
        storage.data.objects.some(
          (object) => object.sidecar.id === "fact.remember-restores-deleted-storage"
        )
      ).toBe(true);
      expect(
        originalIds.every((id) =>
          storage.data.objects.some((object) => object.sidecar.id === id)
        )
      )
        .toBe(true);
    }
  });
});

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const output = createCapturedOutput();
  const exitCode = await main(["node", "memory", "init", "--json"], {
    ...output.writers,
    cwd: projectRoot
  });

  expect(exitCode).toBe(0);
  expect(output.stderr()).toBe("");

  return projectRoot;
}

async function createInitializedGitProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  await git(projectRoot, ["init", "--initial-branch=main"]);
  await git(projectRoot, ["config", "user.email", "test@example.com"]);
  await git(projectRoot, ["config", "user.name", "Memory Test"]);
  await writeFile(join(projectRoot, "README.md"), "# Test\n", "utf8");
  await git(projectRoot, ["add", "README.md"]);
  await git(projectRoot, ["commit", "-m", "Initial commit"]);
  const output = createCapturedOutput();
  const exitCode = await main(["node", "memory", "init", "--json"], {
    ...output.writers,
    cwd: projectRoot
  });

  expect(exitCode).toBe(0);
  expect(output.stderr()).toBe("");

  return projectRoot;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runSubprocess("git", args, { cwd });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  if (result.data.exitCode !== 0) {
    throw new Error(result.data.stderr || result.data.stdout || `git ${args.join(" ")} failed`);
  }

  return result.data.stdout;
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
