import { CommanderError, type Command } from "commander";

import {
  dataAccessService,
  type DataAccessSearchInput
} from "../../data-access/index.js";
import type { SearchMemoryData, SearchResult } from "../../index/search.js";
import { CLI_EXIT_SUCCESS } from "../exit.js";
import { renderAppResult } from "../render.js";

type CliOutputWriter = (text: string) => void;

export interface RegisterSearchCommandOptions {
  cwd: string;
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
}

interface SearchCommandFlags {
  limit?: string;
}

export function registerSearchCommand(
  program: Command,
  options: RegisterSearchCommandOptions
): void {
  program
    .command("search")
    .description("Search local Memory using the generated SQLite index.")
    .argument("<query>", "Search query.")
    .option("--limit <number>", "Maximum number of matches to return.")
    .action(async (query: string, commandOptions: SearchCommandFlags, command: Command) => {
      const result = await dataAccessService.search(
        searchMemoryOptions(options, query, commandOptions)
      );
      const rendered = renderAppResult(result, {
        json: isJsonMode(command),
        renderData: renderSearchData
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

function searchMemoryOptions(
  options: RegisterSearchCommandOptions,
  query: string,
  flags: SearchCommandFlags
): DataAccessSearchInput {
  return {
    target: {
      kind: "cwd",
      cwd: options.cwd
    },
    query,
    ...(flags.limit === undefined ? {} : { limit: Number(flags.limit) })
  };
}

function isJsonMode(command: Command): boolean {
  const options = command.optsWithGlobals() as { json?: unknown };
  return options.json === true;
}

function renderSearchData(data: SearchMemoryData): string {
  if (data.matches.length === 0) {
    return "No matching Memory.";
  }

  return data.matches.map(renderSearchResult).join("\n\n");
}

function renderSearchResult(result: SearchResult, index: number): string {
  return [
    `${index + 1}. ${result.id} (${result.type}, ${result.status}, score ${formatScore(result.score)})`,
    `   Title: ${result.title}`,
    `   Path: ${result.body_path}`,
    `   Snippet: ${result.snippet}`
  ].join("\n");
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}
