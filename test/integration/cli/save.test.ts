import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import { searchMemory } from "../../../src/app/operations.js";
import { runSubprocess } from "../../../src/core/subprocess.js";
import { dataAccessService } from "../../../src/data-access/index.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import { createFixedTestClock } from "../../fixtures/time.js";

const tempRoots: string[] = [];

interface SaveEnvelope {
  ok: true;
  warnings: string[];
  data: {
    dry_run: boolean;
    patch: unknown;
    files_changed: string[];
    memory_created: string[];
    memory_updated: string[];
    memory_deleted: string[];
    relations_created: string[];
    relations_updated: string[];
    relations_deleted: string[];
    recovery_files: unknown[];
    repairs_applied: string[];
    events_appended: number;
    index_updated: boolean;
  };
}

interface SaveErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory save CLI", () => {
  it("saves intent-first memory from stdin through the shared write path and makes it immediately searchable", async () => {
    const projectRoot = await createInitializedProject("memory-cli-save-");
    const output = createCapturedOutput();
    const save = vi.spyOn(dataAccessService, "save");
    const input = {
      task: "Document billing retry location",
      nodes: [
        {
          kind: "decision",
          title: "Billing retries run in the worker",
          body:
            "Billing retry execution happens in the queue worker, not inside the HTTP webhook handler.",
          tags: ["billing", "retries"],
          anchors: ["services/billing/src/workers/retry.ts"],
          evidence: [{ kind: "file", id: "services/billing/src/workers/retry.ts" }]
        }
      ]
    };

    const exitCode = await main(["node", "memory", "save", "--stdin", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      stdin: Readable.from([JSON.stringify(input)])
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      target: {
        kind: "cwd",
        cwd: projectRoot
      },
      input,
      dryRun: false
    });
    const envelope = JSON.parse(output.stdout()) as SaveEnvelope;
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
      expect(saved?.sidecar.anchors).toEqual(["services/billing/src/workers/retry.ts"]);
      expect(saved?.sidecar.evidence).toEqual([
        { kind: "file", id: "services/billing/src/workers/retry.ts" }
      ]);
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
    const projectRoot = await createInitializedProject("memory-cli-save-dry-run-");
    const output = createCapturedOutput();
    const eventsBefore = await readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8");
    const input = {
      task: "Preview durable memory",
      nodes: [
        {
          kind: "gotcha",
          title: "Preview gotcha",
          body: "This gotcha should only be planned."
        }
      ]
    };

    const exitCode = await main(
      ["node", "memory", "save", "--stdin", "--dry-run", "--json"],
      {
        ...output.writers,
        cwd: projectRoot,
        stdin: Readable.from([JSON.stringify(input)])
      }
    );

    expect(exitCode).toBe(0);
    const envelope = JSON.parse(output.stdout()) as SaveEnvelope;
    expect(envelope.data.dry_run).toBe(true);
    expect(envelope.data.memory_created).toEqual(["gotcha.preview-gotcha"]);
    expect(envelope.data.index_updated).toBe(false);
    await expect(readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8")).resolves.toBe(
      eventsBefore
    );
  });

  it("exits 1 with a validation error for unsupported node kinds", async () => {
    const projectRoot = await createInitializedProject("memory-cli-save-bad-kind-");
    const output = createCapturedOutput();
    const eventsBefore = await readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8");
    const input = {
      task: "Use a removed kind",
      nodes: [
        {
          kind: "note",
          title: "Old kind",
          body: "The note kind no longer exists."
        }
      ]
    };

    const exitCode = await main(["node", "memory", "save", "--stdin", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      stdin: Readable.from([JSON.stringify(input)])
    });

    expect(exitCode).toBe(1);
    const envelope = JSON.parse(output.stdout()) as SaveErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("MemoryValidationFailed");
    expect(JSON.stringify(envelope.error.details)).toContain("kind");
    await expect(readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8")).resolves.toBe(
      eventsBefore
    );
  });

  it("exits 1 for invalid JSON from stdin without touching memory", async () => {
    const projectRoot = await createInitializedProject("memory-cli-save-invalid-json-");
    const output = createCapturedOutput();
    const eventsBefore = await readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8");

    const exitCode = await main(["node", "memory", "save", "--stdin", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      stdin: Readable.from(["{bad json\n"])
    });

    expect(exitCode).toBe(1);
    expect(output.stderr()).toBe("");
    const envelope = JSON.parse(output.stdout()) as SaveErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("MemoryInvalidJson");
    await expect(readFile(join(projectRoot, ".memory", "events.jsonl"), "utf8")).resolves.toBe(
      eventsBefore
    );
  });

  it("exits 2 when --stdin is not provided", async () => {
    const projectRoot = await createInitializedProject("memory-cli-save-missing-source-");
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "save"], {
      ...output.writers,
      cwd: projectRoot
    });

    expect(exitCode).toBe(2);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("--stdin is required");
  });

  it("restores tracked deleted Memory storage before saving new information", async () => {
    const projectRoot = await createInitializedGitProject("memory-cli-save-deleted-");
    await git(projectRoot, ["add", "-A"]);
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
      nodes: [
        {
          kind: "gotcha",
          title: "Save restores deleted storage",
          body: "The save command restores tracked deleted Memory storage before writing new information."
        }
      ]
    };

    const exitCode = await main(["node", "memory", "save", "--stdin", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      stdin: Readable.from([JSON.stringify(input)])
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const envelope = JSON.parse(output.stdout()) as SaveEnvelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toContain(
      "Memory storage was restored from HEAD before writing because tracked .memory files were deleted."
    );
    expect(envelope.data.memory_created).toEqual([
      "gotcha.save-restores-deleted-storage"
    ]);

    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (storage.ok) {
      expect(
        storage.data.objects.some(
          (object) => object.sidecar.id === "gotcha.save-restores-deleted-storage"
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
