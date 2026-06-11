import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  RelationConfidence,
  RelationId
} from "../../../src/core/types.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import type { MemoryRelation } from "../../../src/storage/relations.js";
import { applyMemoryPatch } from "../../../src/storage/write.js";
import { SCHEMA_FILES } from "../../../src/validation/schemas.js";
import { createFixedTestClock, FIXED_TIMESTAMP } from "../../fixtures/time.js";

const repoRoot = process.cwd();
const tempRoots: string[] = [];
const projectId = "project.billing-api";
const originalTimestamp = "2026-04-25T13:00:00+02:00";
const noGit: GitState = {
  available: false,
  branch: null,
  commit: null,
  dirty: null
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
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("applyMemoryPatch relation operations", () => {
  it("creates, updates, deletes, hashes, and appends relation events", async () => {
    const projectRoot = await createRelationPatchProject();

    const result = await applyMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent",
          task: "Record relation changes"
        },
        changes: [
          {
            op: "create_relation",
            from: "decision.webhook-idempotency",
            predicate: "affects",
            to: "decision.billing-retries",
            confidence: "high",
            evidence: [
              {
                kind: "memory",
                id: "decision.webhook-idempotency"
              }
            ]
          },
          {
            op: "update_relation",
            id: "rel.billing-retries-depends-on-idempotency",
            status: "stale",
            confidence: "low",
            evidence: [
              {
                kind: "commit",
                id: "abc123"
              }
            ]
          },
          {
            op: "delete_relation",
            id: "rel.billing-retries-related-to-idempotency"
          }
        ]
      },
      git: noGit,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.relations_created).toEqual([
      "rel.decision-webhook-idempotency-affects-decision-billing-retries"
    ]);
    expect(result.data.relations_updated).toEqual(["rel.billing-retries-depends-on-idempotency"]);
    expect(result.data.relations_deleted).toEqual(["rel.billing-retries-related-to-idempotency"]);
    expect(result.data.events_appended).toBe(3);
    expect(result.data.files_changed).toEqual([
      ".memory/events.jsonl",
      ".memory/relations/billing-retries-depends-on-idempotency.json",
      ".memory/relations/billing-retries-related-to-idempotency.json",
      ".memory/relations/decision-webhook-idempotency-affects-decision-billing-retries.json"
    ]);

    const created = await readJsonProjectFile(
      projectRoot,
      ".memory/relations/decision-webhook-idempotency-affects-decision-billing-retries.json"
    );
    expect(created).toEqual(
      expect.objectContaining({
        id: "rel.decision-webhook-idempotency-affects-decision-billing-retries",
        from: "decision.webhook-idempotency",
        predicate: "affects",
        to: "decision.billing-retries",
        status: "active",
        confidence: "high",
        evidence: [
          {
            kind: "memory",
            id: "decision.webhook-idempotency"
          }
        ],
        created_at: FIXED_TIMESTAMP,
        updated_at: FIXED_TIMESTAMP
      })
    );
    expectRelationHash(created);

    const updated = await readJsonProjectFile(
      projectRoot,
      ".memory/relations/billing-retries-depends-on-idempotency.json"
    );
    expect(updated).toEqual(
      expect.objectContaining({
        id: "rel.billing-retries-depends-on-idempotency",
        from: "decision.billing-retries",
        predicate: "depends_on",
        to: "decision.webhook-idempotency",
        status: "stale",
        confidence: "low",
        evidence: [
          {
            kind: "commit",
            id: "abc123"
          }
        ],
        created_at: originalTimestamp,
        updated_at: FIXED_TIMESTAMP
      })
    );
    expectRelationHash(updated);
    await expectPathMissing(
      projectRoot,
      ".memory/relations/billing-retries-related-to-idempotency.json"
    );

    const events = await readEvents(projectRoot);
    expect(events).toEqual([
      expect.objectContaining({
        event: "relation.created",
        relation_id: "rel.decision-webhook-idempotency-affects-decision-billing-retries",
        actor: "agent",
        timestamp: FIXED_TIMESTAMP
      }),
      expect.objectContaining({
        event: "relation.updated",
        relation_id: "rel.billing-retries-depends-on-idempotency",
        actor: "agent",
        timestamp: FIXED_TIMESTAMP
      }),
      expect.objectContaining({
        event: "relation.deleted",
        relation_id: "rel.billing-retries-related-to-idempotency",
        actor: "agent",
        timestamp: FIXED_TIMESTAMP
      })
    ]);
  });

  it.each([
    {
      name: "from",
      change: {
        op: "create_relation",
        from: "decision.missing",
        predicate: "depends_on",
        to: "decision.webhook-idempotency"
      },
      field: "/changes/0/from"
    },
    {
      name: "to",
      change: {
        op: "create_relation",
        from: "decision.billing-retries",
        predicate: "depends_on",
        to: "gotcha.missing"
      },
      field: "/changes/0/to"
    }
  ])("rejects missing $name endpoints before disk mutation", async ({ change, field }) => {
    const projectRoot = await createRelationPatchProject();
    const before = await readMemorySnapshot(projectRoot);

    const result = await applyMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [change]
      },
      git: noGit,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryObjectNotFound");
      expect(JSON.stringify(result.error.details)).toContain(field);
    }
    await expect(readMemorySnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("rejects duplicate equivalent relations before disk mutation", async () => {
    const projectRoot = await createRelationPatchProject();
    const before = await readMemorySnapshot(projectRoot);

    const result = await applyMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "create_relation",
            id: "rel.duplicate-depends-on",
            from: "decision.billing-retries",
            predicate: "depends_on",
            to: "decision.webhook-idempotency"
          }
        ]
      },
      git: noGit,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryInvalidRelation");
    }
    await expect(readMemorySnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("rejects immutable relation endpoint updates before disk mutation", async () => {
    const projectRoot = await createRelationPatchProject();
    const before = await readMemorySnapshot(projectRoot);

    const result = await applyMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "update_relation",
            id: "rel.billing-retries-depends-on-idempotency",
            from: "decision.webhook-idempotency"
          }
        ]
      },
      git: noGit,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemorySchemaValidationFailed");
    }
    await expect(readMemorySnapshot(projectRoot)).resolves.toEqual(before);
  });

  it("treats relation updates without mutable fields as no-ops", async () => {
    const projectRoot = await createRelationPatchProject();
    const before = await readMemorySnapshot(projectRoot);

    const result = await applyMemoryPatch({
      projectRoot,
      patch: {
        source: {
          kind: "agent"
        },
        changes: [
          {
            op: "update_relation",
            id: "rel.billing-retries-depends-on-idempotency"
          }
        ]
      },
      git: noGit,
      clock: createFixedTestClock(FIXED_TIMESTAMP)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.relations_updated).toEqual([]);
    expect(result.data.events_appended).toBe(0);
    expect(result.data.files_changed).toEqual([]);
    await expect(readMemorySnapshot(projectRoot)).resolves.toEqual(before);
  });
});

async function createRelationPatchProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "memory-relation-patch-"));
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
    status: "active",
    confidence: "medium"
  });
  await writeRelation(projectRoot, {
    id: "rel.billing-retries-related-to-idempotency",
    from: "decision.billing-retries",
    predicate: "related_to",
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
    created_at: originalTimestamp,
    updated_at: originalTimestamp
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
    confidence?: RelationConfidence;
  }
): Promise<void> {
  const relationWithoutHash = {
    id: fixture.id,
    from: fixture.from,
    predicate: fixture.predicate,
    to: fixture.to,
    status: fixture.status,
    ...(fixture.confidence === undefined ? {} : { confidence: fixture.confidence }),
    created_at: originalTimestamp,
    updated_at: originalTimestamp
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

async function readJsonProjectFile(
  projectRoot: string,
  path: string
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(projectRoot, path), "utf8")) as Record<string, unknown>;
}

async function readEvents(projectRoot: string): Promise<Record<string, unknown>[]> {
  const contents = await readFile(join(projectRoot, ".memory/events.jsonl"), "utf8");

  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

async function expectPathMissing(projectRoot: string, path: string): Promise<void> {
  await expect(access(join(projectRoot, path))).rejects.toMatchObject({
    code: "ENOENT"
  });
}

function expectRelationHash(relation: Record<string, unknown>): void {
  const { content_hash: contentHash, ...withoutHash } = relation;

  expect(contentHash).toBe(computeRelationContentHash(withoutHash));
}

async function writeJsonProjectFile(
  projectRoot: string,
  path: string,
  value: Record<string, unknown>
): Promise<void> {
  await writeProjectFile(projectRoot, path, `${JSON.stringify(value, null, 2)}\n`);
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
