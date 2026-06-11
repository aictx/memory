import { resolve } from "node:path";

import { CommanderError, type Command } from "commander";

import { memoryError } from "../../core/errors.js";
import type { MemoryMeta } from "../../core/types.js";
import { renderAppResult } from "../render.js";
import { CLI_EXIT_SUCCESS, type CliExitCode } from "../exit.js";

type CliOutputWriter = (text: string) => void;

export interface RegisterUpgradeCommandOptions {
  cwd: string;
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
}

const UPGRADE_REMOVED_MESSAGE =
  "Memory storage upgrades are not supported by this release. Run `memory reset` then `memory init` to re-index with the current schema.";

export function registerUpgradeCommand(
  program: Command,
  options: RegisterUpgradeCommandOptions
): void {
  program
    .command("upgrade")
    .description("Removed. Run `memory reset` then `memory init` to re-index storage.")
    .action(async (_commandOptions: unknown, command: Command) => {
      const rendered = renderAppResult<never>(
        {
          ok: false,
          error: memoryError("MemoryUnsupportedStorageVersion", UPGRADE_REMOVED_MESSAGE),
          warnings: [],
          meta: fallbackMeta(options.cwd)
        },
        {
          json: isJsonMode(command),
          renderData: () => ""
        }
      );

      options.stdout(rendered.stdout);
      options.stderr(rendered.stderr);

      if (rendered.exitCode !== CLI_EXIT_SUCCESS) {
        throwCommandFailed(rendered.exitCode);
      }
    });
}

function fallbackMeta(cwd: string): MemoryMeta {
  const projectRoot = resolve(cwd);

  return {
    project_root: projectRoot,
    memory_root: resolve(projectRoot, ".memory"),
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
