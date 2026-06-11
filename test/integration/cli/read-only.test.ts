import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import type {
  ObjectId,
  ObjectStatus,
  ObjectType,
  Predicate,
  RelationConfidence,
  RelationStatus
} from "../../../src/core/types.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import type { MemoryRelation } from "../../../src/storage/relations.js";
import { FIXED_TIMESTAMP, FIXED_TIMESTAMP_NEXT_MINUTE } from "../../fixtures/time.js";

const tempRoots: string[] = [];

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ObjectSummary {
  id: string;
  type: string;
  status: string;
  title: string;
  body_path: string;
  json_path: string;
  tags: string[];
  superseded_by: string | null;
  body: string;
}

interface RelationSummary {
  id: string;
  from: string;
  predicate: string;
  to: string;
  status: string;
  json_path: string;
}

interface InspectEnvelope {
  ok: true;
  data: {
    object: ObjectSummary;
    relations: {
      outgoing: RelationSummary[];
      incoming: RelationSummary[];
    };
  };
}

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: {
      id?: string;
    };
  };
}

interface MemoryFixture {
  id: ObjectId;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  body: string;
  tags?: string[];
  supersededBy?: ObjectId | null;
  updatedAt?: string;
}

interface RelationFixture {
  id: string;
  from: ObjectId;
  predicate: Predicate;
  to: ObjectId;
  status?: RelationStatus;
  confidence?: RelationConfidence;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory read-only CLI commands", () => {
  it("inspects one object with incoming and outgoing direct relations", async () => {
    const projectRoot = await createReadOnlyFixtureProject("memory-cli-inspect-");

    const output = await runCli(
      ["node", "memory", "inspect", "decision.billing-retries", "--json"],
      projectRoot
    );

    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe("");
    const envelope = JSON.parse(output.stdout) as InspectEnvelope;

    expect(envelope.ok).toBe(true);
    expect(envelope.data.object).toMatchObject({
      id: "decision.billing-retries",
      type: "decision",
      status: "active",
      title: "Billing retries",
      body_path: ".memory/memory/decisions/billing-retries.md",
      json_path: ".memory/memory/decisions/billing-retries.json"
    });
    expect(envelope.data.object.body).toContain("Billing retries run in the worker.");
    expect(envelope.data.relations.outgoing.map((relation) => relation.id)).toEqual([
      "rel.decision-depends-on-idempotency"
    ]);
    expect(envelope.data.relations.incoming.map((relation) => relation.id)).toEqual([
      "rel.worker-affects-decision"
    ]);
  });

  it("prints compact human output for inspect", async () => {
    const projectRoot = await createReadOnlyFixtureProject("memory-cli-readonly-human-");
    const inspect = await runCli(
      ["node", "memory", "inspect", "decision.billing-retries"],
      projectRoot
    );

    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain("decision.billing-retries");
    expect(inspect.stdout).toContain("Outgoing relations:");
    expect(() => JSON.parse(inspect.stdout) as unknown).toThrow();
  });

  it("returns MemoryObjectNotFound for missing inspect roots", async () => {
    const projectRoot = await createReadOnlyFixtureProject("memory-cli-readonly-missing-");
    const inspect = await runCli(
      ["node", "memory", "inspect", "decision.missing", "--json"],
      projectRoot
    );

    expect(inspect.exitCode).toBe(1);
    const inspectEnvelope = JSON.parse(inspect.stdout) as ErrorEnvelope;

    expect(inspectEnvelope.error).toMatchObject({
      code: "MemoryObjectNotFound",
      details: {
        id: "decision.missing"
      }
    });
  });

  it("does not mutate canonical Memory files", async () => {
    const projectRoot = await createReadOnlyFixtureProject("memory-cli-readonly-mutation-");
    const before = await readCanonicalFiles(projectRoot);

    await expect(
      runCli(["node", "memory", "inspect", "decision.billing-retries", "--json"], projectRoot)
    ).resolves.toMatchObject({ exitCode: 0 });

    await expect(readCanonicalFiles(projectRoot)).resolves.toEqual(before);
  });
});

async function createReadOnlyFixtureProject(prefix: string): Promise<string> {
  const projectRoot = await createInitializedProject(prefix);

  await writeMemoryObject(projectRoot, {
    id: "decision.billing-retries",
    type: "decision",
    status: "active",
    title: "Billing retries",
    body: "# Billing retries\n\nBilling retries run in the worker.\n",
    tags: ["billing", "retries"],
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
  await writeMemoryObject(projectRoot, {
    id: "gotcha.webhook-idempotency",
    type: "gotcha",
    status: "active",
    title: "Webhook idempotency",
    body: "# Webhook idempotency\n\nWebhook delivery IDs must be deduplicated.\n",
    tags: ["webhooks"]
  });
  await writeMemoryObject(projectRoot, {
    id: "gotcha.worker-details",
    type: "gotcha",
    status: "active",
    title: "Worker details",
    body: "# Worker details\n\nThe queue worker owns retry execution.\n",
    tags: ["worker"]
  });
  await writeMemoryObject(projectRoot, {
    id: "gotcha.second-hop-only",
    type: "gotcha",
    status: "active",
    title: "Second-hop only",
    body: "# Second-hop only\n\nThis object is only connected through another neighbor.\n"
  });
  await writeMemoryObject(projectRoot, {
    id: "decision.old-queue",
    type: "decision",
    status: "stale",
    title: "Old queue",
    body: "# Old queue\n\nThe old queue design is stale.\n"
  });
  await writeMemoryObject(projectRoot, {
    id: "decision.old-api",
    type: "decision",
    status: "superseded",
    title: "Old API",
    body: "# Old API\n\nThe old API constraint was superseded.\n",
    supersededBy: "decision.billing-retries"
  });
  await writeMemoryObject(projectRoot, {
    id: "gotcha.stale-memory",
    type: "gotcha",
    status: "stale",
    title: "Stale memory",
    body: "# Stale memory\n\nThis memory is stale.\n"
  });
  await writeMemoryObject(projectRoot, {
    id: "gotcha.active-memory",
    type: "gotcha",
    status: "active",
    title: "Active memory",
    body: "# Active memory\n\nThis active memory should not be in stale output.\n"
  });
  await writeMemoryObject(projectRoot, {
    id: "question.open-memory",
    type: "question",
    status: "open",
    title: "Open memory",
    body: "# Open memory\n\nThis open question should not be in stale output.\n"
  });
  await writeMemoryObject(projectRoot, {
    id: "question.closed-memory",
    type: "question",
    status: "closed",
    title: "Closed memory",
    body: "# Closed memory\n\nThis closed question should not be in stale output.\n"
  });
  await writeRelation(projectRoot, {
    id: "rel.decision-depends-on-idempotency",
    from: "decision.billing-retries",
    predicate: "depends_on",
    to: "gotcha.webhook-idempotency",
    confidence: "high"
  });
  await writeRelation(projectRoot, {
    id: "rel.worker-affects-decision",
    from: "gotcha.worker-details",
    predicate: "affects",
    to: "decision.billing-retries",
    confidence: "medium"
  });
  await writeRelation(projectRoot, {
    id: "rel.idempotency-related-to-second-hop",
    from: "gotcha.webhook-idempotency",
    predicate: "related_to",
    to: "gotcha.second-hop-only",
    confidence: "low"
  });

  return projectRoot;
}

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const output = await runCli(["node", "memory", "init", "--json"], projectRoot);

  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");

  return projectRoot;
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

async function writeMemoryObject(projectRoot: string, fixture: MemoryFixture): Promise<void> {
  const bodyPath = memoryBodyPath(fixture);
  const sidecarWithoutHash = {
    id: fixture.id,
    type: fixture.type,
    status: fixture.status,
    title: fixture.title,
    body_path: bodyPath,
    tags: fixture.tags ?? [],
    source: {
      kind: "agent"
    },
    superseded_by: fixture.supersededBy ?? null,
    created_at: FIXED_TIMESTAMP,
    updated_at: fixture.updatedAt ?? FIXED_TIMESTAMP
  } satisfies Omit<MemoryObjectSidecar, "content_hash">;
  const sidecar: MemoryObjectSidecar = {
    ...sidecarWithoutHash,
    content_hash: computeObjectContentHash(sidecarWithoutHash, fixture.body)
  };

  await writeProjectFile(projectRoot, `.memory/${bodyPath}`, fixture.body);
  await writeJsonProjectFile(
    projectRoot,
    `.memory/${bodyPath.replace(/\.md$/, ".json")}`,
    sidecar
  );
}

async function writeRelation(projectRoot: string, fixture: RelationFixture): Promise<void> {
  const relationWithoutHash = {
    id: fixture.id,
    from: fixture.from,
    predicate: fixture.predicate,
    to: fixture.to,
    status: fixture.status ?? "active",
    ...(fixture.confidence === undefined ? {} : { confidence: fixture.confidence }),
    evidence: [
      {
        kind: "memory",
        id: fixture.from
      }
    ],
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP
  } satisfies Omit<MemoryRelation, "content_hash">;
  const relation: MemoryRelation = {
    ...relationWithoutHash,
    content_hash: computeRelationContentHash(relationWithoutHash)
  };

  await writeJsonProjectFile(
    projectRoot,
    `.memory/relations/${fixture.id.replace(/^rel\./, "")}.json`,
    relation
  );
}

function memoryBodyPath(fixture: MemoryFixture): string {
  const slug = fixture.id.slice(fixture.id.indexOf(".") + 1);

  return `memory/${memoryDirectory(fixture.type)}/${slug}.md`;
}

function memoryDirectory(type: ObjectType): string {
  switch (type) {
    case "feature":
      return "features";
    case "decision":
      return "decisions";
    case "gotcha":
      return "gotchas";
    case "question":
      return "questions";
    case "project":
      throw new Error(`Unsupported fixture type for nested memory path: ${type}`);
  }
}

async function writeJsonProjectFile(
  projectRoot: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  await writeProjectFile(projectRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
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

async function readCanonicalFiles(projectRoot: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  for (const root of [
    ".memory/config.json",
    ".memory/events.jsonl",
    ".memory/memory",
    ".memory/relations",
    ".memory/schema"
  ]) {
    const absoluteRoot = join(projectRoot, root);
    const entries = await readFilesRecursively(projectRoot, absoluteRoot);

    for (const [path, contents] of Object.entries(entries)) {
      files[path] = contents;
    }
  }

  return files;
}

async function readFilesRecursively(
  projectRoot: string,
  absolutePath: string
): Promise<Record<string, string>> {
  const pathStat = await stat(absolutePath);

  if (pathStat.isFile()) {
    return {
      [relative(projectRoot, absolutePath)]: await readFile(absolutePath, "utf8")
    };
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    const child = join(absolutePath, entry.name);

    if (entry.isDirectory()) {
      Object.assign(files, await readFilesRecursively(projectRoot, child));
      continue;
    }

    if (entry.isFile()) {
      files[relative(projectRoot, child)] = await readFile(child, "utf8");
    }
  }

  return files;
}
