import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import { runSubprocess } from "../../../src/core/subprocess.js";
import type {
  Evidence,
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
import { readCanonicalStorage } from "../../../src/storage/read.js";
import type { MemoryRelation } from "../../../src/storage/relations.js";
import {
  FIXED_TIMESTAMP,
  FIXED_TIMESTAMP_NEXT_MINUTE
} from "../../fixtures/time.js";
import {
  cleanupParityTempRoots,
  createInitializedParityRepo,
  createParityTempRoot,
  parseParityCliEnvelope,
  parseParityToolEnvelope,
  rebuildParityProject,
  runParityCli,
  startParityMcpClient,
  writeParityReadFixtures
} from "./parity-fixtures.js";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverEntry = join(repoRoot, "src/mcp/server.ts");
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const tempRoots: string[] = [];

interface StartedMcpClient {
  client: Client;
  close: () => Promise<void>;
  stderr: () => string;
}

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface QueryEnvelope {
  ok: true;
  data: {
    question: string;
    markdown: string;
    included_ids: string[];
    connected_ids: string[];
    estimated_tokens: number;
    truncated: boolean;
  };
}

interface InspectEnvelope {
  ok: true;
  data: {
    object: {
      id: string;
      type: string;
      status: string;
      title: string;
      body_path: string;
      json_path: string;
      tags: string[];
      body: string;
    };
    relations: {
      outgoing: RelationSummary[];
      incoming: RelationSummary[];
    };
  };
}

interface InspectErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: {
      id?: string;
    };
  };
}

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  warnings: string[];
  meta: unknown;
}

interface RelationSummary {
  id: string;
  from: string;
  predicate: string;
  to: string;
  status: string;
  confidence: string | null;
  json_path: string;
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

interface RelationFixture {
  id: string;
  from: string;
  predicate: Predicate;
  to: string;
  status?: RelationStatus;
  confidence?: RelationConfidence;
}

interface TextContent {
  type: "text";
  text: string;
}

interface ToolAnnotationExpectation {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  await cleanupParityTempRoots();
});

describe("memory MCP read tools", () => {
  it("exposes only the normalized v1 MCP tool set", async () => {
    const projectRoot = await createTempRoot("memory-mcp-read-tools-");
    const started = await startMcpClient(projectRoot);

    try {
      const result = await started.client.listTools();
      const toolNames = result.tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual([
        "inspect_memory",
        "query_memory",
        "save_memory"
      ]);
      expect(toolNames).not.toEqual(
        expect.arrayContaining([
          "load_memory",
          "remember_memory",
          "save_memory_patch",
          "diff_memory",
          "init",
          "check",
          "rebuild",
          "history",
          "restore",
          "rewind",
          "inspect",
          "stale",
          "suggest",
          "audit",
          "graph",
          "export",
          "export_obsidian",
          "view",
          "local_viewer",
          "load_mode",
          "set_mode",
          "shell",
          "run_shell",
          "execute_command",
          "read_file",
          "write_file",
          "filesystem",
          "create_object",
          "update_object",
          "delete_object",
          "create_relation",
          "update_relation",
          "delete_relation"
        ])
      );
      expectToolAnnotations(result.tools);
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("rejects unknown read-tool input fields before service execution", async () => {
    const projectRoot = await createTempRoot("memory-mcp-read-invalid-input-");
    const started = await startMcpClient(projectRoot);

    try {
      const invalidCalls = await Promise.all([
        started.client.callTool({
          name: "query_memory",
          arguments: {
            question: "Schema validation",
            unexpected: true
          }
        }),
        started.client.callTool({
          name: "query_memory",
          arguments: {
            question: "Schema validation",
            hints: {
              files: ["src/index/search.ts"]
            }
          }
        }),
        started.client.callTool({
          name: "inspect_memory",
          arguments: {
            id: "decision.schema-validation",
            unexpected: true
          }
        })
      ]);

      for (const result of invalidCalls) {
        expectToolError(result, /unexpected|hints|unrecognized|unknown/i);
      }
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
    await expect(readdir(projectRoot)).resolves.toEqual([]);
  });

  it("returns query_memory data matching CLI query JSON", async () => {
    const projectRoot = await createInitializedProject("memory-mcp-query-");
    await writeLoadSearchFixtures(projectRoot);
    await rebuildProject(projectRoot);
    const started = await startMcpClient(projectRoot);

    try {
      const cli = await runCli(
        ["node", "memory", "query", "Stripe webhook idempotency", "--json"],
        projectRoot
      );
      const mcp = await started.client.callTool({
        name: "query_memory",
        arguments: {
          question: "Stripe webhook idempotency"
        }
      });
      const cliEnvelope = parseCliEnvelope<QueryEnvelope>(cli);
      const mcpEnvelope = parseToolEnvelope<QueryEnvelope>(mcp);

      expect(mcpEnvelope).toEqual(cliEnvelope);
      expect(mcpEnvelope.data.question).toBe("Stripe webhook idempotency");
      expect(mcpEnvelope.data.included_ids).toContain("decision.webhook-idempotency");
      expect(mcpEnvelope.data.markdown).toContain("## Matches");
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("matches anchor path fragments through CLI and MCP query", async () => {
    const projectRoot = await createInitializedProject("memory-mcp-query-anchors-");
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
    const started = await startMcpClient(projectRoot);

    try {
      const cli = await runCli(
        ["node", "memory", "query", "rank.ts", "--json"],
        projectRoot
      );
      const mcp = await started.client.callTool({
        name: "query_memory",
        arguments: {
          question: "rank.ts"
        }
      });
      const cliEnvelope = parseCliEnvelope<QueryEnvelope>(cli);
      const mcpEnvelope = parseToolEnvelope<QueryEnvelope>(mcp);

      expect(mcpEnvelope).toEqual(cliEnvelope);
      expect(mcpEnvelope.data.included_ids).toContain("decision.anchored-ranking");
      expect(mcpEnvelope.data.markdown).toContain(
        "### decision.anchored-ranking — Anchored ranking  [active]"
      );
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("returns inspect_memory data matching CLI inspect JSON", async () => {
    const projectRoot = await createInitializedProject("memory-mcp-inspect-");
    await writeInspectFixtures(projectRoot);
    const started = await startMcpClient(projectRoot);

    try {
      const cli = await runCli(
        ["node", "memory", "inspect", "decision.billing-retries", "--json"],
        projectRoot
      );
      const mcp = await started.client.callTool({
        name: "inspect_memory",
        arguments: {
          id: "decision.billing-retries"
        }
      });
      const cliEnvelope = parseCliEnvelope<InspectEnvelope>(cli);
      const mcpEnvelope = parseToolEnvelope<InspectEnvelope>(mcp);

      expect(mcpEnvelope).toEqual(cliEnvelope);
      expect(mcpEnvelope.data.object).toMatchObject({
        id: "decision.billing-retries",
        type: "decision",
        status: "active",
        title: "Billing retries",
        body_path: ".memory/memory/decisions/billing-retries.md",
        json_path: ".memory/memory/decisions/billing-retries.json"
      });
      expect(mcpEnvelope.data.object.body).toContain("Billing retries run in the worker.");
      expect(mcpEnvelope.data.relations.outgoing.map((relation) => relation.id)).toEqual([
        "rel.decision-depends-on-idempotency"
      ]);
      expect(mcpEnvelope.data.relations.incoming.map((relation) => relation.id)).toEqual([
        "rel.worker-affects-decision"
      ]);
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("targets inspect_memory with explicit project_root from a global MCP launch", async () => {
    const serverRoot = await createTempRoot("memory-mcp-inspect-global-server-");
    const projectRoot = await createInitializedProject("memory-mcp-inspect-global-project-");
    await writeInspectFixtures(projectRoot);
    const started = await startMcpClient(serverRoot);

    try {
      const mcp = await started.client.callTool({
        name: "inspect_memory",
        arguments: {
          project_root: projectRoot,
          id: "gotcha.webhook-idempotency"
        }
      });
      const mcpEnvelope = parseToolEnvelope<InspectEnvelope>(mcp);

      expect(mcpEnvelope.ok).toBe(true);
      expect(mcpEnvelope.data.object).toMatchObject({
        id: "gotcha.webhook-idempotency",
        title: "Webhook idempotency"
      });
      expect(mcpEnvelope.data.relations.incoming.map((relation) => relation.id)).toEqual([
        "rel.decision-depends-on-idempotency"
      ]);
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("returns the shared error envelope for missing inspect_memory IDs", async () => {
    const projectRoot = await createInitializedProject("memory-mcp-inspect-missing-");
    const started = await startMcpClient(projectRoot);

    try {
      const cli = await runCli(
        ["node", "memory", "inspect", "decision.missing", "--json"],
        projectRoot
      );
      const mcp = await started.client.callTool({
        name: "inspect_memory",
        arguments: {
          id: "decision.missing"
        }
      });
      const cliEnvelope = parseCliErrorEnvelope<InspectErrorEnvelope & ErrorEnvelope>(cli);
      const mcpEnvelope = parseToolEnvelope<InspectErrorEnvelope & ErrorEnvelope>(mcp);

      expect(mcpEnvelope).toEqual(cliEnvelope);
      expect(mcpEnvelope.error).toMatchObject({
        code: "MemoryObjectNotFound",
        details: {
          id: "decision.missing"
        }
      });
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });


  it("keeps globally targeted CLI and MCP read envelopes in parity", async () => {
    const serverRoot = await createParityTempRoot("memory-mcp-read-parity-server-");
    const gitProject = await createInitializedParityRepo("memory-mcp-read-parity-git-");

    await writeParityReadFixtures(gitProject);
    await rebuildParityProject(gitProject);

    const started = await startParityMcpClient(serverRoot);

    try {
      const cliQuery = parseParityCliEnvelope<QueryEnvelope>(
        await runParityCli(
          ["node", "memory", "query", "shared adapter parity", "--json"],
          gitProject
        )
      );
      const mcpQuery = parseParityToolEnvelope<QueryEnvelope>(
        await started.client.callTool({
          name: "query_memory",
          arguments: {
            project_root: gitProject,
            question: "shared adapter parity"
          }
        })
      );

      expect(mcpQuery).toEqual(cliQuery);
      expect(mcpQuery.data.included_ids).toContain("decision.parity-shared-read");

      const cliInspect = parseParityCliEnvelope<InspectEnvelope>(
        await runParityCli(
          ["node", "memory", "inspect", "decision.parity-shared-read", "--json"],
          gitProject
        )
      );
      const mcpInspect = parseParityToolEnvelope<InspectEnvelope>(
        await started.client.callTool({
          name: "inspect_memory",
          arguments: {
            project_root: gitProject,
            id: "decision.parity-shared-read"
          }
        })
      );

      expect(mcpInspect).toEqual(cliInspect);
      expect(mcpInspect.data.relations.outgoing.map((relation) => relation.id)).toEqual([
        "rel.parity-read-depends-on-targeting"
      ]);
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  }, 60_000);
});

async function startMcpClient(cwd: string): Promise<StartedMcpClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsxLoader, serverEntry],
    cwd,
    stderr: "pipe"
  });
  const stderrChunks: string[] = [];
  const stderr = transport.stderr;

  if (stderr instanceof Readable) {
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });
  }

  const client = new Client({
    name: "memory-mcp-read-tools-test-client",
    version: "0.0.0"
  });

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    },
    stderr: () => stderrChunks.join("")
  };
}

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const output = await runCli(["node", "memory", "init", "--json"], projectRoot);

  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");

  return projectRoot;
}

async function createInitializedGitProject(prefix: string): Promise<string> {
  const repo = await createRepo(prefix);
  const output = await runCli(["node", "memory", "init", "--json"], repo);

  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");

  await git(repo, ["add", ".gitignore", ".memory"]);
  await git(repo, ["commit", "-m", "Initialize memory"]);

  return repo;
}

async function createRepo(prefix: string): Promise<string> {
  const repo = await createTempRoot(prefix);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Memory Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await writeFile(join(repo, "src.ts"), "initial\n", "utf8");
  await git(repo, ["add", "README.md", "src.ts"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
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

async function writeLoadSearchFixtures(projectRoot: string): Promise<void> {
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

async function writeInspectFixtures(projectRoot: string): Promise<void> {
  await writeMemoryObject(projectRoot, {
    id: "decision.billing-retries",
    type: "decision",
    status: "active",
    title: "Billing retries",
    bodyPath: "memory/decisions/billing-retries.md",
    body: "# Billing retries\n\nBilling retries run in the worker.\n",
    tags: ["billing", "worker"],
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
  await writeMemoryObject(projectRoot, {
    id: "gotcha.webhook-idempotency",
    type: "gotcha",
    status: "active",
    title: "Webhook idempotency",
    bodyPath: "memory/gotchas/webhook-idempotency.md",
    body: "# Webhook idempotency\n\nWebhook delivery IDs must be deduplicated.\n",
    tags: ["webhooks"],
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
  await writeMemoryObject(projectRoot, {
    id: "gotcha.worker-details",
    type: "gotcha",
    status: "active",
    title: "Worker details",
    bodyPath: "memory/gotchas/worker-details.md",
    body: "# Worker details\n\nThe queue worker owns retry execution.\n",
    tags: ["worker"],
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runSubprocess("git", args, { cwd });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  if (result.data.exitCode !== 0) {
    throw new Error(
      [
        `git ${args.join(" ")} failed with exit code ${result.data.exitCode}`,
        result.data.stderr
      ].join("\n")
    );
  }

  return result.data.stdout;
}

async function readJsonId(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

  if (!isRecord(parsed) || typeof parsed.id !== "string") {
    throw new Error(`Expected ${path} to contain a string id.`);
  }

  return parsed.id;
}

function parseCliEnvelope<T>(output: CliRunResult): T {
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");
  return JSON.parse(output.stdout) as T;
}

function parseCliErrorEnvelope<T>(output: CliRunResult): T {
  expect(output.exitCode).not.toBe(0);
  expect(output.stderr).toBe("");
  return JSON.parse(output.stdout) as T;
}

function expectToolError(result: unknown, message: RegExp): void {
  expect(isRecord(result)).toBe(true);
  if (!isRecord(result)) {
    throw new Error("Expected MCP tool error result to be an object.");
  }

  expect(result.isError).toBe(true);
  expect(Array.isArray(result.content)).toBe(true);

  if (!Array.isArray(result.content)) {
    throw new Error("Expected MCP tool error result content to be an array.");
  }

  const text = result.content.find(isTextContent);

  expect(text).toBeDefined();
  if (text === undefined) {
    throw new Error("Expected MCP tool error result to include text content.");
  }

  expect(text.text).toMatch(message);
}

function parseToolEnvelope<T>(result: unknown): T {
  expect(isRecord(result)).toBe(true);
  if (!isRecord(result)) {
    throw new Error("Expected MCP tool result to be an object.");
  }

  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  expect(Array.isArray(result.content)).toBe(true);

  if (!Array.isArray(result.content)) {
    throw new Error("Expected MCP tool result content to be an array.");
  }

  const text = result.content.find(isTextContent);

  expect(text).toBeDefined();
  if (
    text === undefined ||
    !isRecord(result.structuredContent)
  ) {
    throw new Error("Expected MCP tool result to include text and structured content.");
  }

  expect(JSON.parse(text.text) as unknown).toEqual(result.structuredContent);

  return result.structuredContent as T;
}

function expectToolAnnotations(tools: unknown[]): void {
  expectToolAnnotation(tools, "query_memory", {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  expectToolAnnotation(tools, "inspect_memory", {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  expectToolAnnotation(tools, "save_memory", {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  });
}

function expectToolAnnotation(
  tools: unknown[],
  name: string,
  expected: ToolAnnotationExpectation
): void {
  const tool = tools.find((value) => isRecord(value) && value.name === name);

  expect(tool).toBeDefined();
  if (!isRecord(tool)) {
    throw new Error(`Expected ${name} tool to be listed.`);
  }

  expect(tool.annotations).toEqual(expected);
}

function isTextContent(value: unknown): value is TextContent {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
