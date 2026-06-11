import { CommanderError, type Command } from "commander";

import {
  syncMemory,
  type SyncMemoryData,
  type SyncMemoryOptions
} from "../../app/operations.js";
import { CLI_EXIT_SUCCESS } from "../exit.js";
import { renderAppResult } from "../render.js";

type CliOutputWriter = (text: string) => void;

const UNANCHORED_DISPLAY_CAP = 10;
const SHORT_COMMIT_LENGTH = 7;

export interface RegisterSyncCommandOptions {
  cwd: string;
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
}

interface SyncCommandFlags {
  dryRun?: boolean;
}

export function registerSyncCommand(
  program: Command,
  options: RegisterSyncCommandOptions
): void {
  program
    .command("sync")
    .description(
      "Run the diff-driven staleness pass: report nodes whose anchors changed or died since the last sync, list coverage gaps, refresh the product map, and advance the sync marker."
    )
    .option("--dry-run", "Report without advancing the sync marker or refreshing the map.")
    .action(async (flags: SyncCommandFlags, command: Command) => {
      const result = await syncMemory(syncMemoryOptions(options, flags));
      const rendered = renderAppResult(result, {
        json: isJsonMode(command),
        renderData: renderSyncData
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

function syncMemoryOptions(
  options: RegisterSyncCommandOptions,
  flags: SyncCommandFlags
): SyncMemoryOptions {
  return {
    cwd: options.cwd,
    dryRun: flags.dryRun === true
  };
}

function renderSyncData(data: SyncMemoryData): string {
  const lines = [renderSummaryLine(data)];

  if (data.changed.length > 0) {
    lines.push("", "Anchors changed:");

    for (const node of data.changed) {
      lines.push(
        `- ${node.id} — ${titleOf(data, node.id)} — anchors: ${node.anchors.join(", ")} — files: ${node.files.join(", ")}`
      );
    }
  }

  if (data.orphaned.length > 0) {
    lines.push("", "Anchors orphaned:");

    for (const node of data.orphaned) {
      for (const anchor of node.anchors) {
        lines.push(`- ${node.id} — ${anchor}`);
      }
    }
  }

  if (data.coverage_gaps.length > 0) {
    lines.push("", "Coverage gaps:");

    for (const gap of data.coverage_gaps) {
      const count = gap.files_count === 1 ? "1 file" : `${gap.files_count} files`;

      lines.push(`- ${gap.dir} — ${count} — e.g. ${gap.examples.join(", ")}`);
    }
  }

  if (data.unanchored.length > 0) {
    lines.push("", "Unanchored nodes:");

    for (const id of data.unanchored.slice(0, UNANCHORED_DISPLAY_CAP)) {
      lines.push(`- ${id} — ${titleOf(data, id)}`);
    }

    if (data.unanchored.length > UNANCHORED_DISPLAY_CAP) {
      lines.push(`… and ${data.unanchored.length - UNANCHORED_DISPLAY_CAP} more`);
    }
  }

  if (data.save_skeleton.nodes.length > 0 || data.save_skeleton.stale.length > 0) {
    lines.push("", "Agent prompt:", ...renderAgentPrompt(data));
  }

  lines.push(
    "",
    data.marker_advanced
      ? `Sync marker advanced to ${shortCommit(data.head_commit)}.`
      : "Dry run: sync marker not advanced."
  );

  return lines.join("\n");
}

function renderSummaryLine(data: SyncMemoryData): string {
  const verdictCounts = `${data.fresh.length} nodes fresh, ${data.changed.length} changed, ${data.orphaned.length} orphaned`;

  if (data.full_verification || data.base_commit === null) {
    return `Sync: full verification (no usable sync marker) — ${verdictCounts}`;
  }

  const fileCount =
    data.changed_files_count === 1 ? "1 changed file" : `${data.changed_files_count} changed files`;

  return `Sync: ${fileCount} since ${shortCommit(data.base_commit)} — ${verdictCounts}`;
}

function renderAgentPrompt(data: SyncMemoryData): string[] {
  const scope =
    data.full_verification || data.base_commit === null
      ? "the current repository state"
      : `the code changes since ${shortCommit(data.base_commit)} (plus the working tree)`;

  return [
    "```",
    `Re-verify the memory nodes listed below against ${scope}. Update bodies and stages where behavior moved, fix or replace dead anchors, and mark nodes that no longer hold stale — all in ONE \`memory save --stdin\` call using this skeleton:`,
    "",
    JSON.stringify(data.save_skeleton),
    "```"
  ];
}

function titleOf(data: SyncMemoryData, id: string): string {
  return data.titles[id] ?? id;
}

function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

function isJsonMode(command: Command): boolean {
  const options = command.optsWithGlobals() as { json?: unknown };
  return options.json === true;
}
