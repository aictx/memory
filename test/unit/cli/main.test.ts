import { describe, expect, it } from "vitest";

import { createCliProgram, main, type CliOutputWriter } from "../../../src/cli/main.js";
import { version } from "../../../src/generated/version.js";

describe("CLI main", () => {
  it("creates the base Commander program", () => {
    const program = createCliProgram();

    expect(program.name()).toBe("memory");
    expect(program.description()).toBe("Local project memory CLI");
    expect(program.version()).toBe(version);
    expect(program.helpInformation()).toContain("--json");
  });

  it("documents workflow and how-to memory in remember help", () => {
    const program = createCliProgram();
    const remember = program.commands.find((command) => command.name() === "remember");

    expect(remember?.description()).toContain("workflows/how-tos");
  });

  it("registers only the surviving commands", () => {
    const program = createCliProgram();

    expect(program.commands.map((command) => command.name()).sort()).toEqual([
      "check",
      "diff",
      "docs",
      "init",
      "inspect",
      "projects",
      "rebuild",
      "remember",
      "reset",
      "save",
      "search",
      "upgrade",
      "view"
    ]);
  });

  it("returns exit 2 for unknown options", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "--does-not-exist"], output.writers);

    expect(exitCode).toBe(2);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("error:");
  });

  it("returns exit 2 for unexpected command arguments", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "unknown"], output.writers);

    expect(exitCode).toBe(2);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("error:");
  });

  it("returns exit 0 for help and version output", async () => {
    const helpOutput = createCapturedOutput();
    const versionOutput = createCapturedOutput();

    await expect(main(["node", "memory", "--help"], helpOutput.writers)).resolves.toBe(0);
    await expect(main(["node", "memory", "--version"], versionOutput.writers)).resolves.toBe(0);
    expect(helpOutput.stdout()).toContain("--json");
    expect(versionOutput.stdout()).toBe(`${version}\n`);
    expect(helpOutput.stderr()).toBe("");
    expect(versionOutput.stderr()).toBe("");
  });

  it("keeps JSON usage errors out of stdout", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "--json", "--does-not-exist"], output.writers);

    expect(exitCode).toBe(2);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("error:");
  });
});

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
