import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  initProject,
  queryMemory,
  rebuildIndex,
  saveMemoryPatch
} from "../../../src/app/operations.js";
import type {
  MemoryEvent,
  ObjectId,
  Predicate
} from "../../../src/core/types.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import type { MemoryRelation } from "../../../src/storage/relations.js";
import {
  createFixedTestClock,
  FIXED_TIMESTAMP,
  FIXED_TIMESTAMP_NEXT_MINUTE
} from "../../fixtures/time.js";

const GENERATED_OBJECT_COUNT = 500;
const GENERATED_RELATION_COUNT = 1000;
const GENERATED_EVENT_COUNT = 2500;
const TEST_TIMEOUT_MS = 180_000;
const FIXTURE_TIMEOUT_MS = 60_000;
const REBUILD_TIMEOUT_MS = 60_000;
const OPERATION_TIMEOUT_MS = 30_000;
const WRITE_BATCH_SIZE = 64;
const PERFORMANCE_QUERY = "decision.perf-smoke-0001 performance smoke query";
const RELATION_PREDICATES = [
  "depends_on",
  "affects",
  "related_to"
] as const satisfies readonly Predicate[];

const tempRoots: string[] = [];

interface FileWrite {
  relativePath: string;
  contents: string;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("performance smoke tests", () => {
  it(
    "keeps local rebuild, search, and save operations responsive on a generated project",
    async () => {
      const projectRoot = await createInitializedProject("memory-performance-smoke-");
      const objectIds = await withLocalTimeout(
        "performance fixture generation",
        FIXTURE_TIMEOUT_MS,
        () => writePerformanceFixture(projectRoot)
      );
      const targetObjectId = objectIds[0];

      expect(targetObjectId).toBeDefined();
      if (targetObjectId === undefined) {
        throw new Error("Performance fixture did not create a target object.");
      }

      const rebuilt = await withLocalTimeout("index rebuild", REBUILD_TIMEOUT_MS, () =>
        rebuildIndex({
          cwd: projectRoot,
          clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
        })
      );

      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) {
        throw new Error(rebuilt.error.message);
      }
      expect(rebuilt.data).toMatchObject({
        index_rebuilt: true,
        objects_indexed: GENERATED_OBJECT_COUNT + 1,
        relations_indexed: GENERATED_RELATION_COUNT,
        events_indexed: GENERATED_EVENT_COUNT,
        event_appended: false
      });
      expect(rebuilt.data.objects_indexed).toBeGreaterThanOrEqual(GENERATED_OBJECT_COUNT);
      expect(rebuilt.data.relations_indexed).toBeGreaterThanOrEqual(
        GENERATED_RELATION_COUNT
      );
      expect(rebuilt.data.events_indexed).toBeGreaterThanOrEqual(GENERATED_EVENT_COUNT);

      const queried = await withLocalTimeout("query memory", OPERATION_TIMEOUT_MS, () =>
        queryMemory({
          cwd: projectRoot,
          question: PERFORMANCE_QUERY,
          tokenBudget: 8000
        })
      );

      expect(queried.ok).toBe(true);
      if (!queried.ok) {
        throw new Error(queried.error.message);
      }
      expect(queried.data.included_ids).toContain(targetObjectId);

      const saved = await withLocalTimeout("save small patch", OPERATION_TIMEOUT_MS, () =>
        saveMemoryPatch({
          cwd: projectRoot,
          clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
          patch: {
            source: {
              kind: "agent",
              task: "performance smoke save"
            },
            changes: [
              {
                op: "create_object",
                type: "gotcha",
                title: "Performance smoke saved note",
                body:
                  "# Performance smoke saved note\n\nThis local note proves save patch updates remain searchable in the performance smoke fixture.\n",
                tags: ["performance", "smoke", "save"]
              }
            ]
          }
        })
      );

      expect(saved.ok).toBe(true);
      if (!saved.ok) {
        throw new Error(saved.error.message);
      }
      expect(saved.data.memory_created).toEqual(["gotcha.performance-smoke-saved-note"]);
      expect(saved.data.events_appended).toBe(1);
      expect(saved.data.index_updated).toBe(true);

      const queriedAfterSave = await withLocalTimeout(
        "query saved memory",
        OPERATION_TIMEOUT_MS,
        () =>
          queryMemory({
            cwd: projectRoot,
            question: "gotcha.performance-smoke-saved-note",
            tokenBudget: 8000
          })
      );

      expect(queriedAfterSave.ok).toBe(true);
      if (!queriedAfterSave.ok) {
        throw new Error(queriedAfterSave.error.message);
      }
      expect(queriedAfterSave.data.included_ids).toContain(
        "gotcha.performance-smoke-saved-note"
      );
    },
    TEST_TIMEOUT_MS
  );
});

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const initialized = await initProject({
    cwd: projectRoot,
    clock: createFixedTestClock(FIXED_TIMESTAMP)
  });

  expect(initialized.ok).toBe(true);
  if (!initialized.ok) {
    throw new Error(initialized.error.message);
  }
  expect(initialized.data.index_built).toBe(true);

  return projectRoot;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function writePerformanceFixture(projectRoot: string): Promise<ObjectId[]> {
  const storage = await readCanonicalStorage(projectRoot);

  expect(storage.ok).toBe(true);
  if (!storage.ok) {
    throw new Error(storage.error.message);
  }

  const objectIds = Array.from({ length: GENERATED_OBJECT_COUNT }, (_value, index) =>
    objectIdForIndex(index + 1)
  );
  const writes = [
    ...buildObjectWrites(objectIds),
    ...buildRelationWrites(objectIds)
  ];

  await mkdir(join(projectRoot, ".memory", "memory", "decisions"), { recursive: true });
  await mkdir(join(projectRoot, ".memory", "relations"), { recursive: true });
  await writeFilesInBatches(projectRoot, writes, WRITE_BATCH_SIZE);
  await writeFile(
    join(projectRoot, ".memory", "events.jsonl"),
    buildEventsJsonl(objectIds),
    "utf8"
  );

  return objectIds;
}

function buildObjectWrites(objectIds: readonly ObjectId[]): FileWrite[] {
  return objectIds.flatMap((id, index) => {
    const fixtureIndex = index + 1;
    const slug = slugForIndex(fixtureIndex);
    const title = `Performance smoke fixture ${slug}`;
    const bodyPath = `memory/decisions/${slug}.md`;
    const body = [
      `# ${title}`,
      "",
      `Performance smoke query fixture ${fixtureIndex} documents local index rebuild, search, and context packaging behavior.`,
      "This deterministic project memory entry keeps performance smoke coverage local-only and repeatable."
    ].join("\n") + "\n";
    const sidecarWithoutHash = {
      id,
      type: "decision",
      status: "active",
      title,
      body_path: bodyPath,
      tags: ["performance", "smoke", "local"],
      source: {
        kind: "agent",
        task: "performance smoke fixture"
      },
      created_at: FIXED_TIMESTAMP,
      updated_at: FIXED_TIMESTAMP
    } satisfies Omit<MemoryObjectSidecar, "content_hash">;
    const sidecar: MemoryObjectSidecar = {
      ...sidecarWithoutHash,
      content_hash: computeObjectContentHash(sidecarWithoutHash, body)
    };

    return [
      {
        relativePath: `.memory/${bodyPath}`,
        contents: body
      },
      {
        relativePath: `.memory/${bodyPath.replace(/\.md$/, ".json")}`,
        contents: `${JSON.stringify(sidecar, null, 2)}\n`
      }
    ];
  });
}

function buildRelationWrites(objectIds: readonly ObjectId[]): FileWrite[] {
  return Array.from({ length: GENERATED_RELATION_COUNT }, (_value, index) => {
    const fixtureIndex = index + 1;
    const sourceIndex = index % objectIds.length;
    const round = Math.floor(index / objectIds.length);
    const targetIndex = (sourceIndex + 1 + round) % objectIds.length;
    const relationWithoutHash = {
      id: `rel.perf-smoke-${padIndex(fixtureIndex)}`,
      from: objectIds[sourceIndex] ?? objectIds[0] ?? "decision.perf-smoke-0001",
      predicate: RELATION_PREDICATES[index % RELATION_PREDICATES.length] ?? "related_to",
      to: objectIds[targetIndex] ?? objectIds[0] ?? "decision.perf-smoke-0001",
      status: "active",
      confidence: "high",
      created_at: FIXED_TIMESTAMP,
      updated_at: FIXED_TIMESTAMP
    } satisfies Omit<MemoryRelation, "content_hash">;
    const relation: MemoryRelation = {
      ...relationWithoutHash,
      content_hash: computeRelationContentHash(relationWithoutHash)
    };

    return {
      relativePath: `.memory/relations/perf-smoke-${padIndex(fixtureIndex)}.json`,
      contents: `${JSON.stringify(relation, null, 2)}\n`
    };
  });
}

function buildEventsJsonl(objectIds: readonly ObjectId[]): string {
  const lines = Array.from({ length: GENERATED_EVENT_COUNT }, (_value, index) => {
    const event = {
      event: "memory.updated",
      id: objectIds[index % objectIds.length] ?? "decision.perf-smoke-0001",
      actor: "agent",
      timestamp: FIXED_TIMESTAMP,
      reason: "Generated local performance smoke event."
    } satisfies MemoryEvent;

    return JSON.stringify(event);
  });

  return `${lines.join("\n")}\n`;
}

async function writeFilesInBatches(
  projectRoot: string,
  writes: readonly FileWrite[],
  batchSize: number
): Promise<void> {
  for (let index = 0; index < writes.length; index += batchSize) {
    const batch = writes.slice(index, index + batchSize);

    await Promise.all(
      batch.map((entry) => writeFile(join(projectRoot, entry.relativePath), entry.contents, "utf8"))
    );
  }
}

async function withLocalTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} did not finish within ${timeoutMs}ms.`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function objectIdForIndex(index: number): ObjectId {
  return `decision.perf-smoke-${padIndex(index)}`;
}

function slugForIndex(index: number): string {
  return `perf-smoke-${padIndex(index)}`;
}

function padIndex(index: number): string {
  return String(index).padStart(4, "0");
}
