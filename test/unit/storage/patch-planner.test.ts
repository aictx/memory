import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import fg from "fast-glob";
import { afterEach, describe, expect, it } from "vitest";

import type {
  GitState,
  ObjectId,
  ObjectStatus,
  ObjectType,
  Predicate,
  RelationId
} from "../../../src/core/types.js";
import type {
  SubprocessResult,
  SubprocessRunner,
  SubprocessRunnerOptions
} from "../../../src/core/subprocess.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import type { MemoryRelation } from "../../../src/storage/relations.js";
import { planMemoryPatch } from "../../../src/storage/patch.js";
import { SCHEMA_FILES } from "../../../src/validation/schemas.js";
import { createFixedTestClock, FIXED_TIMESTAMP } from "../../fixtures/time.js";

const repoRoot = process.cwd();
const tempRoots: string[] = [];
const projectId = "project.billing-api";
const noGit: GitState = {
  available: false,
  branch: null,
  commit: null,
  dirty: null
};
const dirtyGit: GitState = {
  available: true,
  branch: "main",
  commit: "abc123",
  dirty: true
};
const validConfig = {
  version: 5,
  project: {
    id: projectId,
    name: "Billing API"
  },
  memory: {
    defaultTokenBudget: 2000,
    autoIndex: true
  }
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("planMemoryPatch", () => {
  it("normalizes valid changes, resolves paths, and does not mutate disk", async () => {
    const projectRoot = await createPatchProject();
    const before = await readMemorySnapshot(projectRoot);

    const result = await planMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent",
          task: "Document retry follow up"
        },
        changes: [
          {
            op: "create_object",
            type: "gotcha",
            title: "Billing retries follow up",
            body: "Check retry behavior after the worker change."
          },
          {
            op: "update_object",
            id: "decision.billing-retries",
            body: "Retries now run in the queue worker.",
            tags: ["billing", "queue"]
          }
        ]
      },
      git: noGit,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.memory_created).toEqual(["gotcha.billing-retries-follow-up"]);
    expect(result.data.memory_updated).toEqual(["decision.billing-retries"]);
    expect(result.data.events_appended).toBe(2);
    expect(result.data.changes[0]).toEqual(
      expect.objectContaining({
        op: "create_object",
        id: "gotcha.billing-retries-follow-up",
        status: "active",
        path: ".memory/memory/gotchas/billing-retries-follow-up.json",
        bodyPath: ".memory/memory/gotchas/billing-retries-follow-up.md"
      })
    );
    expect(result.data.touchedFiles).toEqual([
      ".memory/events.jsonl",
      ".memory/memory/decisions/billing-retries.json",
      ".memory/memory/decisions/billing-retries.md",
      ".memory/memory/gotchas/billing-retries-follow-up.json",
      ".memory/memory/gotchas/billing-retries-follow-up.md"
    ]);
    expect(result.data.fileWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".memory/memory/gotchas/billing-retries-follow-up.md",
          kind: "object_body",
          operation: "create_object"
        }),
        expect.objectContaining({
          path: ".memory/memory/decisions/billing-retries.json",
          kind: "object_sidecar",
          operation: "update_object"
        })
      ])
    );
    await expect(readMemorySnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("fails schema-invalid patches before disk writes", async () => {
    const projectRoot = await createPatchProject();
    const before = await readMemorySnapshot(projectRoot);

    const result = await planMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "create_object",
            type: "gotcha",
            title: "Missing body"
          }
        ]
      },
      git: noGit,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemorySchemaValidationFailed");
    }
    await expect(readMemorySnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("fails empty changes", async () => {
    const projectRoot = await createPatchProject();

    const result = await planMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: []
      },
      git: noGit,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemorySchemaValidationFailed");
      expect(JSON.stringify(result.error.details)).toContain("SchemaMinItems");
    }
  });

  it("fails unknown operations with MemoryUnknownPatchOperation", async () => {
    const projectRoot = await createPatchProject();

    const result = await planMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "rename_object",
            id: "decision.billing-retries"
          }
        ]
      },
      git: noGit,
      clock: createFixedTestClock()
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryUnknownPatchOperation");
      expect(result.error.details).toEqual(
        expect.objectContaining({
          op: "rename_object",
          field: "/changes/0/op"
        })
      );
    }
  });

  it("plans recovery backups when dirty files overlap touched files", async () => {
    const projectRoot = await createPatchProject();

    const result = await planMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "update_object",
            id: "decision.billing-retries",
            title: "Billing retries run in the worker"
          }
        ]
      },
      git: dirtyGit,
      clock: createFixedTestClock(),
      runner: createGitStatusRunner(
        [
          " M .memory/memory/decisions/billing-retries.json",
          " M .memory/memory/gotchas/unrelated.json",
          ""
        ].join("\n"),
        new Set([".memory/memory/decisions/billing-retries.json"])
      )
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.recovery_files).toEqual([
        {
          path: ".memory/memory/decisions/billing-retries.json",
          recovery_path:
            ".memory/recovery/2026-04-25T14-00-00-02-00/memory/decisions/billing-retries.json",
          reason: "dirty_overwrite"
        }
      ]);
      expect(result.warnings.join("\n")).toContain(
        ".memory/memory/decisions/billing-retries.json"
      );
      expect(result.warnings.join("\n")).not.toContain(".memory/memory/gotchas/unrelated.json");
    }
  });

  it("plans recovery metadata for dirty touched deletes", async () => {
    const projectRoot = await createPatchProject();

    const result = await planMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "delete_relation",
            id: "rel.billing-retries-depends-on-idempotency"
          },
          {
            op: "delete_object",
            id: "decision.billing-retries"
          }
        ]
      },
      git: dirtyGit,
      clock: createFixedTestClock(),
      runner: createGitStatusRunner(
        [
          " M .memory/memory/decisions/billing-retries.json",
          " M .memory/memory/decisions/billing-retries.md",
          ""
        ].join("\n"),
        new Set([
          ".memory/memory/decisions/billing-retries.json",
          ".memory/memory/decisions/billing-retries.md"
        ])
      )
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.recovery_files).toEqual([
        {
          path: ".memory/memory/decisions/billing-retries.json",
          recovery_path:
            ".memory/recovery/2026-04-25T14-00-00-02-00/memory/decisions/billing-retries.json",
          reason: "dirty_delete"
        },
        {
          path: ".memory/memory/decisions/billing-retries.md",
          recovery_path:
            ".memory/recovery/2026-04-25T14-00-00-02-00/memory/decisions/billing-retries.md",
          reason: "dirty_delete"
        }
      ]);
    }
  });

  it("allows dirty tracked events history because saves append to it", async () => {
    const projectRoot = await createPatchProject();

    const result = await planMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "update_object",
            id: "decision.billing-retries",
            title: "Billing retries run in the worker"
          }
        ]
      },
      git: dirtyGit,
      clock: createFixedTestClock(),
      runner: createGitStatusRunner(
        [" M .memory/events.jsonl", ""].join("\n"),
        new Set([".memory/events.jsonl"])
      )
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.touchedFiles).toContain(".memory/events.jsonl");
      expect(result.data.events_appended).toBe(1);
    }
  });

  it("allows untracked first-run Memory files to be updated before the initial memory commit", async () => {
    const projectRoot = await createPatchProject();

    const result = await planMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "update_object",
            id: "decision.billing-retries",
            title: "Billing retries run in the worker"
          }
        ]
      },
      git: dirtyGit,
      clock: createFixedTestClock(),
      runner: createGitStatusRunner(
        ["?? .memory/memory/decisions/billing-retries.json", ""].join("\n"),
        new Set()
      )
    });

    expect(result.ok).toBe(true);
  });
});

async function createPatchProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "memory-patch-plan-"));
  tempRoots.push(projectRoot);
  await mkdir(join(projectRoot, ".memory", "schema"), { recursive: true });

  for (const schemaFile of Object.values(SCHEMA_FILES)) {
    await copyFile(
      join(repoRoot, "src", "schemas", schemaFile),
      join(projectRoot, ".memory", "schema", schemaFile)
    );
  }

  await writeJsonProjectFile(projectRoot, ".memory/config.json", validConfig);
  await writeMemoryObject(projectRoot, {
    id: "decision.billing-retries",
    type: "decision",
    status: "active",
    title: "Billing retries moved to queue worker",
    bodyPath: "memory/decisions/billing-retries.md",
    body: "# Billing retries moved to queue worker\n\nRetries run in the queue worker.\n"
  });
  await writeMemoryObject(projectRoot, {
    id: "decision.webhook-idempotency",
    type: "decision",
    status: "active",
    title: "Webhook processing must be idempotent",
    bodyPath: "memory/decisions/webhook-idempotency.md",
    body: "# Webhook processing must be idempotent\n\nDuplicate webhooks are expected.\n"
  });
  await writeRelation(projectRoot, {
    id: "rel.billing-retries-depends-on-idempotency",
    from: "decision.billing-retries",
    predicate: "depends_on",
    to: "decision.webhook-idempotency",
    status: "active"
  });
  await writeProjectFile(projectRoot, ".memory/events.jsonl", "");

  return projectRoot;
}

async function writeMemoryObject(
  projectRoot: string,
  fixture: {
    id: ObjectId;
    type: ObjectType;
    status: ObjectStatus;
    title: string;
    bodyPath: string;
    body: string;
  }
): Promise<void> {
  const sidecarWithoutHash = {
    id: fixture.id,
    type: fixture.type,
    status: fixture.status,
    title: fixture.title,
    body_path: fixture.bodyPath,
    tags: [],
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  } satisfies Omit<MemoryObjectSidecar, "content_hash">;
  const sidecar = {
    ...sidecarWithoutHash,
    content_hash: computeObjectContentHash(sidecarWithoutHash, fixture.body)
  } satisfies MemoryObjectSidecar;

  await writeJsonProjectFile(
    projectRoot,
    `.memory/${fixture.bodyPath.replace(/\.md$/, ".json")}`,
    sidecar
  );
  await writeProjectFile(projectRoot, `.memory/${fixture.bodyPath}`, fixture.body);
}

async function writeRelation(
  projectRoot: string,
  fixture: {
    id: RelationId;
    from: ObjectId;
    predicate: Predicate;
    to: ObjectId;
    status: "active" | "stale" | "rejected";
  }
): Promise<void> {
  const relationWithoutHash = {
    id: fixture.id,
    from: fixture.from,
    predicate: fixture.predicate,
    to: fixture.to,
    status: fixture.status,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  } satisfies Omit<MemoryRelation, "content_hash">;
  const relation = {
    ...relationWithoutHash,
    content_hash: computeRelationContentHash(relationWithoutHash)
  } satisfies MemoryRelation;

  await writeJsonProjectFile(
    projectRoot,
    `.memory/relations/${fixture.id.slice("rel.".length)}.json`,
    relation
  );
}

async function readMemorySnapshot(projectRoot: string): Promise<Record<string, string>> {
  const paths = (
    await fg(".memory/**", {
      cwd: projectRoot,
      dot: true,
      onlyFiles: true,
      unique: true
    })
  ).sort();
  const snapshot: Record<string, string> = {};

  for (const path of paths) {
    snapshot[path] = await readFile(join(projectRoot, path), "utf8");
  }

  return snapshot;
}

async function writeJsonProjectFile(
  projectRoot: string,
  path: string,
  value: Record<string, unknown>
): Promise<void> {
  await writeProjectFile(projectRoot, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProjectFile(projectRoot: string, path: string, contents: string): Promise<void> {
  const absolutePath = join(projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

function createGitStatusRunner(stdout: string, trackedFiles = new Set<string>()): SubprocessRunner {
  return async (command, args, options) => {
    expect(command).toBe("git");

    if (args[0] === "status") {
      expect(args).toEqual(["status", "--porcelain=v1", "--", ".memory"]);
      return subprocessResult(command, args, options, stdout, 0);
    }

    if (args[0] === "ls-files") {
      const file = args.at(-1) ?? "";
      return subprocessResult(command, args, options, "", trackedFiles.has(file) ? 0 : 1);
    }

    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  };
}

function subprocessResult(
  command: string,
  args: readonly string[],
  options: SubprocessRunnerOptions,
  stdout: string,
  exitCode: number
): SubprocessResult {
  return {
    command,
    args,
    cwd: options.cwd ?? null,
    exitCode,
    signal: null,
    stdout,
    stderr: ""
  };
}
