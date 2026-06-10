import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

const mcpSourcePaths = [
  "src/mcp/server.ts",
  "src/mcp/tools/search-memory.ts",
  "src/mcp/tools/inspect-memory.ts",
  "src/mcp/tools/remember-memory.ts"
] as const;

const toolSourcePaths = [
  "src/mcp/tools/search-memory.ts",
  "src/mcp/tools/inspect-memory.ts",
  "src/mcp/tools/remember-memory.ts"
] as const;

const exactMcpToolNames = [
  "inspect_memory",
  "remember_memory",
  "search_memory"
] as const;

async function readProjectFile(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("MCP registration cleanup guardrail", () => {
  it("declares zod as a direct runtime dependency", async () => {
    const packageJson = JSON.parse(await readProjectFile("package.json")) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.zod).toBe("^4.3.6");
  });

  it("imports zod only from the direct package", async () => {
    for (const path of mcpSourcePaths) {
      const source = await readProjectFile(path);
      const zodImports = [...source.matchAll(/from\s+["']([^"']*zod[^"']*)["']/g)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => specifier !== undefined);

      for (const specifier of zodImports) {
        expect(specifier).toBe("zod");
      }

      expect(source).not.toMatch(/@modelcontextprotocol\/sdk\/.*zod|zod-compat/);
    }
  });

  it("uses the SDK high-level tool registration path", async () => {
    const serverSource = await readProjectFile("src/mcp/server.ts");

    expect(serverSource).toContain(".registerTool(");
    expect(serverSource).not.toMatch(/CallToolRequestSchema|ListToolsRequestSchema/);
    expect(serverSource).not.toMatch(/registerCapabilities|setRequestHandler/);
    expect(serverSource).not.toMatch(/toolsByName|new Map\(/);
    expect(serverSource).not.toMatch(/\bMcpError\b|\bErrorCode\b/);
  });

  it("keeps the registered v1 MCP tool names exact", async () => {
    const toolNames: string[] = [];

    for (const path of toolSourcePaths) {
      const source = await readProjectFile(path);
      const match = source.match(/name:\s*"([^"]+)"/);

      if (match?.[1] === undefined) {
        throw new Error(`Missing MCP tool name in ${path}.`);
      }

      toolNames.push(match[1]);
    }

    expect(toolNames.sort()).toEqual([...exactMcpToolNames]);
  });

  it("documents workflow and how-to memory in remember_memory description", async () => {
    const source = await readProjectFile("src/mcp/tools/remember-memory.ts");

    expect(source).toContain("workflows/how-tos");
  });
});
