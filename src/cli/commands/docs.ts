import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CommanderError, type Command } from "commander";

import { type AppResult } from "../../app/operations.js";
import { memoryError, type MemoryError } from "../../core/errors.js";
import { runSubprocess } from "../../core/subprocess.js";
import { CLI_EXIT_SUCCESS, type CliExitCode } from "../exit.js";
import { renderAppResult } from "../render.js";

type CliOutputWriter = (text: string) => void;

export type DocsUrlOpener = (url: string) => Promise<void> | void;

export interface RegisterDocsCommandOptions {
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
  docsDir?: string;
  baseUrl?: string;
  opener?: DocsUrlOpener;
}

interface DocsCommandFlags {
  open?: boolean;
}

interface DocsTopic {
  topic: string;
  title: string;
  description: string;
  file: string;
  path: string;
  aliases: readonly string[];
}

interface DocsTopicSummary {
  topic: string;
  title: string;
  description: string;
  url: string;
  aliases: readonly string[];
}

interface DocsListData {
  kind: "list";
  base_url: string;
  topics: DocsTopicSummary[];
  open_attempted: boolean;
  opened_url: string | null;
}

interface DocsTopicData extends DocsTopicSummary {
  kind: "topic";
  content: string;
  open_attempted: boolean;
  opened_url: string | null;
}

type DocsData = DocsListData | DocsTopicData;

const DEFAULT_DOCS_BASE_URL = "https://docs.aictx.dev";

const DOC_TOPICS = [
  {
    topic: "getting-started",
    title: "Getting started",
    description:
      "Install Memory, run init, build the first product graph, and run the query/save/sync loop.",
    file: "getting-started.md",
    path: "/getting-started/",
    aliases: ["quickstart", "install", "start"]
  },
  {
    topic: "mental-model",
    title: "Mental model",
    description:
      "Understand the product graph: kinds, stages, anchors, map-as-push, query-as-pull, and sync.",
    file: "mental-model.md",
    path: "/mental-model/",
    aliases: ["model", "memory-model", "product-graph"]
  },
  {
    topic: "capabilities",
    title: "Capabilities",
    description: "See what Memory can do, grouped by the jobs users and agents need.",
    file: "capabilities.md",
    path: "/capabilities/",
    aliases: ["features", "capability-map", "what-can-it-do"]
  },
  {
    topic: "cli",
    title: "CLI guide",
    description: "Use init, query, save, sync, status, and the inspection and maintenance commands.",
    file: "cli.md",
    path: "/cli/",
    aliases: ["commands", "command-line"]
  },
  {
    topic: "mcp",
    title: "MCP guide",
    description: "Configure Memory MCP and use the query, save, status, and inspect tools.",
    file: "mcp.md",
    path: "/mcp/",
    aliases: ["mcp-setup", "tools"]
  },
  {
    topic: "agent-integration",
    title: "Agent integration",
    description: "Teach coding agents to query, save, and sync the product graph safely.",
    file: "agent-integration.md",
    path: "/agent-integration/",
    aliases: ["agents", "agent", "guidance"]
  },
  {
    topic: "plugin-publishing",
    title: "Publishing Plugins",
    description: "Publish the generated Memory Codex and Claude Code plugin artifacts.",
    file: "plugin-publishing.md",
    path: "/plugin-publishing/",
    aliases: ["plugins", "publishing", "plugin-marketplace", "marketplace"]
  },
  {
    topic: "viewer",
    title: "Local viewer",
    description: "Inspect the product graph through the local browser viewer.",
    file: "viewer.md",
    path: "/viewer/",
    aliases: ["view", "local-viewer"]
  },
  {
    topic: "troubleshooting",
    title: "Troubleshooting",
    description: "Fix common install, PATH, MCP, schema-version, index, and recovery issues.",
    file: "troubleshooting.md",
    path: "/troubleshooting/",
    aliases: ["help", "debug"]
  },
  {
    topic: "reference",
    title: "Reference",
    description:
      "Schema v5 reference: node kinds, sidecar fields, predicates, save input, config, and storage layout.",
    file: "reference.md",
    path: "/reference/",
    aliases: ["ref", "schema", "storage-layout"]
  }
] as const satisfies readonly DocsTopic[];

export function registerDocsCommand(
  program: Command,
  options: RegisterDocsCommandOptions
): void {
  program
    .command("docs")
    .description("Read bundled public Memory docs or open the hosted docs site.")
    .argument("[topic]", "Docs topic to print.")
    .option("--open", "Open the hosted docs page in the default browser.")
    .action(async (topic: string | undefined, flags: DocsCommandFlags, command: Command) => {
      const result = await docsCommandResult(topic, flags, options);
      const rendered = renderAppResult(result, {
        json: isJsonMode(command),
        renderData: renderDocsData
      });

      options.stdout(rendered.stdout);
      options.stderr(rendered.stderr);

      if (rendered.exitCode !== CLI_EXIT_SUCCESS) {
        throwCommandFailed(rendered.exitCode);
      }
    });
}

async function docsCommandResult(
  topic: string | undefined,
  flags: DocsCommandFlags,
  options: RegisterDocsCommandOptions
): Promise<AppResult<DocsData>> {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_DOCS_BASE_URL);
  const openAttempted = flags.open === true;

  if (topic === undefined) {
    const openedUrl = openAttempted ? baseUrl : null;
    const warnings = openAttempted ? await openDocsUrl(baseUrl, options.opener) : [];

    return {
      ok: true,
      data: {
        kind: "list",
        base_url: baseUrl,
        topics: DOC_TOPICS.map((entry) => summarizeTopic(entry, baseUrl)),
        open_attempted: openAttempted,
        opened_url: openedUrl
      },
      warnings,
      meta: docsMeta()
    };
  }

  const entry = findTopic(topic);

  if (entry === null) {
    return {
      ok: false,
      error: unknownTopicError(topic),
      warnings: [],
      meta: docsMeta()
    };
  }

  const url = topicUrl(entry, baseUrl);
  let content: string;

  try {
    content = await readTopicMarkdown(entry, options.docsDir);
  } catch (error) {
    return {
      ok: false,
      error: memoryError("MemoryInternalError", `Could not read bundled docs topic: ${entry.topic}`, {
        topic: entry.topic,
        message: messageFromUnknown(error)
      }),
      warnings: [],
      meta: docsMeta()
    };
  }

  const warnings = openAttempted ? await openDocsUrl(url, options.opener) : [];

  return {
    ok: true,
    data: {
      kind: "topic",
      ...summarizeTopic(entry, baseUrl),
      content,
      open_attempted: openAttempted,
      opened_url: openAttempted ? url : null
    },
    warnings,
    meta: docsMeta()
  };
}

function renderDocsData(data: DocsData): string {
  if (data.kind === "topic") {
    return data.content;
  }

  if (data.open_attempted) {
    return `Memory docs: ${data.base_url}`;
  }

  return [
    `Memory docs: ${data.base_url}`,
    "",
    "Topics:",
    ...data.topics.map((topic) => `- ${topic.topic}: ${topic.description}`),
    "",
    "Run `memory docs <topic>` to print a topic or `memory docs --open` to open the docs site."
  ].join("\n");
}

async function readTopicMarkdown(entry: DocsTopic, docsDir: string | undefined): Promise<string> {
  const errors: string[] = [];

  for (const baseUrl of docsContentUrls(docsDir)) {
    const path = fileURLToPath(new URL(entry.file, baseUrl));

    try {
      const content = await readFile(path, "utf8");

      return topicMarkdownWithTitle(entry, stripFrontmatter(content));
    } catch (error) {
      errors.push(`${path}: ${messageFromUnknown(error)}`);
    }
  }

  throw new Error(errors.join("; "));
}

function docsContentUrls(docsDir: string | undefined): URL[] {
  if (docsDir !== undefined) {
    return [pathToFileURL(ensureTrailingSlash(resolve(docsDir)))];
  }

  return [
    new URL("../../docs/src/content/docs/", import.meta.url),
    new URL("../../../docs/src/content/docs/", import.meta.url)
  ];
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) {
    return content;
  }

  const end = content.indexOf("\n---\n", 4);

  if (end === -1) {
    return content;
  }

  return content.slice(end + "\n---\n".length);
}

function topicMarkdownWithTitle(entry: DocsTopic, content: string): string {
  const body = content.trimStart();

  if (body.startsWith(`# ${entry.title}`)) {
    return body;
  }

  return `# ${entry.title}\n\n${body}`;
}

function summarizeTopic(entry: DocsTopic, baseUrl: string): DocsTopicSummary {
  return {
    topic: entry.topic,
    title: entry.title,
    description: entry.description,
    url: topicUrl(entry, baseUrl),
    aliases: entry.aliases
  };
}

function findTopic(value: string): DocsTopic | null {
  const normalized = normalizeTopic(value);

  return (
    DOC_TOPICS.find(
      (entry) =>
        normalizeTopic(entry.topic) === normalized ||
        entry.aliases.some((alias) => normalizeTopic(alias) === normalized)
    ) ?? null
  );
}

function unknownTopicError(topic: string): MemoryError {
  return memoryError("MemoryObjectNotFound", `Unknown docs topic: ${topic}`, {
    topic,
    available_topics: DOC_TOPICS.map((entry) => entry.topic)
  });
}

function topicUrl(entry: DocsTopic, baseUrl: string): string {
  return new URL(entry.path, baseUrl).toString();
}

function normalizeTopic(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeBaseUrl(value: string): string {
  return ensureTrailingSlash(value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function openDocsUrl(
  url: string,
  opener: DocsUrlOpener | undefined
): Promise<string[]> {
  try {
    if (opener !== undefined) {
      await opener(url);
      return [];
    }

    await openWithDefaultBrowser(url);
    return [];
  } catch (error) {
    return [`Docs URL could not be opened: ${messageFromUnknown(error)}`];
  }
}

async function openWithDefaultBrowser(url: string): Promise<void> {
  const command = browserOpenCommand(url);
  const result = await runSubprocess(command.command, command.args);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  if (result.data.exitCode !== 0) {
    throw new Error(result.data.stderr.trim() || `exit code ${result.data.exitCode}`);
  }
}

function browserOpenCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

function docsMeta() {
  return {
    project_root: process.cwd(),
    memory_root: `${process.cwd()}/.memory`,
    git: {
      available: false,
      branch: null,
      commit: null,
      dirty: null
    }
  };
}

function isJsonMode(command: Command): boolean {
  const options = command.optsWithGlobals() as { json?: unknown };
  return options.json === true;
}

function throwCommandFailed(exitCode: CliExitCode): never {
  throw new CommanderError(
    exitCode,
    "memory.command.failed",
    "Memory command failed."
  );
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
