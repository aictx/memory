import { CommanderError, type Command } from "commander";

import {
  dataAccessService,
  type DataAccessQueryInput,
  type QueryMemoryData
} from "../../data-access/index.js";
import { CLI_EXIT_SUCCESS } from "../exit.js";
import { renderAppResult } from "../render.js";

type CliOutputWriter = (text: string) => void;

export interface RegisterQueryCommandOptions {
  cwd: string;
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
}

interface QueryCommandFlags {
  budget?: string;
}

export function registerQueryCommand(
  program: Command,
  options: RegisterQueryCommandOptions
): void {
  program
    .command("query")
    .description("Query local Memory and print a token-budgeted subgraph of matching memory.")
    .argument("<question>", "Question to answer from project memory.")
    .option("--budget <number>", "Token budget for the rendered result.")
    .action(async (question: string, commandOptions: QueryCommandFlags, command: Command) => {
      const result = await dataAccessService.query(
        queryMemoryInput(options, question, commandOptions)
      );
      const rendered = renderAppResult(result, {
        json: isJsonMode(command),
        renderData: renderQueryData
      });

      options.stdout(rendered.stdout);
      options.stderr(rendered.stderr);

      if (rendered.exitCode !== CLI_EXIT_SUCCESS) {
        throw new CommanderError(
          rendered.exitCode,
          "memory.command.failed",
          "Memory command failed."
        );
      }
    });
}

function queryMemoryInput(
  options: RegisterQueryCommandOptions,
  question: string,
  flags: QueryCommandFlags
): DataAccessQueryInput {
  return {
    target: {
      kind: "cwd",
      cwd: options.cwd
    },
    question,
    ...(flags.budget === undefined ? {} : { budget: Number(flags.budget) })
  };
}

function isJsonMode(command: Command): boolean {
  const options = command.optsWithGlobals() as { json?: unknown };
  return options.json === true;
}

function renderQueryData(data: QueryMemoryData): string {
  return data.markdown;
}
