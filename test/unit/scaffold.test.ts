import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const generatedNotice = "<!-- Generated from integrations/templates/agent-guidance.md. Do not edit directly. -->";

async function readProjectFile(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("package scaffold", () => {
  it("imports CLI and MCP entry modules", async () => {
    await expect(import("../../src/cli/main.js")).resolves.toMatchObject({
      createCliProgram: expect.any(Function),
      main: expect.any(Function)
    });

    await expect(import("../../src/mcp/server.js")).resolves.toMatchObject({
      main: expect.any(Function)
    });
  });

  it("keeps generated agent guidance in sync with the template", async () => {
    const template = (await readProjectFile("integrations/templates/agent-guidance.md")).trimEnd();
    const codex = await readProjectFile("integrations/codex/memory/SKILL.md");
    const codexStandaloneSkill = await readProjectFile(
      "integrations/codex/skills/memory/SKILL.md"
    );
    const codexPluginSkill = await readProjectFile(
      "integrations/codex/plugins/memory/skills/memory/SKILL.md"
    );
    const claudeSkill = await readProjectFile("integrations/claude/memory/SKILL.md");
    const claudePluginSkill = await readProjectFile(
      "integrations/claude/plugins/memory/skills/memory/SKILL.md"
    );
    const claude = await readProjectFile("integrations/claude/memory.md");
    const cursor = await readProjectFile("integrations/cursor/memory.mdc");
    const cline = await readProjectFile("integrations/cline/memory.md");
    const generic = await readProjectFile("integrations/generic/memory-agent-instructions.md");

    expect(codex).toBe(`---\nname: memory\ndescription: Use this skill when working in a project that uses Memory by Aictx as product-layer project memory. It guides the agent to query memory on demand mid-task, save product-meaningful changes after meaningful work, and sync memory at session end.\n---\n\n${generatedNotice}\n\n${template}\n`);
    expect(codexStandaloneSkill).toBe(codex);
    expect(codexPluginSkill).toBe(codex);
    expect(claudeSkill).toBe(`---\nname: memory\ndescription: Use this skill when working in a project that uses Memory by Aictx as product-layer project memory. It guides the agent to query memory on demand mid-task, save product-meaningful changes after meaningful work, and sync memory at session end.\n---\n\n${generatedNotice}\n\n${template}\n`);
    expect(claudePluginSkill).toBe(claudeSkill);
    expect(claude).toBe(`${generatedNotice}\n\n${template}\n`);
    expect(cursor).toBe(`---\ndescription: Use Memory as project memory when working in this repository.\nalwaysApply: true\n---\n\n${generatedNotice}\n\n${template}\n`);
    expect(cline).toBe(`${generatedNotice}\n\n${template}\n`);
    expect(generic).toBe(`${generatedNotice}\n\n${template}\n`);
  });

  it("includes all required bundled schema placeholders", async () => {
    const schemaFiles = [
      "config.schema.json",
      "object.schema.json",
      "relation.schema.json",
      "event.schema.json",
      "patch.schema.json"
    ];

    for (const schemaFile of schemaFiles) {
      const schema = JSON.parse(await readProjectFile(`src/schemas/${schemaFile}`)) as { $schema?: string };
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });
});
