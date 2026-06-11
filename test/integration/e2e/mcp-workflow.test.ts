import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { runSubprocess } from "../../../src/core/subprocess.js";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliEntry = join(repoRoot, "src/cli/main.ts");
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

interface ResponseMeta {
  project_root: string;
  memory_root: string;
  git: {
    available: boolean;
    branch: string | null;
    commit: string | null;
    dirty: boolean | null;
  };
}

interface SuccessEnvelope<TData> {
  ok: true;
  data: TData;
  warnings: string[];
  meta: ResponseMeta;
}

interface InitData {
  created: boolean;
  index_built: boolean;
  git_available: boolean;
}

interface SaveData {
  files_changed: string[];
  memory_created: string[];
  memory_updated: string[];
  memory_deleted: string[];
  relations_created: string[];
  relations_updated: string[];
  relations_deleted: string[];
  events_appended: number;
  index_updated: boolean;
}

interface QueryData {
  question: string;
  markdown: string;
  included_ids: string[];
  connected_ids: string[];
  estimated_tokens: number;
  truncated: boolean;
}

interface InspectData {
  object: {
    id: string;
    type: string;
    status: string;
    title: string;
    body_path: string;
    json_path: string;
    body: string;
  };
  relations: {
    outgoing: unknown[];
    incoming: unknown[];
  };
}

interface DiffData {
  diff: string;
  changed_files: string[];
  changed_memory_ids: string[];
  changed_relation_ids: string[];
}

interface CheckData {
  valid: boolean;
  errors: unknown[];
  warnings: unknown[];
}

interface RebuildData {
  index_rebuilt: boolean;
  objects_indexed: number;
  relations_indexed: number;
  events_indexed: number;
  event_appended: boolean;
}

interface TextContent {
  type: "text";
  text: string;
}

const REQUIRED_MCP_TOOLS = [
  "inspect_memory",
  "query_memory",
  "save_memory",
  "status_memory"
] as const;

const FORBIDDEN_MCP_TOOLS = [
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
] as const;

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory full MCP workflow", () => {
  it("runs the routine MCP flow and keeps CLI-only capabilities out of MCP", async () => {
    const repo = await createRepo("memory-e2e-mcp-workflow-");
    const started = await startMcpClient(repo);

    try {
      await expect(started.client.ping()).resolves.toEqual({});

      const listedTools = await started.client.listTools();
      const toolNames = listedTools.tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual([...REQUIRED_MCP_TOOLS]);
      expect(toolNames).not.toEqual(expect.arrayContaining([...FORBIDDEN_MCP_TOOLS]));

      const init = parseCliEnvelope<InitData>(
        await expectSuccessfulMemoryCli(repo, ["init", "--json"])
      );

      expect(init.data).toMatchObject({
        created: true,
        index_built: true,
        git_available: true
      });
      expect(init.meta.git.available).toBe(true);

      await commit(repo, "Initialize memory", "2026-04-25T14:00:00+02:00", [
        ".gitignore",
        ".memory"
      ]);

      const headBeforeSave = (await git(repo, ["rev-parse", "HEAD"])).trim();
      const saved = parseToolEnvelope<SuccessEnvelope<SaveData>>(
        await started.client.callTool({
          name: "save_memory",
          arguments: createWorkflowSaveArguments()
        })
      );

      expect(saved.data.memory_created).toEqual(
        expect.arrayContaining([
          "decision.mcp-routine-workflow",
          "gotcha.mcp-does-not-mirror-cli-only-commands"
        ])
      );
      expect(saved.data.memory_updated).toEqual([]);
      expect(saved.data.index_updated).toBe(true);
      expect(saved.meta.git).toMatchObject({
        available: true,
        commit: headBeforeSave,
        dirty: true
      });
      expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(headBeforeSave);

      const mcpQuery = parseToolEnvelope<SuccessEnvelope<QueryData>>(
        await started.client.callTool({
          name: "query_memory",
          arguments: {
            question: "MCP routine workflow"
          }
        })
      );
      const cliQuery = parseCliEnvelope<QueryData>(
        await expectSuccessfulMemoryCli(repo, [
          "query",
          "MCP routine workflow",
          "--json"
        ])
      );

      expect(mcpQuery).toEqual(cliQuery);
      expect(includedIds(mcpQuery)).toContain("decision.mcp-routine-workflow");

      const mcpInspect = parseToolEnvelope<SuccessEnvelope<InspectData>>(
        await started.client.callTool({
          name: "inspect_memory",
          arguments: {
            id: "decision.mcp-routine-workflow"
          }
        })
      );
      const cliInspect = parseCliEnvelope<InspectData>(
        await expectSuccessfulMemoryCli(repo, [
          "inspect",
          "decision.mcp-routine-workflow",
          "--json"
        ])
      );

      expect(mcpInspect).toEqual(cliInspect);
      expect(mcpInspect.data.object).toMatchObject({
        id: "decision.mcp-routine-workflow",
        type: "decision",
        status: "active",
        title: "MCP routine workflow"
      });
      expect(mcpInspect.data.object.body).toContain("inspect_memory");

      const checked = parseCliEnvelope<CheckData>(
        await expectSuccessfulMemoryCli(repo, ["check", "--json"])
      );

      expect(checked.data).toMatchObject({
        valid: true,
        errors: []
      });

      const rebuilt = parseCliEnvelope<RebuildData>(
        await expectSuccessfulMemoryCli(repo, ["rebuild", "--json"])
      );

      expect(rebuilt.data.index_rebuilt).toBe(true);
      expect(rebuilt.data.objects_indexed).toBeGreaterThan(0);

      await writeFile(join(repo, "src.ts"), "unrelated dirty source change\n", "utf8");

      const cliDiff = parseCliEnvelope<DiffData>(
        await expectSuccessfulMemoryCli(repo, ["diff", "--json"])
      );

      expect(cliDiff.data.changed_files.length).toBeGreaterThan(0);
      expect(
        cliDiff.data.changed_files.every((path) => path.startsWith(".memory/"))
      ).toBe(true);
      expect(cliDiff.data.changed_files).toContain(".memory/events.jsonl");
      expect(cliDiff.data.diff).toContain(".memory/events.jsonl");
      expect(cliDiff.data.diff).not.toContain("src.ts");
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  }, 180_000);
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
    name: "memory-mcp-workflow-test-client",
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

async function createRepo(prefix: string): Promise<string> {
  const repo = await createTempRoot(prefix);

  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Memory Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await writeFile(join(repo, "src.ts"), "initial source\n", "utf8");
  await commit(repo, "Initial commit", "2026-04-25T13:59:00+02:00", [
    "README.md",
    "src.ts"
  ]);

  return repo;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);

  tempRoots.push(resolvedRoot);

  return resolvedRoot;
}

async function expectSuccessfulMemoryCli(
  cwd: string,
  args: readonly string[]
): Promise<CliRunResult> {
  const output = await runMemoryCli(cwd, args);

  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");

  return output;
}

async function runMemoryCli(
  cwd: string,
  args: readonly string[]
): Promise<CliRunResult> {
  const result = await runSubprocess(process.execPath, [
    "--import",
    tsxLoader,
    cliEntry,
    ...args
  ], {
    cwd
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return {
    exitCode: result.data.exitCode ?? -1,
    stdout: result.data.stdout,
    stderr: result.data.stderr
  };
}

async function commit(
  cwd: string,
  message: string,
  date: string,
  paths: string[]
): Promise<void> {
  await git(cwd, ["add", ...paths]);
  await git(cwd, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  });
}

async function git(
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {}
): Promise<string> {
  const result = await runSubprocess("git", args, {
    cwd,
    env: { ...process.env, ...env }
  });

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

function createWorkflowSaveArguments() {
  return {
    task: "Full MCP workflow test",
    nodes: [
      {
        kind: "decision",
        id: "decision.mcp-routine-workflow",
        title: "MCP routine workflow",
        body:
          "MCP routine workflow agents use query_memory, inspect_memory, and save_memory for normal project memory work. Relevant file src/mcp/server.ts.",
        tags: ["mcp", "workflow", "routine"]
      },
      {
        kind: "gotcha",
        title: "MCP does not mirror CLI-only commands",
        body:
          "Do not expose init, check, rebuild, shell, or filesystem operations through MCP. Agents must use the memory binary for CLI-only capabilities.",
        tags: ["mcp", "workflow", "cli-only"]
      }
    ]
  };
}

function parseCliEnvelope<TData>(output: CliRunResult): SuccessEnvelope<TData> {
  return JSON.parse(output.stdout) as SuccessEnvelope<TData>;
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

function includedIds(envelope: SuccessEnvelope<QueryData>): string[] {
  return envelope.data.included_ids;
}

function isTextContent(value: unknown): value is TextContent {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
