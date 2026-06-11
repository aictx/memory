import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PassThrough, Readable, Writable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { initProject } from "../../../src/app/operations.js";
import {
  createMemoryMcpServer,
  main as mcpMain,
  startMcpServer
} from "../../../src/mcp/server.js";
import { version } from "../../../src/generated/version.js";

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

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory MCP server bootstrap", () => {
  it("creates a project-scoped server context before connecting", async () => {
    const projectRoot = await createTempRoot("memory-mcp-context-");
    const mcp = createMemoryMcpServer({ cwd: projectRoot });

    expect(mcp.context.cwd).toBe(projectRoot);
    expect(mcp.server.isConnected()).toBe(false);
  });

  it("starts over stdio without non-protocol stdout or filesystem writes", async () => {
    const projectRoot = await createTempRoot("memory-mcp-stdio-");
    const started = await startMcpClient(projectRoot);

    try {
      await expect(started.client.ping()).resolves.toEqual({});
      expect(started.client.getServerVersion()).toEqual({
        name: "memory-mcp",
        version
      });
      expect(started.client.getServerCapabilities()).toEqual({
        tools: {
          listChanged: true
        }
      });
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
    await expect(readdir(projectRoot)).resolves.toEqual([]);
  });

  it("direct startup does not write non-protocol stdout", async () => {
    const projectRoot = await createTempRoot("memory-mcp-direct-");
    const stdin = new PassThrough();
    const stdout = createWritableCapture();
    const mcp = await startMcpServer({
      cwd: projectRoot,
      stdin,
      stdout: stdout.writable
    });

    try {
      expect(mcp.server.isConnected()).toBe(true);
      expect(stdout.text()).toBe("");
    } finally {
      await mcp.server.close();
      stdin.destroy();
    }

    expect(stdout.text()).toBe("");
    await expect(readdir(projectRoot)).resolves.toEqual([]);
  });

  it("reports startup failures to stderr without writing stdout", async () => {
    const projectRoot = await createTempRoot("memory-mcp-failure-");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    const failure = new Error("simulated startup failure");
    failure.name = "StartupTestError";

    await expect(
      mcpMain({
        cwd: projectRoot,
        stdout: stdout.writable,
        stderr: stderr.writable,
        startServer: async () => {
          throw failure;
        }
      })
    ).rejects.toThrow(failure);

    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Memory MCP server failed to start.");
    expect(stderr.text()).toContain(`cwd: ${projectRoot}`);
    expect(stderr.text()).toContain("error: StartupTestError: simulated startup failure");
  });

  it("exposes only normalized Memory tools and no CLI-only, shell, or filesystem tools", async () => {
    const projectRoot = await createTempRoot("memory-mcp-tools-");
    const started = await startMcpClient(projectRoot);

    try {
      await expect(started.client.ping()).resolves.toEqual({});

      const result = await started.client.listTools();
      const toolNames = result.tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual([
        "inspect_memory",
        "query_memory",
        "save_memory",
        "status_memory"
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
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
    await expect(readdir(projectRoot)).resolves.toEqual([]);
  });

  it("documents project_root as project selection in every MCP tool schema", async () => {
    const projectRoot = await createTempRoot("memory-mcp-schema-");
    const started = await startMcpClient(projectRoot);

    try {
      const result = await started.client.listTools();
      const descriptions = getProjectRootDescriptions(result.tools);

      expect(descriptions).toHaveLength(4);

      for (const description of descriptions) {
        expect(description).toContain("select");
        expect(description).toContain("not arbitrary filesystem access");
        expect(description).toContain(".memory");
      }
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
    await expect(readdir(projectRoot)).resolves.toEqual([]);
  });

  it("documents supported MCP client launch forms", async () => {
    const docsPath = join(repoRoot, "docs/src/content/docs/mcp.md");
    const docs = await readFile(docsPath, "utf8");

    expect(docs).toContain("Configure your MCP client to launch the");
    expect(docs).toContain("global binary");
    expect(docs).toContain("memory-mcp");
    expect(docs).toContain("pnpm exec memory-mcp");
    expect(docs).toContain("npm exec memory-mcp");
    expect(docs).toContain("npx --package @aictx/memory -- memory-mcp");
    expect(docs).toContain("./node_modules/.bin/memory-mcp");
    expect(docs).toContain("Startup diagnostics and failures are written");
    expect(docs).toContain("not arbitrary filesystem access");
  });

  it("serves multiple isolated projects from one globally launched process", async () => {
    const serverRoot = await createTempRoot("memory-mcp-global-");
    const alphaRoot = await createInitializedProject("memory-mcp-alpha-");
    const betaRoot = await createInitializedProject("memory-mcp-beta-");
    const started = await startMcpClient(serverRoot);

    try {
      await expect(started.client.ping()).resolves.toEqual({});

      await started.client.callTool({
        name: "save_memory",
        arguments: {
          project_root: alphaRoot,
          ...createProjectGotchaSaveArguments("Alpha-only deployment fact")
        }
      });
      await started.client.callTool({
        name: "save_memory",
        arguments: {
          project_root: betaRoot,
          ...createProjectGotchaSaveArguments("Beta-only deployment fact")
        }
      });

      const alphaQuery = parseToolEnvelope<QueryEnvelope>(
        await started.client.callTool({
          name: "query_memory",
          arguments: {
            project_root: alphaRoot,
            question: "deployment fact"
          }
        })
      );
      const betaQuery = parseToolEnvelope<QueryEnvelope>(
        await started.client.callTool({
          name: "query_memory",
          arguments: {
            project_root: betaRoot,
            question: "deployment fact"
          }
        })
      );

      expect(alphaQuery.ok).toBe(true);
      expect(betaQuery.ok).toBe(true);
      expect(alphaQuery.data.markdown).toContain("Alpha-only deployment fact");
      expect(alphaQuery.data.markdown).not.toContain("Beta-only deployment fact");
      expect(betaQuery.data.markdown).toContain("Beta-only deployment fact");
      expect(betaQuery.data.markdown).not.toContain("Alpha-only deployment fact");
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });
});

interface QueryEnvelope {
  ok: true;
  data: {
    markdown: string;
    included_ids: string[];
  };
}

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
    name: "memory-mcp-test-client",
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

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const result = await initProject({
    cwd: projectRoot,
    agentGuidance: false
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return projectRoot;
}

function createProjectGotchaSaveArguments(title: string): Record<string, unknown> {
  return {
    task: "Exercise global MCP project targeting",
    nodes: [
      {
        kind: "gotcha",
        title,
        body: `${title} belongs only to its initialized Memory project.`,
        tags: ["mcp", "global-server"]
      }
    ]
  };
}

function parseToolEnvelope<T>(result: unknown): T {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("Expected a call tool result.");
  }

  const content = result.content[0];

  if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected a text tool result.");
  }

  return JSON.parse(content.text) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createWritableCapture(): { writable: Writable; text: () => string } {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      callback();
    }
  });

  return {
    writable,
    text: () => chunks.join("")
  };
}

function getProjectRootDescriptions(tools: unknown[]): string[] {
  const descriptions: string[] = [];

  for (const tool of tools) {
    if (!isRecord(tool) || !isRecord(tool.inputSchema)) {
      continue;
    }

    const properties = tool.inputSchema.properties;

    if (!isRecord(properties)) {
      continue;
    }

    const projectRoot = properties.project_root;

    if (!isRecord(projectRoot) || typeof projectRoot.description !== "string") {
      continue;
    }

    descriptions.push(projectRoot.description);
  }

  return descriptions;
}
