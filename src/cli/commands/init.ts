import { CommanderError, type Command } from "commander";

import {
  initProject,
  type AppResult,
  type InitProjectData,
  type InitProjectOptions
} from "../../app/operations.js";
import type { MemoryMeta } from "../../core/types.js";
import { buildIndexingBrief } from "../../init/brief.js";
import { CLI_EXIT_SUCCESS } from "../exit.js";
import { renderAppResult } from "../render.js";
import { maybeStartViewer, type ViewerDetacher } from "./view.js";

type CliOutputWriter = (text: string) => void;

export interface RegisterInitCommandOptions {
  cwd: string;
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
  detacher?: ViewerDetacher;
}

export function registerInitCommand(
  program: Command,
  options: RegisterInitCommandOptions
): void {
  program
    .command("init")
    .description("Initialize Memory storage in this project and print the indexing brief.")
    .option("--no-agent-guidance", "Skip AGENTS.md and CLAUDE.md setup.")
    .option("--force", "Discard existing Memory storage and initialize from scratch.")
    .option("--dry-run", "Preview what init would create or change without writing anything.")
    .option("--no-view", "Skip local viewer startup after init.")
    .option("--brief", "Print only the indexing brief and touch nothing.")
    .action(async (commandOptions: InitCommandOptions, command: Command) => {
      const json = isJsonMode(command);

      if (commandOptions.brief === true) {
        renderBriefOnly(options, json);
        return;
      }

      const result = await initProject(initProjectOptions(options, commandOptions));
      const viewer = await startViewerAfterInit(result, commandOptions, options, json);
      const rendered = renderAppResult(withViewerWarnings(result, viewer.warnings), {
        json,
        renderData: (data: InitProjectData) => renderInitData(data, viewer.url, json)
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

interface InitCommandOptions {
  agentGuidance?: boolean;
  force?: boolean;
  dryRun?: boolean;
  view?: boolean;
  brief?: boolean;
}

interface ViewerStartResult {
  url: string | null;
  warnings: string[];
}

function initProjectOptions(
  options: RegisterInitCommandOptions,
  commandOptions: InitCommandOptions
): InitProjectOptions {
  return {
    cwd: options.cwd,
    agentGuidance: commandOptions.agentGuidance !== false,
    force: commandOptions.force === true,
    dryRun: commandOptions.dryRun === true
  };
}

function renderBriefOnly(options: RegisterInitCommandOptions, json: boolean): void {
  const brief = buildIndexingBrief();
  const result: AppResult<{ brief: string }> = {
    ok: true,
    data: { brief },
    warnings: [],
    meta: fallbackMeta(options.cwd)
  };
  const rendered = renderAppResult(result, {
    json,
    renderData: (data) => data.brief
  });

  options.stdout(rendered.stdout);
  options.stderr(rendered.stderr);
}

/**
 * Starts the detached viewer after a successful real init. Default ON for
 * human output, OFF for JSON output, always suppressed by `--no-view`,
 * dry runs, and test runs (VITEST) without an injected detacher so suites
 * never spawn real background processes.
 */
async function startViewerAfterInit(
  result: AppResult<InitProjectData>,
  commandOptions: InitCommandOptions,
  options: RegisterInitCommandOptions,
  json: boolean
): Promise<ViewerStartResult> {
  if (
    !result.ok ||
    result.data.dry_run ||
    !viewerAutostartAllowed(options.detacher)
  ) {
    return { url: null, warnings: [] };
  }

  const viewer = await maybeStartViewer(
    options.cwd,
    commandOptions.view === false ? { view: false } : {},
    options.detacher,
    { json }
  );

  if (!viewer.ok) {
    return {
      url: null,
      warnings: [`Viewer autostart failed: ${viewer.error.message}`]
    };
  }

  return {
    url: viewer.data === null ? null : viewer.data.url,
    warnings: viewer.warnings
  };
}

function viewerAutostartAllowed(detacher: ViewerDetacher | undefined): boolean {
  return detacher !== undefined || process.env.VITEST !== "true";
}

function withViewerWarnings<T>(
  result: AppResult<T>,
  viewerWarnings: string[]
): AppResult<T> {
  if (viewerWarnings.length === 0) {
    return result;
  }

  return {
    ...result,
    warnings: [...result.warnings, ...viewerWarnings]
  };
}

function isJsonMode(command: Command): boolean {
  const options = command.optsWithGlobals() as { json?: unknown };
  return options.json === true;
}

function renderInitData(
  data: InitProjectData,
  viewerUrl: string | null,
  json: boolean
): string {
  const lines = [
    initHeadline(data),
    ...renderCreatedFiles(data),
    `Gitignore ${data.gitignore_updated ? "updated" : "unchanged"}.`,
    `Index ${data.index_built ? "built" : "not built"}.`,
    ...renderAgentGuidance(data.agent_guidance),
    ...(viewerUrl === null ? [] : [`Memory viewer: ${viewerUrl}`]),
    ...renderNextSteps(data.next_steps)
  ];

  if (!json && !data.dry_run) {
    lines.push("", data.brief);
  }

  return lines.join("\n");
}

function initHeadline(data: InitProjectData): string {
  if (data.dry_run) {
    return data.created
      ? "Init dry run: Memory would be initialized (nothing written)."
      : "Init dry run: Memory is already initialized (nothing written).";
  }

  return data.created ? "Initialized Memory." : "Memory is already initialized.";
}

function renderCreatedFiles(data: InitProjectData): string[] {
  if (data.files_created.length === 0) {
    return [];
  }

  const label = data.dry_run ? "Files that would be created:" : "Created files:";

  return [label, ...data.files_created.map((file) => `- ${file}`)];
}

function renderAgentGuidance(agentGuidance: {
  enabled: boolean;
  targets: Array<{ path: string; status: string }>;
  optional_skills: string[];
}): string[] {
  if (!agentGuidance.enabled) {
    return ["Agent guidance skipped."];
  }

  return [
    "Agent guidance installed:",
    ...agentGuidance.targets.map((target) => `- ${target.path}: ${target.status}`),
    `Optional bundled guidance: ${agentGuidance.optional_skills.join(", ")}`
  ];
}

function renderNextSteps(nextSteps: readonly string[]): string[] {
  if (nextSteps.length === 0) {
    return [];
  }

  return ["Next steps:", ...nextSteps.map((step) => `- ${step}`)];
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
