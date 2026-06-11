import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { runSubprocess } from "../../../src/core/subprocess.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tempRoots: string[] = [];

interface PackedFile {
  path: string;
}

interface PnpmPackOutput {
  filename: string;
  files: PackedFile[];
}

interface PackageJson {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  description?: string;
  devDependencies?: Record<string, string>;
  engines?: {
    node?: string;
  };
  bugs?: {
    url?: string;
  };
  homepage?: string;
  keywords?: string[];
  license?: string;
  name?: string;
  publishConfig?: {
    access?: string;
  };
  repository?: {
    type?: string;
    url?: string;
  };
  scripts?: Record<string, string>;
  version?: string;
}

interface StartedMcpClient {
  client: Client;
  close: () => Promise<void>;
  stderr: () => string;
}

interface StartedViewerProcess {
  url: string;
  close: () => Promise<void>;
  stderr: () => string;
  stdout: () => string;
}

interface ViewerStartupEnvelope {
  ok: true;
  data: {
    url: string;
    host: "127.0.0.1";
    port: number;
    token_required: true;
    open_attempted: boolean;
  };
}

type ViewerChildProcess = ChildProcessByStdio<null, Readable, Readable>;

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("release package", () => {
  it("packs required files and runs published binaries", async () => {
    const packDestination = await createTempRoot("memory-release-pack-");
    const installRoot = await createTempRoot("memory-release-install-");
    const packageJson = parsePackageJson(await readFile(join(repoRoot, "package.json"), "utf8"));
    const packageVersion = requirePackageVersion(packageJson);

    await ensureBuiltPackageOutput(packageVersion);
    await expect(readFile(join(repoRoot, "dist", "viewer", "index.html"), "utf8")).resolves.toContain(
      '<script type="module"'
    );

    const pack = parsePnpmPackOutput(
      await expectSuccessfulCommand("pnpm", [
        "pack",
        "--pack-destination",
        packDestination,
        "--json"
      ], repoRoot)
    );
    const packedPaths = pack.files.map((file) => file.path).sort();
    const packedPathSet = new Set(packedPaths);

    expect(packedPaths).toEqual(expect.arrayContaining(requiredPackedPaths));
    expect(packedPaths.some((path) => path.startsWith("dist/viewer/assets/"))).toBe(true);
    expect(packedPaths).not.toEqual(expect.arrayContaining([...forbiddenPackedPaths]));
    for (const prefix of forbiddenPackedPathPrefixes) {
      expect(packedPaths.every((path) => !path.startsWith(prefix))).toBe(true);
    }
    expect(packedPaths.every((path) => !path.startsWith("src/"))).toBe(true);
    expect(packedPaths.every((path) => !path.startsWith("scripts/"))).toBe(true);
    expect(packedPaths.every((path) => !path.startsWith("test/"))).toBe(true);
    expect(packedPaths.every((path) => !path.startsWith("viewer/"))).toBe(true);

    expect(packageJson.name).toBe("@aictx/memory");
    expect(packageJson.publishConfig).toEqual({
      access: "public"
    });
    expect(packageJson.description).toBe("Local-first project memory for AI coding agents.");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/aictx/memory.git"
    });
    expect(packageJson.homepage).toBe("https://memory.aictx.dev");
    expect(packageJson.bugs).toEqual({
      url: "https://github.com/aictx/memory/issues"
    });
    expect(packageJson.keywords).toEqual(
      expect.arrayContaining(["coding-agents", "project-memory", "local-first", "mcp"])
    );
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.engines?.node).toBe(">=22");
    expect(packageJson.bin).toEqual({
      memory: "dist/cli/main.js",
      "memory-mcp": "dist/mcp/server.js"
    });
    expect(packageJson.scripts?.build).toContain("pnpm build:viewer");
    expect(packageJson.scripts?.build).toContain("pnpm build:version");
    const expectedVersionPatchScript = [
      "npm version patch --no-git-tag-version",
      "pnpm build",
      "pnpm build:docs"
    ].join(" && ");

    expect(packageJson.scripts?.["build:docs"]).toBe("astro build --root docs");
    expect(packageJson.scripts?.["build:version"]).toBe("node scripts/generate-version.mjs");
    expect(packageJson.scripts?.["build:viewer"]).toBe("vite build --config viewer/vite.config.ts");
    expect(packageJson.scripts?.["version:patch"]).toBe(expectedVersionPatchScript);
    await expectBuiltPublicDocs();
    expect(packageJson.devDependencies).toEqual(
      expect.objectContaining({
        "@astrojs/starlight": expect.any(String),
        "@sveltejs/vite-plugin-svelte": expect.any(String),
        astro: expect.any(String),
        "starlight-llms-txt": expect.any(String),
        svelte: expect.any(String),
        "svelte-check": expect.any(String),
        vite: expect.any(String)
      })
    );
    expect(packageJson.dependencies ?? {}).not.toEqual(
      expect.objectContaining({
        "@sveltejs/vite-plugin-svelte": expect.any(String),
        svelte: expect.any(String),
        "svelte-check": expect.any(String),
        vite: expect.any(String)
      })
    );

    await expectCliSymlinkRuns(packageVersion);

    for (const requiredPath of requiredPackedPaths) {
      expect(packedPathSet.has(requiredPath)).toBe(true);
    }

    await writeInstallPackageJson(installRoot, packageJson);
    await expectSuccessfulCommand("pnpm", ["add", "--prefer-offline", pack.filename], installRoot);
    await expectInstalledMemoryDisciplineDocs(installRoot);

    const viewerProjectRoot = await createTempRoot("memory-release-viewer-project-");
    const init = await expectSuccessfulCommand(
      installedBin("memory", installRoot),
      ["init", "--json"],
      viewerProjectRoot
    );

    expect(init.stderr).toBe("");

    const memoryHelp = await expectSuccessfulCommand(
      installedBin("memory", installRoot),
      ["--help"],
      installRoot
    );

    expect(memoryHelp.stderr).toBe("");
    expect(memoryHelp.stdout).toContain("Usage: memory");
    expect(memoryHelp.stdout).toContain("Local project memory CLI");

    const initHelp = await expectSuccessfulCommand(
      installedBin("memory", installRoot),
      ["init", "--help"],
      installRoot
    );

    expect(initHelp.stderr).toBe("");
    expect(initHelp.stdout).toContain("--force");

    const memoryVersion = await expectSuccessfulCommand(
      installedBin("memory", installRoot),
      ["--version"],
      installRoot
    );

    expect(memoryVersion.stderr).toBe("");
    expect(memoryVersion.stdout).toBe(`${packageVersion}\n`);

    const docsList = await expectSuccessfulCommand(
      installedBin("memory", installRoot),
      ["docs"],
      installRoot
    );

    expect(docsList.stderr).toBe("");
    expect(docsList.stdout).toContain("Memory docs: https://docs.aictx.dev/");
    expect(docsList.stdout).toContain("- getting-started:");

    const docsTopic = await expectSuccessfulCommand(
      installedBin("memory", installRoot),
      ["docs", "agent-integration"],
      installRoot
    );

    expect(docsTopic.stderr).toBe("");
    expect(docsTopic.stdout).toContain("# Agent integration");

    const viewer = await startInstalledViewerProcess(installRoot, viewerProjectRoot);

    try {
      await expectInstalledViewerAssetsServe(viewer.url);
    } finally {
      await viewer.close();
    }

    expect(viewer.stderr()).toBe("");

    const started = await startInstalledMcpClient(installRoot);

    try {
      await expect(started.client.ping()).resolves.toEqual({});
      expect(started.client.getServerVersion()).toMatchObject({
        name: "memory-mcp",
        version: packageVersion
      });
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  }, 180_000);
});

const requiredPackedPaths = [
  "README.md",
  "LICENSE",
  "package.json",
  "dist/cli/main.js",
  "dist/mcp/server.js",
  "dist/schemas/config.schema.json",
  "dist/schemas/event.schema.json",
  "dist/schemas/object.schema.json",
  "dist/schemas/patch.schema.json",
  "dist/schemas/relation.schema.json",
  "dist/viewer/favicon.ico",
  "dist/viewer/index.html",
  "docs/src/content/docs/agent-integration.md",
  "docs/src/content/docs/agent-recipes.md",
  "docs/src/content/docs/capabilities.md",
  "docs/src/content/docs/cli.md",
  "docs/src/content/docs/demand-driven-memory.md",
  "docs/src/content/docs/getting-started.md",
  "docs/src/content/docs/index.md",
  "docs/src/content/docs/memory-recipes.md",
  "docs/src/content/docs/mcp.md",
  "docs/src/content/docs/plugin-publishing.md",
  "docs/src/content/docs/reference.md",
  "docs/src/content/docs/specializing-memory.md",
  "docs/src/content/docs/troubleshooting.md",
  "docs/src/content/docs/viewer.md",
  "docs/src/content/docs/wiki-workflow.md",
  "integrations/templates/agent-guidance.md",
  "integrations/codex/memory/SKILL.md",
  "integrations/codex/skills/memory/SKILL.md",
  "integrations/codex/skills/memory/LICENSE.txt",
  "integrations/codex/plugins/memory/.codex-plugin/plugin.json",
  "integrations/codex/plugins/memory/LICENSE",
  "integrations/codex/plugins/memory/README.md",
  "integrations/codex/plugins/memory/skills/memory/SKILL.md",
  "integrations/claude/memory/SKILL.md",
  "integrations/claude/plugins/memory/.claude-plugin/plugin.json",
  "integrations/claude/plugins/memory/LICENSE",
  "integrations/claude/plugins/memory/README.md",
  "integrations/claude/plugins/memory/skills/memory/SKILL.md",
  "integrations/claude/memory.md",
  "integrations/cursor/memory.mdc",
  "integrations/cline/memory.md",
  "integrations/generic/memory-agent-instructions.md"
];

const forbiddenPackedPaths = [
  "docs/.astro/data-store.json",
  "docs/astro.config.mjs",
  "docs/dist/index.html",
  "docs/node_modules/.vite/deps/_metadata.json",
  "docs/public/CNAME",
  "scripts/copy-schemas.mjs",
  "scripts/generate-agent-guidance.mjs",
  "src/cli/main.ts",
  "test/fixtures/.gitkeep",
  "test/fixtures/time.ts",
  "test/integration/release/packaging.test.ts",
  "viewer/index.html",
  "viewer/src/App.svelte",
  "viewer/src/main.ts",
  "viewer/vite.config.ts"
] as const;

const forbiddenPackedPathPrefixes = [
  "docs/.astro/",
  "docs/dist/",
  "docs/node_modules/",
  "site/",
  "src/",
  "test/",
  "scripts/",
  "viewer/"
] as const;

const bundledPublicDocsPaths = [
  "docs/src/content/docs/agent-integration.md",
  "docs/src/content/docs/capabilities.md",
  "docs/src/content/docs/cli.md",
  "docs/src/content/docs/getting-started.md",
  "docs/src/content/docs/index.md",
  "docs/src/content/docs/memory-recipes.md",
  "docs/src/content/docs/mcp.md",
  "docs/src/content/docs/agent-recipes.md",
  "docs/src/content/docs/reference.md",
  "docs/src/content/docs/specializing-memory.md",
  "docs/src/content/docs/troubleshooting.md",
  "docs/src/content/docs/viewer.md",
  "docs/src/content/docs/wiki-workflow.md"
] as const;

const generatedGuidancePaths = [
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

async function ensureBuiltPackageOutput(packageVersion: string): Promise<void> {
  try {
    await Promise.all([
      readFile(join(repoRoot, "dist", "cli", "main.js"), "utf8"),
      readFile(join(repoRoot, "dist", "mcp", "server.js"), "utf8"),
      readFile(join(repoRoot, "dist", "viewer", "favicon.ico")),
      readFile(join(repoRoot, "dist", "viewer", "index.html"), "utf8")
    ]);
    const version = await expectSuccessfulCommand(
      join(repoRoot, "dist", "cli", "main.js"),
      ["--version"],
      repoRoot
    );

    if (version.stdout === `${packageVersion}\n`) {
      return;
    }
  } catch {
    // Fall through to a full rebuild when artifacts are missing or unusable.
  }

  await expectSuccessfulCommand("pnpm", ["build"], repoRoot);
}

async function expectBuiltPublicDocs(): Promise<void> {
  await expectSuccessfulCommand("pnpm", ["build:docs"], repoRoot);
  await expect(
    readFile(join(repoRoot, "docs", "dist", "agent-recipes", "index.html"), "utf8")
  ).resolves.toContain("AI coding agent memory recipes");

  for (const filename of ["llms-small.txt", "llms-full.txt"] as const) {
    const content = await readFile(join(repoRoot, "docs", "dist", filename), "utf8");

    expect(content).toContain("brew install aictx/tap/memory");
    expect(content).toContain("npm install -g @aictx/memory");
    expect(content).not.toMatch(/^npm install -g @aictx\/memory@/m);
  }
}

async function expectSuccessfulCommand(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  const result = await runSubprocess(command, args, { cwd });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  if (result.data.exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${formatCommand(command, args)}`,
        `cwd: ${cwd}`,
        `exit: ${String(result.data.exitCode)}`,
        result.data.stdout.length > 0 ? `stdout:\n${result.data.stdout}` : "stdout: <empty>",
        result.data.stderr.length > 0 ? `stderr:\n${result.data.stderr}` : "stderr: <empty>"
      ].join("\n\n")
    );
  }

  return {
    stdout: result.data.stdout,
    stderr: result.data.stderr
  };
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function parsePnpmPackOutput(output: { stdout: string }): PnpmPackOutput {
  const parsed = JSON.parse(output.stdout) as unknown;

  if (!isPnpmPackOutput(parsed)) {
    throw new Error("Unexpected pnpm pack --json output.");
  }

  return parsed;
}

function isPnpmPackOutput(value: unknown): value is PnpmPackOutput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.filename === "string" &&
    Array.isArray(value.files) &&
    value.files.every((file) => isRecord(file) && typeof file.path === "string")
  );
}

function parsePackageJson(contents: string): PackageJson {
  const parsed = JSON.parse(contents) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("package.json must contain a JSON object.");
  }

  return parsed as PackageJson;
}

function requirePackageVersion(packageJson: PackageJson): string {
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json must declare a non-empty version.");
  }

  return packageJson.version;
}

async function expectCliSymlinkRuns(packageVersion: string): Promise<void> {
  const binRoot = await createTempRoot("memory-release-bin-symlink-");
  const binPath = join(binRoot, executableName("memory"));

  await symlink(join(repoRoot, "dist", "cli", "main.js"), binPath);

  const result = await expectSuccessfulCommand(binPath, ["--version"], binRoot);

  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`${packageVersion}\n`);
}

async function writeInstallPackageJson(
  installRoot: string,
  packageJson: PackageJson
): Promise<void> {
  const zodVersion = packageJson.dependencies?.zod;

  if (zodVersion === undefined) {
    throw new Error("package.json must declare zod for the offline install fixture.");
  }

  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        pnpm: {
          overrides: {
            zod: exactDependencyVersion(zodVersion)
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function exactDependencyVersion(version: string): string {
  return version.replace(/^[~^]/u, "");
}

async function expectInstalledMemoryDisciplineDocs(installRoot: string): Promise<void> {
  for (const relativePath of bundledPublicDocsPaths) {
    const content = await readInstalledPackageFile(installRoot, relativePath);

    expect(content).toMatch(/^---\n/u);
    expect(content).toMatch(/^title:/m);
    for (const forbiddenName of forbiddenMcpToolNames) {
      expect(content).not.toContain(forbiddenName);
    }
  }

  const agentIntegration = await readInstalledPackageFile(
    installRoot,
    "docs/src/content/docs/agent-integration.md"
  );

  expect(agentIntegration).toContain("memory remember --stdin");
  expect(agentIntegration).toContain("Save nothing when the task produced no durable future value.");

  for (const relativePath of generatedGuidancePaths) {
    const content = await readInstalledPackageFile(installRoot, relativePath);

    expectGeneratedGuidanceContent(content);
  }
}

function expectGeneratedGuidanceContent(content: string): void {
  expect(content).toContain('memory query "<question>"');
  expect(content).toContain("memory save --stdin");
  expect(content).toContain("memory sync");
  expect(content).toContain("{task, nodes, stale, supersede, delete}");
  expect(content).toContain("`gotcha`");
  expect(content).toContain('"stage": "building"');
  expect(content).not.toContain("memory load");
  expect(content).not.toContain("memory remember");

  for (const forbiddenName of forbiddenMcpToolNames) {
    expect(content).not.toContain(forbiddenName);
  }
}

async function readInstalledPackageFile(
  installRoot: string,
  relativePath: string
): Promise<string> {
  return readFile(join(installRoot, "node_modules", "@aictx", "memory", relativePath), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function startInstalledMcpClient(cwd: string): Promise<StartedMcpClient> {
  const transport = new StdioClientTransport({
    command: installedBin("memory-mcp", cwd),
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
    name: "memory-release-test-client",
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

async function startInstalledViewerProcess(
  installRoot: string,
  cwd: string
): Promise<StartedViewerProcess> {
  const child = spawn(installedBin("memory", installRoot), ["view", "--json"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  const closedPromise = new Promise<void>((resolveClose) => {
    child.once("close", () => {
      closed = true;
      resolveClose();
    });
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const startup = waitForViewerStartup(child, () => stdout, () => stderr);
  let envelope: ViewerStartupEnvelope;

  try {
    envelope = await startup;
  } catch (error) {
    if (!closed) {
      child.kill("SIGTERM");
    }

    await closedPromise;
    throw error;
  }

  return {
    url: envelope.data.url,
    close: async () => {
      if (!closed) {
        child.kill("SIGTERM");
      }

      await closedPromise;
    },
    stderr: () => stderr,
    stdout: () => stdout
  };
}

function waitForViewerStartup(
  child: ViewerChildProcess,
  readStdout: () => string,
  readStderr: () => string
): Promise<ViewerStartupEnvelope> {
  return new Promise((resolveStartup, rejectStartup) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle(new Error(`Timed out waiting for viewer startup. stderr: ${readStderr()}`));
    }, 20_000);

    const settle = (value: ViewerStartupEnvelope | Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (value instanceof Error) {
        rejectStartup(value);
        return;
      }

      resolveStartup(value);
    };

    const tryParseStartup = (): void => {
      const output = readStdout().trim();

      if (!output.endsWith("}")) {
        return;
      }

      try {
        const parsed = JSON.parse(output) as unknown;

        if (!isViewerStartupEnvelope(parsed)) {
          settle(new Error(`Unexpected viewer startup envelope: ${output}`));
          return;
        }

        settle(parsed);
      } catch (error) {
        settle(new Error(`Viewer startup JSON could not be parsed: ${messageFromUnknown(error)}`));
      }
    };

    child.stdout.on("data", tryParseStartup);
    child.once("error", (error) => {
      settle(error);
    });
    child.once("close", (exitCode, signal) => {
      settle(new Error(
        `Viewer exited before startup. exit=${String(exitCode)} signal=${String(signal)} stderr=${readStderr()}`
      ));
    });
    tryParseStartup();
  });
}

async function expectInstalledViewerAssetsServe(url: string): Promise<void> {
  const viewerUrl = new URL(url);

  expect(viewerUrl.hostname).toBe("127.0.0.1");
  expect(viewerUrl.searchParams.get("token")).toBeTruthy();

  const htmlResponse = await fetch(viewerUrl);

  expect(htmlResponse.status).toBe(200);
  expect(htmlResponse.headers.get("content-type")).toContain("text/html");

  const html = await htmlResponse.text();
  const assetPaths = extractViewerAssetPaths(html);

  expect(html).toContain('<script type="module"');
  expect(assetPaths.some((path) => path.endsWith(".js"))).toBe(true);
  expect(assetPaths.some((path) => path.endsWith(".css"))).toBe(true);

  for (const assetPath of assetPaths) {
    const assetUrl = new URL(assetPath, viewerUrl);
    const assetResponse = await fetch(assetUrl);
    const assetBody = await assetResponse.text();

    expect(assetResponse.status).toBe(200);
    expect(assetBody.length).toBeGreaterThan(0);

    if (assetPath.endsWith(".js")) {
      expect(assetResponse.headers.get("content-type")).toContain("text/javascript");
    }

    if (assetPath.endsWith(".css")) {
      expect(assetResponse.headers.get("content-type")).toContain("text/css");
    }
  }

  const bootstrapUrl = new URL("/api/bootstrap", viewerUrl);
  bootstrapUrl.searchParams.set("token", viewerUrl.searchParams.get("token") ?? "");
  await expect(fetch(bootstrapUrl)).resolves.toMatchObject({ status: 200 });
}

function extractViewerAssetPaths(html: string): string[] {
  const paths = new Set<string>();

  for (const match of html.matchAll(/(?:src|href)="(?<path>\.\/assets\/[^"]+)"/g)) {
    const path = match.groups?.path;

    if (path !== undefined) {
      paths.add(path);
    }
  }

  return [...paths].sort();
}

function isViewerStartupEnvelope(value: unknown): value is ViewerStartupEnvelope {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return false;
  }

  return (
    typeof value.data.url === "string" &&
    value.data.host === "127.0.0.1" &&
    typeof value.data.port === "number" &&
    value.data.token_required === true &&
    typeof value.data.open_attempted === "boolean"
  );
}

function installedBin(name: "memory" | "memory-mcp", installRoot: string): string {
  return join(installRoot, "node_modules", ".bin", executableName(name));
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);

  tempRoots.push(resolvedRoot);

  return resolvedRoot;
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
