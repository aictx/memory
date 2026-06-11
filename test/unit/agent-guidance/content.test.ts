import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

const generatedGuidanceTargets = [
  "integrations/templates/agent-guidance.md",
  "integrations/codex/memory/SKILL.md",
  "integrations/codex/skills/memory/SKILL.md",
  "integrations/codex/plugins/memory/skills/memory/SKILL.md",
  "integrations/claude/memory/SKILL.md",
  "integrations/claude/plugins/memory/skills/memory/SKILL.md",
  "integrations/claude/memory.md",
  "integrations/cursor/memory.mdc",
  "integrations/cline/memory.md",
  "integrations/generic/memory-agent-instructions.md"
] as const;

const publicDocsTargets = [
  "docs/src/content/docs/index.md",
  "docs/src/content/docs/getting-started.md",
  "docs/src/content/docs/capabilities.md",
  "docs/src/content/docs/cli.md",
  "docs/src/content/docs/mcp.md",
  "docs/src/content/docs/agent-integration.md",
  "docs/src/content/docs/mental-model.md",
  "docs/src/content/docs/plugin-publishing.md",
  "docs/src/content/docs/reference.md",
  "docs/src/content/docs/troubleshooting.md",
  "docs/src/content/docs/viewer.md"
] as const;

const forbiddenMcpToolNames = [
  "init_memory",
  "check_memory",
  "rebuild_memory",
  "restore_memory",
  "export_memory",
  "view_memory",
  "suggest_memory",
  "audit_memory",
  "stale_memory",
  "graph_memory"
] as const;

async function readProjectFile(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("agent guidance content", () => {
  it("keeps generated guidance focused on the routine Memory loop", async () => {
    for (const path of generatedGuidanceTargets) {
      const content = await readProjectFile(path);

      expect(content).toContain('memory query "<question>"');
      expect(content).toContain("memory save --stdin");
      expect(content).toContain("memory sync");
      expect(content).toContain("{task, nodes, stale, supersede, delete}");
      expect(content).toContain('"kind": "feature"');
      expect(content).toContain('"stage": "building"');
      expect(content).toContain('"anchors"');
      expect(content).toContain('"kind": "decision"');
      expect(content).toContain("Do not save refactors, formatting details, task diaries");
      expect(content).toContain("Save nothing when the task produced no");
      expect(content).toContain("Do not save secrets, tokens, private keys");
      expect(content).toMatch(/editing\s+`\.memory\/` (?:files directly|manually)/i);
      expect(content).toContain("`query_memory`");
      expect(content).toContain("`save_memory`");
      expect(content).toContain("`inspect_memory`");
    }
  });

  it("keeps generated guidance free of removed v1 verbs and concepts", async () => {
    for (const path of generatedGuidanceTargets) {
      const content = await readProjectFile(path);

      expect(content).not.toContain("memory load");
      expect(content).not.toContain("memory remember");
      expect(content).not.toContain("load_memory");
      expect(content).not.toContain("remember_memory");
      expect(content).not.toContain("save_memory_patch");
      expect(content).not.toContain("memory wiki");
      expect(content).not.toContain("memory setup");
      expect(content).not.toContain("memory lens");
      expect(content).not.toContain("memory handoff");
      expect(content).not.toContain("memory suggest");
      expect(content).not.toContain("memory audit");
      expect(content).not.toMatch(/\bfacets?\b/iu);
      expect(content).not.toContain("applies_to");
    }
  });

  it("keeps generated guidance installable through package-manager fallbacks", async () => {
    for (const path of generatedGuidanceTargets) {
      const content = await readProjectFile(path);

      expect(content).toContain("pnpm exec memory");
      expect(content).toContain("npm exec memory");
      expect(content).toContain("npx --package @aictx/memory -- memory");
      expect(content).toContain("./node_modules/.bin/memory");
    }
  });

  it("does not advertise unsupported local MCP tool names", async () => {
    for (const path of [...publicDocsTargets, ...generatedGuidanceTargets]) {
      const content = await readProjectFile(path);

      for (const forbiddenName of forbiddenMcpToolNames) {
        expect(content).not.toContain(forbiddenName);
      }
    }
  });
});
