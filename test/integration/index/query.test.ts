import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initProject, queryMemory, rebuildIndex } from "../../../src/app/operations.js";
import { computeObjectContentHash } from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import type { ObjectStatus, ObjectType, Predicate } from "../../../src/core/types.js";
import {
  createFixedTestClock,
  FIXED_TIMESTAMP,
  FIXED_TIMESTAMP_NEXT_MINUTE
} from "../../fixtures/time.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("query memory integration", () => {
  it("queries rebuilt local SQLite memory and expands one-hop relations", async () => {
    const projectRoot = await createInitializedProject("memory-query-app-");
    await writeQueryFixtures(projectRoot);

    const rebuilt = await rebuildIndex({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(rebuilt.ok).toBe(true);

    const first = await queryMemory({
      cwd: projectRoot,
      question: "Stripe webhook idempotency",
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });
    const second = await queryMemory({
      cwd: projectRoot,
      question: "Stripe webhook idempotency",
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

      expect(first.data.question).toBe("Stripe webhook idempotency");
      expect(first.data.included_ids).toContain("decision.webhook-idempotency");
      expect(first.data.markdown).toContain("## Matches");
      expect(first.data.markdown).toContain(
        "### decision.webhook-idempotency — Webhook idempotency  [active]"
      );
      expect(first.data.markdown).toContain(
        "Stripe may deliver duplicate webhook events"
      );

      // One-hop expansion: the gotcha does not match the question text and can
      // only appear through its relation to the seed decision.
      expect(first.data.connected_ids).toContain("gotcha.payment-retry-window");
      expect(first.data.markdown).toContain("## Connected");
      expect(first.data.markdown).toContain(
        "- gotcha.payment-retry-window (affects decision.webhook-idempotency) — Payment retry window"
      );

      // Connected open questions always surface in their own section.
      expect(first.data.connected_ids).toContain("question.retry-cap-policy");
      expect(first.data.markdown).toContain("## Open questions");
      expect(first.data.markdown).toContain(
        "- question.retry-cap-policy — Retry cap policy"
      );

      expect(first.data.estimated_tokens).toBeGreaterThan(0);
      expect(first.data.truncated).toBe(false);
      expect(second.data.markdown).toBe(first.data.markdown);
    }
  });

  it("respects the token budget and reports truncation", async () => {
    const projectRoot = await createInitializedProject("memory-query-budget-");
    await writeQueryFixtures(projectRoot);
    await writeMemoryObject(projectRoot, {
      id: "feature.webhook-idempotency-deep-dive",
      type: "feature",
      status: "active",
      title: "Webhook idempotency deep dive",
      bodyPath: "memory/features/webhook-idempotency-deep-dive.md",
      body: `# Webhook idempotency deep dive\n\n${"Stripe webhook idempotency handling depends on deduplicated delivery IDs and replay-safe processing. ".repeat(120)}\n`,
      tags: ["stripe", "webhooks", "idempotency"],
      updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
    });

    const rebuilt = await rebuildIndex({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(rebuilt.ok).toBe(true);

    const result = await queryMemory({
      cwd: projectRoot,
      question: "Stripe webhook idempotency",
      tokenBudget: 600,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.estimated_tokens).toBeLessThanOrEqual(600);
      expect(result.data.truncated).toBe(true);
      expect(result.data.included_ids.length).toBeGreaterThan(0);
    }
  });

  it("rebuilds and retries once when the index is missing and auto-indexing is enabled", async () => {
    const projectRoot = await createInitializedProject("memory-query-auto-rebuild-");
    const storage = await readCanonicalStorage(projectRoot);
    expect(storage.ok).toBe(true);
    const projectId = storage.ok ? storage.data.config.project.id : "project.unknown";
    await rm(join(projectRoot, ".memory", "index"), { recursive: true, force: true });

    const result = await queryMemory({
      cwd: projectRoot,
      question: projectId,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.included_ids).toContain(projectId);
    }
  });

  it("returns index unavailable when the index is missing and auto-indexing is disabled", async () => {
    const projectRoot = await createInitializedProject("memory-query-auto-index-off-");
    const configPath = join(projectRoot, ".memory", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      memory: { autoIndex: boolean };
    };

    config.memory.autoIndex = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rm(join(projectRoot, ".memory", "index"), { recursive: true, force: true });

    const result = await queryMemory({
      cwd: projectRoot,
      question: "anything",
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE)
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MemoryIndexUnavailable");
    }
  });
});

interface QueryObjectFixture {
  id: string;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  bodyPath: string;
  body: string;
  tags: string[];
  updatedAt?: string;
}

interface QueryRelationFixture {
  id: string;
  from: string;
  predicate: Predicate;
  to: string;
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

async function writeQueryFixtures(projectRoot: string): Promise<void> {
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
    id: "gotcha.payment-retry-window",
    type: "gotcha",
    status: "active",
    title: "Payment retry window",
    bodyPath: "memory/gotchas/payment-retry-window.md",
    body: "# Payment retry window\n\nPayment retries must respect a 24 hour delivery window.\n",
    tags: ["payments"],
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryObject(projectRoot, {
    id: "question.retry-cap-policy",
    type: "question",
    status: "open",
    title: "Retry cap policy",
    bodyPath: "memory/questions/retry-cap-policy.md",
    body: "# Retry cap policy\n\nShould delivery retries cap at five attempts?\n",
    tags: ["payments"],
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryRelation(projectRoot, {
    id: "rel.webhook-idempotency-affects-payment-retry-window",
    from: "decision.webhook-idempotency",
    predicate: "affects",
    to: "gotcha.payment-retry-window"
  });
  await writeMemoryRelation(projectRoot, {
    id: "rel.retry-cap-policy-related-to-webhook-idempotency",
    from: "question.retry-cap-policy",
    predicate: "related_to",
    to: "decision.webhook-idempotency"
  });
}

async function writeMemoryObject(
  projectRoot: string,
  fixture: QueryObjectFixture
): Promise<void> {
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

async function writeMemoryRelation(
  projectRoot: string,
  fixture: QueryRelationFixture
): Promise<void> {
  await writeJsonProjectFile(projectRoot, `.memory/relations/${fixture.id.replace(/^rel\./, "")}.json`, {
    id: fixture.id,
    from: fixture.from,
    predicate: fixture.predicate,
    to: fixture.to,
    status: "active",
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  });
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
