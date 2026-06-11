import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  initProject,
  saveMemoryPatch
} from "../../../src/app/operations.js";
import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import {
  createFixedTestClock,
  FIXED_TIMESTAMP,
  FIXED_TIMESTAMP_NEXT_MINUTE
} from "../../fixtures/time.js";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverEntry = join(repoRoot, "src/mcp/server.ts");
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const tempRoots: string[] = [];

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
  "graph",
  "export",
  "export_obsidian",
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

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  warnings: unknown[];
  meta: unknown;
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

describe("integration security regression guardrails", () => {
  it("quarantines tampered body_path traversal without writing outside Memory storage", async () => {
    const projectRoot = await createInitializedProject("memory-security-path-");
    const sidecarPath = join(projectRoot, ".memory", "memory", "project.json");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
    sidecar.body_path = "memory/../../outside.md";
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

    const result = await saveMemoryPatch({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createNotePatch("Traversal blocked", "This write must not happen.")
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.memory_created).toContain("gotcha.traversal-blocked");
      expect(result.data.repairs_applied).toContain(
        "Quarantined invalid memory object sidecar: .memory/memory/project.json"
      );
      expect(result.data.recovery_files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ".memory/memory/project.json",
            reason: "repair_quarantine"
          })
        ])
      );
    }
    await expect(readFile(join(projectRoot, "outside.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      readFile(join(projectRoot, ".memory", "memory", "gotchas", "traversal-blocked.md"), "utf8")
    ).resolves.toContain("This write must not happen.");
    await expect(readFile(sidecarPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts detected secret values from CLI and MCP save failures", async () => {
    const secret = syntheticOpenAiKey();
    const cliProject = await createInitializedProject("memory-security-cli-secret-");
    const cliOutput = await runCli(
      ["node", "memory", "save", "--stdin", "--json"],
      cliProject,
      Readable.from([
        JSON.stringify(createGotchaSaveInput("CLI secret blocked", `Secret: ${secret}`))
      ])
    );

    expect(cliOutput.exitCode).toBe(1);
    expect(cliOutput.stderr).toBe("");
    expectNoSecret(cliOutput.stdout, secret);
    const cliEnvelope = JSON.parse(cliOutput.stdout) as ErrorEnvelope;
    expect(cliEnvelope.ok).toBe(false);
    expect(cliEnvelope.error.code).toBe("MemorySecretDetected");
    expectNoSecret(cliEnvelope, secret);
    await expect(
      readFile(join(cliProject, ".memory", "memory", "gotchas", "cli-secret-blocked.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });

    const mcpProject = await createInitializedProject("memory-security-mcp-secret-");
    const started = await startMcpClient(mcpProject);

    try {
      const result = await started.client.callTool({
        name: "save_memory",
        arguments: {
          task: "Security regression test",
          nodes: [
            {
              kind: "gotcha",
              title: "MCP secret blocked",
              body: `Secret: ${secret}`
            }
          ]
        }
      });
      const envelope = parseToolEnvelope<ErrorEnvelope>(result);

      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("MemorySecretDetected");
      expectNoSecret(result, secret);
      expectNoSecret(envelope, secret);
      await expect(
        readFile(join(mcpProject, ".memory", "memory", "gotchas", "mcp-secret-blocked.md"), "utf8")
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("quarantines conflict-marked canonical files and still applies independent creates", async () => {
    const projectRoot = await createInitializedProject("memory-security-conflict-");
    await writeFile(
      join(projectRoot, ".memory", "memory", "project.md"),
      ["<<<<<<< HEAD", "# Project", "=======", "# Other project", ">>>>>>> branch", ""].join("\n"),
      "utf8"
    );

    const result = await saveMemoryPatch({
      cwd: projectRoot,
      clock: createFixedTestClock(FIXED_TIMESTAMP_NEXT_MINUTE),
      patch: createNotePatch("Conflict blocked", "This write must not happen.")
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.memory_created).toContain("gotcha.conflict-blocked");
      expect(result.data.repairs_applied).toEqual(
        expect.arrayContaining([
          "Quarantined invalid memory object sidecar: .memory/memory/project.json",
          "Quarantined invalid memory object body: .memory/memory/project.md"
        ])
      );
      expect(result.data.recovery_files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ".memory/memory/project.json",
            reason: "repair_quarantine"
          }),
          expect.objectContaining({
            path: ".memory/memory/project.md",
            reason: "repair_quarantine"
          })
        ])
      );
    }
    await expect(
      readFile(join(projectRoot, ".memory", "memory", "gotchas", "conflict-blocked.md"), "utf8")
    ).resolves.toContain("This write must not happen.");
    await expect(
      readFile(join(projectRoot, ".memory", "memory", "project.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes exactly the normalized MCP tool set and keeps CLI-only tools uncallable", async () => {
    const projectRoot = await createTempRoot("memory-security-mcp-tools-");
    const started = await startMcpClient(projectRoot);

    try {
      const result = await started.client.listTools();
      const toolNames = result.tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual([...REQUIRED_MCP_TOOLS]);
      expect(toolNames).not.toEqual(expect.arrayContaining([...FORBIDDEN_MCP_TOOLS]));

      for (const toolName of FORBIDDEN_MCP_TOOLS) {
        await expect(
          started.client.callTool({
            name: toolName,
            arguments: {}
          })
        ).resolves.toMatchObject({
          isError: true,
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringMatching(/not found/i)
            })
          ])
        });
      }
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
    await expect(readdir(projectRoot)).resolves.toEqual([]);
  });

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

  return projectRoot;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);

  tempRoots.push(resolvedRoot);

  return resolvedRoot;
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
    name: "memory-security-test-client",
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

async function runCli(
  argv: string[],
  cwd: string,
  stdin?: Readable
): Promise<CliRunResult> {
  const output = createCapturedOutput();
  const exitCode = await main(argv, {
    ...output.writers,
    cwd,
    ...(stdin === undefined ? {} : { stdin })
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

function createNotePatch(title: string, body: string) {
  return {
    source: {
      kind: "agent",
      task: "Security regression test"
    },
    changes: [
      {
        op: "create_object",
        type: "gotcha",
        title,
        body: `# ${title}\n\n${body}\n`
      }
    ]
  };
}

function createGotchaSaveInput(title: string, body: string) {
  return {
    task: "Security regression test",
    nodes: [
      {
        kind: "gotcha",
        title,
        body: `# ${title}\n\n${body}\n`
      }
    ]
  };
}

function parseToolEnvelope<T>(result: unknown): T {
  expect(isRecord(result)).toBe(true);
  if (!isRecord(result)) {
    throw new Error("Expected MCP tool result to be an object.");
  }

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

function isTextContent(value: unknown): value is TextContent {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function syntheticOpenAiKey(): string {
  return ["sk", "A".repeat(20)].join("-");
}

function expectNoSecret(value: unknown, secret: string): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);

  expect(serialized).not.toContain(secret);
}

