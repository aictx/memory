import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const generatedNotice = "<!-- Generated from integrations/templates/agent-guidance.md. Do not edit directly. -->";
const skillPrefix = `---\nname: memory\ndescription: Use this skill when working in a project that uses Memory by Aictx as product-layer project memory. It guides the agent to query memory on demand mid-task, save product-meaningful changes after meaningful work, and sync memory at session end.\n---\n\n${generatedNotice}\n\n`;
const cursorPrefix = `---\ndescription: Use Memory as project memory when working in this repository.\nalwaysApply: true\n---\n\n${generatedNotice}\n\n`;

const skillGuidancePaths = [
  "integrations/codex/memory/SKILL.md",
  "integrations/codex/skills/memory/SKILL.md",
  "integrations/codex/plugins/memory/skills/memory/SKILL.md",
  "integrations/claude/memory/SKILL.md",
  "integrations/claude/plugins/memory/skills/memory/SKILL.md"
] as const;

async function readProjectFile(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readProjectFile(path)) as T;
}

describe("generated agent guidance files", () => {
  it("keeps Codex and Claude skills generated from the shared template", async () => {
    const template = (await readProjectFile("integrations/templates/agent-guidance.md")).trimEnd();

    for (const path of skillGuidancePaths) {
      await expect(readProjectFile(path)).resolves.toBe(`${skillPrefix}${template}\n`);
    }
  });

  it("keeps Claude and generic guidance generated from the shared template", async () => {
    const template = (await readProjectFile("integrations/templates/agent-guidance.md")).trimEnd();
    const expected = `${generatedNotice}\n\n${template}\n`;

    await expect(readProjectFile("integrations/claude/memory.md")).resolves.toBe(expected);
    await expect(readProjectFile("integrations/generic/memory-agent-instructions.md")).resolves.toBe(expected);
  });

  it("keeps Cursor and Cline guidance generated from the shared template", async () => {
    const template = (await readProjectFile("integrations/templates/agent-guidance.md")).trimEnd();
    const clineExpected = `${generatedNotice}\n\n${template}\n`;

    await expect(readProjectFile("integrations/cursor/memory.mdc")).resolves.toBe(
      `${cursorPrefix}${template}\n`
    );
    await expect(readProjectFile("integrations/cline/memory.md")).resolves.toBe(clineExpected);
  });

  it("keeps plugin manifests aligned with package metadata", async () => {
    const packageJson = await readJsonFile<{
      version: string;
      homepage: string;
      repository: { url: string };
      license: string;
      author: string;
    }>("package.json");
    const repository = packageJson.repository.url.replace(/^git\+/u, "").replace(/\.git$/u, "");
    const codex = await readJsonFile<{
      name: string;
      version: string;
      description: string;
      author: { name: string; url: string };
      homepage: string;
      repository: string;
      license: string;
      skills: string;
      interface: {
        displayName: string;
        shortDescription: string;
        developerName: string;
        category: string;
        websiteURL: string;
        defaultPrompt: string[];
      };
      mcpServers?: string;
    }>("integrations/codex/plugins/memory/.codex-plugin/plugin.json");
    const claude = await readJsonFile<{
      name: string;
      version: string;
      description: string;
      author: { name: string; url: string };
      homepage: string;
      repository: string;
      license: string;
      mcpServers?: string;
    }>("integrations/claude/plugins/memory/.claude-plugin/plugin.json");

    expect(codex).toMatchObject({
      name: "memory",
      version: packageJson.version,
      author: { name: packageJson.author, url: repository },
      homepage: packageJson.homepage,
      repository,
      license: packageJson.license,
      skills: "./skills/",
      interface: {
        displayName: "Memory",
        developerName: packageJson.author,
        category: "Productivity",
        websiteURL: packageJson.homepage
      }
    });
    expect(codex.description).toMatch(/Memory by Aictx as local project memory/i);
    expect(codex.interface.shortDescription).toMatch(/product-layer project memory/i);
    expect(codex.interface.defaultPrompt).toHaveLength(3);
    expect(codex.mcpServers).toBeUndefined();

    expect(claude).toMatchObject({
      name: "memory",
      version: packageJson.version,
      author: { name: packageJson.author, url: repository },
      homepage: packageJson.homepage,
      repository,
      license: packageJson.license
    });
    expect(claude.description).toMatch(/Memory by Aictx as local project memory/i);
    expect(claude.mcpServers).toBeUndefined();
  });

  it("documents concise marketplace install commands in generated plugin readmes", async () => {
    const codexReadme = await readProjectFile("integrations/codex/plugins/memory/README.md");
    const claudeReadme = await readProjectFile("integrations/claude/plugins/memory/README.md");

    expect(codexReadme).toContain("codex plugin marketplace add aictx/memory");
    expect(codexReadme).toContain("install Memory");
    expect(codexReadme).not.toContain("codex plugin marketplace upgrade");
    expect(codexReadme).toContain("Memory MCP setup remains an optional client-level configuration");

    expect(claudeReadme).toContain("/plugin marketplace add aictx/memory");
    expect(claudeReadme).toContain("/plugin install memory@aictx");
    expect(claudeReadme).toContain("claude plugin validate integrations/claude/plugins/memory");
    expect(claudeReadme).not.toContain("claude plugin marketplace list --json");
    expect(claudeReadme).toContain("MCP equivalents only when the current Claude Code session already exposes Memory MCP tools");
  });

  it("keeps local Codex and Claude marketplace catalogs reachable", async () => {
    const codexMarketplace = await readJsonFile<{
      name: string;
      interface: { displayName: string };
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
        category: string;
      }>;
    }>(".agents/plugins/marketplace.json");
    const claudeMarketplace = await readJsonFile<{
      name: string;
      metadata: { description: string };
      owner: { name: string };
      plugins: Array<{
        name: string;
        source: string;
        description: string;
      }>;
    }>(".claude-plugin/marketplace.json");

    expect(codexMarketplace).toMatchObject({
      name: "memory",
      interface: { displayName: "Memory" },
      plugins: [
        {
          name: "memory",
          source: {
            source: "local",
            path: "./integrations/codex/plugins/memory"
          },
          category: "Productivity"
        }
      ]
    });
    expect(claudeMarketplace).toMatchObject({
      name: "memory",
      metadata: {
        description: "Memory by Aictx local project memory plugins for AI coding agents."
      },
      owner: { name: "Aictx" },
      plugins: [
        {
          name: "memory",
          source: "./integrations/claude/plugins/memory",
          description: "Use Memory by Aictx as local project memory in AI coding agents."
        }
      ]
    });
  });
});
