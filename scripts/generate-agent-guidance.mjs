import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRootUrl = new URL("../", import.meta.url);
const packageJsonUrl = new URL("package.json", repoRootUrl);
const licenseUrl = new URL("LICENSE", repoRootUrl);
const templateUrl = new URL("integrations/templates/agent-guidance.md", repoRootUrl);
const generatedNotice = "<!-- Generated from integrations/templates/agent-guidance.md. Do not edit directly. -->";
const publicName = "memory";
const displayName = "Memory";
const skillDescription = "Use this skill when working in a project that uses Memory by Aictx as product-layer project memory. It guides the agent to query memory on demand mid-task, save product-meaningful changes after meaningful work, and sync memory at session end.";
const pluginDescription = "Use Memory by Aictx as local project memory in AI coding agents.";
const skillPrefix = `---\nname: ${publicName}\ndescription: ${skillDescription}\n---\n\n${generatedNotice}\n\n`;
const cursorPrefix = `---\ndescription: Use Memory as project memory when working in this repository.\nalwaysApply: true\n---\n\n${generatedNotice}\n\n`;

const guidanceTargets = [
  {
    path: "integrations/codex/memory/SKILL.md",
    prefix: skillPrefix
  },
  {
    path: "integrations/codex/skills/memory/SKILL.md",
    prefix: skillPrefix
  },
  {
    path: "integrations/codex/plugins/memory/skills/memory/SKILL.md",
    prefix: skillPrefix
  },
  {
    path: "integrations/claude/memory/SKILL.md",
    prefix: skillPrefix
  },
  {
    path: "integrations/claude/plugins/memory/skills/memory/SKILL.md",
    prefix: skillPrefix
  },
  {
    path: "integrations/claude/memory.md",
    prefix: `${generatedNotice}\n\n`
  },
  {
    path: "integrations/cursor/memory.mdc",
    prefix: cursorPrefix
  },
  {
    path: "integrations/cline/memory.md",
    prefix: `${generatedNotice}\n\n`
  },
  {
    path: "integrations/generic/memory-agent-instructions.md",
    prefix: `${generatedNotice}\n\n`
  }
];

const [template, packageJsonRaw, licenseText] = await Promise.all([
  readFile(templateUrl, "utf8"),
  readFile(packageJsonUrl, "utf8"),
  readFile(licenseUrl, "utf8")
]);
const normalizedTemplate = template.trimEnd();
const packageJson = JSON.parse(packageJsonRaw);
const repositoryUrl = normalizeRepositoryUrl(packageJson.repository);
const authorName = typeof packageJson.author === "string" ? packageJson.author : "Memory";

const codexPluginManifest = {
  name: publicName,
  version: packageJson.version,
  description: pluginDescription,
  author: {
    name: authorName,
    url: repositoryUrl
  },
  homepage: packageJson.homepage,
  repository: repositoryUrl,
  license: packageJson.license,
  keywords: ["memory", "project-memory", "coding-agents", "local-first"],
  skills: "./skills/",
  interface: {
    displayName,
    shortDescription: "Query and save product-layer project memory with Memory.",
    longDescription:
      "Packages the Memory by Aictx workflow as a Codex skill. Agents stay CLI-first, query project memory on demand mid-task, save product-meaningful changes, and sync memory at session end.",
    developerName: authorName,
    category: "Productivity",
    websiteURL: packageJson.homepage,
    defaultPrompt: [
      "Set up Memory for this repo.",
      "Query Memory for this task.",
      "Decide whether this task changed Memory."
    ]
  }
};

const claudePluginManifest = {
  name: publicName,
  description: pluginDescription,
  version: packageJson.version,
  author: {
    name: authorName,
    url: repositoryUrl
  },
  homepage: packageJson.homepage,
  repository: repositoryUrl,
  license: packageJson.license
};

for (const target of guidanceTargets) {
  await writeGeneratedText(target.path, `${target.prefix}${normalizedTemplate}\n`);
}

await Promise.all([
  writeGeneratedJson("integrations/codex/plugins/memory/.codex-plugin/plugin.json", codexPluginManifest),
  writeGeneratedJson("integrations/claude/plugins/memory/.claude-plugin/plugin.json", claudePluginManifest),
  writeGeneratedText("integrations/codex/skills/memory/LICENSE.txt", licenseText),
  writeGeneratedText("integrations/codex/plugins/memory/LICENSE", licenseText),
  writeGeneratedText("integrations/claude/plugins/memory/LICENSE", licenseText),
  writeGeneratedText("integrations/codex/plugins/memory/README.md", buildCodexPluginReadme()),
  writeGeneratedText("integrations/claude/plugins/memory/README.md", buildClaudePluginReadme())
]);

async function writeGeneratedText(path, contents) {
  const targetUrl = new URL(path, repoRootUrl);

  await mkdir(dirname(fileURLToPath(targetUrl)), { recursive: true });
  await writeFile(targetUrl, contents);
}

async function writeGeneratedJson(path, value) {
  await writeGeneratedText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeRepositoryUrl(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;

  if (typeof value !== "string" || value.length === 0) {
    return packageJson.homepage;
  }

  return value.replace(/^git\+/u, "").replace(/\.git$/u, "");
}

function buildCodexPluginReadme() {
  return `${generatedNotice}

# ${displayName} for Codex

This plugin packages the \`${publicName}\` skill for Codex.

It keeps Memory usage CLI-first: query project memory on demand with \`memory query\`, save product-meaningful changes with \`memory save --stdin\`, and use MCP equivalents only when the current Codex session already exposes Memory MCP tools.

## Contents

- \`.codex-plugin/plugin.json\`
- \`skills/memory/SKILL.md\`

## Distribution

This directory follows the Codex plugin format. It intentionally does not include MCP server configuration; Memory MCP setup remains an optional client-level configuration.

Codex adds plugins through marketplace sources, not by adding this plugin directory directly. This repo exposes the plugin through its root marketplace catalog:

\`\`\`bash
codex plugin marketplace add aictx/memory
\`\`\`

Then open Codex Plugins, choose the Memory marketplace, and install Memory.
`;
}

function buildClaudePluginReadme() {
  return `${generatedNotice}

# ${displayName} for Claude Code

This plugin packages the \`${publicName}\` skill for Claude Code.

It keeps Memory usage CLI-first: query project memory on demand with \`memory query\`, save product-meaningful changes with \`memory save --stdin\`, and use MCP equivalents only when the current Claude Code session already exposes Memory MCP tools.

## Contents

- \`.claude-plugin/plugin.json\`
- \`skills/memory/SKILL.md\`

## Distribution

This directory follows the Claude Code plugin format. Submit it through Anthropic's plugin submission flow when targeting the official Claude plugin directory.

Claude Code adds plugins through marketplace sources, not by adding this plugin directory directly. This repo exposes the plugin through its root marketplace catalog:

\`\`\`text
/plugin marketplace add aictx/memory
/plugin install memory@aictx
\`\`\`

For official Claude listing, validate this directory with \`claude plugin validate integrations/claude/plugins/memory\` and use Anthropic's plugin submission flow.
`;
}
