import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initProject, rebuildIndex, searchMemory } from "../../../src/app/operations.js";
import { computeObjectContentHash } from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import type { ObjectStatus, ObjectType } from "../../../src/core/types.js";
import { createFixedTestClock, FIXED_TIMESTAMP, FIXED_TIMESTAMP_NEXT_MINUTE } from "../../fixtures/time.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("search memory integration", () => {
  it("searches rebuilt local SQLite memory through the app service", async () => {
    const projectRoot = await createInitializedProject("memory-search-app-");
    await writeSearchFixtures(projectRoot);

    const rebuilt = await rebuildIndex({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(rebuilt.ok).toBe(true);

    const first = await searchMemory({
      cwd: projectRoot,
      query: "Stripe webhook idempotency",
      limit: 10,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });
    const second = await searchMemory({
      cwd: projectRoot,
      query: "Stripe webhook idempotency",
      limit: 10,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (first.ok && second.ok) {
      expect(first.meta).toMatchObject({
        project_root: projectRoot,
        memory_root: join(projectRoot, ".memory"),
        git: {
          available: false,
          branch: null,
          commit: null,
          dirty: null
        }
      });

      const ids = first.data.matches.map((match) => match.id);
      const webhook = first.data.matches.find(
        (match) => match.id === "decision.webhook-idempotency"
      );

      expect(ids).toContain("decision.webhook-idempotency");
      expect(ids).toContain("decision.old-webhook-queue");
      expect(ids).toContain("feature.webhook-context");
      expect(second.data.matches.map((match) => match.id)).toEqual(ids);
      expect(webhook).toMatchObject({
        id: "decision.webhook-idempotency",
        type: "decision",
        status: "active",
        title: "Webhook idempotency",
        body_path: ".memory/memory/decisions/webhook-idempotency.md"
      });
      expect(typeof webhook?.score).toBe("number");
      expect(webhook?.snippet).toContain("Stripe may deliver duplicate webhook events");
    }
  });

  it("rebuilds and retries once when the index is missing and auto-indexing is enabled", async () => {
    const projectRoot = await createInitializedProject("memory-search-auto-rebuild-");
    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    const projectId = storage.ok ? storage.data.config.project.id : "project.unknown";
    await rm(join(projectRoot, ".memory", "index"), { recursive: true, force: true });

    const result = await searchMemory({
      cwd: projectRoot,
      query: projectId,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.matches.map((match) => match.id)).toContain(projectId);
      expect(result.data.matches[0]).toHaveProperty("status");
    }
  });

  it("returns index unavailable when the index is missing and auto-indexing is disabled", async () => {
    const projectRoot = await createInitializedProject("memory-search-auto-index-off-");
    const configPath = join(projectRoot, ".memory", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      memory: { autoIndex: boolean };
    };

    config.memory.autoIndex = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rm(join(projectRoot, ".memory", "index"), { recursive: true, force: true });

    const result = await searchMemory({
      cwd: projectRoot,
      query: "anything",
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryIndexUnavailable");
    }
  });
});

interface SearchFixture {
  id: string;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  bodyPath: string;
  body: string;
  tags: string[];
  updatedAt?: string;
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

async function writeSearchFixtures(projectRoot: string): Promise<void> {
  await writeMemoryObject(projectRoot, {
    id: "decision.webhook-idempotency",
    type: "decision",
    status: "active",
    title: "Webhook idempotency",
    bodyPath: "memory/decisions/webhook-idempotency.md",
    body: "# Webhook idempotency\n\nStripe may deliver duplicate webhook events, so delivery IDs must be deduplicated.\n",
    tags: ["stripe", "webhooks", "idempotency"],
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
  await writeMemoryObject(projectRoot, {
    id: "decision.old-webhook-queue",
    type: "decision",
    status: "stale",
    title: "Old webhook queue",
    bodyPath: "memory/decisions/old-webhook-queue.md",
    body: "# Old webhook queue\n\nStripe webhook work previously used an old queue design.\n",
    tags: ["stripe", "webhooks"],
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryObject(projectRoot, {
    id: "feature.webhook-context",
    type: "feature",
    status: "active",
    title: "Webhook context",
    bodyPath: "memory/features/webhook-context.md",
    body: "# Webhook context\n\nStripe webhook implementation context is maintained as feature memory.\n",
    tags: ["stripe", "webhooks"],
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
}

async function writeMemoryObject(projectRoot: string, fixture: SearchFixture): Promise<void> {
  const storage = await readCanonicalStorage(projectRoot);

  expect(storage.ok).toBe(true);
  if (!storage.ok) {
    throw new Error(storage.error.message);
  }

  const sidecarWithoutHash = {
    id: fixture.id,
    type: fixture.type,
    status: fixture.status,
    title: fixture.title,
    body_path: fixture.bodyPath,
    tags: fixture.tags,
    source: {
      kind: "agent"
    },
    created_at: fixture.updatedAt ?? FIXED_TIMESTAMP,
    updated_at: fixture.updatedAt ?? FIXED_TIMESTAMP
  } satisfies Omit<MemoryObjectSidecar, "content_hash">;
  const sidecar: MemoryObjectSidecar = {
    ...sidecarWithoutHash,
    content_hash: computeObjectContentHash(sidecarWithoutHash, fixture.body)
  };

  await writeProjectFile(projectRoot, `.memory/${fixture.bodyPath}`, fixture.body);
  await writeJsonProjectFile(
    projectRoot,
    `.memory/${fixture.bodyPath.replace(/\.md$/, ".json")}`,
    sidecar
  );
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  contents: string
): Promise<void> {
  const target = join(projectRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function writeJsonProjectFile(
  projectRoot: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  await writeProjectFile(projectRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}
