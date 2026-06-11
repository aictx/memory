import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initProject } from "../../../src/app/operations.js";
import {
  updateIndexAfterCanonicalWrite,
  updateIndexIncrementally
} from "../../../src/index/incremental.js";
import { openIndexDatabase, type IndexDatabaseConnection } from "../../../src/index/sqlite.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../../src/storage/hashes.js";
import type { Evidence } from "../../../src/core/types.js";
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

describe("incremental index update", () => {
  it("skips unchanged object rows by content hash", async () => {
    const projectRoot = await createInitializedProject("memory-incremental-skip-");
    const projectId = await readProjectObjectId(projectRoot);

    const result = await updateIndexIncrementally({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        objectIds: [projectId]
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        index_updated: true,
        index_rebuilt: false,
        objects_updated: 0,
        objects_skipped: 1,
        objects_deleted: 0
      });
    }
  });

  it("upserts touched objects and replaces matching FTS rows", async () => {
    const projectRoot = await createInitializedProject("memory-incremental-object-");
    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (!storage.ok) {
      return;
    }

    await writeObject(projectRoot, {
      id: "gotcha.incremental-search",
      type: "gotcha",
      title: "Incremental search",
      bodyPath: "memory/gotchas/incremental-search.md",
      sidecarPath: ".memory/memory/gotchas/incremental-search.json",
      body: "# Incremental search\n\nSQLite FTS receives the new body for src/index/incremental.ts during updates.\n",
      tags: ["sqlite", "search"],
      anchors: ["src/index/incremental.ts", "src/index/"],
      evidence: [
        { kind: "file", id: "src/index/incremental.ts" },
        { kind: "commit", id: "abc123" }
      ],
      sourceCommit: "def456"
    });

    const result = await updateIndexIncrementally({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        objectIds: ["gotcha.incremental-search"]
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.objects_updated).toBe(1);
      expect(result.data.objects_skipped).toBe(0);
    }

    const connection = await openConnection(projectRoot);
    try {
      expect(readObject(connection.db, "gotcha.incremental-search")).toMatchObject({
        id: "gotcha.incremental-search",
        title: "Incremental search",
        tags_json: JSON.stringify(["sqlite", "search"]),
        anchors_json: JSON.stringify(["src/index/incremental.ts", "src/index/"])
      });
      expect(readFts(connection.db, "gotcha.incremental-search")).toMatchObject({
        object_id: "gotcha.incremental-search",
        title: "Incremental search",
        body: "# Incremental search\n\nSQLite FTS receives the new body for src/index/incremental.ts during updates.\n",
        tags: "sqlite search",
        anchors: "src/index/incremental.ts src/index/"
      });
      expect(readMemoryFileLinks(connection.db, "gotcha.incremental-search")).toEqual([
        { file_path: "src/index/incremental.ts", link_kind: "body.reference" },
        { file_path: "src/index/incremental.ts", link_kind: "evidence.file" }
      ]);
      expect(readMemoryCommitLinks(connection.db, "gotcha.incremental-search")).toEqual([
        { commit_hash: "abc123", link_kind: "evidence.commit" },
        { commit_hash: "def456", link_kind: "source.commit" }
      ]);
    } finally {
      connection.close();
    }
  });

  it("deletes touched objects from objects and FTS", async () => {
    const projectRoot = await createInitializedProject("memory-incremental-delete-object-");
    const projectId = await readProjectObjectId(projectRoot);

    await writeObject(projectRoot, {
      id: "decision.delete-me",
      type: "decision",
      title: "Delete me",
      bodyPath: "memory/decisions/delete-me.md",
      sidecarPath: ".memory/memory/decisions/delete-me.json",
      body: "# Delete me\n\nThis decision will be deleted from the index.\n",
      tags: []
    });
    const relation = buildRelation("decision.delete-me", projectId);
    await writeJsonProjectFile(
      projectRoot,
      ".memory/relations/decision-related-to-project.json",
      relation
    );

    const indexed = await updateIndexIncrementally({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        objectIds: ["decision.delete-me"],
        relationIds: [relation.id]
      }
    });
    expect(indexed.ok).toBe(true);

    await rm(join(projectRoot, ".memory", "memory", "decisions", "delete-me.md"));
    await rm(join(projectRoot, ".memory", "memory", "decisions", "delete-me.json"));
    await rm(join(projectRoot, ".memory", "relations", "decision-related-to-project.json"));

    const result = await updateIndexIncrementally({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        deletedObjectIds: ["decision.delete-me"],
        deletedRelationIds: [relation.id]
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.objects_deleted).toBe(1);
      expect(result.data.relations_deleted).toBe(1);
    }

    const connection = await openConnection(projectRoot);
    try {
      expect(readObject(connection.db, "decision.delete-me")).toBeUndefined();
      expect(readFts(connection.db, "decision.delete-me")).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("upserts relations, deletes relations, and indexes appended events", async () => {
    const projectRoot = await createInitializedProject("memory-incremental-relation-event-");
    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    if (!storage.ok) {
      return;
    }

    const projectId = storage.data.config.project.id;
    const relation = buildRelation(projectId, projectId);
    await writeJsonProjectFile(
      projectRoot,
      ".memory/relations/project-related-to-project.json",
      relation
    );
    await writeProjectFile(
      projectRoot,
      ".memory/events.jsonl",
      `${JSON.stringify({
        event: "relation.created",
        relation_id: relation.id,
        actor: "agent",
        timestamp: FIXED_TIMESTAMP,
        payload: {
          from: projectId,
          predicate: "related_to",
          to: projectId
        }
      })}\n`
    );

    const created = await updateIndexIncrementally({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        relationIds: [relation.id],
        appendedEventCount: 1
      }
    });

    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.data.relations_updated).toBe(1);
      expect(created.data.events_indexed).toBe(1);
    }

    let connection = await openConnection(projectRoot);
    try {
      expect(readRelation(connection.db, relation.id)).toMatchObject({
        id: relation.id,
        predicate: "related_to"
      });
      expect(readEventsRows(connection.db)).toEqual([
        {
          line_number: 1,
          event: "relation.created",
          memory_id: null,
          relation_id: relation.id
        }
      ]);
    } finally {
      connection.close();
    }

    await rm(join(projectRoot, ".memory", "relations", "project-related-to-project.json"));
    const deleted = await updateIndexIncrementally({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        deletedRelationIds: [relation.id]
      }
    });

    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.data.relations_deleted).toBe(1);
    }

    connection = await openConnection(projectRoot);
    try {
      expect(readRelation(connection.db, relation.id)).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("skips cleanly when auto-indexing is disabled", async () => {
    const projectRoot = await createInitializedProject("memory-incremental-auto-index-off-");
    const projectId = await readProjectObjectId(projectRoot);
    const configPath = join(projectRoot, ".memory", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      memory: { autoIndex: boolean };
    };
    config.memory.autoIndex = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = await updateIndexIncrementally({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        objectIds: [projectId]
      }
    });

    expect(result).toEqual({
      ok: true,
      data: {
        index_updated: false,
        index_rebuilt: false,
        objects_updated: 0,
        objects_skipped: 0,
        objects_deleted: 0,
        relations_updated: 0,
        relations_deleted: 0,
        events_indexed: 0
      },
      warnings: []
    });
  });

  it("converts strict index failures to post-write warnings", async () => {
    const projectRoot = await createInitializedProject("memory-incremental-warning-");

    const result = await updateIndexAfterCanonicalWrite({
      projectRoot,
      memoryRoot: join(projectRoot, ".memory"),
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      touched: {
        appendedEventCount: -1
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.index_updated).toBe(false);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Index warning:")
        ])
      );
    }
  });
});

interface ObjectRow {
  id: string;
  title: string;
  tags_json: string;
  anchors_json: string | null;
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
  predicate: string;
}

interface EventRow {
  line_number: number;
  event: string;
  memory_id: string | null;
  relation_id: string | null;
}

interface FileLinkRow {
  file_path: string;
  link_kind: string;
}

interface CommitLinkRow {
  commit_hash: string;
  link_kind: string;
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

async function readProjectObjectId(projectRoot: string): Promise<string> {
  const storage = await readCanonicalStorage(projectRoot);

  if (!storage.ok) {
    throw new Error(storage.error.message);
  }

  return storage.data.config.project.id;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function openConnection(projectRoot: string): Promise<IndexDatabaseConnection> {
  const opened = await openIndexDatabase({ memoryRoot: join(projectRoot, ".memory") });

  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }

  return opened.data;
}

function readObject(
  db: IndexDatabaseConnection["db"],
  id: string
): ObjectRow | undefined {
  return db
    .prepare<[string], ObjectRow>(
      "SELECT id, title, tags_json, anchors_json FROM objects WHERE id = ?"
    )
    .get(id);
}

function readFts(db: IndexDatabaseConnection["db"], id: string): FtsRow | undefined {
  return db
    .prepare<[string], FtsRow>(
      "SELECT object_id, title, body, tags, anchors FROM objects_fts WHERE object_id = ?"
    )
    .get(id);
}

function readRelation(
  db: IndexDatabaseConnection["db"],
  id: string
): RelationRow | undefined {
  return db
    .prepare<[string], RelationRow>("SELECT id, predicate FROM relations WHERE id = ?")
    .get(id);
}

function readEventsRows(db: IndexDatabaseConnection["db"]): EventRow[] {
  return db
    .prepare<[], EventRow>(
      `
        SELECT line_number, event, memory_id, relation_id
        FROM events
        ORDER BY line_number
      `
    )
    .all();
}

function readMemoryFileLinks(db: IndexDatabaseConnection["db"], id: string): FileLinkRow[] {
  return db
    .prepare<[string], FileLinkRow>(
      `
        SELECT file_path, link_kind
        FROM memory_file_links
        WHERE memory_id = ?
        ORDER BY file_path, link_kind
      `
    )
    .all(id);
}

function readMemoryCommitLinks(db: IndexDatabaseConnection["db"], id: string): CommitLinkRow[] {
  return db
    .prepare<[string], CommitLinkRow>(
      `
        SELECT commit_hash, link_kind
        FROM memory_commit_links
        WHERE memory_id = ?
        ORDER BY commit_hash, link_kind
      `
    )
    .all(id);
}

async function writeObject(
  projectRoot: string,
  options: {
    id: string;
    type: MemoryObjectSidecar["type"];
    title: string;
    bodyPath: string;
    sidecarPath: string;
    body: string;
    tags: string[];
    anchors?: string[];
    evidence?: Evidence[];
    sourceCommit?: string;
  }
): Promise<void> {
  const sidecarWithoutHash = {
    id: options.id,
    type: options.type,
    status: "active",
    title: options.title,
    body_path: options.bodyPath,
    ...(options.anchors === undefined ? {} : { anchors: options.anchors }),
    tags: options.tags,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    source: {
      kind: "agent",
      ...(options.sourceCommit === undefined ? {} : { commit: options.sourceCommit })
    },
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  } satisfies Omit<MemoryObjectSidecar, "content_hash">;
  const sidecar: MemoryObjectSidecar = {
    ...sidecarWithoutHash,
    content_hash: computeObjectContentHash(sidecarWithoutHash, options.body)
  };

  await writeProjectFile(projectRoot, `.memory/${options.bodyPath}`, options.body);
  await writeJsonProjectFile(projectRoot, options.sidecarPath, sidecar);
}

function buildRelation(from: string, to: string): MemoryRelation {
  const relationWithoutHash = {
    id: `rel.${from.replace(".", "-")}-related-to-${to.replace(".", "-")}`,
    from,
    predicate: "related_to",
    to,
    status: "active",
    confidence: "medium",
    evidence: [
      {
        kind: "memory",
        id: to
      }
    ],
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  } satisfies Omit<MemoryRelation, "content_hash">;

  return {
    ...relationWithoutHash,
    content_hash: computeRelationContentHash(relationWithoutHash)
  };
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
