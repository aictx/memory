import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import type { Evidence, ObjectStatus, ObjectType } from "../../../src/core/types.js";
import { computeObjectContentHash } from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import {
  FIXED_TIMESTAMP,
  FIXED_TIMESTAMP_NEXT_MINUTE
} from "../../fixtures/time.js";

const tempRoots: string[] = [];

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SearchEnvelope {
  ok: true;
  data: {
    matches: Array<{
      id: string;
      type: string;
      status: string;
      title: string;
      snippet: string;
      body_path: string;
      score: number;
    }>;
  };
}

interface MemoryFixture {
  id: string;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  bodyPath: string;
  body: string;
  tags: string[];
  anchors?: string[];
  evidence?: Evidence[];
  updatedAt?: string;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory search CLI", () => {
  it("returns SQLite FTS search results in JSON mode", async () => {
    const projectRoot = await createInitializedProject("memory-cli-search-json-");
    await writeSearchFixtures(projectRoot);
    await rebuildProject(projectRoot);

    const output = await runCli(
      [
        "node",
        "memory",
        "search",
        "Stripe webhook idempotency",
        "--limit",
        "10",
        "--json"
      ],
      projectRoot
    );

    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    const envelope = JSON.parse(output.stdout) as SearchEnvelope;
    const ids = envelope.data.matches.map((match) => match.id);
    const webhook = envelope.data.matches.find(
      (match) => match.id === "decision.webhook-idempotency"
    );

    expect(envelope.ok).toBe(true);
    expect(ids).toContain("decision.webhook-idempotency");
    expect(ids).toContain("feature.webhook-context");
    expect(ids).toContain("decision.old-webhook-queue");
    expect(webhook).toMatchObject({
      id: "decision.webhook-idempotency",
      type: "decision",
      status: "active",
      title: "Webhook idempotency",
      body_path: ".memory/memory/decisions/webhook-idempotency.md"
    });
    expect(webhook?.snippet).toContain("Stripe may deliver duplicate webhook events");
    expect(typeof webhook?.score).toBe("number");
  });

  it("matches anchor path fragments without hint flags", async () => {
    const projectRoot = await createInitializedProject("memory-cli-search-anchors-");
    await writeMemoryObject(projectRoot, {
      id: "decision.anchored-ranking",
      type: "decision",
      status: "active",
      title: "Anchored ranking",
      bodyPath: "memory/decisions/anchored-ranking.md",
      body: "# Anchored ranking\n\nThis memory is linked to code through anchors.\n",
      tags: ["retrieval"],
      anchors: ["src/context/rank.ts"],
      evidence: [{ kind: "file", id: "src/context/rank.ts" }],
      updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
    });
    await rebuildProject(projectRoot);

    const searchOutput = await runCli(
      ["node", "memory", "search", "rank.ts", "--limit", "10", "--json"],
      projectRoot
    );

    expect(searchOutput.exitCode).toBe(0);

    const searchEnvelope = JSON.parse(searchOutput.stdout) as SearchEnvelope;

    expect(searchEnvelope.data.matches[0]).toMatchObject({
      id: "decision.anchored-ranking",
      status: "active"
    });
  });

  it("rejects removed retrieval hint flags", async () => {
    const projectRoot = await createInitializedProject("memory-cli-search-no-hints-");

    const searchOutput = await runCli(
      ["node", "memory", "search", "opaque", "--file", "src/context/rank.ts"],
      projectRoot
    );

    expect(searchOutput.exitCode).toBe(2);
    expect(searchOutput.stderr).toContain("--file");
  });

  it("prints compact human search results", async () => {
    const projectRoot = await createInitializedProject("memory-cli-search-human-");
    await writeSearchFixtures(projectRoot);
    await rebuildProject(projectRoot);

    const output = await runCli(
      ["node", "memory", "search", "Stripe webhook idempotency"],
      projectRoot
    );

    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("decision.webhook-idempotency");
    expect(output.stdout).toContain("Title: Webhook idempotency");
    expect(output.stdout).toContain("Path: .memory/memory/decisions/webhook-idempotency.md");
    expect(output.stdout).toContain("Snippet:");
    expect(() => JSON.parse(output.stdout) as unknown).toThrow();
  });
});

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const output = await runCli(["node", "memory", "init", "--json"], projectRoot);

  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");

  return projectRoot;
}

async function rebuildProject(projectRoot: string): Promise<void> {
  const output = await runCli(["node", "memory", "rebuild", "--json"], projectRoot);

  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");
}

async function runCli(argv: string[], cwd: string): Promise<CliRunResult> {
  const output = createCapturedOutput();
  const exitCode = await main(argv, {
    ...output.writers,
    cwd
  });

  return {
    exitCode,
    stdout: output.stdout(),
    stderr: output.stderr()
  };
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
    body:
      "# Webhook idempotency\n\nStripe may deliver duplicate webhook events, so delivery IDs must be deduplicated.\n",
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
    tags: ["stripe", "webhooks", "idempotency"],
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
}

async function writeMemoryObject(projectRoot: string, fixture: MemoryFixture): Promise<void> {
  const sidecarWithoutHash = {
    id: fixture.id,
    type: fixture.type,
    status: fixture.status,
    title: fixture.title,
    body_path: fixture.bodyPath,
    tags: fixture.tags,
    ...(fixture.anchors === undefined ? {} : { anchors: fixture.anchors }),
    ...(fixture.evidence === undefined ? {} : { evidence: fixture.evidence }),
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
