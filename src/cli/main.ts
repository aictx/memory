#!/usr/bin/env node

import { realpathSync } from "node:fs";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { version } from "../generated/version.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerDiffCommand } from "./commands/diff.js";
import {
  registerDocsCommand,
  type DocsUrlOpener
} from "./commands/docs.js";
import { registerInitCommand } from "./commands/init.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerProjectsCommand } from "./commands/projects.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerRebuildCommand } from "./commands/rebuild.js";
import { registerResetCommand } from "./commands/reset.js";
import { registerSaveCommand } from "./commands/save.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUpgradeCommand } from "./commands/upgrade.js";
import {
  registerViewCommand,
  type ViewerDetacher,
  type ViewerUrlOpener
} from "./commands/view.js";
import {
  CLI_EXIT_SUCCESS,
  CLI_EXIT_USAGE,
  type CliExitCode
} from "./exit.js";
import { registerCurrentProject } from "../app/operations.js";

export type CliOutputWriter = (text: string) => void;

export interface CliMainOptions {
  stdout?: CliOutputWriter;
  stderr?: CliOutputWriter;
  stdin?: Readable;
  cwd?: string;
  viewer?: {
    assetsDir?: string;
    opener?: ViewerUrlOpener;
    detacher?: ViewerDetacher;
    shutdownSignal?: AbortSignal;
  };
  docs?: {
    docsDir?: string;
    baseUrl?: string;
    opener?: DocsUrlOpener;
  };
  registry?: {
    enabled?: boolean;
    memoryHome?: string;
  };
}

export function createCliProgram(options: CliMainOptions = {}): Command {
  const program = new Command();
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.stderr ?? ((text: string) => process.stderr.write(text));

  program
    .name("memory")
    .description("Local project memory CLI")
    .configureOutput({
      writeOut,
      writeErr
    })
    .exitOverride((error) => {
      throw error;
    })
    .version(version)
    .option("--json", "Render output as JSON.")
    .action(() => {
      program.outputHelp();
    });

  registerInitCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr,
    ...(options.viewer?.detacher === undefined ? {} : { detacher: options.viewer.detacher })
  });
  registerStatusCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr,
    ...(options.registry?.memoryHome === undefined
      ? {}
      : { memoryHome: options.registry.memoryHome })
  });
  registerCheckCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr
  });
  registerRebuildCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr
  });
  registerQueryCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr
  });
  registerInspectCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr
  });
  registerProjectsCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr,
    ...(options.registry?.memoryHome === undefined
      ? {}
      : { memoryHome: options.registry.memoryHome })
  });
  registerUpgradeCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr
  });
  registerDocsCommand(program, {
    stdout: writeOut,
    stderr: writeErr,
    ...(options.docs?.docsDir === undefined ? {} : { docsDir: options.docs.docsDir }),
    ...(options.docs?.baseUrl === undefined ? {} : { baseUrl: options.docs.baseUrl }),
    ...(options.docs?.opener === undefined ? {} : { opener: options.docs.opener })
  });
  registerViewCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr,
    ...(options.registry?.memoryHome === undefined
      ? {}
      : { memoryHome: options.registry.memoryHome }),
    ...(options.viewer?.assetsDir === undefined
      ? {}
      : { assetsDir: options.viewer.assetsDir }),
    ...(options.viewer?.opener === undefined ? {} : { opener: options.viewer.opener }),
    ...(options.viewer?.detacher === undefined ? {} : { detacher: options.viewer.detacher }),
    ...(options.viewer?.shutdownSignal === undefined
      ? {}
      : { shutdownSignal: options.viewer.shutdownSignal })
  });
  registerDiffCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr
  });
  registerResetCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdout: writeOut,
    stderr: writeErr,
    registryEnabled: registryAutoRegistrationEnabled(options),
    ...(options.registry?.memoryHome === undefined
      ? {}
      : { memoryHome: options.registry.memoryHome })
  });
  registerSaveCommand(program, {
    cwd: options.cwd ?? process.cwd(),
    stdin: options.stdin ?? process.stdin,
    stdout: writeOut,
    stderr: writeErr
  });
  installProjectRegistryHook(program, {
    cwd: options.cwd ?? process.cwd(),
    stderr: writeErr,
    enabled: registryAutoRegistrationEnabled(options),
    ...(options.registry?.memoryHome === undefined
      ? {}
      : { memoryHome: options.registry.memoryHome })
  });

  return program;
}

export async function main(
  argv = process.argv,
  options: CliMainOptions = {}
): Promise<CliExitCode> {
  try {
    await createCliProgram(options).parseAsync(argv);
    return CLI_EXIT_SUCCESS;
  } catch (error) {
    if (error instanceof CommanderError) {
      return exitCodeForCommanderError(error);
    }

    throw error;
  }
}

function exitCodeForCommanderError(error: CommanderError): CliExitCode {
  if (error.exitCode === CLI_EXIT_SUCCESS) {
    return CLI_EXIT_SUCCESS;
  }

  if (error.code === "memory.command.failed" && isCliExitCode(error.exitCode)) {
    return error.exitCode;
  }

  return CLI_EXIT_USAGE;
}

function isCliExitCode(exitCode: number): exitCode is CliExitCode {
  return exitCode === 0 || exitCode === 1 || exitCode === 2 || exitCode === 3;
}

interface ProjectRegistryHookOptions {
  cwd: string;
  stderr: CliOutputWriter;
  enabled: boolean;
  memoryHome?: string;
}

function installProjectRegistryHook(
  program: Command,
  options: ProjectRegistryHookOptions
): void {
  if (!options.enabled) {
    return;
  }

  program.hook("postAction", async (_thisCommand, actionCommand) => {
    if (!shouldAutoRegisterProject(actionCommand)) {
      return;
    }

    const registered = await registerCurrentProject({
      cwd: options.cwd,
      ...(options.memoryHome === undefined ? {} : { memoryHome: options.memoryHome })
    });

    if (!registered.ok && registered.error.code !== "MemoryNotInitialized") {
      options.stderr(`warning: Project registry was not updated: ${registered.error.message}\n`);
    }
  });
}

function shouldAutoRegisterProject(command: Command): boolean {
  const path = commandPath(command);

  return AUTO_REGISTER_COMMANDS.has(path);
}

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;

  while (current !== null && current.name() !== "memory") {
    names.unshift(current.name());
    current = current.parent ?? null;
  }

  return names.join(" ");
}

const AUTO_REGISTER_COMMANDS = new Set([
  "init",
  "status",
  "check",
  "rebuild",
  "query",
  "inspect",
  "diff",
  "save",
  "upgrade"
]);

function registryAutoRegistrationEnabled(options: CliMainOptions): boolean {
  if (options.registry?.enabled !== undefined) {
    return options.registry.enabled;
  }

  return process.env.VITEST !== "true";
}

if (isEntrypoint()) {
  process.exitCode = await main();
}

function isEntrypoint(): boolean {
  const argvPath = process.argv[1];

  if (argvPath === undefined) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return fileURLToPath(import.meta.url) === argvPath;
  }
}
