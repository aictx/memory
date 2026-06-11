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
  dry_run: boolean;
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

describe("memory MCP save_memory tool", () => {
  it("exposes only the normalized MCP tool set", async () => {
    const projectRoot = await createProjectRoot("memory-mcp-save-tools-");
    const started = await startMcpClient(projectRoot);

    try {
      const result = await started.client.listTools();
      const toolNames = result.tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual([
        "inspect_memory",
        "save_memory",
        "search_memory"
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

  it("advertises the intent-first save input shape", async () => {
    const projectRoot = await createProjectRoot("memory-mcp-save-schema-");
    const started = await startMcpClient(projectRoot);

    try {
      const result = await started.client.listTools();
      const saveTool = result.tools.find((tool) => tool.name === "save_memory");
      const schema = JSON.stringify(saveTool?.inputSchema);

      expect(saveTool).toBeDefined();
      expect(schema).toContain("task");
      expect(schema).toContain("nodes");
      expect(schema).toContain("stale");
      expect(schema).toContain("supersede");
      expect(schema).toContain("delete");
      expect(schema).toContain("anchors");
      expect(schema).toContain("stage");
      expect(schema).toContain("related");
      expect(schema).not.toContain("additionalProperties\":{}");
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("saves intent-first memory through globally targeted MCP writes", async () => {
    const serverRoot = await createProjectRoot("memory-mcp-save-server-");
    const projectRoot = await createInitializedProject("memory-mcp-save-project-");
    const started = await startMcpClient(serverRoot);

    try {
      const mcp = await started.client.callTool({
        name: "save_memory",
        arguments: {
          project_root: projectRoot,
          task: "Add MCP save coverage",
          nodes: [
            {
              kind: "decision",
              title: "MCP save uses intent-first writes",
              body: "The save_memory tool accepts semantic memory input and routes it through the shared save path.",
              tags: ["mcp", "save"],
              anchors: ["src/mcp/tools/save-memory.ts"],
              evidence: [{ kind: "file", id: "src/mcp/tools/save-memory.ts" }]
            }
          ]
        }
      });
      const envelope = parseToolEnvelope<SaveEnvelope>(mcp);

      expect(envelope.ok).toBe(true);
      expect(envelope.data.memory_created).toEqual([
        "decision.mcp-save-uses-intent-first-writes"
      ]);

      const storage = await readCanonicalStorage(projectRoot);

      expect(storage.ok).toBe(true);
      if (!storage.ok) {
        return;
      }

      const saved = storage.data.objects.find(
        (object) =>
          object.sidecar.id === "decision.mcp-save-uses-intent-first-writes"
      );

      expect(saved?.body).toContain("semantic memory input");
      expect(saved?.sidecar.anchors).toEqual(["src/mcp/tools/save-memory.ts"]);
      expect(saved?.sidecar.evidence).toEqual([
        { kind: "file", id: "src/mcp/tools/save-memory.ts" }
      ]);
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("saves feature stage and lifecycle actions through MCP", async () => {
    const projectRoot = await createInitializedProject("memory-mcp-save-lifecycle-");
    const started = await startMcpClient(projectRoot);

    try {
      const seeded = await started.client.callTool({
        name: "save_memory",
        arguments: {
          task: "Seed lifecycle nodes",
          nodes: [
            {
              id: "feature.mcp-save",
              kind: "feature",
              title: "MCP save",
              body: "Save memory through MCP.",
              stage: "building"
            },
            {
              id: "gotcha.stale-me",
              kind: "gotcha",
              title: "Stale me",
              body: "Old knowledge."
            }
          ]
        }
      });
      const seededEnvelope = parseToolEnvelope<SaveEnvelope>(seeded);
      expect(seededEnvelope.ok).toBe(true);

      const transitioned = await started.client.callTool({
        name: "save_memory",
        arguments: {
          task: "Ship the feature and stale the gotcha",
          nodes: [
            {
              id: "feature.mcp-save",
              stage: "shipped"
            }
          ],
          stale: [{ id: "gotcha.stale-me", reason: "Behavior changed." }]
        }
      });
      const transitionedEnvelope = parseToolEnvelope<SaveEnvelope>(transitioned);
      expect(transitionedEnvelope.ok).toBe(true);
      expect(transitionedEnvelope.data.memory_updated).toEqual(
        expect.arrayContaining(["feature.mcp-save", "gotcha.stale-me"])
      );

      const storage = await readCanonicalStorage(projectRoot);
      expect(storage.ok).toBe(true);
      if (storage.ok) {
        const byId = new Map(
          storage.data.objects.map((object) => [object.sidecar.id, object.sidecar])
        );
        expect(byId.get("feature.mcp-save")?.stage).toBe("shipped");
        expect(byId.get("gotcha.stale-me")?.status).toBe("stale");
      }
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("serializes concurrent MCP writes or returns lock errors", async () => {
    const projectRoot = await createInitializedProject("memory-mcp-save-concurrent-");
    const started = await startMcpClient(projectRoot);

    try {
      const results = await Promise.all([
        started.client.callTool({
          name: "save_memory",
          arguments: createSaveGotchaArguments(
            "Concurrent gotcha one",
            "First concurrent MCP write."
          )
        }),
        started.client.callTool({
          name: "save_memory",
          arguments: createSaveGotchaArguments(
            "Concurrent gotcha two",
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
          expect.arrayContaining(["gotcha.concurrent-gotcha-one", "gotcha.concurrent-gotcha-two"])
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
    const repo = await createInitializedGitProject("memory-mcp-save-git-");
    const commitBefore = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const started = await startMcpClient(repo);

    try {
      const mcp = await started.client.callTool({
        name: "save_memory",
        arguments: createSaveGotchaArguments(
          "MCP git save gotcha",
          "MCP save must not create a commit."
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
      expect(status).toContain(".memory/memory/gotchas/mcp-git-save-gotcha.md");
      expect(status).toContain(".memory/memory/gotchas/mcp-git-save-gotcha.json");
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("rejects invalid MCP input before service execution", async () => {
    const projectRoot = await createProjectRoot("memory-mcp-save-invalid-");
    const started = await startMcpClient(projectRoot);

    try {
      const missingTask = await started.client.callTool({
        name: "save_memory",
        arguments: {}
      });
      const unsupportedProjectRoot = await started.client.callTool({
        name: "save_memory",
        arguments: {
          ...createSaveGotchaArguments("Ignored", "Should not run."),
          projectRoot
        }
      });
      const unknownTopLevel = await started.client.callTool({
        name: "save_memory",
        arguments: {
          ...createSaveGotchaArguments("Ignored top level", "Should not run."),
          unexpected: true
        }
      });
      const unknownNodeField = await started.client.callTool({
        name: "save_memory",
        arguments: {
          task: "Ignored node field",
          nodes: [
            {
              kind: "gotcha",
              title: "Ignored node field",
              body: "Should not run.",
              unexpected: true
            }
          ]
        }
      });
      const unsupportedKind = await started.client.callTool({
        name: "save_memory",
        arguments: {
          task: "Reject removed kinds",
          nodes: [
            {
              kind: "fact",
              title: "Removed kind",
              body: "Should not run."
            }
          ]
        }
      });

      expectToolError(missingTask, /task/);
      expectToolError(unsupportedProjectRoot, /projectRoot|unexpected|unrecognized|unknown/i);
      expectToolError(unknownTopLevel, /unexpected|unrecognized|unknown/i);
      expectToolError(unknownNodeField, /unexpected|unrecognized|unknown/i);
      expectToolError(unsupportedKind, /kind|invalid|enum/i);
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
    name: "memory-mcp-save-tool-test-client",
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

function createSaveGotchaArguments(title: string, body: string) {
  return {
    task: "Save MCP integration test",
    nodes: [
      {
        kind: "gotcha",
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
