import { CommanderError, type Command } from "commander";

import {
  getAllProjectsStatus,
  type AllProjectsStatusData,
  type AppResult,
  type ProjectStatusRow,
  type StatusData
} from "../../app/operations.js";
import { FEATURE_STAGES, type FeatureStage } from "../../core/types.js";
import {
  dataAccessService,
  type DataAccessStatusInput
} from "../../data-access/index.js";
import { CLI_EXIT_SUCCESS, type CliExitCode } from "../exit.js";
import { renderAppResult } from "../render.js";

type CliOutputWriter = (text: string) => void;

export interface RegisterStatusCommandOptions {
  cwd: string;
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
  memoryHome?: string;
}

interface StatusCommandFlags {
  all?: boolean;
}

/** Stage order used by the human rendering, most active work first. */
const STATUS_STAGE_ORDER: readonly FeatureStage[] = [
  "building",
  "shipped",
  "idea",
  "paused",
  "dead"
];

export function registerStatusCommand(
  program: Command,
  options: RegisterStatusCommandOptions
): void {
  program
    .command("status")
    .description(
      "Summarize the product graph: features by stage, open questions, stale anchors, last activity, and last sync."
    )
    .option("--all", "Summarize every registered Memory project.")
    .action(async (flags: StatusCommandFlags, command: Command) => {
      const json = isJsonMode(command);
      const rendered = flags.all === true
        ? renderAppResult(await getAllProjectsStatus(allStatusOptions(options)), {
            json,
            renderData: renderAllProjectsStatusData
          })
        : renderAppResult(await dataAccessService.status(statusInput(options)), {
            json,
            renderData: renderStatusData
          });

      options.stdout(rendered.stdout);
      options.stderr(rendered.stderr);

      if (rendered.exitCode !== CLI_EXIT_SUCCESS) {
        throwCommandFailed(rendered.exitCode);
      }
    });
}

function statusInput(options: RegisterStatusCommandOptions): DataAccessStatusInput {
  return {
    target: {
      kind: "cwd",
      cwd: options.cwd
    }
  };
}

function allStatusOptions(options: RegisterStatusCommandOptions): {
  cwd: string;
  memoryHome?: string;
} {
  return {
    cwd: options.cwd,
    ...(options.memoryHome === undefined ? {} : { memoryHome: options.memoryHome })
  };
}

function renderStatusData(data: StatusData): string {
  const lines = [
    `${data.project.name} — product graph status`,
    `Features: ${STATUS_STAGE_ORDER.map(
      (stage) => `${stage} ${data.features_by_stage[stage].count}`
    ).join(" · ")}`
  ];

  for (const stage of STATUS_STAGE_ORDER) {
    const summary = data.features_by_stage[stage];

    if (summary.count > 0) {
      lines.push(`  ${stage}: ${summary.titles.join(", ")}`);
    }
  }

  lines.push(
    data.open_questions.length === 0
      ? "Open questions: none"
      : `Open questions (${data.open_questions.length}): ${data.open_questions
          .map((question) => question.title)
          .join(", ")}`
  );
  lines.push(
    data.stale.length === 0
      ? "Stale anchors: none"
      : `Stale anchors (${data.stale.length}): ${data.stale
          .map((entry) => `${entry.id} — ${entry.orphaned_anchors.join(", ")} matches no files`)
          .join("; ")}`
  );
  lines.push(
    `Last activity: ${formatTimestamp(data.last_activity)} · Last sync: ${formatSync(data)}`
  );

  return lines.join("\n");
}

function renderAllProjectsStatusData(data: AllProjectsStatusData): string {
  if (data.projects.length === 0) {
    return "No registered Memory projects.";
  }

  return data.projects.map(renderProjectStatusRow).join("\n");
}

function renderProjectStatusRow(row: ProjectStatusRow): string {
  if (row.needs_reset || row.features_by_stage === null) {
    const version = row.storage_version === null
      ? "storage unreadable"
      : `storage v${row.storage_version}`;

    return `${row.project.name} — needs \`memory reset && memory init\` (${version})`;
  }

  const counts = (["idea", "building", "shipped"] as const)
    .map((stage) => `${stage} ${row.features_by_stage?.[stage].count ?? 0}`)
    .join(" · ");

  return [
    `${row.project.name} — ${counts}`,
    `questions ${row.open_questions?.length ?? 0}`,
    `stale ${row.stale?.length ?? 0}`,
    `last activity ${formatTimestamp(row.last_activity)}`,
    `last sync ${formatSyncState(row.last_sync)}`
  ].join(" · ");
}

function formatSync(data: StatusData): string {
  return formatSyncState(data.last_sync);
}

function formatSyncState(
  lastSync: { last_sync_at: string | null } | null
): string {
  if (lastSync === null || lastSync.last_sync_at === null) {
    return "never";
  }

  return formatTimestamp(lastSync.last_sync_at);
}

function formatTimestamp(timestamp: string | null): string {
  if (timestamp === null) {
    return "never";
  }

  return timestamp.slice(0, 16).replace("T", " ");
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
