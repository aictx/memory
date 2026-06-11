import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import { runSubprocess } from "../../../src/core/subprocess.js";

const tempRoots: string[] = [];

interface StatusStageSummary {
  count: number;
  titles: string[];
}

interface StatusData {
  project: {
    id: string;
    name: string;
  };
  features_by_stage: Record<string, StatusStageSummary>;
  open_questions: Array<{ id: string; title: string }>;
  stale: Array<{ id: string; title: string; orphaned_anchors: string[] }>;
  last_activity: string | null;
  last_sync: { last_sync_commit: string | null; last_sync_at: string | null } | null;
}

interface StatusSuccessEnvelope {
  ok: true;
  data: StatusData;
  warnings: string[];
}

interface ProjectStatusRow {
  registry_id: string;
  project: {
    id: string;
    name: string;
  };
  project_root: string;
  needs_reset: boolean;
  storage_version: number | string | null;
  features_by_stage: Record<string, StatusStageSummary> | null;
  open_questions: Array<{ id: string; title: string }> | null;
  stale: Array<{ id: string; title: string; orphaned_anchors: string[] }> | null;
  last_activity: string | null;
  last_sync: { last_sync_commit: string | null; last_sync_at: string | null } | null;
}

interface AllStatusSuccessEnvelope {
  ok: true;
  data: {
    registry_path: string;
    projects: ProjectStatusRow[];
  };
}

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory status CLI", () => {
  it("summarizes features, questions, stale anchors, and sync state", async () => {
    const repo = await createRepo("memory-cli-status-");

    expect((await runCli(["node", "memory", "init", "--json"], repo)).exitCode).toBe(0);
    await saveProductGraph(repo);

    const jsonOutput = await runCli(["node", "memory", "status", "--json"], repo);
    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    const envelope = JSON.parse(jsonOutput.stdout) as StatusSuccessEnvelope;

    expect(envelope.ok).toBe(true);
    expect(envelope.data.features_by_stage).toMatchObject({
      building: { count: 1, titles: ["Query verb"] },
      shipped: { count: 1, titles: ["Save verb"] },
      idea: { count: 0, titles: [] },
      paused: { count: 0, titles: [] },
      dead: { count: 1, titles: ["Old importer"] }
    });
    expect(envelope.data.open_questions).toEqual([
      { id: "question.retry-cap-policy", title: "Retry cap policy" }
    ]);
    expect(envelope.data.stale).toEqual([
      {
        id: "feature.save-verb",
        title: "Save verb",
        orphaned_anchors: ["src/missing/"]
      }
    ]);
    expect(envelope.data.last_activity).not.toBeNull();
    expect(envelope.data.last_sync).toBeNull();

    const humanOutput = await runCli(["node", "memory", "status"], repo);
    expect(humanOutput.exitCode).toBe(0);
    expect(humanOutput.stderr).toBe("");
    expect(humanOutput.stdout).toContain(
      `${envelope.data.project.name} — product graph status`
    );
    expect(humanOutput.stdout).toContain(
      "Features: building 1 · shipped 1 · idea 0 · paused 0 · dead 1"
    );
    expect(humanOutput.stdout).toContain("  building: Query verb");
    expect(humanOutput.stdout).toContain("  shipped: Save verb");
    expect(humanOutput.stdout).toContain("  dead: Old importer");
    expect(humanOutput.stdout).toContain("Open questions (1): Retry cap policy");
    expect(humanOutput.stdout).toContain(
      "Stale anchors (1): feature.save-verb — src/missing/ matches no files"
    );
    expect(humanOutput.stdout).toMatch(/Last activity: \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Last sync: never/);
  });

  it("reports a recorded sync state and skips stale checks outside Git", async () => {
    const projectRoot = await createTempRoot("memory-cli-status-nongit-");

    expect((await runCli(["node", "memory", "init", "--json"], projectRoot)).exitCode).toBe(0);
    await saveCli(projectRoot, {
      task: "Feature with unverifiable anchor",
      nodes: [
        {
          kind: "feature",
          title: "Orphan candidate",
          body: "# Orphan candidate\n\nAnchor cannot be verified without Git.\n",
          stage: "building",
          anchors: ["src/never-exists/"]
        }
      ]
    });
    await writeFile(
      join(projectRoot, ".memory", "sync-state.json"),
      `${JSON.stringify({
        last_sync_commit: "abc123",
        last_sync_at: "2026-06-10T12:00:00Z"
      })}\n`,
      "utf8"
    );

    const output = await runCli(["node", "memory", "status", "--json"], projectRoot);
    expect(output.exitCode).toBe(0);
    const envelope = JSON.parse(output.stdout) as StatusSuccessEnvelope;

    expect(envelope.data.stale).toEqual([]);
    expect(envelope.data.last_sync).toEqual({
      last_sync_commit: "abc123",
      last_sync_at: "2026-06-10T12:00:00Z"
    });

    const humanOutput = await runCli(["node", "memory", "status"], projectRoot);
    expect(humanOutput.stdout).toContain("Stale anchors: none");
    expect(humanOutput.stdout).toContain("Last sync: 2026-06-10 12:00");
  });

  it("summarizes all registered projects and isolates version-gated storage", async () => {
    const memoryHome = await createTempRoot("memory-cli-status-home-");
    const activeProject = await createTempRoot("memory-cli-status-all-active-");
    const gatedProject = await createTempRoot("memory-cli-status-all-gated-");

    expect(
      (await runCli(["node", "memory", "init", "--json"], activeProject, memoryHome, true)).exitCode
    ).toBe(0);
    await saveCli(activeProject, {
      task: "Active project graph",
      nodes: [
        {
          kind: "feature",
          title: "Live feature",
          body: "# Live feature\n\nStill in progress.\n",
          stage: "building"
        }
      ]
    }, memoryHome, true);

    expect(
      (await runCli(["node", "memory", "init", "--json"], gatedProject, memoryHome, true)).exitCode
    ).toBe(0);
    await downgradeStorageVersion(gatedProject, 4);

    const jsonOutput = await runCli(
      ["node", "memory", "status", "--all", "--json"],
      activeProject,
      memoryHome
    );
    expect(jsonOutput.exitCode).toBe(0);
    const envelope = JSON.parse(jsonOutput.stdout) as AllStatusSuccessEnvelope;

    expect(envelope.data.registry_path).toBe(join(memoryHome, "projects.json"));
    expect(envelope.data.projects).toHaveLength(2);

    const [first, second] = envelope.data.projects;
    expect(first?.project_root).toBe(activeProject);
    expect(first?.needs_reset).toBe(false);
    expect(first?.storage_version).toBe(5);
    expect(first?.features_by_stage).toMatchObject({
      building: { count: 1, titles: ["Live feature"] },
      paused: { count: 0, titles: [] },
      dead: { count: 0, titles: [] }
    });
    expect(first?.last_activity).not.toBeNull();
    expect(second?.project_root).toBe(gatedProject);
    expect(second?.needs_reset).toBe(true);
    expect(second?.storage_version).toBe(4);
    expect(second?.features_by_stage).toBeNull();
    expect(second?.last_activity).toBeNull();

    const humanOutput = await runCli(
      ["node", "memory", "status", "--all"],
      activeProject,
      memoryHome
    );
    expect(humanOutput.exitCode).toBe(0);
    expect(humanOutput.stdout).toContain(
      `${first?.project.name} — idea 0 · building 1 · shipped 0 · questions 0 · stale 0 · last activity `
    );
    expect(humanOutput.stdout).toContain("last sync never");
    expect(humanOutput.stdout).toContain(
      `${second?.project.name} — needs \`memory reset && memory init\` (storage v4)`
    );

    const firstLine = humanOutput.stdout.split("\n")[0] ?? "";
    expect(firstLine).toContain(first?.project.name ?? "");
  });
});

async function saveProductGraph(repo: string): Promise<void> {
  await saveCli(repo, {
    task: "initial product graph",
    nodes: [
      {
        kind: "feature",
        title: "Query verb",
        body: "# Query verb\n\nToken-budgeted subgraph answers.\n",
        stage: "building",
        anchors: ["README.md"]
      },
      {
        kind: "feature",
        title: "Save verb",
        body: "# Save verb\n\nIntent-first save.\n",
        stage: "shipped",
        anchors: ["src/missing/"]
      },
      {
        kind: "feature",
        title: "Old importer",
        body: "# Old importer\n\nAbandoned path.\n",
        stage: "dead"
      },
      {
        kind: "question",
        title: "Retry cap policy",
        body: "# Retry cap policy\n\nWhat is the retry cap?\n"
      }
    ]
  });
}

async function saveCli(
  cwd: string,
  input: unknown,
  memoryHome?: string,
  registryEnabled?: boolean
): Promise<void> {
  const output = await runCli(
    ["node", "memory", "save", "--stdin", "--json"],
    cwd,
    memoryHome,
    registryEnabled,
    JSON.stringify(input)
  );

  expect(output.exitCode).toBe(0);
}

async function downgradeStorageVersion(projectRoot: string, version: number): Promise<void> {
  const configPath = join(projectRoot, ".memory", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

  config.version = version;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function runCli(
  argv: string[],
  cwd: string,
  memoryHome?: string,
  registryEnabled?: boolean,
  stdinText?: string
): Promise<CliRunResult> {
  const output = createCapturedOutput();
  const exitCode = await main(argv, {
    ...output.writers,
    cwd,
    ...(stdinText === undefined ? {} : { stdin: Readable.from([stdinText]) }),
    ...(memoryHome === undefined
      ? {}
      : { registry: { enabled: registryEnabled === true, memoryHome } })
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

async function createRepo(prefix: string): Promise<string> {
  const repo = await createTempRoot(prefix);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Memory Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "Initial commit"]);
  return repo;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runSubprocess("git", args, { cwd });

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
