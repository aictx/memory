import type { Readable } from "node:stream";

import { CommanderError, type Command } from "commander";

import {
  type AppResult,
  dataAccessService,
  type DataAccessSaveInput,
  type SaveMemoryData
} from "../../data-access/index.js";
import { memoryError, type MemoryError } from "../../core/errors.js";
import type { MemoryMeta } from "../../core/types.js";
import { err, ok, type Result } from "../../core/result.js";
import {
  CLI_EXIT_SUCCESS,
  type CliExitCode
} from "../exit.js";
import { renderAppResult } from "../render.js";

type CliOutputWriter = (text: string) => void;

export interface RegisterSaveCommandOptions {
  cwd: string;
  stdin: Readable;
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
}

interface SaveCommandFlags {
  stdin?: boolean;
  dryRun?: boolean;
}

export function registerSaveCommand(
  program: Command,
  options: RegisterSaveCommandOptions
): void {
  program
    .command("save")
    .description(
      "Save product memory from intent-first input: create or update feature/decision/gotcha/question nodes, mark stale, supersede, or delete."
    )
    .option("--stdin", "Read the save input from stdin.")
    .option("--dry-run", "Validate and plan the generated patch without writing memory.")
    .action(async (commandOptions: SaveCommandFlags, command: Command) => {
      if (commandOptions.stdin !== true) {
        command.error("error: --stdin is required", {
          code: "commander.invalidArgument",
          exitCode: 2
        });
      }

      const input = await readSaveInput(options.stdin);

      if (!input.ok) {
        renderAndThrowOnFailure(inputErrorResult(input.error, options.cwd), options, command);
        return;
      }

      const parsed = parseSaveJson(input.data);

      if (!parsed.ok) {
        renderAndThrowOnFailure(inputErrorResult(parsed.error, options.cwd), options, command);
        return;
      }

      const result = await dataAccessService.save(
        saveMemoryOptions(options, parsed.data, commandOptions)
      );

      renderAndThrowOnFailure(result, options, command);
    });
}

function saveMemoryOptions(
  options: RegisterSaveCommandOptions,
  input: unknown,
  flags: SaveCommandFlags
): DataAccessSaveInput {
  return {
    target: {
      kind: "cwd",
      cwd: options.cwd
    },
    input,
    dryRun: flags.dryRun === true
  };
}

async function readSaveInput(stdin: Readable): Promise<Result<string>> {
  let contents = "";

  try {
    for await (const chunk of stdin) {
      contents += chunkToString(chunk);
    }
  } catch (error) {
    return err(
      memoryError("MemoryValidationFailed", "Save input could not be read from stdin.", {
        message: messageFromUnknown(error)
      })
    );
  }

  return ok(contents);
}

function parseSaveJson(contents: string): Result<unknown> {
  try {
    return ok(JSON.parse(contents) as unknown);
  } catch (error) {
    return err(
      memoryError("MemoryInvalidJson", "Save input contains invalid JSON.", {
        source: "stdin",
        message: messageFromUnknown(error)
      })
    );
  }
}

function renderAndThrowOnFailure(
  result: AppResult<SaveMemoryData>,
  options: RegisterSaveCommandOptions,
  command: Command
): void {
  const rendered = renderAppResult(result, {
    json: isJsonMode(command),
    renderData: renderSaveData
  });

  options.stdout(rendered.stdout);
  options.stderr(rendered.stderr);

  if (rendered.exitCode !== CLI_EXIT_SUCCESS) {
    throwCommandFailed(rendered.exitCode);
  }
}

function inputErrorResult(error: MemoryError, cwd: string): AppResult<SaveMemoryData> {
  return {
    ok: false,
    error,
    warnings: [],
    meta: fallbackMeta(cwd)
  };
}

function fallbackMeta(cwd: string): MemoryMeta {
  return {
    project_root: cwd,
    memory_root: `${cwd}/.memory`,
    git: {
      available: false,
      branch: null,
      commit: null,
      dirty: null
    }
  };
}

function renderSaveData(data: SaveMemoryData): string {
  return [
    data.dry_run ? "Planned Memory save input." : "Saved Memory save input.",
    ...renderList("Files changed", data.files_changed),
    ...renderList("Memory created", data.memory_created),
    ...renderList("Memory updated", data.memory_updated),
    ...renderList("Memory deleted", data.memory_deleted),
    ...renderList("Relations created", data.relations_created),
    ...renderList("Relations updated", data.relations_updated),
    ...renderList("Relations deleted", data.relations_deleted),
    `Events appended: ${data.events_appended}`,
    `Index ${data.index_updated ? "updated" : "not updated"}.`
  ].join("\n");
}

function renderList(label: string, values: readonly string[]): string[] {
  if (values.length === 0) {
    return [];
  }

  return [`${label}:`, ...values.map((value) => `- ${value}`)];
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

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf8");
  }

  return String(chunk);
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
