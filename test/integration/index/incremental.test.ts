import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initProject, rebuildIndex } from "../../../src/app/operations.js";
import {
  updateIndexAfterCanonicalWrite,
  updateIndexIncrementally
} from "../../../src/index/incremental.js";
import { openIndexDatabase, type IndexDatabaseConnection } from "../../../src/index/sqlite.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import type { MemoryRelation } from "../../../src/storage/relations.js";
import { createFixedTestClock, FIXED_TIMESTAMP, FIXED_TIMESTAMP_NEXT_MINUTE } from "../../fixtures/time.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("incremental index integration", () => {
  it("matches a full rebuild after touched object, relation, and event changes", async () => {
    const projectRoot = await createInitializedProject("memory-incremental-match-rebuild-");
    const touched = await writeTouchedCanonicalChanges(projectRoot);

    const incremental = await updateIndexIncrementally({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched
    });

    expect(incremental.ok).toBe(true);
    if (!incremental.ok) {
      return;
    }
    expect(incremental.data).toMatchObject({
      index_updated: true,
      index_rebuilt: false,
      objects_updated: 2,
      relations_updated: 1,
      events_indexed: 2
    });

    const incrementalSnapshot = await snapshotIndex(projectRoot);
    const rebuilt = await rebuildIndex({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(rebuilt.ok).toBe(true);
    const rebuiltSnapshot = await snapshotIndex(projectRoot);

    expect(incrementalSnapshot).toEqual(rebuiltSnapshot);
  });

  it("returns an index warning instead of a failed save result after canonical writes", async () => {
    const projectRoot = await createInitializedProject("memory-incremental-warning-after-write-");
    const storageBefore = await readCanonicalStorage(projectRoot);
    expect(storageBefore.ok).toBe(true);

    await rm(join(projectRoot, ".memory", "index", "memory.sqlite"), { force: true });
    await mkdir(join(projectRoot, ".memory", "index", "memory.sqlite"));

    const result = await updateIndexAfterCanonicalWrite({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        objectIds: [
          storageBefore.ok ? storageBefore.data.config.project.id : "project.unknown"
        ]
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        index_updated: false,
        index_rebuilt: false,
        objects_updated: 0,
        objects_skipped: 0,
        objects_deleted: 0,
        relations_updated: 0,
        relations_deleted: 0,
        events_indexed: 0
      });
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Index warning:")
        ])
      );
    }

    const storageAfter = await readCanonicalStorage(projectRoot);
    expect(storageAfter.ok).toBe(true);
    if (storageBefore.ok && storageAfter.ok) {
      expect(storageAfter.data.objects.map((object) => object.sidecar.id).sort()).toEqual(
        storageBefore.data.objects.map((object) => object.sidecar.id).sort()
      );
    }
  });
});

type TouchedChanges = Parameters<typeof updateIndexIncrementally>[0]["touched"];

interface ObjectRow {
  id: string;
  type: string;
  status: string;
  title: string;
  body_path: string;
  json_path: string;
  body: string;
  content_hash: string;
  stage: string | null;
  anchors_json: string | null;
  tags_json: string;
  source_json: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

interface FtsRow {
  object_id: string;
  title: string;
  body: string;
  tags: string;
  anchors: string;
}

interface RelationRow {
  id: string;
  from_id: string;
  predicate: string;
  to_id: string;
  status: string;
  confidence: string | null;
  evidence_json: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  line_number: number;
  event: string;
  memory_id: string | null;
  relation_id: string | null;
  actor: string;
  timestamp: string;
  reason: string | null;
  payload_json: string | null;
}

interface MetaRow {
  key: string;
  value: string;
}

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const initialized = await initProject({
    cwd: projectRoot,
    clock: createFixedTestClock()
  });

  expect(initialized.ok).toBe(true);
  if (!initialized.ok) {
    throw new Error(initialized.error.message);
  }

  return projectRoot;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function writeTouchedCanonicalChanges(projectRoot: string): Promise<TouchedChanges> {
  const storage = await readCanonicalStorage(projectRoot);
  expect(storage.ok).toBe(true);
  if (!storage.ok) {
    throw new Error(storage.error.message);
  }

  const projectId = storage.data.config.project.id;
  const projectObject = storage.data.objects.find(
    (object) => object.sidecar.id === projectId
  );

  if (projectObject === undefined) {
    throw new Error("Missing starter project fixture object.");
  }

  const updatedProjectBody =
    "# Project\n\nProject memory starts here.\n\nIncremental updates keep SQLite current.\n";
  const { content_hash: _oldProjectHash, ...projectWithoutHash } = {
    ...projectObject.sidecar,
    updated_at: FIXED_TIMESTAMP_NEXT_MINUTE
  };
  const updatedProject: MemoryObjectSidecar = {
    ...projectWithoutHash,
    content_hash: computeObjectContentHash(projectWithoutHash, updatedProjectBody)
  };

  await writeProjectFile(
    projectRoot,
    `.memory/${updatedProject.body_path}`,
    updatedProjectBody
  );
  await writeJsonProjectFile(projectRoot, projectObject.path, updatedProject);

  const decisionBody = "# Webhook idempotency\n\nWebhook handlers must dedupe delivery IDs.\n";
  const decisionWithoutHash = {
    id: "decision.webhook-idempotency",
    type: "decision",
    status: "active",
    title: "Webhook idempotency",
    body_path: "memory/decisions/webhook-idempotency.md",
    anchors: ["src/webhooks/"],
    tags: ["stripe", "webhooks"],
    source: {
      kind: "agent"
    },
    created_at: FIXED_TIMESTAMP_NEXT_MINUTE,
    updated_at: FIXED_TIMESTAMP_NEXT_MINUTE
  } satisfies Omit<MemoryObjectSidecar, "content_hash">;
  const decision: MemoryObjectSidecar = {
    ...decisionWithoutHash,
    content_hash: computeObjectContentHash(decisionWithoutHash, decisionBody)
  };
  const relationWithoutHash = {
    id: "rel.project-depends-on-webhook-idempotency",
    from: projectId,
    predicate: "depends_on",
    to: "decision.webhook-idempotency",
    status: "active",
    confidence: "high",
    evidence: [
      {
        kind: "memory",
        id: projectId
      }
    ],
    created_at: FIXED_TIMESTAMP_NEXT_MINUTE,
    updated_at: FIXED_TIMESTAMP_NEXT_MINUTE
  } satisfies Omit<MemoryRelation, "content_hash">;
  const relation: MemoryRelation = {
    ...relationWithoutHash,
    content_hash: computeRelationContentHash(relationWithoutHash)
  };
  const events = [
    {
      event: "memory.created",
      id: "decision.webhook-idempotency",
      actor: "agent",
      timestamp: FIXED_TIMESTAMP_NEXT_MINUTE,
      payload: {
        title: "Webhook idempotency"
      }
    },
    {
      event: "relation.created",
      relation_id: "rel.project-depends-on-webhook-idempotency",
      actor: "agent",
      timestamp: FIXED_TIMESTAMP_NEXT_MINUTE,
      payload: {
        from: projectId,
        predicate: "depends_on",
        to: "decision.webhook-idempotency"
      }
    }
  ];

  await writeProjectFile(projectRoot, ".memory/memory/decisions/webhook-idempotency.md", decisionBody);
  await writeJsonProjectFile(
    projectRoot,
    ".memory/memory/decisions/webhook-idempotency.json",
    decision
  );
  await writeJsonProjectFile(
    projectRoot,
    ".memory/relations/project-depends-on-webhook-idempotency.json",
    relation
  );
  await writeProjectFile(
    projectRoot,
    ".memory/events.jsonl",
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );

  return {
    objectIds: [projectId, "decision.webhook-idempotency"],
    relationIds: ["rel.project-depends-on-webhook-idempotency"],
    appendedEventCount: 2
  };
}

async function snapshotIndex(projectRoot: string) {
  const connection = await openConnection(projectRoot);

  try {
    return {
      objects: connection.db
        .prepare<[], ObjectRow>(
          `
            SELECT
              id,
              type,
              status,
              title,
              body_path,
              json_path,
              body,
              content_hash,
              stage,
              anchors_json,
              tags_json,
              source_json,
              superseded_by,
              created_at,
              updated_at
            FROM objects
            ORDER BY id
          `
        )
        .all(),
      fts: connection.db
        .prepare<[], FtsRow>(
          "SELECT object_id, title, body, tags, anchors FROM objects_fts ORDER BY object_id"
        )
        .all(),
      relations: connection.db
        .prepare<[], RelationRow>(
          `
            SELECT
              id,
              from_id,
              predicate,
              to_id,
              status,
              confidence,
              evidence_json,
              content_hash,
              created_at,
              updated_at
            FROM relations
            ORDER BY id
          `
        )
        .all(),
      events: connection.db
        .prepare<[], EventRow>(
          `
            SELECT
              line_number,
              event,
              memory_id,
              relation_id,
              actor,
              timestamp,
              reason,
              payload_json
            FROM events
            ORDER BY line_number
          `
        )
        .all(),
      meta: connection.db
        .prepare<[], MetaRow>("SELECT key, value FROM meta ORDER BY key")
        .all()
    };
  } finally {
    connection.close();
  }
}

async function openConnection(projectRoot: string): Promise<IndexDatabaseConnection> {
  const opened = await openIndexDatabase({ memoryRoot: join(projectRoot, ".memory") });

  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }

  return opened.data;
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

async function writeJsonProjectFile(
  projectRoot: string,
  path: string,
  value: unknown
): Promise<void> {
  await writeProjectFile(projectRoot, path, `${JSON.stringify(value, null, 2)}\n`);
}
