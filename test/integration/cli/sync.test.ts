import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import { runSubprocess } from "../../../src/core/subprocess.js";

const tempRoots: string[] = [];

interface SyncData {
  base_commit: string | null;
  head_commit: string;
  full_verification: boolean;
  changed_files_count: number;
  fresh: string[];
  changed: Array<{ id: string; anchors: string[]; files: string[] }>;
  orphaned: Array<{ id: string; anchors: string[] }>;
  unanchored: string[];
  coverage_gaps: Array<{ dir: string; files_count: number; examples: string[] }>;
  save_skeleton: {
    task: string;
    nodes: Array<{ id: string }>;
    stale: Array<{ id: string; reason: string }>;
  };
  marker_advanced: boolean;
  titles: Record<string, string>;
}

interface SyncSuccessEnvelope {
  ok: true;
  data: SyncData;
  warnings: string[];
}

interface StatusSuccessEnvelope {
  ok: true;
  data: {
    last_sync: { last_sync_commit: string | null; last_sync_at: string | null } | null;
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

describe("memory sync CLI", () => {
  it("runs in full-verification mode on the first sync and writes the marker", async () => {
    const repo = await createSyncRepo("memory-cli-sync-first-");
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const envelope = await syncJson(repo);

    expect(envelope.data.full_verification).toBe(true);
    expect(envelope.data.base_commit).toBeNull();
    expect(envelope.data.head_commit).toBe(head);
    expect(envelope.data.changed_files_count).toBe(0);
    expect(envelope.data.fresh).toContain("feature.sync-target");
    expect(envelope.data.changed).toEqual([]);
    expect(envelope.data.orphaned).toEqual([]);
    expect(envelope.data.unanchored).toEqual(["gotcha.local-quirk"]);
    expect(envelope.data.marker_advanced).toBe(true);

    const marker = JSON.parse(
      await readFile(join(repo, ".memory", "sync-state.json"), "utf8")
    ) as { version: number; last_sync_commit: string; last_sync_at: string };
    expect(marker.version).toBe(1);
    expect(marker.last_sync_commit).toBe(head);
    expect(marker.last_sync_at).toBeTruthy();
  });

  it("reports anchored nodes whose files changed, advances the marker, then settles fresh", async () => {
    const repo = await createSyncRepo("memory-cli-sync-changed-");
    await syncJson(repo);
    const baseHead = (await git(repo, ["rev-parse", "HEAD"])).trim();

    await writeFile(join(repo, "src", "feature.ts"), "export const changed = true;\n", "utf8");
    await commit(repo, "Change anchored file", ["src/feature.ts"]);
    const newHead = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const second = await syncJson(repo);
    expect(second.data.full_verification).toBe(false);
    expect(second.data.base_commit).toBe(baseHead);
    expect(second.data.changed).toEqual([
      {
        id: "feature.sync-target",
        anchors: ["src/feature.ts"],
        files: ["src/feature.ts"]
      }
    ]);
    expect(second.data.save_skeleton.nodes).toEqual([{ id: "feature.sync-target" }]);
    expect(second.data.save_skeleton.stale).toEqual([]);
    expect(second.data.marker_advanced).toBe(true);

    const marker = JSON.parse(
      await readFile(join(repo, ".memory", "sync-state.json"), "utf8")
    ) as { last_sync_commit: string };
    expect(marker.last_sync_commit).toBe(newHead);

    const third = await syncJson(repo);
    expect(third.data.base_commit).toBe(newHead);
    expect(third.data.changed_files_count).toBe(0);
    expect(third.data.changed).toEqual([]);
    expect(third.data.fresh).toContain("feature.sync-target");
  });

  it("reports orphaned anchors, pre-fills the stale skeleton, and surfaces staleness in the map", async () => {
    const repo = await createSyncRepo("memory-cli-sync-orphaned-");
    await syncJson(repo);

    await git(repo, ["rm", "src/feature.ts"]);
    await git(repo, ["commit", "-m", "Delete anchored file"]);

    const envelope = await syncJson(repo);
    expect(envelope.data.orphaned).toEqual([
      { id: "feature.sync-target", anchors: ["src/feature.ts"] }
    ]);
    expect(envelope.data.changed).toEqual([]);
    expect(envelope.data.save_skeleton.nodes).toEqual([]);
    expect(envelope.data.save_skeleton.stale).toEqual([
      { id: "feature.sync-target", reason: "" }
    ]);
    expect(envelope.data.titles["feature.sync-target"]).toBe("Sync target");

    const agents = await readFile(join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("**Stale:**");
    expect(agents).toContain("feature.sync-target — anchor src/feature.ts matches no files");
  });

  it("lists coverage gaps for changed files no anchor covers", async () => {
    const repo = await createSyncRepo("memory-cli-sync-gaps-");
    await syncJson(repo);

    await mkdir(join(repo, "notes"), { recursive: true });
    await writeFile(join(repo, "notes", "ideas.md"), "# Ideas\n", "utf8");
    await writeFile(join(repo, "notes", "todo.md"), "# Todo\n", "utf8");
    await commit(repo, "Add uncovered files", ["notes/ideas.md", "notes/todo.md"]);

    const envelope = await syncJson(repo);
    expect(envelope.data.changed).toEqual([]);
    expect(envelope.data.fresh).toContain("feature.sync-target");
    expect(envelope.data.coverage_gaps).toEqual([
      {
        dir: "notes",
        files_count: 2,
        examples: ["notes/ideas.md", "notes/todo.md"]
      }
    ]);
  });

  it("reports without advancing the marker or touching the map in dry-run mode", async () => {
    const repo = await createSyncRepo("memory-cli-sync-dry-run-");
    await syncJson(repo);

    await writeFile(join(repo, "src", "feature.ts"), "export const dirty = true;\n", "utf8");
    const markerBefore = await readFile(join(repo, ".memory", "sync-state.json"), "utf8");
    const agentsBefore = await readFile(join(repo, "AGENTS.md"), "utf8");

    const human = await runCli(["node", "memory", "sync", "--dry-run"], repo);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Anchors changed:");
    expect(human.stdout).toContain("- feature.sync-target — Sync target");
    expect(human.stdout).toContain("Agent prompt:");
    expect(human.stdout).toContain('"task":"sync reconciliation"');
    expect(human.stdout).toContain("Dry run: sync marker not advanced.");

    const dryJson = await runCli(["node", "memory", "sync", "--dry-run", "--json"], repo);
    expect(dryJson.exitCode).toBe(0);
    const envelope = JSON.parse(dryJson.stdout) as SyncSuccessEnvelope;
    expect(envelope.data.marker_advanced).toBe(false);
    expect(envelope.data.changed.map((node) => node.id)).toEqual(["feature.sync-target"]);

    expect(await readFile(join(repo, ".memory", "sync-state.json"), "utf8")).toBe(markerBefore);
    expect(await readFile(join(repo, "AGENTS.md"), "utf8")).toBe(agentsBefore);
  });

  it("re-reports uncommitted working-tree changes after the marker advances", async () => {
    const repo = await createSyncRepo("memory-cli-sync-working-tree-");
    await syncJson(repo);

    await writeFile(join(repo, "src", "feature.ts"), "export const dirty = true;\n", "utf8");

    const first = await syncJson(repo);
    expect(first.data.changed).toEqual([
      {
        id: "feature.sync-target",
        anchors: ["src/feature.ts"],
        files: ["src/feature.ts"]
      }
    ]);
    expect(first.data.marker_advanced).toBe(true);

    const second = await syncJson(repo);
    expect(second.data.changed.map((node) => node.id)).toEqual(["feature.sync-target"]);
  });

  it("falls back to full verification when the marker is invalid", async () => {
    const repo = await createSyncRepo("memory-cli-sync-invalid-marker-");
    await writeFile(join(repo, ".memory", "sync-state.json"), "not-json{{{", "utf8");

    const envelope = await syncJson(repo);
    expect(envelope.data.full_verification).toBe(true);
    expect(envelope.data.base_commit).toBeNull();
    expect(envelope.data.marker_advanced).toBe(true);

    const marker = JSON.parse(
      await readFile(join(repo, ".memory", "sync-state.json"), "utf8")
    ) as { version: number };
    expect(marker.version).toBe(1);
  });

  it("surfaces the recorded sync state through memory status", async () => {
    const repo = await createSyncRepo("memory-cli-sync-status-");
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await syncJson(repo);

    const statusJson = await runCli(["node", "memory", "status", "--json"], repo);
    expect(statusJson.exitCode).toBe(0);
    const envelope = JSON.parse(statusJson.stdout) as StatusSuccessEnvelope;
    expect(envelope.data.last_sync?.last_sync_commit).toBe(head);
    expect(envelope.data.last_sync?.last_sync_at).toBeTruthy();

    const statusHuman = await runCli(["node", "memory", "status"], repo);
    expect(statusHuman.exitCode).toBe(0);
    expect(statusHuman.stdout).toMatch(/Last sync: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(statusHuman.stdout).not.toContain("Last sync: never");
  });
});

async function syncJson(repo: string): Promise<SyncSuccessEnvelope> {
  const output = await runCli(["node", "memory", "sync", "--json"], repo);

  expect(output.exitCode).toBe(0);
  expect(output.stderr).toBe("");

  const envelope = JSON.parse(output.stdout) as SyncSuccessEnvelope;

  expect(envelope.ok).toBe(true);
  return envelope;
}

/**
 * Initialized Git repo with one anchored feature (src/feature.ts), one
 * unanchored gotcha, and everything committed so the working tree is clean.
 */
async function createSyncRepo(prefix: string): Promise<string> {
  const repo = await createTempRoot(prefix);

  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Memory Test"]);
  await writeFile(join(repo, "README.md"), "# Test\n", "utf8");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "feature.ts"), "export const feature = true;\n", "utf8");
  await commit(repo, "Initial commit", ["README.md", "src/feature.ts"]);

  expect((await runCli(["node", "memory", "init", "--json"], repo)).exitCode).toBe(0);
  await saveCli(repo, {
    task: "sync test graph",
    nodes: [
      {
        kind: "feature",
        title: "Sync target",
        body: "# Sync target\n\nAnchored to the feature source file.\n",
        stage: "building",
        anchors: ["src/feature.ts"]
      },
      {
        kind: "gotcha",
        title: "Local quirk",
        body: "# Local quirk\n\nUnanchored on purpose.\n"
      }
    ]
  });
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "Memory baseline"]);

  return repo;
}

async function saveCli(cwd: string, input: unknown): Promise<void> {
  const output = await runCli(
    ["node", "memory", "save", "--stdin", "--json"],
    cwd,
    JSON.stringify(input)
  );

  expect(output.exitCode).toBe(0);
}

async function commit(cwd: string, message: string, paths: string[]): Promise<void> {
  await git(cwd, ["add", ...paths]);
  await git(cwd, ["commit", "-m", message]);
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
