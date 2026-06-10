import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
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
import { readCanonicalStorage } from "../../../src/storage/read.js";

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

interface SaveEnvelope {
  ok: true;
  data: SaveData;
  meta: {
    git: {
      available: boolean;
      branch: string | null;
      commit: string | null;
      dirty: boolean | null;
    };
  };
}

interface SaveErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  warnings: string[];
  meta: unknown;
}

interface SaveData {
  files_changed: string[];
  memory_created: string[];
  memory_updated: string[];
  memory_deleted: string[];
  relations_created: string[];
  relations_updated: string[];
  relations_deleted: string[];
  recovery_files: unknown[];
  repairs_applied: string[];
  events_appended: number;
  index_updated: boolean;
}

interface TextContent {
  type: "text";
  text: string;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory MCP remember_memory tool", () => {
  it("exposes only the normalized MCP tool set", async () => {
    const projectRoot = await createProjectRoot("memory-mcp-remember-tools-");
    const started = await startMcpClient(projectRoot);

    try {
      const result = await started.client.listTools();
      const toolNames = result.tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual([
        "inspect_memory",
        "remember_memory",
        "search_memory"
      ]);
      expect(toolNames).not.toEqual(
        expect.arrayContaining([
          "load_memory",
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
          "graph",
          "export",
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
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("advertises the intent-first remember input shape", async () => {
    const projectRoot = await createProjectRoot("memory-mcp-remember-schema-");
    const started = await startMcpClient(projectRoot);

    try {
      const result = await started.client.listTools();
      const rememberTool = result.tools.find((tool) => tool.name === "remember_memory");
      const schema = JSON.stringify(rememberTool?.inputSchema);

      expect(rememberTool).toBeDefined();
      expect(schema).toContain("task");
      expect(schema).toContain("memories");
      expect(schema).toContain("updates");
      expect(schema).toContain("stale");
      expect(schema).toContain("supersede");
      expect(schema).toContain("relations");
      expect(schema).toContain("applies_to");
      expect(schema).toContain("origin");
      expect(schema).not.toContain("additionalProperties\":{}");
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("remembers intent-first memory through globally targeted MCP writes", async () => {
    const serverRoot = await createProjectRoot("memory-mcp-remember-server-");
    const projectRoot = await createInitializedProject("memory-mcp-remember-project-");
    const started = await startMcpClient(serverRoot);

    try {
      const mcp = await started.client.callTool({
        name: "remember_memory",
        arguments: {
          project_root: projectRoot,
          task: "Add MCP remember coverage",
          memories: [
            {
              kind: "decision",
              title: "MCP remember uses intent-first writes",
              body: "The remember_memory tool accepts semantic memory input and routes it through the shared save path.",
              tags: ["mcp", "remember"],
              applies_to: ["src/mcp/tools/remember-memory.ts"],
              evidence: [{ kind: "file", id: "src/mcp/tools/remember-memory.ts" }]
            }
          ]
        }
      });
      const envelope = parseToolEnvelope<SaveEnvelope>(mcp);

      expect(envelope.ok).toBe(true);
      expect(envelope.data.memory_created).toEqual([
        "decision.mcp-remember-uses-intent-first-writes"
      ]);

      const storage = await readCanonicalStorage(projectRoot);

      expect(storage.ok).toBe(true);
      if (!storage.ok) {
        return;
      }

      const saved = storage.data.objects.find(
        (object) =>
          object.sidecar.id === "decision.mcp-remember-uses-intent-first-writes"
      );

      expect(saved?.body).toContain("semantic memory input");
      expect(saved?.sidecar.facets).toEqual({
        category: "decision-rationale",
        applies_to: ["src/mcp/tools/remember-memory.ts"]
      });
      expect(saved?.sidecar.evidence).toEqual([
        { kind: "file", id: "src/mcp/tools/remember-memory.ts" }
      ]);
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("saves source origin through MCP remember", async () => {
    const projectRoot = await createInitializedProject("memory-mcp-remember-origin-");
    const started = await startMcpClient(projectRoot);

    try {
      const remembered = await started.client.callTool({
        name: "remember_memory",
        arguments: {
          task: "Remember source origin",
          memories: [
            {
              kind: "source",
              id: "source.mcp-remember-origin",
              title: "MCP remember origin source",
              body: "MCP remember_memory can set raw-source origin metadata on source records.",
              origin: {
                kind: "url",
                locator: "https://example.com/mcp-remember-origin",
                captured_at: "2026-05-14T12:00:00+02:00",
                media_type: "text/markdown"
              }
            }
          ]
        }
      });
      const rememberedEnvelope = parseToolEnvelope<SaveEnvelope>(remembered);

      expect(rememberedEnvelope.ok).toBe(true);

      const storage = await readCanonicalStorage(projectRoot);

      expect(storage.ok).toBe(true);
      if (!storage.ok) {
        return;
      }

      const rememberedSource = storage.data.objects.find(
        (object) => object.sidecar.id === "source.mcp-remember-origin"
      );

      expect(rememberedSource?.sidecar.origin).toMatchObject({
        kind: "url",
        locator: "https://example.com/mcp-remember-origin",
        captured_at: "2026-05-14T12:00:00+02:00",
        media_type: "text/markdown"
      });
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("serializes concurrent MCP writes or returns lock errors", async () => {
    const projectRoot = await createInitializedProject("memory-mcp-remember-concurrent-");
    const started = await startMcpClient(projectRoot);

    try {
      const results = await Promise.all([
        started.client.callTool({
          name: "remember_memory",
          arguments: createRememberFactArguments(
            "Concurrent fact one",
            "First concurrent MCP write."
          )
        }),
        started.client.callTool({
          name: "remember_memory",
          arguments: createRememberFactArguments(
            "Concurrent fact two",
            "Second concurrent MCP write."
          )
        })
      ]);
      const envelopes = results.map((result) =>
        parseToolEnvelope<SaveEnvelope | SaveErrorEnvelope>(result)
      );
      const successes = envelopes.filter(isSaveSuccess);
      const lockFailures = envelopes.filter(
        (envelope): envelope is SaveErrorEnvelope =>
          !envelope.ok && envelope.error.code === "MemoryLockBusy"
      );

      expect(successes.length + lockFailures.length).toBe(2);
      expect(successes.length).toBeGreaterThanOrEqual(1);

      const savedIds = await readMemoryIds(projectRoot);

      if (successes.length === 2) {
        expect(savedIds).toEqual(
          expect.arrayContaining(["fact.concurrent-fact-one", "fact.concurrent-fact-two"])
        );
      } else {
        expect(savedIds).toEqual(
          expect.arrayContaining(successes.flatMap((envelope) => envelope.data.memory_created))
        );
      }

      await expect(readFile(join(projectRoot, ".memory", ".lock"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("does not create a Git commit", async () => {
    const repo = await createInitializedGitProject("memory-mcp-remember-git-");
    const commitBefore = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const started = await startMcpClient(repo);

    try {
      const mcp = await started.client.callTool({
        name: "remember_memory",
        arguments: createRememberFactArguments(
          "MCP git remember fact",
          "MCP remember must not create a commit."
        )
      });
      const envelope = parseToolEnvelope<SaveEnvelope>(mcp);

      expect(envelope.ok).toBe(true);
      expect(envelope.meta.git.available).toBe(true);
      expect(envelope.meta.git.commit).toBe(commitBefore);
      expect(envelope.meta.git.dirty).toBe(true);
      expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(commitBefore);

      const status = await git(repo, ["status", "--porcelain=v1", "-uall", "--", ".memory"]);
      expect(status).toContain(".memory/events.jsonl");
      expect(status).toContain(".memory/memory/facts/mcp-git-remember-fact.md");
      expect(status).toContain(".memory/memory/facts/mcp-git-remember-fact.json");
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("rejects invalid MCP input before service execution", async () => {
    const projectRoot = await createProjectRoot("memory-mcp-remember-invalid-");
    const started = await startMcpClient(projectRoot);

    try {
      const missingTask = await started.client.callTool({
        name: "remember_memory",
        arguments: {}
      });
      const unsupportedProjectRoot = await started.client.callTool({
        name: "remember_memory",
        arguments: {
          ...createRememberFactArguments("Ignored", "Should not run."),
          projectRoot
        }
      });
      const unknownTopLevel = await started.client.callTool({
        name: "remember_memory",
        arguments: {
          ...createRememberFactArguments("Ignored top level", "Should not run."),
          unexpected: true
        }
      });
      const unknownMemoryField = await started.client.callTool({
        name: "remember_memory",
        arguments: {
          task: "Ignored memory field",
          memories: [
            {
              kind: "fact",
              title: "Ignored memory field",
              body: "Should not run.",
              unexpected: true
            }
          ]
        }
      });

      expectToolError(missingTask, /task/);
      expectToolError(unsupportedProjectRoot, /projectRoot|unexpected|unrecognized|unknown/i);
      expectToolError(unknownTopLevel, /unexpected|unrecognized|unknown/i);
      expectToolError(unknownMemoryField, /unexpected|unrecognized|unknown/i);
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
    await expect(readdir(projectRoot)).resolves.toEqual([]);
  });
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
    name: "memory-mcp-remember-tool-test-client",
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
  const projectRoot = await createProjectRoot(prefix);
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
  const repo = await createProjectRoot(prefix);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Memory Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
}

async function createProjectRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  const projectRoot = join(resolvedRoot, "repo");

  tempRoots.push(resolvedRoot);
  await mkdir(projectRoot);

  return projectRoot;
}

async function runCli(
  argv: string[],
  cwd: string,
  options: { stdin?: Readable } = {}
): Promise<CliRunResult> {
  const output = createCapturedOutput();
  const exitCode = await main(argv, {
    ...output.writers,
    cwd,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin })
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

function createRememberFactArguments(title: string, body: string) {
  return {
    task: "Remember MCP integration test",
    memories: [
      {
        kind: "fact",
        title,
        body
      }
    ]
  };
}

async function readMemoryIds(projectRoot: string): Promise<string[]> {
  const storage = await readCanonicalStorage(projectRoot);

  expect(storage.ok).toBe(true);
  if (!storage.ok) {
    return [];
  }

  return storage.data.objects.map((object) => object.sidecar.id).sort();
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
  if (text === undefined || !isRecord(result.structuredContent)) {
    throw new Error("Expected MCP tool result to include text and structured content.");
  }

  expect(JSON.parse(text.text) as unknown).toEqual(result.structuredContent);

  return result.structuredContent as T;
}

function isSaveSuccess(envelope: SaveEnvelope | SaveErrorEnvelope): envelope is SaveEnvelope {
  return envelope.ok;
}

function isTextContent(value: unknown): value is TextContent {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
