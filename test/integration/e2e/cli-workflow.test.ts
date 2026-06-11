import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import { runSubprocess } from "../../../src/core/subprocess.js";

const tempRoots: string[] = [];

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ResponseMeta {
  project_root: string;
  memory_root: string;
  git: {
    available: boolean;
    branch: string | null;
    commit: string | null;
    dirty: boolean | null;
  };
}

interface SuccessEnvelope<TData> {
  ok: true;
  data: TData;
  warnings: string[];
  meta: ResponseMeta;
}

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  warnings: string[];
  meta: ResponseMeta;
}

interface InitData {
  created: boolean;
  index_built: boolean;
  git_available: boolean;
}

interface SaveData {
  files_changed: string[];
  memory_created: string[];
  memory_updated: string[];
  memory_deleted: string[];
  relations_created: string[];
  relations_updated: string[];
  relations_deleted: string[];
  events_appended: number;
  index_updated: boolean;
}

interface SearchData {
  matches: Array<{
    id: string;
    type: string;
    status: string;
    title: string;
    snippet: string;
    body_path: string;
    score: number;
  }>;
}

interface CheckData {
  valid: boolean;
  errors: unknown[];
  warnings: unknown[];
}

interface RebuildData {
  index_rebuilt: boolean;
  objects_indexed: number;
  relations_indexed: number;
  events_indexed: number;
  event_appended: boolean;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("memory full CLI workflow", () => {
  it("runs the Git-backed workflow end to end", async () => {
    const repo = await createRepo("memory-e2e-cli-git-");
    const initOutput = await runCli(["node", "memory", "init", "--json"], repo);

    expect(initOutput.exitCode).toBe(0);
    expect(initOutput.stderr).toBe("");
    const initEnvelope = parseSuccessEnvelope<InitData>(initOutput.stdout);
    expect(initEnvelope.data).toMatchObject({
      created: true,
      index_built: true,
      git_available: true
    });
    expect(initEnvelope.meta.git.available).toBe(true);

    await commit(repo, "Initialize memory", "2026-04-25T14:00:00+02:00", [
      ".gitignore",
      ".memory"
    ]);
    const projectId = await readJsonString(join(repo, ".memory", "memory", "project.json"), "id");
    const saveOutput = await runCli(
      ["node", "memory", "save", "--stdin", "--json"],
      repo,
      JSON.stringify(createGitWorkflowPatch(projectId))
    );

    expect(saveOutput.exitCode).toBe(0);
    expect(saveOutput.stderr).toBe("");
    const saveEnvelope = parseSuccessEnvelope<SaveData>(saveOutput.stdout);
    expect(saveEnvelope.data.memory_updated).toContain(projectId);
    expect(saveEnvelope.data.memory_created).toContain("decision.workflow-retry-queue");
    expect(saveEnvelope.data.memory_created).toContain("gotcha.workflow-local-only");
    expect(saveEnvelope.data.index_updated).toBe(true);
    expect(saveEnvelope.meta.git.dirty).toBe(true);

    const searched = parseSuccessEnvelope<SearchData>(
      (
        await expectSuccessfulCli([
          "node",
          "memory",
          "search",
          "workflow retry queue",
          "--json"
        ], repo)
      ).stdout
    );
    expect(searchIds(searched)).toContain("decision.workflow-retry-queue");

    const outsideDirtyContent = "outside dirty change must stay out of memory diff\n";
    await writeFile(join(repo, "src.ts"), outsideDirtyContent, "utf8");
    const diffOutput = await expectSuccessfulCli(["node", "memory", "diff"], repo);
    expect(diffOutput.stdout).toContain(".memory/memory/project.md");
    expect(diffOutput.stdout).toContain("Workflow retry queue requires local deterministic CLI coverage");
    expect(diffOutput.stdout).not.toContain("src.ts");
    expect(() => JSON.parse(diffOutput.stdout) as unknown).toThrow();
  });

  it("runs the core workflow outside Git and rejects Git-only commands", async () => {
    const projectRoot = await createTempRoot("memory-e2e-cli-nongit-");
    const init = parseSuccessEnvelope<InitData>(
      (await expectSuccessfulCli(["node", "memory", "init", "--json"], projectRoot)).stdout
    );

    expect(init.meta).toEqual({
      project_root: projectRoot,
      memory_root: join(projectRoot, ".memory"),
      git: {
        available: false,
        branch: null,
        commit: null,
        dirty: null
      }
    });

    const save = parseSuccessEnvelope<SaveData>(
      (
        await expectSuccessfulCli(
          ["node", "memory", "save", "--stdin", "--json"],
          projectRoot,
          JSON.stringify(createNonGitWorkflowPatch())
        )
      ).stdout
    );
    expect(save.data.memory_created).toContain("decision.nongit-cli-workflow");
    expect(save.data.index_updated).toBe(true);
    expect(save.meta.git.available).toBe(false);

    const searched = parseSuccessEnvelope<SearchData>(
      (
        await expectSuccessfulCli([
          "node",
          "memory",
          "search",
          "non git workflow search",
          "--json"
        ], projectRoot)
      ).stdout
    );
    expect(searchIds(searched)).toContain("decision.nongit-cli-workflow");

    const checked = parseSuccessEnvelope<CheckData>(
      (await expectSuccessfulCli(["node", "memory", "check", "--json"], projectRoot)).stdout
    );
    expect(checked.data).toMatchObject({
      valid: true,
      errors: []
    });

    const rebuilt = parseSuccessEnvelope<RebuildData>(
      (await expectSuccessfulCli(["node", "memory", "rebuild", "--json"], projectRoot)).stdout
    );
    expect(rebuilt.data.index_rebuilt).toBe(true);
    expect(rebuilt.data.objects_indexed).toBeGreaterThan(0);
    expect(rebuilt.data.event_appended).toBe(false);

    for (const argv of gitOnlyCommands()) {
      const output = await runCli(argv, projectRoot);
      expect(output.exitCode).toBe(3);
      expect(output.stderr).toBe("");
      const envelope = parseErrorEnvelope(output.stdout);
      expect(envelope.error.code).toBe("MemoryGitRequired");
      expect(envelope.meta.git.available).toBe(false);
    }

    const searchAfterFailures = parseSuccessEnvelope<SearchData>(
      (
        await expectSuccessfulCli([
          "node",
          "memory",
          "search",
          "non git workflow search",
          "--json"
        ], projectRoot)
      ).stdout
    );
    expect(searchIds(searchAfterFailures)).toContain("decision.nongit-cli-workflow");
  });
});

function createGitWorkflowPatch(projectId: string) {
  return {
    task: "Full CLI workflow test",
    nodes: [
      {
        id: projectId,
        title: "Workflow Project Memory",
        body:
          "# Workflow Project Memory\n\nWorkflow retry queue requires local deterministic CLI coverage. Do not call network services while loading context. Relevant file src/cli/main.ts.\n",
        tags: ["workflow", "retry", "e2e"]
      },
      {
        id: "gotcha.workflow-local-only",
        kind: "gotcha",
        title: "Workflow stays local",
        body:
          "# Workflow stays local\n\nFull CLI workflow tests must pass without network access and restore must stay scoped to .memory/ only.\n",
        tags: ["workflow", "local", "restore"]
      },
      {
        id: "decision.workflow-retry-queue",
        kind: "decision",
        title: "Workflow retry queue",
        body:
          "# Workflow retry queue\n\nUse the generated SQLite index and CLI adapters to load and search saved workflow retry queue memory. Do not mutate product files from the e2e test.\n",
        tags: ["workflow", "retry", "queue"],
        anchors: ["src/cli/main.ts"],
        related: [
          {
            predicate: "depends_on",
            to: "gotcha.workflow-local-only",
            confidence: "high"
          }
        ]
      }
    ]
  };
}

function createNonGitWorkflowPatch() {
  return {
    task: "Full CLI workflow non Git test",
    nodes: [
      {
        id: "decision.nongit-cli-workflow",
        kind: "decision",
        title: "Non Git CLI workflow",
        body:
          "# Non Git CLI workflow\n\nCore non git workflow search, load, check, and rebuild commands must work without Git metadata.\n",
        tags: ["non", "git", "workflow"]
      }
    ]
  };
}

function gitOnlyCommands(): string[][] {
  return [["node", "memory", "diff", "--json"]];
}

async function expectSuccessfulCli(
  argv: string[],
  cwd: string,
  stdinText?: string
): Promise<CliRunResult> {
  const output = await runCli(argv, cwd, stdinText);

  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");

  return output;
}

async function runCli(
  argv: string[],
  cwd: string,
  stdinText?: string
): Promise<CliRunResult> {
  const output = createCapturedOutput();
  const exitCode = await main(argv, {
    ...output.writers,
    cwd,
    ...(stdinText === undefined ? {} : { stdin: Readable.from([stdinText]) })
  });

  return {
    exitCode,
    stdout: output.stdout(),
    stderr: output.stderr()
  };
}

function parseSuccessEnvelope<TData>(stdout: string): SuccessEnvelope<TData> {
  return JSON.parse(stdout) as SuccessEnvelope<TData>;
}

function parseErrorEnvelope(stdout: string): ErrorEnvelope {
  return JSON.parse(stdout) as ErrorEnvelope;
}

function searchIds(envelope: SuccessEnvelope<SearchData>): string[] {
  return envelope.data.matches.map((match) => match.id);
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
  await writeFile(join(repo, "src.ts"), "initial source\n", "utf8");
  await commit(repo, "Initial commit", "2026-04-25T13:59:00+02:00", [
    "README.md",
    "src.ts"
  ]);
  return repo;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function commit(
  cwd: string,
  message: string,
  date: string,
  paths: string[]
): Promise<void> {
  await git(cwd, ["add", ...paths]);
  await git(cwd, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  });
}

async function git(
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {}
): Promise<string> {
  const result = await runSubprocess("git", args, {
    cwd,
    env: { ...process.env, ...env }
  });

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

async function readJsonString(path: string, key: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;

  if (!isRecord(parsed) || typeof parsed[key] !== "string") {
    throw new Error(`Expected ${path} to contain a string ${key}.`);
  }

  return parsed[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
