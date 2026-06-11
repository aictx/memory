import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";

const legacyFixtureRoot = join(
  process.cwd(),
  "test",
  "fixtures",
  "golden-storage",
  "legacy-v4"
);
const tempRoots: string[] = [];

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("storage version gate", () => {
  it.each([
    ["inspect", ["node", "memory", "inspect", "project.legacy-v4", "--json"]],
    ["query", ["node", "memory", "query", "legacy", "--json"]],
    ["check", ["node", "memory", "check", "--json"]],
    ["rebuild", ["node", "memory", "rebuild", "--json"]]
  ] as const)(
    "rejects v4 storage from %s with MemoryUnsupportedStorageVersion",
    async (_name, argv) => {
      const projectRoot = await createLegacyProject();

      const output = await runCli([...argv], projectRoot);

      expect(output.exitCode).not.toBe(0);
      const envelope = JSON.parse(output.stdout) as ErrorEnvelope;

      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("MemoryUnsupportedStorageVersion");
      expect(envelope.error.message).toContain("storage version 4 is not supported");
      expect(envelope.error.message).toContain("memory reset");
      expect(envelope.error.message).toContain("memory init");
    }
  );

  it("rejects v4 storage from save with MemoryUnsupportedStorageVersion", async () => {
    const projectRoot = await createLegacyProject();
    const { Readable } = await import("node:stream");

    const output = createCapturedOutput();
    const exitCode = await main(["node", "memory", "save", "--stdin", "--json"], {
      ...output.writers,
      cwd: projectRoot,
      stdin: Readable.from([
        JSON.stringify({
          task: "Attempt write on legacy storage",
          nodes: [{ kind: "gotcha", title: "Blocked", body: "Should not be written." }]
        })
      ])
    });

    expect(exitCode).not.toBe(0);
    const envelope = JSON.parse(output.stdout()) as ErrorEnvelope;

    expect(envelope.error.code).toBe("MemoryUnsupportedStorageVersion");
    expect(envelope.error.message).toContain("memory reset");
  });

  it("always fails memory upgrade with the reset and re-init guidance", async () => {
    for (const projectRoot of [await createLegacyProject(), await createTempRoot("memory-upgrade-empty-")]) {
      const output = await runCli(["node", "memory", "upgrade", "--json"], projectRoot);

      expect(output.exitCode).not.toBe(0);
      const envelope = JSON.parse(output.stdout) as ErrorEnvelope;

      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("MemoryUnsupportedStorageVersion");
      expect(envelope.error.message).toContain("memory reset");
      expect(envelope.error.message).toContain("memory init");
    }
  });
});

async function createLegacyProject(): Promise<string> {
  const projectRoot = await createTempRoot("memory-legacy-v4-");

  await cp(join(legacyFixtureRoot, ".memory"), join(projectRoot, ".memory"), {
    recursive: true
  });

  return projectRoot;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function runCli(argv: string[], cwd: string): Promise<CliRunResult> {
  const output = createCapturedOutput();
  const exitCode = await main(argv, {
    ...output.writers,
    cwd
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
